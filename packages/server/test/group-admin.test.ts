import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import {
  AddGroupMemberResponse,
  GROUP_ADD_LIMIT_PER_DAY,
  GROUP_ADD_LIMIT_PER_HOUR,
  GroupAdminResponse,
  GroupInviteLinkResponse,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@ezychat/shared';
import {
  FakeWaAdapter,
  LINKED_PHONE_CAPABILITIES,
  LINKED_PHONE_GROUP_ADMIN,
  type WaGroupInfo,
} from '@ezychat/wa';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { getChats } from '../src/wa-bridge/index.js';
import { createGroupAdminService, groupAdminCaps } from '../src/groups/admin.js';
import { createGroupService } from '../src/groups/service.js';
import { audit } from '../src/db/audit.js';

let t: TestApp;
let admin: string;
let adminId: number;
let adminName: string;
let agent: string;
const enc = encodeURIComponent;
const GROUP = '120363000000000001@g.us';
const ME = '60000000000@s.whatsapp.net'; // the fake adapter's own number
const DAVID = '6591234567@s.whatsapp.net';
const AISYAH = '60137782210@s.whatsapp.net';
const AISYAH_LID = '311222333444555@lid';
const NEW_PHONE = '60123456789';
const NEW_JID = `${NEW_PHONE}@s.whatsapp.net`;

const group = (
  over: Partial<WaGroupInfo> = {},
  meRole: 'superadmin' | 'admin' | 'member' = 'superadmin',
): WaGroupInfo => ({
  jid: GROUP,
  name: 'SME Founders',
  description: 'Weekly meetup',
  createdAt: 1_710_200_000_000,
  ownerJid: ME,
  size: 3,
  participants: [
    { jid: ME, phoneJid: ME, lidJid: null, username: null, role: meRole },
    { jid: DAVID, phoneJid: DAVID, lidJid: null, username: null, role: 'admin' },
    { jid: AISYAH_LID, phoneJid: AISYAH, lidJid: AISYAH_LID, username: null, role: 'member' },
  ],
  settings: { announce: false, locked: true, memberAdd: 'admins', approval: false },
  ...over,
});

const url = (path = '', key = GROUP) => `/api/chats/${enc(key)}/group${path}`;
const send = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  u: string,
  cookie: string,
  payload?: unknown,
) =>
  t.app.inject({
    method,
    url: u,
    headers: method === 'GET' ? { cookie } : authHeaders(cookie),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const code = (r: { json(): unknown }) => (r.json() as { error: { code: string } }).error.code;
const state = async (cookie = admin, key = GROUP) => {
  const r = await send('GET', url('', key), cookie);
  expect(r.statusCode).toBe(200);
  return GroupAdminResponse.parse(r.json());
};
const auditRows = () =>
  t.ctx.db
    .prepare(`SELECT action, meta, at FROM audit_log WHERE action LIKE 'group.%' ORDER BY id`)
    .all() as Array<{ action: string; meta: string; at: number }>;

async function setup(opts?: Parameters<typeof makeTestApp>[0], info: WaGroupInfo = group()) {
  t = await makeTestApp(opts);
  const a = await createUserAndLogin(t, { role: 'admin' });
  admin = a.cookie;
  adminId = a.user.id;
  adminName = a.user.displayName;
  ({ cookie: agent } = await createUserAndLogin(t));
  getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'SME Founders' });
  t.wa.setGroupInfo(info);
}

afterEach(async () => t?.close());

