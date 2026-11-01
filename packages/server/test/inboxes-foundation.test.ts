import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeWaAdapter, type WaAdapter } from '@ezychat/wa';
import type { User } from '@ezychat/shared';
import { parseArgs, type ServerConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { canOpen, scopeFor, scopeIds, usersWhoCanOpen } from '../src/inboxes/access.js';
import { InboxConnections } from '../src/inboxes/connections.js';
import { InboxRepo } from '../src/inboxes/repo.js';
import { silentLogger } from '../src/logger.js';
import { createContext } from '../src/main.js';
import { makeTestApp, type TestApp } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wati-inboxes-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function devConfig(dataDir: string, extra?: Partial<ServerConfig>): ServerConfig {
  return {
    dataDir,
    port: 0,
    host: '127.0.0.1',
    mode: 'dev',
    fakeWa: true,
    webDistDir: null,
    version: 'test',
    ...extra,
  };
}

async function app(opts?: Parameters<typeof makeTestApp>[0]): Promise<TestApp> {
  const t = await makeTestApp(opts);
  cleanups.push(() => t.close());
  return t;
}

function addUser(t: TestApp, role: 'admin' | 'agent', name: string): User {
  return t.ctx.services.auth!.createUser({
    username: name,
    displayName: name,
    role,
    password: 'password123',
    mustChangePassword: false,
  });
}

describe('inbox foundation', () => {
  it('upgrades an existing data dir to one inbox (RF-5)', async () => {
    const dir = tempDir();
    // a data dir as Lite left it: schema 13, two chats, a linked WhatsApp session
    const old = new Database(join(dir, 'app.db'));
    migrate(old, 13);
    old.exec(
      "INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('agent1', 'A', 'x', 'agent', 1)",
    );
    old.exec(
      "INSERT INTO chats (jid, type, updated_at) VALUES ('6012@s.whatsapp.net', 'dm', 1), ('1-2@g.us', 'group', 2)",
    );
    old.close();
    mkdirSync(join(dir, 'wa-auth'));
    const creds = Buffer.from('{"me":{"id":"6011@s.whatsapp.net"},"noiseKey":"k"}');
    writeFileSync(join(dir, 'wa-auth', 'creds.json'), creds);

    const ctx = await createContext(devConfig(dir), {
      wa: new FakeWaAdapter(),
      log: silentLogger(),
    });
    cleanups.push(() => void ctx.db.close());

    expect(ctx.db.prepare('SELECT * FROM inboxes').all()).toEqual([
      {
        id: 1,
        name: 'WhatsApp',
        tone: 'primary',
        auth_dir: 'wa-auth',
        own_jid: null,
        type: 'linked_phone',
        created_at: expect.any(Number),
        removed_at: null,
      },
    ]);
    expect(ctx.db.prepare('SELECT jid, inbox_id, wa_jid FROM chats ORDER BY jid').all()).toEqual([
      { jid: '1-2@g.us', inbox_id: 1, wa_jid: '1-2@g.us' },
      { jid: '6012@s.whatsapp.net', inbox_id: 1, wa_jid: '6012@s.whatsapp.net' },
    ]);
    // existing agents keep the inbox they could open before
    expect(ctx.inboxes.repo.members(1)).toEqual([1]);
    expect(readFileSync(join(dir, 'wa-auth', 'creds.json')).equals(creds)).toBe(true);
    expect(readdirSync(join(dir, 'wa-auth'))).toEqual(['creds.json']);
    expect(existsSync(join(dir, 'wa-auth-inboxes'))).toBe(false);
    expect(ctx.wa).toBe(ctx.inboxes.connections.adapter(1));
  }, 20_000);

  it('Lite refuses a second inbox', async () => {
    const t = await app();
    expect(t.ctx.inboxes.connections.maxInboxes()).toBe(1);
    expect(t.ctx.inboxes.repo.active().map((r) => r.id)).toEqual([1]);
    expect(t.inboxWa(1)).toBe(t.wa);
    expect(t.ctx.wa).toBe(t.wa);
    await expect(t.addInbox('Second')).rejects.toThrow(/inbox_limit/);
  });

  it('each inbox gets its own adapter and folder', async () => {
    const t = await app({ maxInboxes: 3, inboxes: 2 });
    const { repo, connections } = t.ctx.inboxes;
    expect(connections.maxInboxes()).toBe(3);
    expect(t.inboxWa(2)).not.toBe(t.inboxWa(1));
    expect(t.inboxWa(2).status.state).toBe('open');
    expect(t.inboxWa(2).status.me!.jid).not.toBe(t.inboxWa(1).status.me!.jid);
    expect(repo.get(2)).toMatchObject({ auth_dir: 'wa-auth-inboxes/2', tone: 'warning' });
    expect(connections.forChatKey('6012@s.whatsapp.net#2')).toBe(t.inboxWa(2));
    expect(connections.forChatKey('6012@s.whatsapp.net')).toBe(t.inboxWa(1));
    expect([...connections.statuses().keys()]).toEqual([1, 2]);
    expect(connections.ownJids()).toEqual(
      new Set([t.inboxWa(1).status.me!.jid, t.inboxWa(2).status.me!.jid]),
    );

    const id = await t.addInbox('Third', []);
    expect(id).toBe(3);
    expect(repo.get(3)).toMatchObject({ name: 'Third', tone: 'info' });
    expect(t.inboxWa(3).status.state).toBe('open');
    await expect(t.addInbox('Fourth')).rejects.toThrow(/inbox_limit/);
    expect(() => t.inboxWa(9)).toThrow();
  });

  it('removes an inbox without touching wa-auth', async () => {
    const t = await app({ maxInboxes: 3, inboxes: 2 });
    const { repo, connections } = t.ctx.inboxes;
    const dataDir = t.ctx.config.dataDir;
    mkdirSync(join(dataDir, 'wa-auth'), { recursive: true });
    writeFileSync(join(dataDir, 'wa-auth', 'creds.json'), 'one');
    mkdirSync(join(dataDir, 'wa-auth-inboxes', '2'), { recursive: true });
    writeFileSync(join(dataDir, 'wa-auth-inboxes', '2', 'creds.json'), 'two');
    const removed: number[] = [];
    connections.on('removed', (inboxId) => removed.push(inboxId));
    const wa2 = t.inboxWa(2);

    await connections.remove(2);
    repo.markRemoved(2, 5);

    expect(removed).toEqual([2]);
    expect(wa2.status.state).toBe('logged_out');
    expect(existsSync(join(dataDir, 'wa-auth-inboxes', '2'))).toBe(false);
    expect(readFileSync(join(dataDir, 'wa-auth', 'creds.json'), 'utf8')).toBe('one');
    expect(() => connections.adapter(2)).toThrow();
    expect(repo.active().map((r) => r.id)).toEqual([1]);
    expect(repo.list().map((r) => r.id)).toEqual([1, 2]);
    expect(repo.get(2)!.removed_at).toBe(5);
    await expect(connections.remove(1)).rejects.toThrow(/primary_inbox/);
    await expect(connections.remove(2)).resolves.toBeUndefined();
  });

  it('keeps inbox members and user access in both directions', async () => {
    const t = await app({ maxInboxes: 3, inboxes: 2 });
    const repo = t.ctx.inboxes.repo;
    const a = addUser(t, 'agent', 'a1');
    const b = addUser(t, 'agent', 'b1');
    repo.setMembers(2, [b.id, a.id, a.id]);
    expect(repo.members(2)).toEqual([a.id, b.id]);
    expect(repo.userInboxIds(a.id)).toEqual([2]);
    repo.setUserInboxes(a.id, [1, 2]);
    expect(repo.userInboxIds(a.id)).toEqual([1, 2]);
    repo.setUserInboxes(a.id, []);
    expect(repo.userInboxIds(a.id)).toEqual([]);
    expect(repo.members(2)).toEqual([b.id]);
    repo.rename(2, 'Catering');
    expect(repo.get(2)!.name).toBe('Catering');
    repo.setOwnJid(2, '60111@s.whatsapp.net');
    expect(t.ctx.inboxes.connections.ownJids().has('60111@s.whatsapp.net')).toBe(true);
    repo.setOwnJid(2, null);
    expect(repo.get(2)!.own_jid).toBeNull();
    expect(repo.get(99)).toBeNull();
  });

  it('scopes each user to the inboxes they may open', async () => {
    const t = await app({ maxInboxes: 3, inboxes: 2 });
    const { repo } = t.ctx.inboxes;
    const admin = addUser(t, 'admin', 'boss');
    const a = addUser(t, 'agent', 'a2');
    const b = addUser(t, 'agent', 'b2');
    const off = addUser(t, 'agent', 'off');
    repo.setMembers(2, [a.id, off.id]);
    t.ctx.db.prepare('UPDATE users SET disabled_at = 1 WHERE id = ?').run(off.id);
    t.ctx.db
      .prepare(
        "INSERT INTO users (username, display_name, password_hash, role, kind, created_at) VALUES ('ai', 'AI', 'x', 'agent', 'ai', 1)",
      )
      .run();
    const ai = { ...a, id: 999, kind: 'ai' } as User;

    expect(scopeFor(t.ctx, admin)).toBe('all');
    expect(scopeFor(t.ctx, ai)).toBe('all');
    const sa = scopeFor(t.ctx, a);
    expect(canOpen(sa, 2)).toBe(true);
    expect(canOpen(sa, 1)).toBe(false);
    expect(canOpen(scopeFor(t.ctx, b), 2)).toBe(false);
    expect(canOpen('all', 7)).toBe(true);
    expect(scopeIds(t.ctx, 'all')).toEqual([1, 2]);
    expect(scopeIds(t.ctx, sa)).toEqual([2]);
    expect(usersWhoCanOpen(t.ctx, 2).sort()).toEqual([admin.id, a.id].sort());
    expect(usersWhoCanOpen(t.ctx, 1)).toEqual([admin.id]);

    // a removed inbox is for admins only
    await t.ctx.inboxes.connections.remove(2);
    repo.markRemoved(2, 9);
    expect(canOpen(scopeFor(t.ctx, a), 2)).toBe(false);
    expect(scopeIds(t.ctx, 'all')).toEqual([1]);
    expect(usersWhoCanOpen(t.ctx, 2)).toEqual([admin.id]);
  });

  it('lets every user open the single inbox of Lite', async () => {
    const t = await app();
    const a = addUser(t, 'agent', 'lite');
    expect(scopeFor(t.ctx, a)).toBe('all');
    expect(usersWhoCanOpen(t.ctx, 1)).toEqual([a.id]);
  });

  it('keeps agent scope and connects no extra inbox when a data dir has more inboxes than the limit', async () => {
    const dir = tempDir();
    const first = await createContext(devConfig(dir, { maxInboxes: 3 }), { log: silentLogger() });
    first.inboxes.repo.insert('Two', first.inboxes.repo.nextTone(), 1);
    first.db.close();

    const extra = new FakeWaAdapter({ idPrefix: 'EXTRA' });
    const connect = vi.spyOn(extra, 'connect');
    const ctx = await createContext(devConfig(dir), {
      log: silentLogger(),
      inboxAdapters: { 2: extra },
    });
    cleanups.push(() => void ctx.db.close());
    const { repo, connections } = ctx.inboxes;
    expect(connections.maxInboxes()).toBe(1);
    expect(repo.active().map((r) => r.id)).toEqual([1, 2]);
    expect(connections.entries().map(([id]) => id)).toEqual([1]);
    expect(() => connections.adapter(2)).toThrow();
    await connections.connectAll();
    expect(connect).not.toHaveBeenCalled();
    await connections.disconnectAll();

    ctx.db
      .prepare(
        "INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('m1', 'M', 'x', 'agent', 1), ('m2', 'N', 'x', 'agent', 1)",
      )
      .run();
    const [one, two] = (
      ctx.db
        .prepare("SELECT id FROM users WHERE username IN ('m1','m2') ORDER BY id")
        .all() as Array<{
        id: number;
      }>
    ).map((r) => r.id);
    repo.setMembers(1, [one!]);
    const agent = { id: one!, role: 'agent', kind: 'human' } as const;
    const scope = scopeFor(ctx, agent);
    expect(scope).not.toBe('all');
    expect(canOpen(scope, 1)).toBe(true);
    expect(canOpen(scope, 2)).toBe(false);
    expect(canOpen(scopeFor(ctx, { id: two!, role: 'agent', kind: 'human' }), 1)).toBe(false);
    expect(usersWhoCanOpen(ctx, 2)).toEqual([]);
    expect(usersWhoCanOpen(ctx, 1)).toEqual([one]);
  });

  it('builds a fake adapter per inbox in fake mode and uses given adapters first', async () => {
    const dir = tempDir();
    const given = new FakeWaAdapter({ idPrefix: 'GIVEN' });
    const first = await createContext(devConfig(dir, { maxInboxes: 4 }), {
      log: silentLogger(),
    });
    expect(first.inboxes.connections.maxInboxes()).toBe(4);
    expect(first.wa).toBeInstanceOf(FakeWaAdapter);
    const row = first.inboxes.repo.insert('Two', first.inboxes.repo.nextTone(), 1);
    expect(row).toMatchObject({ id: 2, auth_dir: 'wa-auth-inboxes/2', tone: 'warning' });
    first.db.close();

    const ctx = await createContext(devConfig(dir), {
      log: silentLogger(),
      maxInboxes: 2,
      inboxAdapters: { 2: given },
    });
    cleanups.push(() => void ctx.db.close());
    expect(ctx.inboxes.connections.maxInboxes()).toBe(2);
    expect(ctx.inboxes.connections.adapter(2)).toBe(given);
    expect(ctx.inboxes.connections.entries().map(([id]) => id)).toEqual([1, 2]);
  });

  it('connects every inbox one after another and stops on shutdown', async () => {
    const dir = tempDir();
    const ctx = await createContext(devConfig(dir, { maxInboxes: 3 }), { log: silentLogger() });
    cleanups.push(() => void ctx.db.close());
    const conns = new InboxConnections({
      repo: new InboxRepo(ctx.db),
      maxInboxes: 3,
      log: silentLogger(),
      staggerMs: 5,
      primary: new FakeWaAdapter(),
      create: (row) =>
        Promise.resolve(
          row.id === 3
            ? (Object.assign(new FakeWaAdapter(), {
                connect: () => Promise.reject(new Error('boom')),
              }) as WaAdapter)
            : new FakeWaAdapter({ idPrefix: `F${row.id}` }),
        ),
    });
    const repo = new InboxRepo(ctx.db);
    repo.insert('Two', repo.nextTone(), 1);
    repo.insert('Three', repo.nextTone(), 1);
    await conns.init();
    const added: number[] = [];
    conns.on('added', (id) => added.push(id));
    await conns.connectAll();
    expect(conns.adapter(1).status.state).toBe('open');
    expect(conns.adapter(2).status.state).toBe('open');
    expect(conns.statuses().get(3)?.state).toBe('disconnected');

    const row = repo.insert('Four', repo.nextTone(), 1);
    expect(row.tone).toBe('success');
    const wa4 = await conns.add(row);
    expect(added).toEqual([4]);
    expect(wa4.status.state).toBe('open');

    await conns.disconnectAll();
    expect(conns.adapter(1).status.state).toBe('disconnected');
    expect(conns.adapter(4).status.state).toBe('disconnected');
    // after shutdown a new inbox is not connected
    const wa5 = await conns.add(repo.insert('Five', repo.nextTone(), 1));
    expect(wa5.status.state).toBe('disconnected');
    await expect(conns.add(repo.get(2)!)).rejects.toThrow(/already/);
  });

  it('stops a staggered start when the server shuts down', async () => {
    const dir = tempDir();
    const ctx = await createContext(devConfig(dir, { maxInboxes: 3 }), { log: silentLogger() });
    cleanups.push(() => void ctx.db.close());
    const repo = new InboxRepo(ctx.db);
    repo.insert('Two', repo.nextTone(), 1);
    const second = new FakeWaAdapter();
    const spy = vi.spyOn(second, 'connect');
    const conns = new InboxConnections({
      repo,
      maxInboxes: 3,
      log: silentLogger(),
      staggerMs: 50,
      primary: new FakeWaAdapter(),
      create: () => Promise.resolve(second),
    });
    await conns.init();
    const started = conns.connectAll();
    await conns.disconnectAll();
    await started;
    expect(spy).not.toHaveBeenCalled();
  });

  it('--max-inboxes only in dev with fake WhatsApp', () => {
    expect(() => parseArgs(['--data', 'x', '--max-inboxes', '3'], {})).toThrow(/max-inboxes/);
    expect(() => parseArgs(['--data', 'x', '--max-inboxes', '3', '--fake-wa'], {})).toThrow(
      /max-inboxes/,
    );
    expect(() => parseArgs(['--data', 'x', '--max-inboxes', '3', '--mode', 'dev'], {})).toThrow(
      /max-inboxes/,
    );
    expect(
      parseArgs(['--data', 'x', '--max-inboxes', '3', '--fake-wa', '--mode', 'dev'], {}).maxInboxes,
    ).toBe(3);
    expect(() =>
      parseArgs(['--data', 'x', '--max-inboxes', '0', '--fake-wa', '--mode', 'dev'], {}),
    ).toThrow(/max-inboxes/);
    expect(() =>
      parseArgs(['--data', 'x', '--max-inboxes', 'two', '--fake-wa', '--mode', 'dev'], {}),
    ).toThrow(/max-inboxes/);
    expect(parseArgs(['--data', 'x'], { WATI_MAX_INBOXES: '3' }).maxInboxes).toBeUndefined();
  });
});
