import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type * as Baileys from 'baileys';
import { LINKED_PHONE_CAPABILITIES, WaUnavailableError, type WaAdapter } from '../types.js';
import { BaileysAdapter } from './adapter.js';

const socketFactory = vi.hoisted(() => vi.fn());
vi.mock('baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof Baileys>()),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
  makeWASocket: socketFactory,
}));

const GROUP = '120363000000000001@g.us';
const PN = '60123456789@s.whatsapp.net';
const LID = '111222333444555@lid';

type GroupFn =
  | 'groupUpdateSubject'
  | 'groupUpdateDescription'
  | 'groupParticipantsUpdate'
  | 'groupMetadata'
  | 'sendMessage'
  | 'groupInviteCode'
  | 'groupRevokeInvite'
  | 'groupSettingUpdate'
  | 'groupMemberAddMode'
  | 'groupJoinApprovalMode'
  | 'groupRequestParticipantsList'
  | 'groupRequestParticipantsUpdate';
type Spy = Mock<(...args: never[]) => Promise<unknown>>;
/** A spy with a typed-loose signature, so tests can swap in any answer. */
const spy = (impl: (...args: never[]) => Promise<unknown>): Spy => vi.fn(impl);

/** A socket whose group functions are spies. */
function groupSocket(): Record<GroupFn, Spy> {
  return {
    groupUpdateSubject: spy(async () => {}),
    groupUpdateDescription: spy(async () => {}),
    groupParticipantsUpdate: spy(async (_g: string, jids: string[]) =>
      jids.map((jid) => ({ status: '200', jid, content: { tag: 'participant', attrs: { jid } } })),
    ),
    groupMetadata: spy(async () => ({ id: GROUP, subject: 'SME Founders', participants: [] })),
    sendMessage: spy(async () => ({ key: { id: 'INV1' }, messageTimestamp: 1_700_000_000 })),
    groupInviteCode: spy(async () => 'Code123'),
    groupRevokeInvite: spy(async () => 'NewCode456'),
    groupSettingUpdate: spy(async () => {}),
    groupMemberAddMode: spy(async () => {}),
    groupJoinApprovalMode: spy(async () => {}),
    groupRequestParticipantsList: spy(async () => [{ jid: LID, request_time: '1762200000' }]),
    groupRequestParticipantsUpdate: spy(async (_g: string, jids: string[]) =>
      jids.map((jid) => ({ status: '200', jid })),
    ),
  };
}

/** An open adapter on a spy socket; `over` replaces some of its functions. */
function openAdapter(over: Partial<ReturnType<typeof groupSocket>> = {}) {
  const a = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
  const sock = { ...groupSocket(), ...over };
  const emitted: unknown[] = [];
  a.on('groupChanged', (e) => emitted.push(e));
  Object.assign(a as unknown as Record<string, unknown>, {
    sock,
    _status: { state: 'open', me: null, qr: null, lastError: null },
  });
  return { a, sock, emitted };
}

function closedAdapter() {
  return new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
}