describe('group management: read', () => {
  beforeEach(() => setup());

  it('admins get caps, role, settings, link, requests and recent changes', async () => {
    getChats(t.ctx).upsertContacts([
      { jid: '60111222333@s.whatsapp.net', pushName: 'Mei Ling', savedName: null },
    ]);
    t.wa.addJoinRequest(GROUP, '60111222333', 1_700_000_000_000);
    t.wa.addJoinRequest(GROUP, '60111222444', 1_700_000_000_001);
    const s = await state();
    expect(s.caps).toMatchObject({
      editInfo: true,
      addMembers: true,
      removeMembers: true,
      admins: true,
      inviteLink: true,
      resetInviteLink: true,
      joinRequests: true,
      settings: ['announce', 'locked', 'memberAdd', 'approval'],
      maxMembers: null,
      nameMax: 100,
    });
    expect(s).toMatchObject({
      canManage: true,
      online: true,
      myRole: 'superadmin',
      size: 3,
      settings: { announce: false, locked: true, memberAdd: 'admins', approval: false },
      changes: [],
    });
    expect(s.inviteLink).toMatch(/^https:\/\/chat\.whatsapp\.com\/FAKEINVITE/);
    expect(s.requests).toEqual([
      {
        jid: '60111222333@s.whatsapp.net',
        phone: '60111222333',
        name: 'Mei Ling',
        at: 1_700_000_000_000,
      },
      {
        jid: '60111222444@s.whatsapp.net',
        phone: '60111222444',
        name: null,
        at: 1_700_000_000_001,
      },
    ]);
  });

  it('agents read caps and role only: no link, requests or changes', async () => {
    t.wa.addJoinRequest(GROUP, '60111222333');
    await send('PATCH', url(), admin, { name: 'Renamed' });
    const s = await state(agent);
    expect(s).toMatchObject({
      canManage: false,
      online: true,
      myRole: 'superadmin',
      inviteLink: null,
      requests: [],
      changes: [],
    });
    expect(s.caps.editInfo).toBe(true);
    expect(t.wa.groupAdminCalls.map((c) => c.method)).not.toContain('getGroupInviteLink');
    expect(t.wa.groupAdminCalls.map((c) => c.method)).not.toContain('listGroupJoinRequests');
  });

  it('link and request failures answer null / [] instead of failing the panel', async () => {
    t.wa.addJoinRequest(GROUP, '60111222333');
    t.wa.failNextGroupChange(); // the link read fails
    const s = await state();
    expect(s.inviteLink).toBeNull();
    expect(s.requests).toHaveLength(1);
    vi.spyOn(t.wa, 'listGroupJoinRequests').mockRejectedValueOnce(new Error('boom'));
    const s2 = await state();
    expect(s2.inviteLink).toMatch(/^https:/);
    expect(s2.requests).toEqual([]);
  });

  it('no link or requests when the linked number is not a group admin', async () => {
    t.wa.setGroupInfo(group({}, 'member'));
    const s = await state();
    expect(s).toMatchObject({ myRole: 'member', inviteLink: null, requests: [] });
  });

  it('offline: online false, the cached list still gives the role', async () => {
    await state();
    t.wa.setConnected(false);
    const s = await state();
    expect(s).toMatchObject({ online: false, myRole: 'superadmin', inviteLink: null });
    // no list at all while offline: role and size unknown
    t.ctx.services.groups!.invalidate(GROUP);
    expect(await state()).toMatchObject({ online: false, myRole: null, size: null, settings: {} });
  });

  it('404 for a direct chat, an unknown chat and a malformed key', async () => {
    getChats(t.ctx).upsertFromWa({ jid: DAVID, type: 'dm', name: 'David' });
    expect((await send('GET', url('', DAVID), admin)).statusCode).toBe(404);
    expect((await send('GET', url('', '999@g.us'), admin)).statusCode).toBe(404);
    expect((await send('PATCH', url('', DAVID), admin, { name: 'x' })).statusCode).toBe(404);
    expect((await send('GET', url('', `${GROUP}#0`), admin)).statusCode).toBe(404);
  });

  it('agents get 403 on every change', async () => {
    const calls: Array<[Parameters<typeof send>[0], string, unknown]> = [
      ['PATCH', url(), { name: 'x' }],
      ['POST', url('/members'), { phone: NEW_PHONE }],
      ['POST', url(`/members/${enc(NEW_JID)}/invite`), undefined],
      ['DELETE', url(`/members/${enc(DAVID)}`), undefined],
      ['PUT', url(`/members/${enc(DAVID)}/role`), { admin: false }],
      ['POST', url('/invite-link/reset'), undefined],
      ['PUT', url('/settings'), { announce: true }],
      ['POST', url(`/requests/${enc(NEW_JID)}`), { approve: true }],
    ];
    for (const [m, u, p] of calls) expect((await send(m, u, agent, p)).statusCode).toBe(403);
    expect(t.wa.groupAdminCalls).toEqual([]);
  });
});

