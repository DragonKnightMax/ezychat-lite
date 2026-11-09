import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SafetyChatState,
  SafetyReport,
  SafetyState,
  type Message,
  type SafetyAiAnswer,
} from '@ezychat/shared';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeZip } from './safety-helpers.js';
import { getMessages } from '../src/wa-bridge/index.js';
import { createSafetyService, SAFETY_AI_DAILY_CAP } from '../src/safety/service.js';
import { computeSafetyReport, kindOf } from '../src/reports/safety.js';

const LURE = '601123456789@s.whatsapp.net';
const KNOWN = '60129001234@s.whatsapp.net';
const LURE_TEXT =
  'Please forward this statement of account to your finance manager. Kindly open it on a laptop.';

let t: TestApp;
let admin: { cookie: string; user: { id: number } };
let agent: { cookie: string; user: { id: number } };

const tick = () => new Promise((r) => setTimeout(r, 20));

async function incoming(
  chatJid: string,
  opts: { text?: string; file?: { name: string; mime: string; bytes: Buffer } } = {},
) {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/dev/fake-incoming',
    headers: authHeaders(admin.cookie),
    payload: {
      chatJid,
      senderName: 'Accounts Dept',
      text: opts.text ?? '',
      ...(opts.file
        ? {
            type: 'document',
            media: {
              mime: opts.file.mime,
              fileName: opts.file.name,
              base64: opts.file.bytes.toString('base64'),
            },
          }
        : {}),
    },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { id: string; chatJid: string };
}

const lureZip = () => ({
  name: 'Statement_Oct2026.zip',
  mime: 'application/zip',
  bytes: makeZip([{ name: 'Statement_Oct2026.pdf.vbs' }]),
});

const message = (id: string): Message =>
  getMessages(t.ctx)
    .list(LURE, { limit: 50 })
    .messages.find((m) => m.id === id) ??
  getMessages(t.ctx)
    .list(KNOWN, { limit: 50 })
    .messages.find((m) => m.id === id)!;

async function state(): Promise<SafetyState> {
  const r = await t.app.inject({
    method: 'GET',
    url: '/api/safety',
    headers: authHeaders(admin.cookie),
  });
  expect(r.statusCode).toBe(200);
  return SafetyState.parse(r.json());
}

const act = (id: number, action: string, payload: object = {}) =>
  t.app.inject({
    method: 'POST',
    url: `/api/safety/items/${id}/${action}`,
    headers: authHeaders(admin.cookie),
    payload,
  });

const download = (id: string, cookie: string) =>
  t.app.inject({
    method: 'GET',
    url: `/api/media/${encodeURIComponent(id)}`,
    headers: authHeaders(cookie),
  });

beforeEach(async () => {
  t = await makeTestApp();
  admin = await createUserAndLogin(t, { role: 'admin' });
  agent = await createUserAndLogin(t, { role: 'agent' });
});
afterEach(async () => {
  await t.close();
});

