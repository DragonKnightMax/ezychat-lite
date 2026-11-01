import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { numberOfJid } from '../inboxes/service.js';
import { LiteImportRefused } from './errors.js';
import { pathBytes } from './files.js';

/** Opens a database file read-only (never creates, migrates or checkpoints it). */
export function openReadOnly(file: string): DB {
  return new Database(file, { readonly: true, fileMustExist: true });
}

export function userVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** `60123:12@s.whatsapp.net` → `60123@s.whatsapp.net` (the device part never names the number). */
export function bareJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  return `${jid.slice(0, at).split(':')[0]}${jid.slice(at)}`;
}

const hasTable = (db: DB, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

/** The JID itself, its canonical LID and every alias of it, through one database's `jid_aliases`. */
export function identityOf(db: DB, jid: string): Set<string> {
  const own = bareJid(jid);
  const out = new Set([own]);
  if (!hasTable(db, 'jid_aliases')) return out;
  const canonical = db
    .prepare('SELECT canonical_jid FROM jid_aliases WHERE alias_jid = ?')
    .get(own) as { canonical_jid: string } | undefined;
  if (canonical) out.add(canonical.canonical_jid);
  for (const c of [...out]) {
    for (const r of db
      .prepare('SELECT alias_jid FROM jid_aliases WHERE canonical_jid = ?')
      .all(c) as Array<{ alias_jid: string }>)
      out.add(r.alias_jid);
  }
  return out;
}

/** Lite inbox 1's linked own JID, or null when Lite was never linked. */
export function liteOwnJid(lite: DB): string | null {
  const row = lite.prepare('SELECT own_jid FROM inboxes WHERE id = 1').get() as
    { own_jid: string | null } | undefined;
  return row?.own_jid ? bareJid(row.own_jid) : null;
}

/** Lite's phone number (digits) from its own JID, through an alias when the JID is a LID. */
export function liteNumber(lite: DB, ownJid: string | null): string | null {
  if (!ownJid) return null;
  for (const jid of identityOf(lite, ownJid))
    if (jid.endsWith('@s.whatsapp.net')) return numberOfJid(jid);
  return null;
}

/**
 * Refuses `same_number` when Lite's linked number is already an active inbox of the target
 * (compared alias-resolved through both databases' `jid_aliases`).
 */
export function checkSameNumber(lite: DB, target: DB): void {
  const own = liteOwnJid(lite);
  if (!own) return;
  const liteIds = new Set([...identityOf(lite, own), ...identityOf(target, own)]);
  const rows = target
    .prepare('SELECT own_jid FROM inboxes WHERE removed_at IS NULL AND own_jid IS NOT NULL')
    .all() as Array<{ own_jid: string }>;
  for (const r of rows) {
    const ids = new Set([...identityOf(target, r.own_jid), ...identityOf(lite, r.own_jid)]);
    for (const id of ids) if (liteIds.has(id)) throw new LiteImportRefused('same_number');
  }
}

/** Refuses `no_slot` when the target has no free inbox slot. */
export function checkInboxSlot(target: DB, maxInboxes: number): void {
  const { n } = target
    .prepare('SELECT COUNT(*) AS n FROM inboxes WHERE removed_at IS NULL')
    .get() as { n: number };
  if (n >= maxInboxes) throw new LiteImportRefused('no_slot');
}

/** Bytes the merge needs beside the target: work copy, pre-import backup, WhatsApp folder and media. */
export function mergeBytes(targetDataDir: string, liteDataDir: string): number {
  return (
    pathBytes(join(liteDataDir, 'app.db')) * 2 +
    pathBytes(join(targetDataDir, 'app.db')) +
    pathBytes(join(liteDataDir, 'wa-auth')) +
    pathBytes(join(liteDataDir, 'media'))
  );
}
