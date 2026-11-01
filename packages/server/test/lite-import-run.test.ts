// The import runner around the merge (merge itself is tested in lite-import-merge*.test.ts): the
// hand-over happens only after the merge returned, the notice and audit row land in the target,
// and a merge refusal or failure leaves Lite untouched. Plus the small checks.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiteImportProgress, LiteImportResult } from '@ezychat/shared';
import { SecretBox } from '../src/crypto/secret.js';
import { openDb } from '../src/db/index.js';
import { SettingsStore } from '../src/db/settings.js';
import {
  checkDisk,
  checkSchema,
  freeBytes,
  newestCoreMigration,
} from '../src/lite-import/checks.js';
import { LiteImportRefused } from '../src/lite-import/errors.js';
import { copyTree, pathBytes } from '../src/lite-import/files.js';
import { handOver } from '../src/lite-import/handover.js';
import { LITE_IMPORT_NOTICE_KEY } from '../src/lite-import/notice.js';
import { chooseMode, importLiteCommand, runLiteImport } from '../src/lite-import/run.js';
import { bareJid } from '../src/lite-import/summary.js';
import { silentLogger } from '../src/logger.js';
import { readMovedMarker } from '../src/moved.js';

const merge = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../src/lite-import/merge.js', () => ({ mergeLiteInbox: merge.fn }));

let root: string;
let lite: string;
let target: string;

/** A minimal data folder: a migrated app.db (+ chats), a secret and a WhatsApp link. */
function makeDataDir(
  dir: string,
  opts: { chats?: number; ownJid?: string; tunnel?: string } = {},
): void {
  const db = openDb(join(dir, 'app.db'));
  const settings = new SettingsStore(db, SecretBox.loadOrCreate(join(dir, 'secret.key')));
  for (let i = 0; i < (opts.chats ?? 0); i++)
    db.prepare(
      "INSERT INTO chats (jid, type, wa_jid, inbox_id, updated_at) VALUES (?, 'dm', ?, 1, 1)",
    ).run(`${i}@s.whatsapp.net`, `${i}@s.whatsapp.net`);
  if (opts.ownJid) db.prepare('UPDATE inboxes SET own_jid = ? WHERE id = 1').run(opts.ownJid);
  if (opts.tunnel) {
    settings.set('tunnel_mode', 'named');
    settings.set('named_tunnel_hostname', opts.tunnel);
  }
  db.close();
  mkdirSync(join(dir, 'wa-auth'), { recursive: true });
  writeFileSync(join(dir, 'wa-auth', 'creds.json'), '{}');
}