describe('WhatsApp Safety: the ZIP lure', () => {
  it('a lure the customer deletes shows no finding on the message; admins keep the item', async () => {
    const { id } = await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    expect(message(id).safety?.level).toBe('high');
    t.wa.simulateRevoke({ chatJid: LURE, targetId: id });
    expect(message(id)).toMatchObject({ deletedBy: 'sender', body: null, safety: null });
    expect((await state()).items.map((i) => i.messageId)).toEqual([id]);
  });

  it('flags it High, locks the file in quarantine and shows the finding on the message', async () => {
    const { id } = await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    const m = message(id);
    expect(m.safety).toMatchObject({
      level: 'high',
      rules: ['exeInZip', 'openOnComputer', 'financeUrgency', 'firstFile'],
      locked: true,
      status: 'open',
    });
    const row = t.ctx.db.prepare('SELECT media_path FROM messages WHERE id = ?').get(id) as {
      media_path: string;
    };
    expect(row.media_path).toMatch(/^quarantine\/.+\.bin$/);
    expect(existsSync(join(t.ctx.config.dataDir, 'media', row.media_path))).toBe(true);

    const s = await state();
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      messageId: id,
      phone: '601123456789',
      group: false,
      level: 'high',
      critical: true,
      existingCustomer: false,
      quarantined: true,
      file: { name: 'Statement_Oct2026.zip', inside: ['Statement_Oct2026.pdf.vbs'] },
      canBlock: true,
    });
  });

  it('refuses the locked file to an agent (recorded), gives it to an admin as a plain download', async () => {
    const { id } = await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    const refused = await download(id, agent.cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('safety_locked');
    const again = await t.app.inject({
      method: 'POST',
      url: `/api/media/${encodeURIComponent(id)}/redownload`,
      headers: authHeaders(agent.cookie),
    });
    expect(again.statusCode).toBe(409);

    const ok = await download(id, admin.cookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('application/octet-stream');
    expect(ok.headers['content-disposition']).toMatch(/^attachment;/);
    expect(ok.headers['cache-control']).toBe('no-store');
    // The same admin re-opening it within minutes counts once.
    await download(id, admin.cookie);

    const item = (await state()).items[0]!;
    expect(item.downloads.map((d) => d.allowed)).toEqual([false, true]);

    expect((await act(item.id, 'release')).statusCode).toBe(200);
    expect((await download(id, agent.cookie)).statusCode).toBe(200);
  });

  it('reports and blocks the number through the connection, then unblocks it', async () => {
    const { id } = await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    const item = (await state()).items[0]!;
    const r = await act(item.id, 'report', { block: true });
    expect(r.statusCode).toBe(200);
    expect(t.wa.blocked.has(LURE)).toBe(true);
    const after = SafetyState.parse(r.json());
    expect(after.items[0]).toMatchObject({ status: 'blocked', scam: true, blocked: true });
    expect(after.blocked).toEqual([
      expect.objectContaining({ waJid: LURE, phone: '601123456789', auto: false, itemId: item.id }),
    ]);

    const bar = await t.app.inject({
      method: 'GET',
      url: `/api/safety/chats/${encodeURIComponent(LURE)}`,
      headers: authHeaders(agent.cookie),
    });
    expect(SafetyChatState.parse(bar.json())).toMatchObject({
      scam: true,
      blocked: { auto: false },
    });

    const un = await act(item.id, 'unblock');
    expect(un.statusCode).toBe(200);
    expect(t.wa.blocked.has(LURE)).toBe(false);
    expect(SafetyState.parse(un.json()).items[0]).toMatchObject({
      status: 'reported',
      blocked: false,
    });
    // A reported number is flagged whatever it sends next.
    const { id: next } = await incoming(LURE, { text: 'hello again' });
    expect(message(next).safety?.rules).toEqual(['scamNumber']);
    expect(message(id).safety?.status).toBe('reported');

    const audit = t.ctx.db
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'safety.%' ORDER BY id")
      .all() as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(['safety.report', 'safety.unblock']);
  });

  it('marks safe and trusts the sender, deletes a file, and refuses what cannot be done', async () => {
    const { id } = await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    const item = (await state()).items[0]!;
    const del = await act(item.id, 'delete');
    expect(del.statusCode).toBe(200);
    const deleted = SafetyState.parse(del.json()).items[0]!;
    expect(deleted.deleted?.by).toEqual(expect.any(String));
    expect(message(id).safety).toMatchObject({ locked: false, deletedBy: expect.any(String) });
    expect((await act(item.id, 'delete')).statusCode).toBe(409);

    expect((await act(item.id, 'safe', { trust: true })).statusCode).toBe(200);
    // Trusted for files: the next ZIP from this number is not flagged.
    await incoming(LURE, { file: lureZip() });
    expect((await state()).items).toHaveLength(1);
    expect((await act(999, 'safe')).statusCode).toBe(404);
    const asAgent = await t.app.inject({
      method: 'POST',
      url: `/api/safety/items/${item.id}/safe`,
      headers: authHeaders(agent.cookie),
      payload: {},
    });
    expect(asAgent.statusCode).toBe(403);
  });
});

