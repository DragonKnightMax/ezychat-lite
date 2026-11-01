// Read-only summary of a Lite data folder (`server --lite-summary <dir>`). Lite's app.db is opened
// read only and nothing in Lite's folder is written. The summary carries counts and names of the
// team, agents, quick replies and tokens only: never chat text, customers' names or numbers, nor
// any secret (the tunnel hostname is read from plain settings, the token never).
import Database from 'better-sqlite3';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LiteRemote, LiteRole, LiteSummary } from '@ezychat/shared';
import { NoLiteDataError } from './errors.js';
import { COPIED_ITEMS, pathBytes } from './files.js';

type DB = Database.Database;

/**
 * Runs `fn` on Lite's app.db opened read only (NoLiteDataError when it is missing). SQLite creates
 * the WAL side files even for a read-only reader of a stopped WAL database; the ones this read
 * created (and left empty) are removed again, so Lite's folder stays as it was.
 */
export function withLiteDb<T>(liteDataDir: string, fn: (db: DB) => T): T {
  const file = join(liteDataDir, 'app.db');
  if (!existsSync(file)) throw new NoLiteDataError(liteDataDir);
  const sidecars = [`${file}-wal`, `${file}-shm`];
  const existed = sidecars.map((p) => existsSync(p));
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
    try {
      if (
        !existed[0] &&
        !existed[1] &&
        existsSync(sidecars[0]!) &&
        statSync(sidecars[0]!).size === 0
      )
        for (const p of sidecars) rmSync(p, { force: true });
    } catch {
      // left as SQLite made them: harmless
    }
  }
}

/** Runs a query that may hit a table an older Lite does not have yet; `fallback` then. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const count = (db: DB, sql: string): number =>
  safe(() => (db.prepare(sql).get() as { n: number }).n, 0);

function setting<T>(db: DB, key: string): T | null {
  const row = safe(
    () =>
      db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value: string } | undefined,
    undefined,
  );
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/** `60123:12@s.whatsapp.net` → `60123@s.whatsapp.net` (device suffix dropped). */
export function bareJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(':')[0]!;
  return `${user}${jid.slice(at)}`;
}

/** The linked number of inbox 1 (alias-resolved own JID and its digits). */
export function liteOwnNumber(
  db: DB,
  liteDataDir: string,
): { ownJid: string | null; number: string | null } {
  let own = safe(
    () =>
      (
        db.prepare('SELECT own_jid FROM inboxes WHERE id = 1').get() as
          { own_jid: string | null } | undefined
      )?.own_jid ?? null,
    null,
  );
  if (!own) {
    // Never connected since multi-inbox: the WhatsApp creds still name the account.
    try {
      const creds = JSON.parse(
        readFileSync(join(liteDataDir, 'wa-auth', 'creds.json'), 'utf8'),
      ) as {
        me?: { id?: unknown };
      };
      if (typeof creds.me?.id === 'string') own = creds.me.id;
    } catch {
      // not linked
    }
  }
  if (!own) return { ownJid: null, number: null };
  let jid = bareJid(own);
  if (jid.endsWith('@lid')) {
    const pn = safe(
      () =>
        (
          db
            .prepare(
              'SELECT alias_jid FROM jid_aliases WHERE canonical_jid = ? ORDER BY learned_at DESC LIMIT 1',
            )
            .get(jid) as { alias_jid: string } | undefined
        )?.alias_jid ?? null,
      null,
    );
    if (pn) jid = bareJid(pn);
  }
  const digits = jid.endsWith('@s.whatsapp.net') ? jid.slice(0, jid.indexOf('@')) : null;
  return { ownJid: jid, number: digits && /^\d+$/.test(digits) ? `+${digits}` : null };
}

/** How Lite reached the internet, and its own address (hostname only). */
export function liteRemote(db: DB): { remote: LiteRemote; address: string | null } {
  const mode = setting<string>(db, 'tunnel_mode');
  if (mode === 'named') {
    const managed = setting<{ hostname?: unknown }>(db, 'cloudflare_managed_tunnel');
    const named = setting<string>(db, 'named_tunnel_hostname');
    if (managed && typeof managed.hostname === 'string')
      return { remote: 'managed', address: managed.hostname };
    return { remote: 'dashboard', address: typeof named === 'string' && named ? named : null };
  }
  // A quick tunnel's address is never stored: it changes on every start.
  if (mode === 'quick') return { remote: 'quick', address: null };
  return { remote: 'lan', address: null };
}

