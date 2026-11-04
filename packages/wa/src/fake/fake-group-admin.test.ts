import { describe, expect, it } from 'vitest';
import {
  FakeWaAdapter,
  LINKED_PHONE_CAPABILITIES,
  LINKED_PHONE_GROUP_ADMIN,
  WaUnavailableError,
} from '../index.js';

const G = '120363000000001@g.us';
const OWNER = '60111111111@s.whatsapp.net';
const MEMBER = '60122222222@s.whatsapp.net';
const NEW = '60133333333@s.whatsapp.net';

async function setup() {
  const wa = new FakeWaAdapter();
  await wa.connect();
  wa.setGroupInfo({
    jid: G,
    name: 'Team',
    description: null,
    createdAt: null,
    ownerJid: OWNER,
    size: 2,
    participants: [
      { jid: OWNER, phoneJid: OWNER, lidJid: null, username: null, role: 'superadmin' },
      { jid: MEMBER, phoneJid: MEMBER, lidJid: null, username: null, role: 'member' },
    ],
    settings: { announce: false, locked: true, memberAdd: 'admins', approval: false },
  });
  const changed: string[] = [];
  wa.on('groupChanged', (e) => changed.push(e.groupJid));
  return { wa, changed };
}

describe('FakeWaAdapter group management', () => {
  it('a linked phone declares every group-admin capability', () => {
    expect(LINKED_PHONE_CAPABILITIES.groupAdmin).toBe(LINKED_PHONE_GROUP_ADMIN);
    expect(LINKED_PHONE_GROUP_ADMIN.settings).toEqual([
      'announce',
      'locked',
      'memberAdd',
      'approval',
    ]);
    expect(LINKED_PHONE_GROUP_ADMIN.nameMax).toBe(100);
  });

  it('renames, sets and clears the description, each raising groupChanged', async () => {
    const { wa, changed } = await setup();
    await wa.setGroupSubject(G, 'New name');
    await wa.setGroupDescription(G, 'About us');
    expect((await wa.getGroupInfo(G)).name).toBe('New name');
    expect((await wa.getGroupInfo(G)).description).toBe('About us');
    await wa.setGroupDescription(G, null);
    expect((await wa.getGroupInfo(G)).description).toBeNull();
    expect(changed).toEqual([G, G, G]);
    expect(wa.groupAdminCalls.map((c) => c.method)).toEqual([
      'setGroupSubject',
      'setGroupDescription',
      'setGroupDescription',
    ]);
  });

  it('adds, promotes, demotes and removes one member with per-person results', async () => {
    const { wa, changed } = await setup();
    expect(await wa.updateGroupMembers(G, [NEW], 'add')).toEqual([{ jid: NEW, status: 'ok' }]);
    expect(await wa.updateGroupMembers(G, [NEW], 'add')).toEqual([{ jid: NEW, status: 'already' }]);
    expect(await wa.updateGroupMembers(G, [NEW], 'promote')).toEqual([{ jid: NEW, status: 'ok' }]);
    expect(await wa.updateGroupMembers(G, [NEW], 'promote')).toEqual([
      { jid: NEW, status: 'already' },
    ]);
    expect((await wa.getGroupInfo(G)).participants.find((p) => p.jid === NEW)?.role).toBe('admin');
    expect(await wa.updateGroupMembers(G, [NEW], 'demote')).toEqual([{ jid: NEW, status: 'ok' }]);
    expect(await wa.updateGroupMembers(G, [NEW], 'demote')).toEqual([
      { jid: NEW, status: 'already' },
    ]);
    expect(await wa.updateGroupMembers(G, [NEW], 'remove')).toEqual([{ jid: NEW, status: 'ok' }]);
    expect(await wa.updateGroupMembers(G, [NEW], 'remove')).toEqual([
      { jid: NEW, status: 'not_member' },
    ]);
    expect(await wa.updateGroupMembers(G, [OWNER], 'remove')).toEqual([
      { jid: OWNER, status: 'not_allowed' },
    ]);
    const info = await wa.getGroupInfo(G);
    expect(info.size).toBe(2);
    // only successful changes raise groupChanged
    expect(changed).toHaveLength(4);
  });

  it('a privacy refusal answers invite_needed with an invite, and sendGroupInvite records it', async () => {
    const { wa } = await setup();
    wa.setPrivacyRefuses('60133333333');
    const [r] = await wa.updateGroupMembers(G, [NEW], 'add');
    expect(r?.status).toBe('invite_needed');
    expect(r?.invite?.code).toMatch(/^FAKEINVITE/);
    expect(r!.invite!.expiresAt).toBeGreaterThan(Date.now());
    await wa.sendGroupInvite(G, NEW, r!.invite!);
    expect(wa.groupInvites).toEqual([{ groupJid: G, toJid: NEW, invite: r!.invite }]);
    expect((await wa.getGroupInfo(G)).participants.some((p) => p.jid === NEW)).toBe(false);
  });

  it('keeps the invite link until it is reset', async () => {
    const { wa, changed } = await setup();
    const link = await wa.getGroupInviteLink(G);
    expect(link).toMatch(/^https:\/\/chat\.whatsapp\.com\/FAKEINVITE/);
    expect(await wa.getGroupInviteLink(G)).toBe(link);
    const reset = await wa.resetGroupInviteLink(G);
    expect(reset).not.toBe(link);
    expect(await wa.getGroupInviteLink(G)).toBe(reset);
    expect(changed).toEqual([G]);
  });

  it('merges settings', async () => {
    const { wa } = await setup();
    await wa.setGroupSettings(G, { announce: true, memberAdd: 'all' });
    expect((await wa.getGroupInfo(G)).settings).toEqual({
      announce: true,
      locked: true,
      memberAdd: 'all',
      approval: false,
    });
  });

  it('lists, approves and rejects join requests', async () => {
    const { wa } = await setup();
    wa.addJoinRequest(G, '60144444444', 1000);
    wa.addJoinRequest(G, '60144444444', 2000); // duplicate ignored
    wa.addJoinRequest(G, '60155555555', 3000);
    expect(await wa.listGroupJoinRequests(G)).toEqual([
      { jid: '60144444444@s.whatsapp.net', phoneJid: '60144444444@s.whatsapp.net', at: 1000 },
      { jid: '60155555555@s.whatsapp.net', phoneJid: '60155555555@s.whatsapp.net', at: 3000 },
    ]);
    expect(await wa.decideGroupJoinRequest(G, '60144444444@s.whatsapp.net', true)).toEqual({
      jid: '60144444444@s.whatsapp.net',
      status: 'ok',
    });
    await wa.decideGroupJoinRequest(G, '60155555555@s.whatsapp.net', false);
    expect(await wa.decideGroupJoinRequest(G, 'nobody@s.whatsapp.net', true)).toEqual({
      jid: 'nobody@s.whatsapp.net',
      status: 'not_member',
    });
    const info = await wa.getGroupInfo(G);
    expect(info.participants.map((p) => p.jid)).toContain('60144444444@s.whatsapp.net');
    expect(info.participants.map((p) => p.jid)).not.toContain('60155555555@s.whatsapp.net');
    expect(await wa.listGroupJoinRequests(G)).toEqual([]);
  });

  it('rejects offline, on an unknown group and after failNextGroupChange', async () => {
    const { wa } = await setup();
    await expect(wa.setGroupSubject('nope@g.us', 'x')).rejects.toThrow('Fake group not found');
    wa.failNextGroupChange();
    await expect(wa.setGroupSubject(G, 'x')).rejects.toThrow('Fake group change failure');
    await wa.setGroupSubject(G, 'ok'); // one failure only
    wa.setConnected(false);
    await expect(wa.getGroupInviteLink(G)).rejects.toBeInstanceOf(WaUnavailableError);
  });
});