describe('group management: changes', () => {
  beforeEach(() => setup());

  it('renames and edits the description; audit keeps no text', async () => {
    const events: string[] = [];
    t.ctx.bus.on('group:changed', (p) => events.push(p.chatJid));
    let r = await send('PATCH', url(), admin, {
      name: 'Secret Founders Club',
      description: 'Very private words',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(t.wa.groupAdminCalls.map((c) => [c.method, c.args[0]])).toEqual([
      ['setGroupSubject', 'Secret Founders Club'],
      ['setGroupDescription', 'Very private words'],
    ]);
    expect(events).toContain(GROUP);
    // '' clears the description
    r = await send('PATCH', url(), admin, { description: '' });
    expect(r.statusCode).toBe(200);
    expect(t.wa.groupAdminCalls.at(-1)).toMatchObject({
      method: 'setGroupDescription',
      args: [null],
    });
    const rows = auditRows();
    expect(rows.map((x) => x.action)).toEqual([
      'group.rename',
      'group.description',
      'group.description',
    ]);
    for (const row of rows) {
      expect(row.meta).not.toMatch(/Secret|private/);
      expect(JSON.parse(row.meta)).toMatchObject({ chatJid: GROUP, inboxId: 1 });
    }
    // the member list is read again after a change
    const before = t.wa.groupInfoCalls.length;
    await state();
    expect(t.wa.groupInfoCalls).toHaveLength(before + 1);
  });

  it('edit validates against the connection limits', async () => {
    expect((await send('PATCH', url(), admin, {})).statusCode).toBe(400);
    const r = await send('PATCH', url(), admin, { name: 'x'.repeat(101) });
    expect(r.statusCode).toBe(400);
    expect(t.wa.groupAdminCalls).toEqual([]);
  });

  it('adds a member; refuses unknown numbers, existing members and full groups', async () => {
    let r = await send('POST', url('/members'), admin, { phone: NEW_PHONE });
    expect(r.statusCode).toBe(200);
    expect(AddGroupMemberResponse.parse(r.json())).toEqual({ result: 'added', memberJid: NEW_JID });
    expect(t.wa.groupAdminCalls.at(-1)).toMatchObject({
      method: 'updateGroupMembers',
      args: [[NEW_JID], 'add'],
    });
    expect(JSON.parse(auditRows().at(-1)!.meta)).toEqual({
      chatJid: GROUP,
      inboxId: 1,
      memberJid: NEW_JID,
      result: 'added',
    });

    t.wa.setNotOnWhatsApp('60999888777');
    const calls = t.wa.groupAdminCalls.length;
    r = await send('POST', url('/members'), admin, { phone: '60999888777' });
    expect([r.statusCode, code(r)]).toEqual([422, 'not_on_whatsapp']);
    // Aisyah is listed by her WhatsApp ID; her number is known through the list
    r = await send('POST', url('/members'), admin, { phone: '60137782210' });
    expect([r.statusCode, code(r)]).toEqual([409, 'already_member']);
    expect(t.wa.groupAdminCalls).toHaveLength(calls);
    expect((await send('POST', url('/members'), admin, { phone: '+6012' })).statusCode).toBe(400);
  });

  it('privacy refusal → invite_needed → Send invite → invite_expired the second time', async () => {
    t.wa.setPrivacyRefuses(NEW_PHONE);
    let r = await send('POST', url('/members'), admin, { phone: NEW_PHONE });
    expect(r.json()).toEqual({ result: 'invite_needed', memberJid: NEW_JID });
    expect(auditRows()).toEqual([]);
    r = await send('POST', url(`/members/${enc(NEW_JID)}/invite`), admin);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ result: 'sent' });
    expect(t.wa.groupInvites).toHaveLength(1);
    expect(t.wa.groupInvites[0]).toMatchObject({ groupJid: GROUP, toJid: NEW_JID });
    expect(JSON.parse(auditRows().at(-1)!.meta)).toMatchObject({
      memberJid: NEW_JID,
      result: 'sent',
    });
    r = await send('POST', url(`/members/${enc(NEW_JID)}/invite`), admin);
    expect([r.statusCode, code(r)]).toEqual([409, 'invite_expired']);
    r = await send('POST', url(`/members/${enc('not-a-jid')}/invite`), admin);
    expect(r.statusCode).toBe(400);
  });

  it('removes members and changes admins; the owner and absent members are refused', async () => {
    let r = await send('PUT', url(`/members/${enc(AISYAH)}/role`), admin, { admin: true });
    expect(r.statusCode).toBe(200);
    expect(t.wa.groupAdminCalls.at(-1)).toMatchObject({ args: [[AISYAH_LID], 'promote'] });
    // already admin: fine, nothing recorded
    r = await send('PUT', url(`/members/${enc(AISYAH_LID)}/role`), admin, { admin: true });
    expect(r.statusCode).toBe(200);
    r = await send('PUT', url(`/members/${enc(DAVID)}/role`), admin, { admin: false });
    expect(r.statusCode).toBe(200);
    r = await send('DELETE', url(`/members/${enc(DAVID)}`), admin);
    expect(r.statusCode).toBe(200);
    expect(auditRows().map((x) => x.action)).toEqual([
      'group.admin_promote',
      'group.admin_demote',
      'group.member_remove',
    ]);

    r = await send('DELETE', url(`/members/${enc(DAVID)}`), admin);
    expect([r.statusCode, code(r)]).toEqual([409, 'not_member']);
    r = await send('DELETE', url(`/members/${enc(ME)}`), admin);
    expect([r.statusCode, code(r)]).toEqual([409, 'cannot_change_owner']);
  });

  it('the creator cannot be removed or demoted; the own number is refused', async () => {
    t.wa.setGroupInfo(
      group({
        participants: [
          { jid: ME, phoneJid: ME, lidJid: null, username: null, role: 'admin' },
          { jid: DAVID, phoneJid: DAVID, lidJid: null, username: null, role: 'superadmin' },
        ],
      }),
    );
    let r = await send('PUT', url(`/members/${enc(DAVID)}/role`), admin, { admin: false });
    expect([r.statusCode, code(r)]).toEqual([409, 'cannot_change_owner']);
    r = await send('DELETE', url(`/members/${enc(DAVID)}`), admin);
    expect([r.statusCode, code(r)]).toEqual([409, 'cannot_change_owner']);
    r = await send('DELETE', url(`/members/${enc(ME)}`), admin);
    expect([r.statusCode, code(r)]).toEqual([409, 'not_supported']);
    expect(t.wa.groupAdminCalls).toEqual([]);
  });

  it('resets the invite link', async () => {
    const before = (await state()).inviteLink;
    const r = await send('POST', url('/invite-link/reset'), admin);
    expect(r.statusCode).toBe(200);
    const { inviteLink } = GroupInviteLinkResponse.parse(r.json());
    expect(inviteLink).not.toBe(before);
    expect(auditRows().map((x) => x.action)).toEqual(['group.invite_reset']);
  });

  it('changes settings: one audit row per setting with its value', async () => {
    const r = await send('PUT', url('/settings'), admin, { announce: true, memberAdd: 'all' });
    expect(r.statusCode).toBe(200);
    expect(t.wa.groupAdminCalls.at(-1)).toMatchObject({
      method: 'setGroupSettings',
      args: [{ announce: true, memberAdd: 'all' }],
    });
    expect(auditRows().map((x) => JSON.parse(x.meta))).toEqual([
      { chatJid: GROUP, inboxId: 1, setting: 'announce', value: true, result: 'ok' },
      { chatJid: GROUP, inboxId: 1, setting: 'memberAdd', value: 'all', result: 'ok' },
    ]);
    expect((await state()).settings).toMatchObject({ announce: true, memberAdd: 'all' });
    expect((await send('PUT', url('/settings'), admin, {})).statusCode).toBe(400);
  });

  it('approves and rejects join requests', async () => {
    t.wa.addJoinRequest(GROUP, '60111222333');
    t.wa.addJoinRequest(GROUP, '60111222444');
    let r = await send('POST', url(`/requests/${enc('60111222333@s.whatsapp.net')}`), admin, {
      approve: true,
    });
    expect(r.statusCode).toBe(200);
    r = await send('POST', url(`/requests/${enc('60111222444@s.whatsapp.net')}`), admin, {
      approve: false,
    });
    expect(r.statusCode).toBe(200);
    expect(auditRows().map((x) => x.action)).toEqual(['group.join_approve', 'group.join_reject']);
    r = await send('POST', url(`/requests/${enc('60111222444@s.whatsapp.net')}`), admin, {
      approve: true,
    });
    expect([r.statusCode, code(r)]).toEqual([409, 'not_member']);
    expect((await state()).requests).toEqual([]);
  });

  it('recent changes: newest first, with who and the member name resolved now', async () => {
    getChats(t.ctx).upsertContacts([{ jid: AISYAH, pushName: 'Nurul Aisyah', savedName: null }]);
    await send('PATCH', url(), admin, { name: 'New name' });
    await send('PUT', url(`/members/${enc(AISYAH)}/role`), admin, { admin: true });
    await send('POST', url('/members'), admin, { phone: NEW_PHONE });
    await send('PUT', url('/settings'), admin, { approval: true });
    // a row of another group never shows
    audit(t.ctx.db, {
      userId: adminId,
      action: 'group.rename',
      ip: null,
      meta: { chatJid: 'x@g.us', inboxId: 1, result: 'ok' },
    });
    const { changes } = await state();
    expect(changes.map((c) => c.action)).toEqual([
      'setting',
      'member_add',
      'admin_promote',
      'rename',
    ]);
    expect(changes[0]).toMatchObject({
      setting: 'approval',
      value: true,
      memberJid: null,
      memberName: null,
    });
    expect(changes[1]).toMatchObject({
      byUserId: adminId,
      byName: adminName,
      memberJid: NEW_JID,
      memberName: '+60123456789',
    });
    expect(changes[2]).toMatchObject({ memberJid: AISYAH_LID, memberName: 'Nurul Aisyah' });
  });

  it('a failed WhatsApp call answers 502 and records nothing; offline answers 503', async () => {
    t.wa.failNextGroupChange();
    let r = await send('PATCH', url(), admin, { name: 'x' });
    expect([r.statusCode, code(r)]).toEqual([502, 'group_change_failed']);
    t.wa.failNextGroupChange();
    r = await send('POST', url('/members'), admin, { phone: NEW_PHONE });
    expect([r.statusCode, code(r)]).toEqual([502, 'group_change_failed']);
    expect(auditRows()).toEqual([]);
    t.wa.setConnected(false);
    r = await send('PATCH', url(), admin, { name: 'x' });
    expect([r.statusCode, code(r)]).toEqual([503, 'wa_unavailable']);
  });

  it('WhatsApp refusing with 401/403 answers not_group_admin', async () => {
    t.wa.failNextGroupChange(Object.assign(new Error('forbidden'), { data: 403 }));
    let r = await send('PATCH', url(), admin, { name: 'x' });
    expect([r.statusCode, code(r)]).toEqual([409, 'not_group_admin']);
    t.wa.failNextGroupChange(
      Object.assign(new Error('unauthorized'), { output: { statusCode: 401 } }),
    );
    r = await send('PUT', url('/settings'), admin, { locked: false });
    expect([r.statusCode, code(r)]).toEqual([409, 'not_group_admin']);
    expect(auditRows()).toEqual([]);
    // the refusal drops the cached member list: the next read asks WhatsApp again
    const before = t.wa.groupInfoCalls.length;
    await state();
    expect(t.wa.groupInfoCalls).toHaveLength(before + 1);
  });

  it('adapter error codes pass through; unknown codes answer 502', async () => {
    t.wa.failNextGroupChange(Object.assign(new Error('x'), { code: 'group_full' }));
    let r = await send('POST', url('/members'), admin, { phone: NEW_PHONE });
    expect([r.statusCode, code(r)]).toEqual([409, 'group_full']);
    t.wa.failNextGroupChange(Object.assign(new Error('x'), { code: 'not_supported' }));
    r = await send('PATCH', url(), admin, { name: 'x' });
    expect([r.statusCode, code(r)]).toEqual([409, 'not_supported']);
    t.wa.failNextGroupChange(Object.assign(new Error('x'), { code: 'not_on_whatsapp' }));
    r = await send('POST', url('/members'), admin, { phone: NEW_PHONE });
    expect([r.statusCode, code(r)]).toEqual([422, 'not_on_whatsapp']);
    t.wa.failNextGroupChange(Object.assign(new Error('x'), { code: 'rate_limited' }));
    r = await send('POST', url('/invite-link/reset'), admin);
    expect([r.statusCode, code(r)]).toEqual([429, 'rate_limited']);
    t.wa.failNextGroupChange(Object.assign(new Error('x'), { code: 'wa_unavailable' }));
    r = await send('POST', url('/invite-link/reset'), admin);
    expect([r.statusCode, code(r)]).toEqual([503, 'wa_unavailable']);
    t.wa.failNextGroupChange(Object.assign(new Error('x'), { code: 'something_else' }));
    r = await send('POST', url('/invite-link/reset'), admin);
    expect([r.statusCode, code(r)]).toEqual([502, 'group_change_failed']);
    expect(auditRows()).toEqual([]);
  });

  it('not a group admin: 409 before calling WhatsApp', async () => {
    t.wa.setGroupInfo(group({}, 'member'));
    for (const [m, u, p] of [
      ['PATCH', url(), { name: 'x' }],
      ['POST', url('/members'), { phone: NEW_PHONE }],
      ['DELETE', url(`/members/${enc(DAVID)}`), undefined],
      ['PUT', url('/settings'), { locked: false }],
    ] as const) {
      const r = await send(m, u, admin, p);
      expect([r.statusCode, code(r)]).toEqual([409, 'not_group_admin']);
    }
    expect(t.wa.groupAdminCalls).toEqual([]);
  });

  it('rate limits: 10 edits a minute per user', async () => {
    for (let i = 0; i < 10; i++)
      expect((await send('PATCH', url(), admin, { name: `n${i}` })).statusCode).toBe(200);
    const r = await send('PATCH', url(), admin, { name: 'n11' });
    expect([r.statusCode, code(r)]).toEqual([429, 'rate_limited']);
  });
});