describe('WhatsApp Safety: auto-block, known customers, settings', () => {
  it('auto-blocks a new number on a critical rule, never a known customer', async () => {
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/safety/settings',
      headers: authHeaders(admin.cookie),
      payload: { autoBlock: true },
    });
    expect(put.json()).toMatchObject({
      enabled: true,
      ai: true,
      autoBlock: true,
      deleteAfterDays: 30,
    });

    // A known customer: the team replied before.
    await incoming(KNOWN, { text: 'Hi, order please' });
    await t.app.inject({
      method: 'POST',
      url: `/api/chats/${encodeURIComponent(KNOWN)}/messages`,
      headers: authHeaders(admin.cookie),
      payload: { text: 'Sure', clientId: 'c-1' },
    });
    await incoming(KNOWN, { text: 'payment slip', file: lureZip() });
    await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    await tick();
    expect(t.wa.blocked.has(LURE)).toBe(true);
    expect(t.wa.blocked.has(KNOWN)).toBe(false);
    const s = await state();
    expect(s.items.find((i) => i.chatJid === LURE)).toMatchObject({
      autoBlocked: true,
      status: 'blocked',
    });
    expect(s.items.find((i) => i.chatJid === KNOWN)).toMatchObject({
      existingCustomer: true,
      autoBlocked: false,
      status: 'open',
    });
    expect(s.blocked).toEqual([expect.objectContaining({ waJid: LURE, auto: true, by: null })]);
    const bar = await t.app.inject({
      method: 'GET',
      url: `/api/safety/chats/${encodeURIComponent(KNOWN)}`,
      headers: authHeaders(agent.cookie),
    });
    expect(bar.json()).toMatchObject({ maybeHacked: true, blocked: null });
  });

  it('checks nothing while switched off, and leaves ordinary messages alone', async () => {
    await incoming(LURE, { text: 'Can I book catering for 30 people?' });
    expect((await state()).items).toHaveLength(0);
    await t.app.inject({
      method: 'PUT',
      url: '/api/safety/settings',
      headers: authHeaders(admin.cookie),
      payload: { enabled: false, deleteAfterDays: 7 },
    });
    await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    const s = await state();
    expect(s.items).toHaveLength(0);
    expect(s.settings).toMatchObject({ enabled: false, deleteAfterDays: 7 });
  });

  it('deletes locked files older than the setting', async () => {
    const { id } = await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    const path = (
      t.ctx.db.prepare('SELECT media_path FROM messages WHERE id = ?').get(id) as {
        media_path: string;
      }
    ).media_path;
    expect(t.ctx.services.safety!.cleanup(Date.now())).toBe(0);
    expect(t.ctx.services.safety!.cleanup(Date.now() + 31 * 86_400_000)).toBe(1);
    expect(existsSync(join(t.ctx.config.dataDir, 'media', path))).toBe(false);
    expect(message(id).safety).toMatchObject({ locked: false, deletedBy: '' });
  });
});

describe('WhatsApp Safety: AI check', () => {
  const withAi = (answer: SafetyAiAnswer | null) => {
    const calls: string[] = [];
    Object.assign(t.ctx.services.ai!, {
      checkSafety: async (_jid: string, input: string) => {
        calls.push(input);
        return answer;
      },
    });
    return calls;
  };

  it('lowers a rules-only Warning to cleared, never a critical file', async () => {
    const calls = withAi({ level: 'none', category: 'none', reason: '' });
    const { id } = await incoming(LURE, {
      file: { name: 'Order.xlsm', mime: 'application/octet-stream', bytes: Buffer.from('x') },
    });
    await tick();
    expect(JSON.parse(calls[0]!)).toMatchObject({
      file: { name: 'Order.xlsm' },
      sender: 'new number',
    });
    expect(calls[0]).not.toContain('eA=='); // never the file's bytes
    expect(message(id).safety).toBeUndefined();
    expect((await state()).items[0]).toMatchObject({
      level: 'none',
      status: 'cleared',
      ai: { level: 'none' },
    });

    const { id: lure } = await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    await tick();
    expect(message(lure).safety?.level).toBe('high');
  });

  it('lets the phone keep a file only once the AI check is done', async () => {
    let release!: (answer: SafetyAiAnswer) => void;
    Object.assign(t.ctx.services.ai!, {
      checkSafety: () => new Promise<SafetyAiAnswer>((resolve) => (release = resolve)),
    });
    const { id } = await incoming(LURE, {
      file: { name: 'Order.xlsm', mime: 'application/octet-stream', bytes: Buffer.from('x') },
    });
    await tick();
    // The AI may still raise it to High and lock it: no phone may keep a copy meanwhile.
    expect(t.ctx.services.safety!.cacheable(id)).toBe(false);
    expect((await download(id, admin.cookie)).headers['cache-control']).toBe('no-store');
    release({ level: 'none', category: 'none', reason: '' });
    await tick();
    expect(t.ctx.services.safety!.cacheable(id)).toBe(true);
    expect((await download(id, agent.cookie)).headers['cache-control']).toBe(
      'private, max-age=2592000, immutable',
    );
    const plain = await incoming(KNOWN, { text: 'Hello' });
    expect(t.ctx.services.safety!.cacheable(plain.id)).toBe(true);
  });

  it('raises a text the rules missed to High and the AI agent leaves it alone', async () => {
    withAi({ level: 'high', category: 'phishing', reason: 'Pretends to be a bank.' });
    const { id } = await incoming(LURE, {
      text: 'Maybank2u: verify at https://maybank2u-secure.my-verify.top/login',
    });
    await tick();
    expect(message(id).safety).toMatchObject({ level: 'high', aiReason: 'Pretends to be a bank.' });
    expect(t.ctx.services.safety!.levelOf(id)).toBe('high');
  });

  it('keeps the rules result when the AI does not answer, and stops at the daily cap', async () => {
    const calls = withAi(null);
    const svc = createSafetyService(t.ctx);
    try {
      for (let i = 0; i < SAFETY_AI_DAILY_CAP + 2; i++)
        svc.inspect({
          messageId: `m-${i}`,
          chatJid: LURE,
          inboxId: 1,
          senderWaJid: LURE,
          group: false,
          live: true,
          text: 'Password: 1234',
          file: null,
        });
      expect(calls.length).toBe(SAFETY_AI_DAILY_CAP);
    } finally {
      svc.shutdown();
    }
  });
});

