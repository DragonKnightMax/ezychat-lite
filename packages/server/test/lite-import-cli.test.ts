// The Lite → Enterprise server CLI (design §5.3, §5.4, §5.6): --lite-summary, --import-lite (copy
// mode), the moved marker (exit 4, --ignore-moved, --restore-moved), rollback and refusals. A real
// Lite data folder is seeded through the core (fake WhatsApp), then runCli runs in-process.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWaAdapter } from '@ezychat/wa';
import {
  LiteImportOutcome,
  LiteImportProgress,
  LiteSummary,
  MovedMarker,
  type LiteImportResult,
} from '@ezychat/shared';
import { getApiTokens } from '../src/api-tokens/index.js';
import { verifyPassword } from '../src/auth/passwords.js';
import type { ServerConfig } from '../src/config.js';
import { parseArgs } from '../src/config.js';
import { SecretBox } from '../src/crypto/secret.js';
import { SettingsStore } from '../src/db/settings.js';
import { newestCoreMigration } from '../src/lite-import/checks.js';
import { LITE_IMPORT_NOTICE_KEY } from '../src/lite-import/notice.js';
import { silentLogger } from '../src/logger.js';
import { createContext, runInitializers, shutdownServices } from '../src/main.js';
import { runCli, type CliProduct } from '../src/run-cli.js';
import '../src/auth/index.js';

const ADMIN_PASSWORD = 'lite-admin-pass-1';
const AI_KEY = 'sk-lite-secret-key-123456';
const TOKEN_NAME = 'Claude Desktop';