describe('group management: add limits', () => {
  beforeEach(() => setup());

  it('6 adds an hour, counted on success only', async () => {
    t.wa.setNotOnWhatsApp('60999888777');
    t.wa.setPrivacyRefuses('60100000099');
    // failures and privacy refusals do not count
    await send('POST', url('/members'), admin, { phone: '60999888777' });
    await send('POST', url('/members'), admin, { phone: '60100000099' });
    for (let i = 0; i < GROUP_ADD_LIMIT_PER_HOUR; i++) {
      const r = await send('POST', url('/members'), admin, { phone: `6010000000${i}` });
      expect(r.statusCode).toBe(200);
    }
    const r = await send('POST', url('/members'), admin, { phone: '60100000088' });
    expect([r.statusCode, code(r)]).toEqual([429, 'too_many_adds']);
    // an invite is counted by the same limit
    const inv = await send(
      'POST',
      url(`/members/${enc('60100000099@s.whatsapp.net')}/invite`),
      admin,
    );
    expect([inv.statusCode, code(inv)]).toEqual([429, 'too_many_adds']);
  });

  it('20 a day, counted from the audit log (survives a restart)', async () => {
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    const ins = t.ctx.db.prepare(
      'INSERT INTO audit_log (user_id, action, ip, meta, at) VALUES (?, ?, NULL, ?, ?)',
    );
    for (let i = 0; i < GROUP_ADD_LIMIT_PER_DAY - 1; i++)
      ins.run(
        adminId,
        'group.member_add',
        JSON.stringify({ chatJid: GROUP, inboxId: 1, memberJid: `x${i}`, result: 'added' }),
        twoHoursAgo,
      );
    // other inboxes and other results never count
    ins.run(
      adminId,
      'group.member_add',
      JSON.stringify({ chatJid: GROUP, inboxId: 2, result: 'added' }),
      twoHoursAgo,
    );
    ins.run(
      adminId,
      'group.member_add',
      JSON.stringify({ chatJid: GROUP, inboxId: 1, result: 'invite_needed' }),
      twoHoursAgo,
    );
    expect((await send('POST', url('/members'), admin, { phone: '60100000001' })).statusCode).toBe(
      200,
    );
    const r = await send('POST', url('/members'), admin, { phone: '60100000002' });
    expect([r.statusCode, code(r)]).toEqual([429, 'too_many_adds']);
    // a fresh service over the same database (a restart) still counts them
    const freshGroups = createGroupService(t.ctx);
    const fresh = createGroupAdminService(t.ctx, freshGroups);
    try {
      await expect(
        fresh.addMember(GROUP, '60100000003', { userId: adminId, ip: null }),
      ).rejects.toMatchObject({
        status: 429,
        code: 'too_many_adds',
      });
    } finally {
      freshGroups.shutdown();
    }
  });
});