describe('Reports → WhatsApp Safety', () => {
  it('counts dangerous files, scam messages, downloads, blocks and false alarms', async () => {
    const { id } = await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    await incoming(KNOWN, { text: 'Verify at https://bit.ly/abc urgently for payment of invoice' });
    await download(id, agent.cookie);
    await download(id, admin.cookie);
    const item = (await state()).items.find((i) => i.chatJid === LURE)!;
    await act(item.id, 'report', { block: true });
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/reports/safety?days=7',
      headers: authHeaders(admin.cookie),
    });
    expect(r.statusCode).toBe(200);
    const report = SafetyReport.parse(r.json());
    expect(report.totals).toEqual({
      dangerousFiles: 1,
      scamMessages: 1,
      riskyDownloads: 1,
      refusedDownloads: 1,
      numbersBlocked: 1,
      autoBlocked: 0,
      maybeHacked: 0,
      flagged: 2,
      falseAlarms: 0,
    });
    expect(report.daily).toHaveLength(7);
    expect(report.daily.at(-1)).toMatchObject({ high: 1, warning: 1 });
    expect(report.kinds).toEqual([
      { kind: 'hiddenProgram', count: 1 },
      { kind: 'fakeLink', count: 1 },
    ]);
    expect(report.senders.find((x) => x.chatJid === LURE)).toMatchObject({
      status: 'blocked',
      count: 1,
      phone: '601123456789',
    });
    expect(report.senders.find((x) => x.chatJid === KNOWN)?.status).toBe('open');
    expect(report.team.map((m) => [m.riskyDownloads, m.refused])).toEqual(
      expect.arrayContaining([
        [1, 0],
        [0, 1],
      ]),
    );
    const asAgent = await t.app.inject({
      method: 'GET',
      url: '/api/reports/safety?days=7',
      headers: authHeaders(agent.cookie),
    });
    expect(asAgent.statusCode).toBe(403);
    expect(
      computeSafetyReport(t.ctx.db, { days: 30, timeZone: 'UTC', now: Date.now(), enabled: true })
        .daily,
    ).toHaveLength(30);
  });

  it('counts every inbox together or one inbox', async () => {
    const { id } = await incoming(LURE, { text: LURE_TEXT, file: lureZip() });
    await download(id, agent.cookie);
    const item = (await state()).items.find((i) => i.chatJid === LURE)!;
    await act(item.id, 'report', { block: true });
    // A second inbox with one scam message from another number.
    const db = t.ctx.db;
    db.prepare(
      "INSERT INTO inboxes (id, name, tone, auth_dir, created_at, removed_at) VALUES (2, 'Catering', 'info', 'x', 0, NULL)",
    ).run();
    const other = '60199999999@s.whatsapp.net#2';
    db.prepare(
      `INSERT INTO chats (jid, wa_jid, type, name, unread_count, status, updated_at, inbox_id)
       VALUES (?, '60199999999@s.whatsapp.net', 'dm', 'X', 0, 'open', 0, 2)`,
    ).run(other);
    const now = Date.now();
    db.prepare(
      `INSERT INTO safety_items (message_id, chat_jid, inbox_id, rules, score, rule_level, critical,
         level, status, existing_customer, has_file, created_at, updated_at)
       VALUES ('m-x', ?, 2, '["financeUrgency"]', 50, 'warning', 0, 'warning', 'open', 0, 0, ?, ?)`,
    ).run(other, now, now);
    const get = async (url: string) => {
      const r = await t.app.inject({ method: 'GET', url, headers: authHeaders(admin.cookie) });
      return r.statusCode === 200 ? SafetyReport.parse(r.json()) : r.statusCode;
    };
    const pick = (r: SafetyReport | number) =>
      typeof r === 'number'
        ? r
        : [
            r.inboxId,
            r.totals.flagged,
            r.totals.refusedDownloads,
            r.totals.numbersBlocked,
            r.senders.length,
          ];
    expect(pick(await get('/api/reports/safety?days=7'))).toEqual([null, 2, 1, 1, 2]);
    expect(pick(await get('/api/reports/safety?days=7&inbox=1'))).toEqual([1, 1, 1, 1, 1]);
    // The blocked number has no chat in inbox 2, so inbox 2 counts no block.
    expect(pick(await get('/api/reports/safety?days=7&inbox=2'))).toEqual([2, 1, 0, 0, 1]);
    expect(await get('/api/reports/safety?days=7&inbox=9')).toBe(404);
  });

  it('names each finding by its most telling kind', () => {
    expect(kindOf(['scamNumber'], null, false)).toBe('scamNumber');
    expect(kindOf(['doubleExtension'], null, true)).toBe('hiddenProgram');
    expect(kindOf(['financeUrgency'], 'phishing', false)).toBe('fakeLink');
    expect(kindOf(['cantInspect'], null, true)).toBe('lockedArchive');
    expect(kindOf(['macroFile'], null, true)).toBe('macroFile');
    expect(kindOf(['financeUrgency'], null, false)).toBe('paymentTrick');
    expect(kindOf(['financeUrgency'], 'impersonation', true)).toBe('other');
  });
});