const result: LiteImportResult = {
  mode: 'merge',
  inboxId: 3,
  inboxName: 'Lite – +60199999999',
  chats: 0,
  usersAdded: 1,
  usersMatched: 1,
  agentImported: true,
  agentOff: false,
  renamedShortcuts: ['/hi-lite'],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wati-lite-run-'));
  lite = join(root, 'lite');
  target = join(root, 'ent');
  merge.fn.mockReset();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const opts = (progress: LiteImportProgress[] = []) => ({
  targetDataDir: target,
  liteDataDir: lite,
  plan: { team: [] },
  maxInboxes: 3,
  product: 'enterprise',
  version: '9.9.9',
  log: silentLogger(),
  progress: (p: LiteImportProgress) => progress.push(p),
});

describe('merge mode', () => {
  it('hands Lite over after the merge, then writes the checklist, MCP flag and audit row', async () => {
    makeDataDir(lite, { chats: 1, ownJid: '60199999999@s.whatsapp.net' });
    makeDataDir(target, {
      chats: 2,
      ownJid: '60111111111@s.whatsapp.net',
      tunnel: 'inbox.example.com',
    });
    merge.fn.mockImplementation(
      async (o: { maxInboxes: number; progress: (p: LiteImportProgress) => void }) => {
        // Lite is not handed over yet while the merge runs, and both folders are locked
        expect(existsSync(join(lite, 'moved.json'))).toBe(false);
        expect(readFileSync(join(lite, 'server.lock'), 'utf8')).toBe(String(process.pid));
        expect(readFileSync(join(target, 'server.lock'), 'utf8')).toBe(String(process.pid));
        expect(o.maxInboxes).toBe(3);
        o.progress({ step: 'merge', state: 'done' });
        return result;
      },
    );
    const progress: LiteImportProgress[] = [];
    expect(await runLiteImport(opts(progress))).toEqual(result);
    expect(progress.map((p) => `${p.step}:${p.state}`)).toEqual([
      'merge:done',
      'handover:running',
      'handover:done',
    ]);
    expect(readMovedMarker(lite)).toMatchObject({
      to: 'enterprise',
      product: 'enterprise',
      version: '9.9.9',
    });
    expect(existsSync(join(lite, 'wa-auth.moved', 'creds.json'))).toBe(true);
    expect(existsSync(join(lite, 'server.lock'))).toBe(false);
    expect(existsSync(join(target, 'server.lock'))).toBe(false);

    const db = new Database(join(target, 'app.db'), { readonly: true });
    const settings = new SettingsStore(db, SecretBox.loadOrCreate(join(target, 'secret.key')));
    expect(settings.get(LITE_IMPORT_NOTICE_KEY, null)).toEqual({
      checklist: {
        inboxId: 3,
        inboxName: 'Lite – +60199999999',
        liteUsers: 2,
        tokens: [],
        items: { share: false, signin: false, notifications: false, mcp: false },
      },
      mcp: { reason: 'merge', mcpUrl: 'https://inbox.example.com/mcp' },
    });
    const row = db
      .prepare("SELECT user_id, meta FROM audit_log WHERE action = 'lite.import'")
      .get() as {
      user_id: number | null;
      meta: string;
    };
    expect(row.user_id).toBeNull();
    expect(JSON.parse(row.meta)).toEqual({
      mode: 'merge',
      inbox: 3,
      counts: { chats: 0, usersAdded: 1, usersMatched: 1, agent: true },
    });
    db.close();
  });

  it.each([
    ['moved', 'inbox.lite.example', 'off'],
    ['stayed', null, 'named'],
  ])(
    "Lite's own address %s: the hand-over releases it only when it moved",
    async (_n, address, mode) => {
      makeDataDir(lite, { chats: 1, tunnel: 'inbox.lite.example' });
      makeDataDir(target, { chats: 1 });
      merge.fn.mockResolvedValue({ ...result, address });
      // the address stays internal: the CLI outcome is the plain result
      expect(await runLiteImport(opts())).toEqual(result);
      const db = new Database(join(lite, 'app.db'), { readonly: true });
      expect(db.prepare("SELECT value FROM settings WHERE key = 'tunnel_mode'").get()).toEqual({
        value: JSON.stringify(mode),
      });
      db.close();
    },
  );

  it('a notice that cannot be saved does not undo a finished merge', async () => {
    makeDataDir(lite, { chats: 1 });
    makeDataDir(target, { chats: 1 });
    merge.fn.mockResolvedValue(result);
    const r = await runLiteImport({
      ...opts(),
      fault: (p) => {
        if (p === 'record') throw new Error('disk full');
      },
    });
    expect(r).toEqual(result);
    expect(readMovedMarker(lite)).not.toBeNull();
  });

  it('a failed hand-over after the merge undoes the merge and leaves Lite as it was', async () => {
    makeDataDir(lite, { chats: 1 });
    makeDataDir(target, { chats: 1 });
    const undo = vi.fn();
    merge.fn.mockImplementation(async (o: { onCommitted?: (u: () => void) => void }) => {
      o.onCommitted?.(undo);
      return result;
    });
    await expect(
      runLiteImport({
        ...opts(),
        fault: (p) => {
          if (p === 'handover:marker') throw new Error('Lite folder is read only');
        },
      }),
    ).rejects.toThrow('read only');
    expect(undo).toHaveBeenCalledTimes(1);
    expect(readMovedMarker(lite)).toBeNull();
    expect(existsSync(join(lite, 'wa-auth', 'creds.json'))).toBe(true);
  });

  it('a merge refusal exits 5 and leaves Lite as it was', async () => {
    makeDataDir(lite, { chats: 1 });
    makeDataDir(target, { chats: 1 });
    merge.fn.mockRejectedValue(new LiteImportRefused('same_number'));
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    let code: number;
    try {
      code = await importLiteCommand({ ...opts(), planFile: undefined });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(5);
    expect(JSON.parse(out.at(-1)!)).toEqual({ error: { code: 'same_number' } });
    expect(existsSync(join(lite, 'moved.json'))).toBe(false);
    expect(existsSync(join(lite, 'wa-auth', 'creds.json'))).toBe(true);
  });

  it('a failed merge marks its running step failed and hands nothing over', async () => {
    makeDataDir(lite, { chats: 1 });
    makeDataDir(target, { chats: 1 });
    merge.fn.mockImplementation(async (o: { progress: (p: LiteImportProgress) => void }) => {
      o.progress({ step: 'merge', state: 'running' });
      throw new Error('boom');
    });
    const progress: LiteImportProgress[] = [];
    await expect(runLiteImport(opts(progress))).rejects.toThrow('boom');
    expect(progress.at(-1)).toEqual({ step: 'merge', state: 'failed' });
    expect(existsSync(join(lite, 'moved.json'))).toBe(false);
  });

  it('a plan file is read and passed on', async () => {
    makeDataDir(lite, { chats: 1 });
    makeDataDir(target, { chats: 1 });
    const plan = { team: [{ liteUserId: 2, action: 'add', matchUserId: null, role: 'agent' }] };
    writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
    merge.fn.mockResolvedValue(result);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await importLiteCommand({ ...opts(), planFile: join(root, 'plan.json') })).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(merge.fn.mock.calls[0]![0].plan).toEqual(plan);
  });
});

describe('chooseMode', () => {
  it('copies into a missing or unused install and merges into one with chats or a linked number', () => {
    expect(chooseMode(target)).toBe('copy');
    makeDataDir(target);
    expect(chooseMode(target)).toBe('copy');
    const db = new Database(join(target, 'app.db'));
    db.prepare("UPDATE inboxes SET own_jid = '1@s.whatsapp.net'").run();
    db.close();
    expect(chooseMode(target)).toBe('merge');
    const other = join(root, 'other');
    makeDataDir(other, { chats: 1 });
    expect(chooseMode(other)).toBe('merge');
  });

  it('an app.db without tables yet counts as unused', () => {
    mkdirSync(target, { recursive: true });
    new Database(join(target, 'app.db')).close();
    expect(chooseMode(target)).toBe('copy');
  });
});

describe('checks and helpers', () => {
  it('refuses a newer schema and too little disk', () => {
    expect(() => checkSchema(newestCoreMigration())).not.toThrow();
    expect(() => checkSchema(newestCoreMigration() + 1)).toThrow(LiteImportRefused);
    expect(() => checkDisk(root, 1000, 1100)).not.toThrow();
    try {
      checkDisk(root, 1000, 1099);
      expect.unreachable();
    } catch (err) {
      expect((err as LiteImportRefused).code).toBe('disk');
    }
  });

  it('measures free space on the nearest existing folder', () => {
    expect(freeBytes(join(root, 'not', 'there', 'yet'))).toBeGreaterThan(0);
  });

  it('sizes and copies trees, skipping missing paths', () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'f'), 'hello');
    writeFileSync(join(root, 'a', 'g'), 'xy');
    expect(pathBytes(join(root, 'a'))).toBe(7);
    expect(pathBytes(join(root, 'missing'))).toBe(0);
    let bytes = 0;
    expect(copyTree(join(root, 'a'), join(root, 'c'), (n) => (bytes += n))).toBe(2);
    expect(bytes).toBe(7);
    expect(readFileSync(join(root, 'c', 'b', 'f'), 'utf8')).toBe('hello');
    expect(copyTree(join(root, 'missing'), join(root, 'd'), () => undefined)).toBe(0);
  });

  it('drops the device from a JID', () => {
    expect(bareJid('601:12@s.whatsapp.net')).toBe('601@s.whatsapp.net');
    expect(bareJid('plain')).toBe('plain');
  });

  it('a hand-over that cannot write its marker changes nothing', () => {
    makeDataDir(lite);
    writeFileSync(join(lite, 'moved.json'), '{}');
    expect(() =>
      handOver({ liteDataDir: lite, product: 'enterprise', version: '1', log: silentLogger() }),
    ).toThrow();
    expect(existsSync(join(lite, 'wa-auth'))).toBe(true);
    // the marker that was there already stays
    expect(readFileSync(join(lite, 'moved.json'), 'utf8')).toBe('{}');
  });

  it('undo after a finished hand-over puts the folders back and removes the marker', () => {
    makeDataDir(lite);
    const h = handOver({
      liteDataDir: lite,
      product: 'enterprise',
      version: '1',
      log: silentLogger(),
    });
    expect(h.renamed).toEqual(['wa-auth']);
    h.undo();
    expect(existsSync(join(lite, 'wa-auth', 'creds.json'))).toBe(true);
    expect(existsSync(join(lite, 'moved.json'))).toBe(false);
  });
});