describe('group management: capabilities', () => {
  it('a connection without groupAdmin is read-only: 409 not_supported', async () => {
    const wa = new FakeWaAdapter({
      capabilities: { ...LINKED_PHONE_CAPABILITIES, groupAdmin: undefined },
    });
    await setup({ wa });
    const s = await state();
    expect(s.caps).toMatchObject({
      editInfo: false,
      addMembers: false,
      settings: [],
      joinRequests: false,
    });
    expect(s.inviteLink).toBeNull();
    const r = await send('PATCH', url(), admin, { name: 'x' });
    expect([r.statusCode, code(r)]).toEqual([409, 'not_supported']);
    expect(t.wa.groupAdminCalls).toEqual([]);
  });

  it('flags false and missing methods turn actions off; settings must all be supported', async () => {
    const wa = new FakeWaAdapter({
      capabilities: {
        ...LINKED_PHONE_CAPABILITIES,
        groupAdmin: {
          ...LINKED_PHONE_GROUP_ADMIN,
          removeMembers: false,
          settings: ['announce'],
          maxMembers: 2,
        },
      },
    });
    (wa as unknown as Record<string, unknown>).resetGroupInviteLink = undefined;
    await setup({ wa });
    const s = await state();
    expect(s.caps).toMatchObject({
      removeMembers: false,
      resetInviteLink: false,
      settings: ['announce'],
      maxMembers: 2,
    });
    let r = await send('DELETE', url(`/members/${enc(DAVID)}`), admin);
    expect(code(r)).toBe('not_supported');
    r = await send('POST', url('/invite-link/reset'), admin);
    expect(code(r)).toBe('not_supported');
    r = await send('PUT', url('/settings'), admin, { announce: true, locked: false });
    expect(code(r)).toBe('not_supported');
    expect((await send('PUT', url('/settings'), admin, { announce: true })).statusCode).toBe(200);
    // 2 members besides the business: full
    r = await send('POST', url('/members'), admin, { phone: NEW_PHONE });
    expect([r.statusCode, code(r)]).toEqual([409, 'group_full']);
  });

  it('a connection without groups has no caps; a missing adapter neither', () => {
    const wa = new FakeWaAdapter({ capabilities: { ...LINKED_PHONE_CAPABILITIES, groups: false } });
    expect(groupAdminCaps(wa).editInfo).toBe(false);
    expect(groupAdminCaps(null).settings).toEqual([]);
    expect(groupAdminCaps(new FakeWaAdapter()).editInfo).toBe(true);
  });
});

