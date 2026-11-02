/**
 * One customer, one profile across inboxes. A person who writes to two of our WhatsApp numbers has a
 * direct chat in each inbox (`<waJid>` and `<waJid>#<id>`, possibly one under the phone-number JID
 * and one under the WhatsApp ID). Their contact fields (name, company, email, other phone, address)
 * are kept the same on every one of those chats. Tags stay per chat: an agent never learns the tags
 * of an inbox they cannot open.
 *
 * Identity is WhatsApp's own (the exact JID, or a phone-number/LID pair in `jid_aliases`), never a
 * name or a number typed by a person. A phone number that WhatsApp moved to another person
 * (`repointed_from`) links nothing: its old chat belongs to the old owner.
 *
 * A leaf module (db, keys and the profile repo only), so chats/repo can seed a new chat from it.
 */
import type { DB } from '../db/index.js';
import { chatKey, parseChatKey } from '../inboxes/keys.js';
import { CustomerRepo } from './repo.js';

interface AliasRow {
  canonical_jid: string;
  repointed_from: string | null;
}

/** Every WhatsApp JID of the person behind `waJid`; empty for a re-pointed phone number. */
function personJids(db: DB, waJid: string): string[] {
  let lid: string | null = waJid.endsWith('@lid') ? waJid : null;
  if (!lid && waJid.endsWith('@s.whatsapp.net')) {
    const row = db
      .prepare('SELECT canonical_jid, repointed_from FROM jid_aliases WHERE alias_jid = ?')
      .get(waJid) as AliasRow | undefined;
    if (row?.repointed_from) return [];
    lid = row?.canonical_jid ?? null;
  }
  if (!lid) return [waJid];
  const pns = (
    db
      .prepare(
        'SELECT alias_jid FROM jid_aliases WHERE canonical_jid = ? AND repointed_from IS NULL',
      )
      .all(lid) as Array<{ alias_jid: string }>
  ).map((r) => r.alias_jid);
  return [...new Set([lid, waJid, ...pns])];
}

/**
 * The other direct chats of the same person, in every inbox (removed ones included), in inbox order.
 * Primary-key look-ups only. Not `chatJid` itself; empty for a group or an unknown key.
 */
export function linkedChats(db: DB, chatJid: string): string[] {
  let waJid: string;
  try {
    waJid = parseChatKey(chatJid).waJid;
  } catch {
    return [];
  }
  if (waJid.endsWith('@g.us')) return [];
  const jids = personJids(db, waJid);
  if (!jids.length) return [];
  const inboxes = (
    db.prepare('SELECT id FROM inboxes ORDER BY id').all() as Array<{ id: number }>
  ).map((r) => r.id);
  // A data dir from before multi-inbox has no inbox rows: inbox 1 only, so nothing links.
  if (inboxes.length < 2) return [];
  const keys = inboxes
    .flatMap((id) => jids.map((j) => chatKey(id, j)))
    .filter((k) => k !== chatJid);
  if (!keys.length) return [];
  return (
    db
      .prepare(
        `SELECT jid FROM chats WHERE type = 'dm' AND jid IN (${keys.map(() => '?').join(', ')})
         ORDER BY inbox_id, jid`,
      )
      .all(...keys) as Array<{ jid: string }>
  ).map((r) => r.jid);
}

interface FieldsRow {
  name: string | null;
  company: string | null;
  email: string | null;
  other_phone: string | null;
  address: string | null;
  updated_at: number;
  updated_by: number | null;
}

const FIELDS_SQL =
  'SELECT name, company, email, other_phone, address, updated_at, updated_by FROM customer_profiles WHERE chat_jid = ?';

/**
 * Gives a chat that has no saved contact fields yet the newest ones of the same person in another
 * inbox (the original editor and time; its own tags and a new profile id). Never overwrites: a chat
 * with a saved profile is left alone. Returns true when it copied one.
 */
export function seedFromLinked(db: DB, chatJid: string): boolean {
  if (db.prepare(FIELDS_SQL).get(chatJid)) return false;
  const newest = linkedChats(db, chatJid)
    .map((jid) => db.prepare(FIELDS_SQL).get(jid) as FieldsRow | undefined)
    .filter((r): r is FieldsRow => !!r)
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  if (!newest) return false;
  const repo = new CustomerRepo(db);
  repo.save(
    chatJid,
    {
      name: newest.name,
      company: newest.company,
      email: newest.email,
      otherPhone: newest.other_phone,
      address: newest.address,
    },
    repo.tags(chatJid),
    newest.updated_by,
    newest.updated_at,
  );
  return true;
}

/**
 * Permanent start-up step: every direct chat without saved contact fields takes the newest ones of the
 * same person in another inbox (chats linked before this sync existed). Non-destructive. Counts only.
 */
export function seedAllFromLinked(db: DB): number {
  const inboxes = (db.prepare('SELECT COUNT(*) AS n FROM inboxes').get() as { n: number }).n;
  if (inboxes < 2) return 0;
  const bare = db
    .prepare(
      `SELECT c.jid FROM chats c WHERE c.type = 'dm'
         AND NOT EXISTS (SELECT 1 FROM customer_profiles p WHERE p.chat_jid = c.jid)`,
    )
    .all() as Array<{ jid: string }>;
  let seeded = 0;
  db.transaction(() => {
    for (const { jid } of bare) if (seedFromLinked(db, jid)) seeded++;
  })();
  return seeded;
}