describe('BaileysAdapter group management', () => {
  it('declares no capabilities, i.e. a linked phone with full group admin', () => {
    const a = closedAdapter();
    expect((a as WaAdapter).capabilities).toBeUndefined();
    expect(LINKED_PHONE_CAPABILITIES.groupAdmin?.settings).toEqual([
      'announce',
      'locked',
      'memberAdd',
      'approval',
    ]);
  });

  it('renames and sets or clears the description', async () => {
    const { a, sock, emitted } = openAdapter();
    await a.setGroupSubject(GROUP, 'New name');
    await a.setGroupDescription(GROUP, 'About us');
    await a.setGroupDescription(GROUP, null);
    await a.setGroupDescription(GROUP, '');
    expect(sock.groupUpdateSubject).toHaveBeenCalledWith(GROUP, 'New name');
    expect(sock.groupUpdateDescription.mock.calls).toEqual([
      [GROUP, 'About us'],
      [GROUP, undefined],
      [GROUP, undefined],
    ]);
    expect(emitted).toEqual([]);
  });

  it.each(['add', 'remove', 'promote', 'demote'] as const)(
    'updates exactly one member (%s) with a normalized address',
    async (action) => {
      const { a, sock, emitted } = openAdapter();
      const res = await a.updateGroupMembers(GROUP, ['60123456789:7@s.whatsapp.net'], action);
      expect(sock.groupParticipantsUpdate).toHaveBeenCalledWith(GROUP, [PN], action);
      expect(res).toEqual([{ jid: PN, status: 'ok' }]);
      expect(emitted).toEqual([]);
    },
  );

  it('returns the private invite when privacy refuses an add', async () => {
    const { a } = openAdapter({
      groupParticipantsUpdate: spy(async () => [
        {
          status: '403',
          jid: LID,
          content: {
            tag: 'participant',
            attrs: { jid: LID, error: '403' },
            content: [{ tag: 'add_request', attrs: { code: 'Inv9', expiration: '1762300000' } }],
          },
        },
      ]),
    });
    await expect(a.updateGroupMembers(GROUP, [PN], 'add')).resolves.toEqual([
      { jid: PN, status: 'invite_needed', invite: { code: 'Inv9', expiresAt: 1_762_300_000_000 } },
    ]);
  });

  it('maps a whole-request 401/403 to not_allowed and an empty answer to failed', async () => {
    const refused = Object.assign(new Error('not-authorized'), { data: 401 });
    const { a } = openAdapter({
      groupParticipantsUpdate: spy(async () => Promise.reject(refused)),
    });
    await expect(a.updateGroupMembers(GROUP, [PN], 'remove')).resolves.toEqual([
      { jid: PN, status: 'not_allowed' },
    ]);
    const { a: b } = openAdapter({ groupParticipantsUpdate: spy(async () => undefined) });
    await expect(b.updateGroupMembers(GROUP, [PN], 'remove')).resolves.toEqual([
      { jid: PN, status: 'failed' },
    ]);
  });

  it('rethrows other WhatsApp errors and turns a lost connection into WaUnavailableError', async () => {
    const other = Object.assign(new Error('bad-request'), { data: 400 });
    const { a } = openAdapter({
      groupParticipantsUpdate: spy(async () => Promise.reject(other)),
    });
    await expect(a.updateGroupMembers(GROUP, [PN], 'add')).rejects.toBe(other);
    const lost = Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    const { a: b } = openAdapter({
      groupParticipantsUpdate: spy(async () => Promise.reject(lost)),
    });
    await expect(b.updateGroupMembers(GROUP, [PN], 'add')).rejects.toBeInstanceOf(
      WaUnavailableError,
    );
    const { a: c } = openAdapter({ groupUpdateSubject: spy(async () => Promise.reject(other)) });
    await expect(c.setGroupSubject(GROUP, 'x')).rejects.toBe(other);
  });

  it('treats an error after the socket closed as unavailable', async () => {
    const { a } = openAdapter();
    const err = new Error('stream errored');
    Object.assign(a as unknown as Record<string, unknown>, {
      sock: {
        groupUpdateSubject: spy(async () => {
          Object.assign(a as unknown as Record<string, unknown>, {
            _status: { state: 'disconnected', me: null, qr: null, lastError: null },
          });
          throw err;
        }),
      },
    });
    await expect(a.setGroupSubject(GROUP, 'x')).rejects.toBeInstanceOf(WaUnavailableError);
  });

  it('sends the private invite as a group invite message with the group name', async () => {
    const { a, sock } = openAdapter();
    await a.sendGroupInvite(GROUP, '60123456789:2@s.whatsapp.net', {
      code: 'Inv9',
      expiresAt: 1_762_300_000_999,
    });
    expect(sock.groupMetadata).toHaveBeenCalledWith(GROUP);
    expect(sock.sendMessage).toHaveBeenCalledWith(
      PN,
      {
        groupInvite: {
          inviteCode: 'Inv9',
          inviteExpiration: 1_762_300_000,
          text: '',
          jid: GROUP,
          subject: 'SME Founders',
        },
      },
      undefined,
    );
  });

  it('sends an invite with an empty name when the group has none', async () => {
    const { a, sock } = openAdapter({ groupMetadata: spy(async () => ({ id: GROUP })) });
    await a.sendGroupInvite(GROUP, LID, { code: 'Inv9', expiresAt: 1_762_300_000_000 });
    expect(sock.sendMessage).toHaveBeenCalledWith(
      LID,
      { groupInvite: expect.objectContaining({ subject: '' }) },
      undefined,
    );
  });

  it('reads and resets the invite link', async () => {
    const { a, sock } = openAdapter();
    await expect(a.getGroupInviteLink(GROUP)).resolves.toBe('https://chat.whatsapp.com/Code123');
    await expect(a.resetGroupInviteLink(GROUP)).resolves.toBe(
      'https://chat.whatsapp.com/NewCode456',
    );
    expect(sock.groupInviteCode).toHaveBeenCalledWith(GROUP);
    expect(sock.groupRevokeInvite).toHaveBeenCalledWith(GROUP);
    const { a: b } = openAdapter({ groupInviteCode: spy(async () => undefined) });
    await expect(b.getGroupInviteLink(GROUP)).rejects.toThrow(/no code/);
  });

  it('changes each given setting with its Baileys call', async () => {
    const { a, sock, emitted } = openAdapter();
    await a.setGroupSettings(GROUP, {
      announce: true,
      locked: false,
      memberAdd: 'admins',
      approval: true,
    });
    expect(sock.groupSettingUpdate.mock.calls).toEqual([
      [GROUP, 'announcement'],
      [GROUP, 'unlocked'],
    ]);
    expect(sock.groupMemberAddMode).toHaveBeenCalledWith(GROUP, 'admin_add');
    expect(sock.groupJoinApprovalMode).toHaveBeenCalledWith(GROUP, 'on');
    await a.setGroupSettings(GROUP, {});
    expect(sock.groupSettingUpdate).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual([]);
  });

  it('lists and decides join requests', async () => {
    const { a, sock } = openAdapter();
    await expect(a.listGroupJoinRequests(GROUP)).resolves.toEqual([
      { jid: LID, phoneJid: null, at: 1_762_200_000_000 },
    ]);
    await expect(a.decideGroupJoinRequest(GROUP, LID, true)).resolves.toEqual({
      jid: LID,
      status: 'ok',
    });
    await expect(a.decideGroupJoinRequest(GROUP, LID, false)).resolves.toEqual({
      jid: LID,
      status: 'ok',
    });
    expect(sock.groupRequestParticipantsUpdate.mock.calls).toEqual([
      [GROUP, [LID], 'approve'],
      [GROUP, [LID], 'reject'],
    ]);
  });

  it('throws WaUnavailableError for every method while offline', async () => {
    const a = closedAdapter();
    const invite = { code: 'x', expiresAt: 1 };
    const calls: Array<() => Promise<unknown>> = [
      () => a.setGroupSubject(GROUP, 'x'),
      () => a.setGroupDescription(GROUP, null),
      () => a.updateGroupMembers(GROUP, [PN], 'add'),
      () => a.sendGroupInvite(GROUP, PN, invite),
      () => a.getGroupInviteLink(GROUP),
      () => a.resetGroupInviteLink(GROUP),
      () => a.setGroupSettings(GROUP, { announce: true }),
      () => a.listGroupJoinRequests(GROUP),
      () => a.decideGroupJoinRequest(GROUP, PN, true),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(WaUnavailableError);
  });

  it('raises groupChanged for WhatsApp-side settings, member and join-request changes', async () => {
    const a = closedAdapter();
    const ev = new EventEmitter();
    socketFactory.mockReturnValueOnce({ ev, end: vi.fn(), logout: vi.fn() });
    Object.assign(a as unknown as Record<string, unknown>, {
      auth: {
        load: async () => ({
          state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
          saveCreds: async () => {},
        }),
        wipe: async () => {},
      },
    });
    const changed: string[] = [];
    a.on('groupChanged', ({ groupJid }) => changed.push(groupJid));
    await a.connect();
    ev.emit('groups.update', [{ id: GROUP, announce: true }]);
    ev.emit('group-participants.update', { id: GROUP, participants: [], action: 'add' });
    ev.emit('group.join-request', { id: GROUP, participant: LID, action: 'created' });
    ev.emit('group.join-request', { id: '', participant: LID, action: 'created' });
    expect(changed).toEqual([GROUP, GROUP, GROUP]);
    await a.disconnect();
    ev.emit('group.join-request', { id: GROUP, participant: LID, action: 'created' });
    expect(changed).toHaveLength(3);
  });
});