/** Lite's port: its desktop.json (beside the data folder), else the saved `port` setting. */
export function litePort(db: DB, liteDataDir: string): number | null {
  const valid = (p: unknown): p is number =>
    typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536;
  try {
    const desk = JSON.parse(readFileSync(join(dirname(liteDataDir), 'desktop.json'), 'utf8')) as {
      port?: unknown;
    };
    if (valid(desk.port)) return desk.port;
  } catch {
    // no desktop settings (service folder, CLI)
  }
  const saved = setting<unknown>(db, 'port');
  return valid(saved) ? saved : null;
}

/** Bytes the copy needs: app.db (+ its WAL) and every copied item. */
export function liteSizes(liteDataDir: string): { mediaBytes: number; totalBytes: number } {
  const mediaBytes = pathBytes(join(liteDataDir, 'media'));
  let totalBytes =
    pathBytes(join(liteDataDir, 'app.db')) + pathBytes(join(liteDataDir, 'app.db-wal'));
  for (const item of COPIED_ITEMS) totalBytes += pathBytes(join(liteDataDir, item));
  return { mediaBytes, totalBytes };
}

/** Reads the summary from an open (read-only) Lite db. */
export function summarizeLite(db: DB, liteDataDir: string): LiteSummary {
  const users = safe(
    () =>
      db
        .prepare(
          "SELECT id, username, display_name, role FROM users WHERE kind = 'human' AND disabled_at IS NULL ORDER BY id",
        )
        .all() as Array<{ id: number; username: string; display_name: string; role: LiteRole }>,
    [],
  );
  const agents = safe(
    () =>
      db
        .prepare(
          'SELECT a.id, u.display_name, u.disabled_at FROM ai_agents a JOIN users u ON u.id = a.user_id WHERE u.ai_deleted_at IS NULL ORDER BY a.id',
        )
        .all() as Array<{ id: number; display_name: string; disabled_at: number | null }>,
    [],
  );
  const shortcuts = safe(
    () =>
      (
        db.prepare('SELECT shortcut FROM quick_replies ORDER BY shortcut').all() as Array<{
          shortcut: string;
        }>
      ).map((r) => r.shortcut),
    [],
  );
  const now = Date.now();
  const tokens = safe(
    () =>
      (
        db
          .prepare(
            'SELECT name FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND oauth_client_id IS NULL ORDER BY id',
          )
          .all(now) as Array<{ name: string }>
      ).map((r) => ({ name: r.name, kind: 'token' as const })),
    safe(
      // before migration 018 there are no OAuth apps
      () =>
        (
          db
            .prepare(
              'SELECT name FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id',
            )
            .all(now) as Array<{ name: string }>
        ).map((r) => ({ name: r.name, kind: 'token' as const })),
      [],
    ),
  );
  const oauth = safe(
    () =>
      (
        db
          .prepare(
            'SELECT DISTINCT c.name FROM oauth_clients c JOIN api_tokens t ON t.oauth_client_id = c.id WHERE t.revoked_at IS NULL ORDER BY c.name',
          )
          .all() as Array<{ name: string }>
      ).map((r) => ({ name: r.name, kind: 'oauth' as const })),
    [],
  );
  const { ownJid, number } = liteOwnNumber(db, liteDataDir);
  const { remote, address } = liteRemote(db);
  return {
    dataDir: liteDataDir,
    schemaVersion: db.pragma('user_version', { simple: true }) as number,
    number,
    ownJid,
    chats: count(db, 'SELECT COUNT(*) AS n FROM chats'),
    customers: count(db, "SELECT COUNT(*) AS n FROM chats WHERE type = 'dm'"),
    messages: count(db, 'SELECT COUNT(*) AS n FROM messages'),
    ...liteSizes(liteDataDir),
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
    })),
    aiAgents: agents.map((a) => ({
      id: a.id,
      name: a.display_name,
      enabled: a.disabled_at === null,
    })),
    quickReplyShortcuts: shortcuts,
    tokens: [...tokens, ...oauth],
    remote,
    address,
    port: litePort(db, liteDataDir),
  };
}

/** Opens Lite's db read only, reads the summary and closes it. */
export function readLiteSummary(liteDataDir: string): LiteSummary {
  return withLiteDb(liteDataDir, (db) => summarizeLite(db, liteDataDir));
}