describe('group management: inboxes', () => {
  const KEY2 = `${GROUP}#2`;
  beforeEach(async () => {
    await setup({ maxInboxes: 3, inboxes: 2 });
    getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'Two' }, 2);
    const me2 = t.inboxWa(2).status.me!.jid;
    t.inboxWa(2).setGroupInfo(
      group({
        participants: [{ jid: me2, phoneJid: me2, lidJid: null, username: null, role: 'admin' }],
        size: 1,
      }),
    );
  });

  it('an agent outside the inbox gets 404; changes go to that inbox’s phone', async () => {
    const outsider = await createUserAndLogin(t);
    t.ctx.inboxes.repo.setUserInboxes(outsider.user.id, [1]);
    expect((await send('GET', url('', KEY2), outsider.cookie)).statusCode).toBe(404);
    expect((await send('GET', url('', GROUP), outsider.cookie)).statusCode).toBe(200);
    const r = await send('PATCH', url('', KEY2), admin, { name: 'Inbox two' });
    expect(r.statusCode).toBe(200);
    expect(t.inboxWa(2).groupAdminCalls.map((c) => c.method)).toEqual(['setGroupSubject']);
    expect(t.wa.groupAdminCalls).toEqual([]);
    expect(JSON.parse(auditRows().at(-1)!.meta)).toMatchObject({ chatJid: KEY2, inboxId: 2 });
    expect((await state(admin, KEY2)).changes).toHaveLength(1);
    expect((await state(admin, GROUP)).changes).toHaveLength(0);
  });

  it('a removed inbox answers 409 inbox_removed; its state is read-only', async () => {
    t.ctx.inboxes.repo.markRemoved(2, Date.now());
    await t.ctx.inboxes.connections.remove(2);
    const r = await send('PATCH', url('', KEY2), admin, { name: 'x' });
    expect([r.statusCode, code(r)]).toEqual([409, 'inbox_removed']);
    const s = await state(admin, KEY2);
    expect(s).toMatchObject({ online: false, myRole: null, size: null });
    expect(s.caps.editInfo).toBe(false);
  });

  it('a WhatsApp-side change in inbox 2 emits group:changed with the chat key', async () => {
    const seen: string[] = [];
    t.ctx.bus.on('group:changed', (p) => seen.push(p.chatJid));
    await state(admin, KEY2); // the group service listens once routes are built
    t.inboxWa(2).simulateGroupChanged(GROUP);
    t.wa.simulateGroupChanged(GROUP);
    expect(seen).toEqual([KEY2, GROUP]);
  });
});

describe('group:changed over Socket.IO', () => {
  it('reaches the inbox room of the group', async () => {
    await setup({ listen: true });
    const s: Socket<ServerToClientEvents, ClientToServerEvents> = ioClient(t.url!, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { cookie: agent },
      forceNew: true,
    });
    try {
      await new Promise<void>((res, rej) => {
        s.once('connect', () => res());
        s.once('connect_error', rej);
      });
      const got = new Promise<{ chatJid: string }>((res) => s.once('group:changed', res));
      expect((await send('POST', url('/invite-link/reset'), admin)).statusCode).toBe(200);
      expect(await got).toEqual({ chatJid: GROUP });
    } finally {
      s.disconnect();
    }
  });
});
