// Inbox connection types (docs/features/business-api/implementation.md, Lite server 2–5, 12): the
// adapter factory dispatches on `inboxes.type`, an unknown type never crashes, a type change swaps
// the adapter and keeps the inbox's chats, and the dev-only `fake-api` type.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxListResponse, type Inbox } from '@ezychat/shared';
import { FakeWaAdapter, WaUnavailableError, type WaCapabilities } from '@ezychat/wa';
import type { ServerConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import type { ServerExtension } from '../src/extensions.js';
import { FAKE_API_TYPE } from '../src/inboxes/fake-api.js';
import { InboxRepo } from '../src/inboxes/repo.js';
import { getInboxService, type InboxActor } from '../src/inboxes/service.js';
import { UnavailableTypeAdapter } from '../src/inboxes/types.js';
import { silentLogger } from '../src/logger.js';
import { createContext } from '../src/main.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

const enc = encodeURIComponent;
const C = '60123456789@s.whatsapp.net';
const CLOUD_CAPS: WaCapabilities = {
  qrLink: false,
  history: false,
  groups: false,
  replyWindowHours: 24,
  templates: false,
  needsPublicUrl: true,
};

/** An extension type `cloudy` that records what the core asks of it. */
function cloudyExtension() {
  const built: Array<{ inboxId: number; wa: FakeWaAdapter }> = [];
  const detached: number[] = [];
  let failCreate = false;
  const ext: ServerExtension = {
    name: 'cloudy',
    inboxTypes: [
      {
        id: 'cloudy',
        async createAdapter(_ctx, row) {
          if (failCreate) throw new Error('no credentials');
          const wa = new FakeWaAdapter({
            me: { jid: `6100000000${row.id}@s.whatsapp.net`, name: row.name },
            idPrefix: `CLOUDY${row.id}`,
            capabilities: CLOUD_CAPS,
          });
          built.push({ inboxId: row.id, wa });
          return wa;
        },
        async detach(_ctx, inboxId) {
          detached.push(inboxId);
        },
      },
    ],
  };
  return {
    ext,
    built,
    detached,
    failNextCreate: (v: boolean) => {
      failCreate = v;
    },
  };
}

let t: TestApp | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await t?.close();
  t = null;
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function setup(opts: { maxInboxes?: number; extensions?: ServerExtension[] } = {}) {
  t = await makeTestApp({ maxInboxes: opts.maxInboxes ?? 3, extensions: opts.extensions });
  const admin = await createUserAndLogin(t, { role: 'admin' });
  const actor: InboxActor = { userId: admin.user.id, ip: null };
  return { t, admin, actor, inboxes: getInboxService(t.ctx) };
}

const listInboxes = async (cookie: string): Promise<Inbox[]> =>
  InboxListResponse.parse(
    (
      await t!.app.inject({ method: 'GET', url: '/api/inboxes', headers: authHeaders(cookie) })
    ).json(),
  ).inboxes;

const audits = (action: string) =>
  (
    t!.ctx.db
      .prepare('SELECT user_id AS userId, meta FROM audit_log WHERE action = ? ORDER BY id')
      .all(action) as Array<{ userId: number; meta: string }>
  ).map((r) => ({ userId: r.userId, meta: JSON.parse(r.meta) as unknown }));

async function inbound(inboxId: number, id: string, timestamp = Date.now()) {
  return getMessages(t!.ctx).ingest(
    {
      id,
      chatJid: C,
      chatJidAlt: null,
      senderJid: C,
      senderJidAlt: null,
      senderName: 'Aminah',
      fromMe: false,
      type: 'text',
      body: `hello ${id}`,
      quotedId: null,
      timestamp,
      media: null,
    },
    'live',
    inboxId,
  );
}

async function waitFor(fn: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function devConfig(dataDir: string): ServerConfig {
  return {
    dataDir,
    port: 0,
    host: '127.0.0.1',
    mode: 'dev',
    fakeWa: true,
    webDistDir: null,
    version: '0.0.0-test',
  };
}

/** A data dir whose inboxes already carry these types (inbox 1 first). */
function seededDir(types: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'wati-types-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'app.db'));
  const repo = new InboxRepo(db);
  repo.setType(1, types[0]!);
  for (const type of types.slice(1)) repo.insert('Old', repo.nextTone(), Date.now(), type);
  db.close();
  return dir;
}

describe('adapter factory by inbox type', () => {
  it('builds an extension-type inbox with its type and lists its type and capabilities', async () => {
    const cloudy = cloudyExtension();
    const { admin, actor, inboxes } = await setup({ extensions: [cloudy.ext] });
    let builtWhenStored = -1;
    const created = await inboxes.create({ name: 'Cloud', memberIds: [] }, actor, {
      type: 'cloudy',
      beforeConnect: (row) => {
        // runs with the row stored and before the adapter exists
        expect(row).toMatchObject({ name: 'Cloud', type: 'cloudy' });
        builtWhenStored = cloudy.built.length;
      },
    });
    expect(builtWhenStored).toBe(0);
    expect(cloudy.built.map((b) => b.inboxId)).toEqual([created.id]);
    expect(created).toMatchObject({ type: 'cloudy', capabilities: CLOUD_CAPS });
    // the server already started: the new adapter connects at once
    expect(t!.ctx.inboxes.connections.adapter(created.id)).toBe(cloudy.built[0]!.wa);
    expect(cloudy.built[0]!.wa.status.state).toBe('open');
    expect(audits('inbox.create').at(-1)?.meta).toMatchObject({
      inboxId: created.id,
      type: 'cloudy',
    });

    const listed = await listInboxes(admin.cookie);
    expect(listed.map((i) => [i.id, i.type, i.capabilities.qrLink])).toEqual([
      [1, 'linked_phone', true],
      [created.id, 'cloudy', false],
    ]);
    expect(listed[0]!.capabilities).toEqual({
      qrLink: true,
      history: true,
      groups: true,
      replyWindowHours: null,
      templates: false,
      needsPublicUrl: false,
      // a linked phone tags group members; an extension type that does not say so cannot
      mentions: true,
      // a linked phone edits and deletes (an extension type reports what it can)
      editMessage: true,
      deleteForEveryone: true,
      deleteForMe: true,
    });
    expect(listed[1]!.capabilities.mentions).toBe(false);
    expect(listed[1]!.capabilities.editMessage).toBeUndefined();
  });

  it('refuses a type no extension registered (400 unknown_inbox_type) and creates nothing', async () => {
    const { actor, inboxes } = await setup();
    await expect(
      inboxes.create({ name: 'X', memberIds: [] }, actor, { type: 'wa-cloud' }),
    ).rejects.toMatchObject({ status: 400, code: 'unknown_inbox_type' });
    expect(t!.ctx.inboxes.repo.list()).toHaveLength(1);
  });

  it('a failing beforeConnect leaves no active inbox and no adapter', async () => {
    const cloudy = cloudyExtension();
    const { actor, inboxes } = await setup({ extensions: [cloudy.ext] });
    await expect(
      inboxes.create({ name: 'Cloud', memberIds: [] }, actor, {
        type: 'cloudy',
        beforeConnect: () => {
          throw new Error('bad credentials');
        },
      }),
    ).rejects.toThrow('bad credentials');
    expect(cloudy.built).toHaveLength(0);
    expect(t!.ctx.inboxes.repo.active().map((r) => r.id)).toEqual([1]);
    expect(t!.ctx.inboxes.repo.get(2)?.removed_at).not.toBeNull();
    expect(audits('inbox.create')).toEqual([]);
    // the limit counts active inboxes only: a new inbox can still be added
    const ok = await inboxes.create({ name: 'Phone', memberIds: [] }, actor);
    expect(ok).toMatchObject({ id: 3, type: 'linked_phone' });
  });

  it('builds inbox 1 through the same dispatch when no adapter is given', async () => {
    const cloudy = cloudyExtension();
    const dir = seededDir(['cloudy']);
    const ctx = await createContext(devConfig(dir), {
      log: silentLogger(),
      extensions: [cloudy.ext],
    });
    try {
      expect(cloudy.built.map((b) => b.inboxId)).toEqual([1]);
      expect(ctx.wa).toBe(cloudy.built[0]!.wa);
      expect(ctx.inboxes.connections.adapter(1)).toBe(ctx.wa);
    } finally {
      ctx.db.close();
    }
  });

  it('an inbox type this edition lacks starts logged out with a reason, never a crash', async () => {
    const dir = seededDir(['wa-cloud']);
    const ctx = await createContext(devConfig(dir), { log: silentLogger() });
    try {
      expect(ctx.wa).toBeInstanceOf(UnavailableTypeAdapter);
      expect(ctx.wa.status).toEqual({
        state: 'logged_out',
        me: null,
        qr: null,
        lastError: 'inbox type wa-cloud is not available in this edition',
      });
      await ctx.wa.connect();
      await ctx.wa.disconnect();
      await ctx.wa.logout();
      await ctx.wa.takeover();
      await ctx.wa.markRead(C, ['x']);
      await ctx.wa.sendPresence(C, 'composing');
      expect(await ctx.wa.downloadMedia('x')).toBeNull();
      expect(await ctx.wa.getContactAliases([C])).toEqual([]);
      expect(ctx.wa.status.state).toBe('logged_out');
      for (const call of [
        () => ctx.wa.sendText(C, 'hi'),
        () => ctx.wa.sendMedia(C, { buffer: Buffer.from('x'), mime: 'text/plain', fileName: 'a' }),
        () => ctx.wa.sendReaction(C, { id: 'x', fromMe: false, participant: null }, '👍'),
        () => ctx.wa.requestPairingCode('60123'),
        () => ctx.wa.getProfilePicture(C),
        () => ctx.wa.getGroupInfo('1@g.us'),
        () => ctx.wa.getAbout(C),
        () => ctx.wa.checkNumber('60123456789'),
      ])
        await expect(call()).rejects.toBeInstanceOf(WaUnavailableError);
    } finally {
      ctx.db.close();
    }
  });

  it('lists another inbox of a missing type as logged out and refuses its QR actions', async () => {
    const dir = seededDir(['linked_phone', 'wa-cloud']);
    t = await makeTestApp({ maxInboxes: 2, config: { dataDir: dir } });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const [, second] = await listInboxes(admin.cookie);
    expect(second).toMatchObject({
      id: 2,
      type: 'wa-cloud',
      status: {
        state: 'logged_out',
        lastError: 'inbox type wa-cloud is not available in this edition',
      },
      capabilities: { qrLink: false, replyWindowHours: null },
    });
    const relink = await t.app.inject({
      method: 'POST',
      url: '/api/inboxes/2/wa/relink',
      headers: authHeaders(admin.cookie),
    });
    expect(relink.statusCode).toBe(409);
    expect(relink.json().error.code).toBe('not_linked_phone');
  });
});

describe('changing an inbox type', () => {
  it('switches a linked phone to another type: logs the phone out, keeps chats and keys', async () => {
    const cloudy = cloudyExtension();
    const { admin, actor, inboxes } = await setup({ extensions: [cloudy.ext] });
    const id = await t!.addInbox('Shop');
    const phone = t!.inboxWa(id);
    await inbound(id, 'before');
    const key = `${C}#${id}`;
    getChats(t!.ctx).patch(key, { assignedTo: admin.user.id }, admin.user.id);
    const logout = vi.spyOn(phone, 'logout');
    let changes = 0;
    t!.ctx.bus.on('inboxes:changed', () => changes++);
    const events: string[] = [];
    t!.ctx.inboxes.connections.on('removed', (i, _wa, reason) =>
      events.push(`removed:${i}:${reason}`),
    );
    t!.ctx.inboxes.connections.on('added', (i) => events.push(`added:${i}`));

    const changed = await inboxes.changeType(id, 'cloudy', actor);
    expect(changed).toMatchObject({ id, type: 'cloudy', capabilities: CLOUD_CAPS });
    expect(logout).toHaveBeenCalledTimes(1);
    expect(cloudy.detached).toEqual([]);
    expect(events).toEqual([`removed:${id}:replaced`, `added:${id}`]);
    expect(changes).toBe(1);
    const api = cloudy.built[0]!.wa;
    expect(t!.ctx.inboxes.connections.adapter(id)).toBe(api);
    expect(api.status.state).toBe('open');
    expect(audits('inbox.type_change')).toEqual([
      { userId: admin.user.id, meta: { inboxId: id, from: 'linked_phone', to: 'cloudy' } },
    ]);
    // the chat, its key and its owner stay; new messages arrive through the new adapter
    expect(getChats(t!.ctx).get(key)).toMatchObject({ assignedTo: admin.user.id, inboxId: id });
    api.simulateIncoming({ chatJid: C, body: 'after the switch' });
    await waitFor(
      () =>
        (
          t!.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?').get(key) as {
            n: number;
          }
        ).n === 2,
    );
    const sent = await t!.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(key)}/messages`,
      headers: authHeaders(admin.cookie),
      payload: { text: 'Hello again', clientId: 'switch-1' },
    });
    expect(sent.statusCode).toBe(201);
    await waitFor(() => api.sent.some((s) => s.text === 'Hello again'));
    expect(phone.sent).toHaveLength(0);
  });

  it('switches back to a linked phone: disconnects, detaches the old type, waits for the phone', async () => {
    const cloudy = cloudyExtension();
    const { actor, inboxes } = await setup({ extensions: [cloudy.ext] });
    const created = await inboxes.create({ name: 'Cloud', memberIds: [] }, actor, {
      type: 'cloudy',
    });
    const api = cloudy.built[0]!.wa;
    const disconnect = vi.spyOn(api, 'disconnect');
    const logout = vi.spyOn(api, 'logout');
    const back = await inboxes.changeType(created.id, 'linked_phone', actor);
    expect(back).toMatchObject({ type: 'linked_phone', capabilities: { qrLink: true } });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
    expect(cloudy.detached).toEqual([created.id]);
    expect(t!.ctx.inboxes.connections.adapter(created.id)).toBeInstanceOf(FakeWaAdapter);
    expect(t!.ctx.inboxes.connections.adapter(created.id)).not.toBe(api);
    expect(t!.ctx.inboxes.repo.get(created.id)?.type).toBe('linked_phone');
  });

  it('works for inbox 1: ctx.wa follows the new adapter and the QR routes answer not_linked_phone', async () => {
    const cloudy = cloudyExtension();
    const { admin, actor, inboxes } = await setup({ extensions: [cloudy.ext] });
    const logout = vi.spyOn(t!.wa, 'logout');
    await inboxes.changeType(1, 'cloudy', actor);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(t!.ctx.wa).toBe(cloudy.built[0]!.wa);
    for (const url of [
      '/api/wa/relink',
      '/api/wa/logout',
      '/api/wa/takeover',
      '/api/inboxes/1/wa/relink',
    ]) {
      const res = await t!.app.inject({ method: 'POST', url, headers: authHeaders(admin.cookie) });
      expect(res.statusCode, url).toBe(409);
      expect(res.json().error.code).toBe('not_linked_phone');
    }
    const pairing = await t!.app.inject({
      method: 'POST',
      url: '/api/inboxes/1/wa/pairing-code',
      headers: authHeaders(admin.cookie),
      payload: { phone: '60123456789' },
    });
    expect(pairing.json().error.code).toBe('not_linked_phone');
    // the bridge follows: inbox 1's status reports the new connection
    expect(t!.ctx.services.waStatus?.me?.jid).toBe('61000000001@s.whatsapp.net');
  });

  it('the same type is a no-op; a removed inbox and an unknown type are refused', async () => {
    const cloudy = cloudyExtension();
    const { actor, inboxes } = await setup({ extensions: [cloudy.ext] });
    const same = await inboxes.changeType(1, 'linked_phone', actor);
    expect(same.type).toBe('linked_phone');
    expect(audits('inbox.type_change')).toEqual([]);
    await expect(inboxes.changeType(1, 'nope', actor)).rejects.toMatchObject({
      status: 400,
      code: 'unknown_inbox_type',
    });
    const id = await t!.addInbox('Gone');
    await inboxes.remove(id, actor);
    await expect(inboxes.changeType(id, 'cloudy', actor)).rejects.toMatchObject({
      status: 409,
      code: 'inbox_removed',
    });
    await expect(inboxes.changeType(99, 'cloudy', actor)).rejects.toMatchObject({ status: 404 });
  });

  it('a failing beforeConnect or adapter keeps the old type and the old adapter', async () => {
    const cloudy = cloudyExtension();
    const { actor, inboxes } = await setup({ extensions: [cloudy.ext] });
    const id = await t!.addInbox('Shop');
    const phone = t!.inboxWa(id);
    const logout = vi.spyOn(phone, 'logout');
    let seen: string | null = null;
    await expect(
      inboxes.changeType(id, 'cloudy', actor, {
        beforeConnect: (row) => {
          seen = row.type;
          throw new Error('bad token');
        },
      }),
    ).rejects.toThrow('bad token');
    expect(seen).toBe('cloudy');
    cloudy.failNextCreate(true);
    await expect(inboxes.changeType(id, 'cloudy', actor)).rejects.toThrow('no credentials');
    expect(t!.ctx.inboxes.repo.get(id)?.type).toBe('linked_phone');
    expect(t!.ctx.inboxes.connections.adapter(id)).toBe(phone);
    expect(logout).not.toHaveBeenCalled();
    expect(phone.status.state).toBe('open');
    expect(audits('inbox.type_change')).toEqual([]);
  });

  it('removing an inbox of another type disconnects it and calls the type detach', async () => {
    const cloudy = cloudyExtension();
    const { actor, inboxes } = await setup({ extensions: [cloudy.ext] });
    const created = await inboxes.create({ name: 'Cloud', memberIds: [] }, actor, {
      type: 'cloudy',
    });
    const api = cloudy.built[0]!.wa;
    const logout = vi.spyOn(api, 'logout');
    await inboxes.remove(created.id, actor);
    expect(logout).not.toHaveBeenCalled();
    expect(api.status.state).toBe('disconnected');
    expect(cloudy.detached).toEqual([created.id]);
  });
});

describe('dev fake Business API inbox', () => {
  it('POST /api/dev/fake-api-inbox adds a fake-api inbox within the limit', async () => {
    const { admin } = await setup({ maxInboxes: 2 });
    const add = () =>
      t!.app.inject({
        method: 'POST',
        url: '/api/dev/fake-api-inbox',
        headers: authHeaders(admin.cookie),
        payload: { name: 'Business API' },
      });
    const res = await add();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 2,
      type: FAKE_API_TYPE,
      number: '60000000002',
      capabilities: {
        qrLink: false,
        history: false,
        groups: false,
        replyWindowHours: 24,
        templates: true,
        needsPublicUrl: true,
      },
    });
    const again = await add();
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('inbox_limit');
    const agent = await createUserAndLogin(t!, { role: 'agent' });
    const refused = await t!.app.inject({
      method: 'POST',
      url: '/api/dev/fake-api-inbox',
      headers: authHeaders(agent.cookie),
      payload: { name: 'x' },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('POST /api/dev/fake-window moves the last customer message of a chat', async () => {
    const { admin } = await setup();
    await inbound(1, 'w1');
    const updates: Array<number | null> = [];
    t!.ctx.bus.on('chat:updated', (c) => updates.push(c.lastInboundAt));
    const before = Date.now();
    const res = await t!.app.inject({
      method: 'POST',
      url: '/api/dev/fake-window',
      headers: authHeaders(admin.cookie),
      payload: { chatJid: C, hoursAgo: 25 },
    });
    expect(res.statusCode).toBe(200);
    const at = res.json().lastInboundAt as number;
    expect(at).toBeLessThanOrEqual(before - 25 * 3_600_000 + 1000);
    expect(getChats(t!.ctx).get(C)?.lastInboundAt).toBe(at);
    expect(updates).toEqual([at]);
    const missing = await t!.app.inject({
      method: 'POST',
      url: '/api/dev/fake-window',
      headers: authHeaders(admin.cookie),
      payload: { chatJid: '60999@s.whatsapp.net', hoursAgo: 1 },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('is never registered outside --mode dev', async () => {
    t = await makeTestApp({ maxInboxes: 2, config: { mode: 'standalone' } });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    for (const url of ['/api/dev/fake-api-inbox', '/api/dev/fake-window']) {
      const res = await t.app.inject({
        method: 'POST',
        url,
        headers: authHeaders(admin.cookie),
        payload: { name: 'x', chatJid: C, hoursAgo: 1 },
      });
      expect(res.statusCode, url).toBe(404);
    }
    await expect(
      getInboxService(t.ctx).create(
        { name: 'x', memberIds: [] },
        { userId: admin.user.id, ip: null },
        {
          type: FAKE_API_TYPE,
        },
      ),
    ).rejects.toMatchObject({ code: 'unknown_inbox_type' });
  });
});