describe('Block any chat (Customer panel)', () => {
  const SPAM = '601164988966@s.whatsapp.net';
  const chatAct = (jid: string, action: string, cookie: string, payload: object = {}) =>
    t.app.inject({
      method: 'POST',
      url: `/api/safety/chats/${encodeURIComponent(jid)}/${action}`,
      headers: authHeaders(cookie),
      payload,
    });
  const bar = async (jid: string) => {
    const r = await t.app.inject({
      method: 'GET',
      url: `/api/safety/chats/${encodeURIComponent(jid)}`,
      headers: authHeaders(admin.cookie),
    });
    return SafetyChatState.parse(r.json());
  };

  it('blocks an unflagged chat on WhatsApp, marks it as spam on request, then unblocks it', async () => {
    await incoming(SPAM, { text: 'Digital Software Branding: grow your business!' });
    expect(await bar(SPAM)).toMatchObject({ blocked: null, scam: false, canBlock: true });

    const r = await chatAct(SPAM, 'block', admin.cookie, { spam: true });
    expect(r.statusCode).toBe(200);
    expect(t.wa.blocked.has(SPAM)).toBe(true);
    expect(SafetyChatState.parse(r.json())).toMatchObject({ scam: true, blocked: { auto: false } });
    expect(t.ctx.services.safety!.isBlocked(SPAM, 1)).toBe(true);
    // Admin → Safety lists it with the other blocked numbers.
    expect((await state()).blocked).toEqual([
      expect.objectContaining({ waJid: SPAM, auto: false, itemId: null }),
    ]);

    const un = await chatAct(SPAM, 'unblock', admin.cookie);
    expect(un.statusCode).toBe(200);
    expect(t.wa.blocked.has(SPAM)).toBe(false);
    expect(SafetyChatState.parse(un.json())).toMatchObject({ blocked: null, scam: true });
    expect(t.ctx.services.safety!.isBlocked(SPAM, 1)).toBe(false);

    const audit = t.ctx.db
      .prepare("SELECT action, meta FROM audit_log WHERE action LIKE 'safety.chat.%' ORDER BY id")
      .all() as Array<{ action: string; meta: string }>;
    expect(audit.map((a) => a.action)).toEqual(['safety.chat.block', 'safety.chat.unblock']);
    expect(JSON.parse(audit[0]!.meta)).toEqual({ chatJid: SPAM, spam: true });
  });

  it('blocks without marking spam when not asked', async () => {
    await incoming(SPAM, { text: 'hello' });
    const r = await chatAct(SPAM, 'block', admin.cookie);
    expect(SafetyChatState.parse(r.json())).toMatchObject({
      scam: false,
      blocked: { auto: false },
    });
  });

  it('is for admins only, and refuses a group or an unknown chat', async () => {
    await incoming(SPAM, { text: 'hello' });
    expect((await chatAct(SPAM, 'block', agent.cookie)).statusCode).toBe(403);
    expect(t.wa.blocked.has(SPAM)).toBe(false);
    expect((await chatAct(SPAM, 'mute', admin.cookie)).statusCode).toBe(400);
    expect((await chatAct('60100000000@s.whatsapp.net', 'block', admin.cookie)).statusCode).toBe(
      404,
    );
    t.ctx.db
      .prepare(
        "INSERT INTO chats (jid, wa_jid, type, name, inbox_id, status, updated_at) VALUES ('1203@g.us', '1203@g.us', 'group', 'Team', 1, 'open', 0)",
      )
      .run();
    const group = await chatAct('1203@g.us', 'block', admin.cookie);
    expect(group.statusCode).toBe(409);
  });
});