let root: string;
const dirs = { lite: '', target: '' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wati-lite-import-'));
  dirs.lite = join(root, 'lite', 'data');
  dirs.target = join(root, 'ent', 'data');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function config(dataDir: string): ServerConfig {
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

/** A Lite data folder as the real core leaves it: users, chats, an AI agent, a token, a secret. */
async function seedLite(
  dataDir: string,
  opts: { tunnel?: 'quick' | 'named' | 'managed' | 'off'; port?: number } = {},
): Promise<{ adminId: number }> {
  const ctx = await createContext(config(dataDir), {
    wa: new FakeWaAdapter(),
    log: silentLogger(),
    connectStaggerMs: 0,
  });
  await runInitializers(ctx);
  const auth = ctx.services.auth!;
  const admin = auth.createUser({
    username: 'boss',
    displayName: 'The Boss',
    role: 'admin',
    password: ADMIN_PASSWORD,
    mustChangePassword: false,
  });
  auth.createUser({
    username: 'amy',
    displayName: 'Amy',
    role: 'agent',
    password: 'amy-password-1',
    mustChangePassword: false,
  });
  const gone = auth.createUser({
    username: 'gone',
    displayName: 'Gone',
    role: 'agent',
    password: 'gone-password-1',
    mustChangePassword: false,
  });
  ctx.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(Date.now(), gone.id);
  const { db } = ctx;
  if (!(db.prepare('SELECT COUNT(*) AS n FROM ai_agents').get() as { n: number }).n) {
    const uid = Number(
      db
        .prepare(
          "INSERT INTO users (username, display_name, password_hash, role, kind, created_at) VALUES ('ai-sales', 'Sales Ava', 'x', 'agent', 'ai', ?)",
        )
        .run(Date.now()).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO ai_agents (user_id, inbox_id, preset, created_at, updated_at) VALUES (?, 1, 'sales', ?, ?)",
    ).run(uid, Date.now(), Date.now());
  }
  const now = Date.now();
  for (const [jid, type] of [
    ['60111111111@s.whatsapp.net', 'dm'],
    ['60122222222@s.whatsapp.net', 'dm'],
    ['1203630@g.us', 'group'],
  ] as const) {
    db.prepare(
      "INSERT INTO chats (jid, type, name, wa_jid, inbox_id, updated_at) VALUES (?, ?, 'Secret Customer Name', ?, 1, ?)",
    ).run(jid, type, jid, now);
    db.prepare(
      "INSERT INTO messages (id, chat_jid, type, body, timestamp, created_at) VALUES (?, ?, 'text', 'private chat text', ?, ?)",
    ).run(`m-${jid}`, jid, now, now);
  }
  db.prepare(
    "INSERT INTO quick_replies (shortcut, body, updated_at) VALUES ('/hi', 'Hello', ?)",
  ).run(now);
  getApiTokens(ctx).create(admin.id, { name: TOKEN_NAME, expiresInDays: null }, '127.0.0.1');
  ctx.settings.setSecret('ai_api_key', AI_KEY);
  ctx.inboxes.repo.setOwnJid(1, '60199999999:7@s.whatsapp.net');
  if (opts.tunnel === 'quick') ctx.settings.set('tunnel_mode', 'quick');
  if (opts.tunnel === 'named') {
    ctx.settings.set('tunnel_mode', 'named');
    ctx.settings.setSecret('tunnel_token', 'eyJ-tunnel-token-secret');
    ctx.settings.set('named_tunnel_hostname', 'inbox.example.com');
  }
  if (opts.tunnel === 'managed') {
    ctx.settings.set('tunnel_mode', 'named');
    ctx.settings.set('cloudflare_managed_tunnel', { hostname: 'chat.example.com', id: 'x' });
  }
  if (opts.port) ctx.settings.set('port', opts.port);
  await shutdownServices(ctx);
  await ctx.inboxes.connections.disconnectAll();
  ctx.bus.removeAllListeners();
  ctx.db.close();
  mkdirSync(join(dataDir, 'wa-auth'), { recursive: true });
  writeFileSync(
    join(dataDir, 'wa-auth', 'creds.json'),
    JSON.stringify({ me: { id: '60199999999:7@s.whatsapp.net' } }),
  );
  mkdirSync(join(dataDir, 'wa-auth-inboxes', '2'), { recursive: true });
  writeFileSync(join(dataDir, 'wa-auth-inboxes', '2', 'creds.json'), '{}');
  mkdirSync(join(dataDir, 'media', '2026'), { recursive: true });
  writeFileSync(join(dataDir, 'media', '2026', 'photo.jpg'), Buffer.alloc(4096, 1));
  mkdirSync(join(dataDir, 'backups'), { recursive: true });
  writeFileSync(join(dataDir, 'backups', 'app-20261031.db'), 'old');
  return { adminId: admin.id };
}

interface CliRun {
  code: number;
  stdout: string[];
  stderr: string;
}

/** Runs the CLI in-process; `exit` throws to stop it like process.exit would. */
async function cli(argv: string[], product: Omit<CliProduct, 'exit'> = {}): Promise<CliRun> {
  const out: string[] = [];
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  class Exit extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }
  let code = -1;
  try {
    await runCli(
      argv,
      {},
      {
        ...product,
        exit: ((c: number) => {
          throw new Exit(c);
        }) as (code: number) => never,
      },
    );
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const stdout = out.join('').split('\n').filter(Boolean);
  return { code, stdout, stderr: err };
}

const importArgs = () => ['--data', dirs.target, '--import-lite', dirs.lite];

function outcomeOf(run: CliRun): LiteImportOutcome {
  return LiteImportOutcome.parse(JSON.parse(run.stdout.at(-1)!));
}

/** Every file below a folder with its contents, to prove a folder was left exactly as it was. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      const r = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(p, r);
      else out[r] = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
    }
  };
  walk(dir, '');
  return out;
}

describe('--lite-summary', () => {
  it('prints counts, team, agents and tokens by name, never chat text, customers or secrets', async () => {
    await seedLite(dirs.lite, { tunnel: 'named', port: 7444 });
    const before = snapshot(dirs.lite);
    const run = await cli(['--lite-summary', dirs.lite]);
    expect(run.code).toBe(0);
    expect(run.stdout).toHaveLength(1);
    const summary = LiteSummary.parse(JSON.parse(run.stdout[0]!));
    expect(summary).toMatchObject({
      dataDir: dirs.lite,
      schemaVersion: newestCoreMigration(),
      number: '+60199999999',
      ownJid: '60199999999@s.whatsapp.net',
      chats: 3,
      customers: 2,
      messages: 3,
      mediaBytes: 4096,
      quickReplyShortcuts: ['/hi'],
      tokens: [{ name: TOKEN_NAME, kind: 'token' }],
      remote: 'dashboard',
      address: 'inbox.example.com',
      port: 7444,
    });
    expect(summary.totalBytes).toBeGreaterThan(4096);
    expect(summary.users.map((u) => [u.username, u.role])).toEqual([
      ['boss', 'admin'],
      ['amy', 'agent'],
    ]);
    expect(summary.aiAgents).toHaveLength(1);
    expect(summary.aiAgents[0]!.name).toBeTruthy();
    for (const secret of [
      AI_KEY,
      'eyJ-tunnel-token-secret',
      'private chat text',
      'Secret Customer Name',
      '60111111111',
      'ezc_pat_',
    ])
      expect(run.stdout[0]).not.toContain(secret);
    // read only: Lite's folder is byte for byte the same
    expect(snapshot(dirs.lite)).toEqual(before);
  });

  it('reads the port from desktop.json and the managed or quick remote', async () => {
    await seedLite(dirs.lite, { tunnel: 'managed' });
    writeFileSync(join(dirs.lite, '..', 'desktop.json'), JSON.stringify({ port: 7425 }));
    let summary = LiteSummary.parse(
      JSON.parse((await cli(['--lite-summary', dirs.lite])).stdout[0]!),
    );
    expect(summary).toMatchObject({ remote: 'managed', address: 'chat.example.com', port: 7425 });

    const db = new Database(join(dirs.lite, 'app.db'));
    db.prepare("UPDATE settings SET value = '\"quick\"' WHERE key = 'tunnel_mode'").run();
    db.prepare('UPDATE inboxes SET own_jid = ? WHERE id = 1').run('555:3@lid');
    db.prepare(
      "INSERT INTO jid_aliases (alias_jid, canonical_jid, source, learned_at) VALUES ('60188888888@s.whatsapp.net', '555@lid', 'message', 1)",
    ).run();
    db.close();
    summary = LiteSummary.parse(JSON.parse((await cli(['--lite-summary', dirs.lite])).stdout[0]!));
    expect(summary).toMatchObject({ remote: 'quick', address: null, number: '+60188888888' });
  });

  it('a folder never linked has no number and LAN remote', async () => {
    await seedLite(dirs.lite);
    const db = new Database(join(dirs.lite, 'app.db'));
    db.prepare('UPDATE inboxes SET own_jid = NULL').run();
    db.close();
    rmSync(join(dirs.lite, 'wa-auth', 'creds.json'));
    const summary = LiteSummary.parse(
      JSON.parse((await cli(['--lite-summary', dirs.lite])).stdout[0]!),
    );
    expect(summary).toMatchObject({ number: null, ownJid: null, remote: 'lan', port: null });
  });

  it('exits 2 without an app.db', async () => {
    mkdirSync(dirs.lite, { recursive: true });
    const run = await cli(['--lite-summary', dirs.lite]);
    expect(run.code).toBe(2);
    expect(run.stdout).toEqual([]);
    expect(run.stderr).toContain('app.db missing');
  });
});

describe('--import-lite, copy mode', () => {
  it('a copy of a LAN-only Lite keeps its address: no "address changed" flag', async () => {
    await seedLite(dirs.lite, { tunnel: 'off' });
    const run = await cli(importArgs(), { edition: 'enterprise', maxInboxes: 5 });
    expect(run.code).toBe(0);
    const db = new Database(join(dirs.target, 'app.db'), { readonly: true });
    const settings = new SettingsStore(db, SecretBox.loadOrCreate(join(dirs.target, 'secret.key')));
    expect(settings.get(LITE_IMPORT_NOTICE_KEY, null)).toBeNull();
    db.close();
  });

  it('copies Lite into an empty install, verifies it and hands Lite over', async () => {
    const { adminId } = await seedLite(dirs.lite, { tunnel: 'quick' });
    // an install that was opened once but has no chats: moved aside, never deleted
    mkdirSync(dirs.target, { recursive: true });
    writeFileSync(join(dirs.target, 'keep.txt'), 'x');

    const run = await cli(importArgs(), { edition: 'enterprise', maxInboxes: 5 });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const lines = run.stdout.map((l) => JSON.parse(l) as unknown);
    const progress = lines.slice(0, -1).map((l) => LiteImportProgress.parse(l));
    expect(progress.map((p) => `${p.step}:${p.state}`)).toEqual(
      expect.arrayContaining(['copy:running', 'copy:done', 'verify:done', 'handover:done']),
    );
    const last = progress.findLast((p) => p.step === 'copy')!;
    expect(last.done).toBe(last.total);
    const outcome = outcomeOf(run) as { result: LiteImportResult };
    expect(outcome.result).toEqual({
      mode: 'copy',
      inboxId: 1,
      inboxName: 'WhatsApp',
      chats: 3,
      usersAdded: 0,
      usersMatched: 0,
      agentImported: true,
      agentOff: false,
      renamedShortcuts: [],
    });

    // the target is Lite's data: same password, same secrets, same files; no logs or backups
    const db = new Database(join(dirs.target, 'app.db'), { readonly: true });
    const hash = (
      db.prepare('SELECT password_hash FROM users WHERE id = ?').get(adminId) as {
        password_hash: string;
      }
    ).password_hash;
    expect(await verifyPassword(hash, ADMIN_PASSWORD)).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n).toBe(3);
    const settings = new SettingsStore(db, SecretBox.loadOrCreate(join(dirs.target, 'secret.key')));
    expect(settings.getSecret('ai_api_key')).toBe(AI_KEY);
    expect(settings.get(LITE_IMPORT_NOTICE_KEY, null)).toEqual({
      checklist: null,
      mcp: { reason: 'quick', mcpUrl: null },
    });
    const auditRow = db
      .prepare("SELECT meta FROM audit_log WHERE action = 'lite.import'")
      .get() as { meta: string };
    expect(JSON.parse(auditRow.meta)).toMatchObject({
      mode: 'copy',
      inbox: 1,
      counts: { chats: 3 },
    });
    db.close();
    expect(readFileSync(join(dirs.target, 'media', '2026', 'photo.jpg')).length).toBe(4096);
    expect(existsSync(join(dirs.target, 'wa-auth', 'creds.json'))).toBe(true);
    expect(existsSync(join(dirs.target, 'wa-auth-inboxes', '2', 'creds.json'))).toBe(true);
    expect(existsSync(join(dirs.target, 'backups'))).toBe(false);
    expect(existsSync(join(dirs.target, 'server.lock'))).toBe(false);
    expect(existsSync(`${dirs.target}.importing`)).toBe(false);
    const aside = readdirSync(join(root, 'ent')).filter((n) => n.startsWith('data.empty-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(root, 'ent', aside[0]!, 'keep.txt'), 'utf8')).toBe('x');
    expect(readFileSync(join(`${dirs.target}.import-logs`, 'lite-import.log'), 'utf8')).toContain(
      'lite import done',
    );

    // Lite is handed over: marker, WhatsApp folders renamed, its data otherwise intact
    const marker = MovedMarker.parse(
      JSON.parse(readFileSync(join(dirs.lite, 'moved.json'), 'utf8')),
    );
    expect(marker).toMatchObject({
      to: 'enterprise',
      product: 'enterprise',
      version: expect.any(String),
    });
    expect(existsSync(join(dirs.lite, 'wa-auth'))).toBe(false);
    expect(existsSync(join(dirs.lite, 'wa-auth.moved', 'creds.json'))).toBe(true);
    expect(existsSync(join(dirs.lite, 'wa-auth-inboxes', '2.moved', 'creds.json'))).toBe(true);
    expect(existsSync(join(dirs.lite, 'app.db'))).toBe(true);
    expect(existsSync(join(dirs.lite, 'server.lock'))).toBe(false);

    // Lite's own server now refuses the folder (exit 4) ...
    const lite = await cli(['--data', dirs.lite]);
    expect(lite.code).toBe(4);
    expect(lite.stderr).toContain('moved to EzyChat Enterprise');
    // ... and "Use Lite again" puts it back
    const restore = await cli(['--data', dirs.lite, '--restore-moved']);
    expect(restore.code).toBe(0);
    expect(JSON.parse(restore.stdout[0]!)).toEqual({
      markerRemoved: true,
      restored: ['wa-auth', 'wa-auth-inboxes/2'],
      kept: [],
    });
    expect(existsSync(join(dirs.lite, 'moved.json'))).toBe(false);
    expect(existsSync(join(dirs.lite, 'wa-auth', 'creds.json'))).toBe(true);
    expect(existsSync(join(dirs.lite, 'wa-auth-inboxes', '2', 'creds.json'))).toBe(true);
  });

  it('an own domain keeps working after a copy: no MCP flag; the copy into a missing folder works', async () => {
    await seedLite(dirs.lite, { tunnel: 'named' });
    const run = await cli(importArgs());
    expect(run.code).toBe(0);
    const db = new Database(join(dirs.target, 'app.db'), { readonly: true });
    const settings = new SettingsStore(db, SecretBox.loadOrCreate(join(dirs.target, 'secret.key')));
    expect(settings.get(LITE_IMPORT_NOTICE_KEY, 'none')).toBe('none');
    expect(settings.getSecret('tunnel_token')).toBe('eyJ-tunnel-token-secret');
    db.close();
    expect(readMarkerProduct()).toBe('lite');
  });

  for (const point of ['db', 'files', 'verify', 'handover:marker', 'handover:wa-auth', 'rename']) {
    it(`a failure at ${point} rolls back: Lite untouched, no staging, the target as before`, async () => {
      await seedLite(dirs.lite);
      mkdirSync(dirs.target, { recursive: true });
      writeFileSync(join(dirs.target, 'keep.txt'), 'x');
      const liteBefore = snapshot(dirs.lite);
      const targetBefore = snapshot(dirs.target);
      const run = await cli(importArgs(), {
        importFault: (p) => {
          if (p === point) throw new Error(`forced at ${p}`);
        },
      });
      expect(run.code).toBe(1);
      const outcome = outcomeOf(run) as { error: { code: string; message?: string } };
      expect(outcome.error.code).toBe('failed');
      expect(outcome.error.message).toContain(`forced at ${point}`);
      expect(run.stdout.some((l) => JSON.parse(l).state === 'failed')).toBe(true);
      expect(snapshot(dirs.lite)).toEqual(liteBefore);
      expect(snapshot(dirs.target)).toEqual(targetBefore);
      expect(existsSync(`${dirs.target}.importing`)).toBe(false);
      expect(readdirSync(join(root, 'ent')).filter((n) => n.startsWith('data.empty-'))).toEqual([]);
    });
  }

  it('refuses a Lite newer than this build (exit 5, nothing changed)', async () => {
    await seedLite(dirs.lite);
    const db = new Database(join(dirs.lite, 'app.db'));
    db.pragma(`user_version = ${newestCoreMigration() + 1}`);
    db.close();
    const before = snapshot(dirs.lite);
    const run = await cli(importArgs());
    expect(run.code).toBe(5);
    expect(outcomeOf(run)).toEqual({ error: { code: 'lite_newer' } });
    expect(snapshot(dirs.lite)).toEqual(before);
    expect(existsSync(dirs.target)).toBe(false);
  });

  it('refuses while Lite runs (its server.lock is held)', async () => {
    await seedLite(dirs.lite);
    // a live process holds the lock (this test process)
    writeFileSync(join(dirs.lite, 'server.lock'), String(process.pid));
    const run = await cli(importArgs());
    expect(run.code).toBe(5);
    expect(outcomeOf(run)).toEqual({ error: { code: 'lite_running' } });
    expect(readFileSync(join(dirs.lite, 'server.lock'), 'utf8')).toBe(String(process.pid));
    expect(existsSync(join(dirs.lite, 'moved.json'))).toBe(false);
  });

  it('fails when the target server still runs', async () => {
    await seedLite(dirs.lite);
    mkdirSync(dirs.target, { recursive: true });
    writeFileSync(join(dirs.target, 'server.lock'), String(process.pid));
    const run = await cli(importArgs());
    expect(run.code).toBe(1);
    expect((outcomeOf(run) as { error: { message: string } }).error.message).toContain(
      'still running',
    );
    expect(existsSync(join(dirs.lite, 'moved.json'))).toBe(false);
  });

  it('exits 2 without Lite data or with an unreadable plan', async () => {
    mkdirSync(dirs.lite, { recursive: true });
    let run = await cli(importArgs());
    expect(run.code).toBe(2);
    expect(outcomeOf(run)).toMatchObject({ error: { code: 'no_lite_data' } });
    const plan = join(root, 'plan.json');
    writeFileSync(plan, '{"team": "nope"}');
    run = await cli([...importArgs(), '--import-plan', plan]);
    expect(run.code).toBe(2);
    expect(outcomeOf(run)).toMatchObject({ error: { code: 'bad_plan' } });
  });

  it('chooses merge when the target already has chats and reports what merge refused', async () => {
    await seedLite(dirs.lite);
    await seedLite(dirs.target);
    const plan = join(root, 'plan.json');
    writeFileSync(plan, JSON.stringify({ team: [] }));
    // whatever the merge does (refuses the same number, or fails), it is never a copy
    const run = await cli([...importArgs(), '--import-plan', plan], { maxInboxes: 3 });
    expect(run.code).not.toBe(0);
    const outcome = outcomeOf(run) as { error: { code: string } };
    expect(outcome.error.code).not.toBe('lite_newer');
    expect(existsSync(`${dirs.target}.importing`)).toBe(false);
    expect(existsSync(join(dirs.lite, 'moved.json'))).toBe(false);
    expect(existsSync(join(dirs.lite, 'wa-auth', 'creds.json'))).toBe(true);
  });
});

function readMarkerProduct(): string {
  return MovedMarker.parse(JSON.parse(readFileSync(join(dirs.lite, 'moved.json'), 'utf8'))).product;
}

describe('moved marker at start', () => {
  const marker = {
    to: 'enterprise',
    product: 'enterprise',
    at: '2026-11-01T00:00:00.000Z',
    version: '1.0.0',
  };

  it('exits 4 with a line on stderr and in the log', async () => {
    mkdirSync(dirs.lite, { recursive: true });
    writeFileSync(join(dirs.lite, 'moved.json'), JSON.stringify(marker));
    const run = await cli(['--data', dirs.lite, '--fake-wa', '--mode', 'dev']);
    expect(run.code).toBe(4);
    expect(run.stderr).toContain('2026-11-01T00:00:00.000Z');
    expect(run.stderr).toContain('--ignore-moved');
    const log = readFileSync(join(dirs.lite, 'logs', 'cli.log'), 'utf8');
    expect(log).toContain('data folder was moved');
    expect(existsSync(join(dirs.lite, 'app.db'))).toBe(false);
  });

  it('a damaged marker still blocks the start', async () => {
    mkdirSync(dirs.lite, { recursive: true });
    writeFileSync(join(dirs.lite, 'moved.json'), 'garbage');
    const run = await cli(['--data', dirs.lite]);
    expect(run.code).toBe(4);
  });

  it('--ignore-moved goes on to start the server', async () => {
    mkdirSync(dirs.lite, { recursive: true });
    writeFileSync(join(dirs.lite, 'moved.json'), JSON.stringify(marker));
    // a live lock makes the start stop right after the moved check: exit 3 (locked), not 4 (moved)
    writeFileSync(join(dirs.lite, 'server.lock'), String(process.pid));
    const run = await cli(['--data', dirs.lite, '--ignore-moved', '--fake-wa', '--mode', 'dev']);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('in use by another server');
  });

  it('--restore-moved keeps a WhatsApp folder that exists again and still removes the marker', async () => {
    mkdirSync(join(dirs.lite, 'wa-auth.moved'), { recursive: true });
    mkdirSync(join(dirs.lite, 'wa-auth'), { recursive: true });
    mkdirSync(join(dirs.lite, 'wa-auth-inboxes', '3.moved'), { recursive: true });
    writeFileSync(join(dirs.lite, 'moved.json'), JSON.stringify(marker));
    const run = await cli(['--data', dirs.lite, '--restore-moved']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout[0]!)).toEqual({
      markerRemoved: true,
      restored: ['wa-auth-inboxes/3'],
      kept: ['wa-auth'],
    });
    expect(existsSync(join(dirs.lite, 'wa-auth.moved'))).toBe(true);
    expect(existsSync(join(dirs.lite, 'wa-auth-inboxes', '3'))).toBe(true);
  });

  it('--restore-moved on a folder that was never moved changes nothing', async () => {
    mkdirSync(dirs.lite, { recursive: true });
    const run = await cli(['--data', dirs.lite, '--restore-moved']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout[0]!)).toEqual({ markerRemoved: false, restored: [], kept: [] });
  });
});

describe('parseArgs, Lite import flags', () => {
  it('parses the commands and keeps them flag-only', () => {
    const a = parseArgs(['--data', 'x', '--import-lite', 'lite', '--import-plan', 'p.json'], {});
    expect(a.importLite).toMatch(/lite$/);
    expect(a.importPlan).toMatch(/p\.json$/);
    expect(parseArgs(['--lite-summary', 'lite'], {}).dataDir).toMatch(/lite$/);
    expect(parseArgs(['--data', 'x', '--restore-moved'], {}).restoreMoved).toBe(true);
    expect(parseArgs(['--data', 'x', '--ignore-moved'], {}).ignoreMoved).toBe(true);
    const plain = parseArgs(['--data', 'x'], { WATI_IGNORE_MOVED: '1', WATI_IMPORT_LITE: 'y' });
    expect(plain).toMatchObject({ ignoreMoved: false, restoreMoved: false });
    expect(plain.importLite).toBeUndefined();
  });

  it('refuses combinations and stray values', () => {
    expect(() => parseArgs(['--data', 'x', '--restore-moved', '--reset-admin'], {})).toThrow(
      /only one/,
    );
    expect(() =>
      parseArgs(['--data', 'x', '--import-lite', 'a', '--lite-summary', 'b'], {}),
    ).toThrow(/only one/);
    expect(() => parseArgs(['--data', 'x', '--import-plan', 'p'], {})).toThrow(/import-plan/);
    expect(() => parseArgs(['--data', 'x', '--ignore-moved=yes'], {})).toThrow(/no value/);
  });

  it('runCli prints the usage with the new commands on a bad argument', async () => {
    const run = await cli(['--data', 'x', '--import-plan', 'p']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--import-lite <lite data dir>');
    expect(run.stderr).toContain('--restore-moved');
  });
});
