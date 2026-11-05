import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WaIncomingMessage } from '@ezychat/wa';
import { makeTestApp, type TestApp } from './helpers.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';

let t: TestApp | null = null;

afterEach(async () => {
  await t?.close();
  t = null;
});

describe('settings', () => {
  it('agent gets 403, admin gets settings', async () => {
    t = await makeTestApp();
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const r1 = await t.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: authHeaders(agent.cookie),
    });
    expect(r1.statusCode).toBe(403);
    const r2 = await t.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: authHeaders(admin.cookie),
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({
      port: 7420,
      lanEnabled: false,
      historyDays: 3,
      namedTunnelHostname: null,
      hasTunnelToken: false,
      usageStats: true,
    });
  });

  it('patch historyDays persists without restart, port change requires restart, and is audited', async () => {
    t = await makeTestApp();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const h = authHeaders(admin.cookie);
    const r1 = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: h,
      payload: { historyDays: 7 },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ settings: { historyDays: 7 }, restartRequired: false });
    expect(t.ctx.settings.get('history_days', 0)).toBe(7);

    const r2 = await t.app.inject({ method: 'GET', url: '/api/settings', headers: h });
    expect(r2.json().historyDays).toBe(7);

    const r3 = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: h,
      payload: { port: 8123, lanEnabled: true },
    });
    expect(r3.json()).toMatchObject({
      settings: { port: 8123, lanEnabled: true },
      restartRequired: true,
    });
    expect(t.ctx.settings.get('port', 0)).toBe(8123);
    expect(t.ctx.settings.get('lan_enabled', false)).toBe(true);

    const bad = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: h,
      payload: { port: 80 },
    });
    expect(bad.statusCode).toBe(400);

    const audit = await t.app.inject({ method: 'GET', url: '/api/audit?limit=10', headers: h });
    expect(audit.statusCode).toBe(200);
    const entries = audit.json().entries as Array<{
      action: string;
      userId: number | null;
      id: number;
    }>;
    expect(entries.filter((e) => e.action === 'settings.update')).toHaveLength(2);
    expect(entries[0]!.action).toBe('settings.update');
    // newest first, `before` paginates by id
    const older = await t.app.inject({
      method: 'GET',
      url: `/api/audit?limit=10&before=${entries[0]!.id}`,
      headers: h,
    });
    expect(older.json().entries.every((e: { id: number }) => e.id < entries[0]!.id)).toBe(true);
  });

  it('names the access token behind an AI assistant change, revoked tokens included', async () => {
    t = await makeTestApp();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const tokenId = Number(
      t.ctx.db
        .prepare(
          `INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at, revoked_at)
           VALUES (?, 'Claude Desktop', 'hash', 'ezc_pat_ab12', 1, 2)`,
        )
        .run(admin.user.id).lastInsertRowid,
    );
    const insert = t.ctx.db.prepare(
      "INSERT INTO audit_log (user_id, action, ip, meta, at) VALUES (?, 'ai.member_update', NULL, ?, 3)",
    );
    insert.run(admin.user.id, JSON.stringify({ via: 'mcp', tokenId, reason: 'narrow rule 4' }));
    insert.run(admin.user.id, JSON.stringify({ instructionsChanged: true }));
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/audit?limit=2',
      headers: authHeaders(admin.cookie),
    });
    const [app, mcp] = r.json().entries as Array<{ apiToken: unknown }>;
    expect(app!.apiToken).toBeNull();
    expect(mcp!.apiToken).toEqual({ name: 'Claude Desktop', prefix: 'ezc_pat_ab12' });
  });

  it('audit is admin only', async () => {
    t = await makeTestApp();
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeaders(agent.cookie),
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('logs download', () => {
  it('returns a zip for admins', async () => {
    t = await makeTestApp();
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const agent = await createUserAndLogin(t, { role: 'agent' });
    mkdirSync(join(t.ctx.config.dataDir, 'logs'), { recursive: true });
    writeFileSync(join(t.ctx.config.dataDir, 'logs', 'server.1.log'), '{"msg":"hello"}\n');
    const denied = await t.app.inject({
      method: 'GET',
      url: '/api/logs/download',
      headers: authHeaders(agent.cookie),
    });
    expect(denied.statusCode).toBe(403);
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/logs/download',
      headers: authHeaders(admin.cookie),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(String(r.headers['content-disposition'])).toMatch(
      /^attachment; filename="wa-team-inbox-logs-\d{8}\.zip"$/,
    );
    const buf = r.rawPayload;
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    expect(buf.includes(Buffer.from('server.1.log'))).toBe(true);
  });
});

describe('wa control', () => {
  it('agent sees qr null while admin sees qr', async () => {
    t = await makeTestApp();
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    t.wa.simulateStatus({ state: 'qr', qr: 'abc' });
    const ra = await t.app.inject({
      method: 'GET',
      url: '/api/wa/status',
      headers: authHeaders(agent.cookie),
    });
    expect(ra.statusCode).toBe(200);
    expect(ra.json()).toMatchObject({ state: 'qr', qr: null });
    const rb = await t.app.inject({
      method: 'GET',
      url: '/api/wa/status',
      headers: authHeaders(admin.cookie),
    });
    expect(rb.json()).toMatchObject({ state: 'qr', qr: 'abc' });
    const anon = await t.app.inject({ method: 'GET', url: '/api/wa/status' });
    expect(anon.statusCode).toBe(401);
  });

  it('logout / relink / takeover are admin-only and audited', async () => {
    t = await makeTestApp();
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const denied = await t.app.inject({
      method: 'POST',
      url: '/api/wa/logout',
      headers: authHeaders(agent.cookie),
    });
    expect(denied.statusCode).toBe(403);

    const h = authHeaders(admin.cookie);
    const r1 = await t.app.inject({ method: 'POST', url: '/api/wa/logout', headers: h });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().state).toBe('logged_out');
    expect(t.wa.status.state).toBe('logged_out');

    const r2 = await t.app.inject({ method: 'POST', url: '/api/wa/relink', headers: h });
    expect(r2.statusCode).toBe(200);
    expect(t.wa.status.state).toBe('open');

    t.wa.simulateStatus({ state: 'replaced' });
    const r3 = await t.app.inject({ method: 'POST', url: '/api/wa/takeover', headers: h });
    expect(r3.statusCode).toBe(200);
    expect(t.wa.status.state).toBe('open');

    const actions = (
      t.ctx.db.prepare('SELECT action FROM audit_log ORDER BY id').all() as Array<{
        action: string;
      }>
    ).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['wa.logout', 'wa.relink', 'wa.takeover']));
  });

  it('pairing code: admin-only, returns the code, rejects when already linked', async () => {
    t = await makeTestApp();
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const body = { phone: '+60 12-345 6789' };
    const denied = await t.app.inject({
      method: 'POST',
      url: '/api/wa/pairing-code',
      headers: authHeaders(agent.cookie),
      payload: body,
    });
    expect(denied.statusCode).toBe(403);

    const h = authHeaders(admin.cookie);
    t.wa.simulateStatus({ state: 'qr', qr: 'abc' });
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/wa/pairing-code',
      headers: h,
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ code: 'FAKE1234' });
    expect(t.wa.pairingRequests).toEqual(['60123456789']);

    t.wa.simulateStatus({ state: 'open' });
    const linked = await t.app.inject({
      method: 'POST',
      url: '/api/wa/pairing-code',
      headers: h,
      payload: body,
    });
    expect(linked.statusCode).toBe(400);

    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/wa/pairing-code',
      headers: h,
      payload: { phone: '1' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('dev fake-incoming', () => {
  it('requires login and emits an incoming message on the fake adapter', async () => {
    t = await makeTestApp();
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const anon = await t.app.inject({
      method: 'POST',
      url: '/api/dev/fake-incoming',
      payload: { chatJid: '60123456789@s.whatsapp.net', text: 'hi' },
    });
    expect(anon.statusCode).toBe(401);

    const seen: WaIncomingMessage[] = [];
    t.wa.on('message', (m) => seen.push(m));
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/dev/fake-incoming',
      headers: authHeaders(agent.cookie),
      payload: { chatJid: '60123456789@s.whatsapp.net', text: 'hello there', senderName: 'Alice' },
    });
    expect(r.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      chatJid: '60123456789@s.whatsapp.net',
      body: 'hello there',
      senderName: 'Alice',
    });
    expect(r.json().id).toBe(seen[0]!.id);

    // Once Task 7 (messages service + WA bridge) is present, the chat must be listed.
    if (t.ctx.services.messages) {
      const chats = await t.app.inject({
        method: 'GET',
        url: '/api/chats',
        headers: authHeaders(agent.cookie),
      });
      expect(chats.statusCode).toBe(200);
      const jids = (chats.json().chats as Array<{ jid: string }>).map((c) => c.jid);
      expect(jids).toContain('60123456789@s.whatsapp.net');
    }
  });

  it('accepts chatJidAlt and reports the routed chat', async () => {
    t = await makeTestApp();
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/dev/fake-incoming',
      headers: authHeaders(agent.cookie),
      payload: { chatJid: '60123456789@s.whatsapp.net', chatJidAlt: '123456789@lid', text: 'hi' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().chatJid).toBe('123456789@lid');
  });

  it('attaches simulated media (e.g. a voice note) that the adapter serves as the download', async () => {
    t = await makeTestApp();
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const seen: WaIncomingMessage[] = [];
    t.wa.on('message', (m) => seen.push(m));
    const audio = Buffer.from('OggS fake voice bytes');
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/dev/fake-incoming',
      headers: authHeaders(agent.cookie),
      payload: {
        chatJid: '60123456789@s.whatsapp.net',
        text: '',
        type: 'audio',
        media: { mime: 'audio/ogg; codecs=opus', base64: audio.toString('base64') },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(seen[0]).toMatchObject({ type: 'audio', media: { mime: 'audio/ogg; codecs=opus' } });
    expect(await seen[0]!.media!.download()).toEqual(audio);
  });

  it('is absent when fakeWa is false', async () => {
    t = await makeTestApp({ config: { fakeWa: false } });
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/dev/fake-incoming',
      headers: authHeaders(agent.cookie),
      payload: { chatJid: '60123456789@s.whatsapp.net', text: 'hi' },
    });
    expect(r.statusCode).toBe(404);
  });
});