describe('Block any chat: per inbox and the flagged items', () => {
  const X = '60177000111@s.whatsapp.net';
  const chatAct = (jid: string, action: string, payload: object = {}) =>
    t.app.inject({
      method: 'POST',
      url: `/api/safety/chats/${encodeURIComponent(jid)}/${action}`,
      headers: authHeaders(admin.cookie),
      payload,
    });
  const bar = async (jid: string) =>
    SafetyChatState.parse(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/safety/chats/${encodeURIComponent(jid)}`,
          headers: authHeaders(admin.cookie),
        })
      ).json(),
    );

  it('a block on one inbox is not a block of the same customer on another inbox', async () => {
    await incoming(X, { text: 'hello sales' });
    // The same customer also writes to inbox 2 (chat key `<waJid>#2`).
    t.ctx.db
      .prepare(
        "INSERT INTO inboxes (id, name, tone, auth_dir, created_at, removed_at) VALUES (2, 'Support', 'info', 'x', 0, NULL)",
      )
      .run();
    t.ctx.db
      .prepare(
        "INSERT INTO chats (jid, wa_jid, type, name, inbox_id, status, updated_at) VALUES (?, ?, 'dm', 'X', 2, 'open', 0)",
      )
      .run(`${X}#2`, X);
    expect((await chatAct(X, 'block')).statusCode).toBe(200);

    const safety = t.ctx.services.safety!;
    expect(safety.isBlocked(X, 1)).toBe(true);
    expect(safety.isBlocked(X, 2)).toBe(false);
    // The other inbox's chat is not shown as blocked, cannot unblock it, and cannot block again
    // until the block on inbox 1 is undone.
    expect(await bar(`${X}#2`)).toMatchObject({ blocked: null, canBlock: false });
    expect((await chatAct(`${X}#2`, 'unblock')).statusCode).toBe(409);
    expect(t.wa.blocked.has(X)).toBe(true);
  });

  it('an older block with no inbox still counts for every inbox', () => {
    t.ctx.db
      .prepare(
        'INSERT INTO safety_numbers (wa_jid, blocked_at, blocked_inbox_id) VALUES (?, 1, NULL)',
      )
      .run(X);
    expect(t.ctx.services.safety!.isBlocked(X, 1)).toBe(true);
    expect(t.ctx.services.safety!.isBlocked(X, 2)).toBe(true);
  });

  it('blocking and unblocking from the chat moves its flagged item like Admin → Safety does', async () => {
    await incoming(X, { text: LURE_TEXT, file: lureZip() });
    const item = (await state()).items[0]!;
    expect(item.status).toBe('open');

    await chatAct(X, 'block', { spam: true });
    expect((await state()).items[0]).toMatchObject({ status: 'blocked', blocked: true });

    await chatAct(X, 'unblock');
    // Marked as spam: back to Reported, like Unblock in Admin → Safety.
    expect((await state()).items[0]).toMatchObject({ status: 'reported', blocked: false });
  });
});
