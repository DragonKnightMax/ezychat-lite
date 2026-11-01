import { randomUUID } from 'node:crypto';
import type { LiteImportPlan, LiteRole } from '@ezychat/shared';
import type { SecretBox } from '../crypto/secret.js';
import { audit } from '../db/audit.js';
import type { DB } from '../db/index.js';
import { InboxRepo } from '../inboxes/repo.js';
import { moveOwnAddress } from './merge-address.js';
import { IdMaps, remapJson } from './merge-remap.js';

/**
 * How the merge treats every table of the core schema. `merge-coverage` pins that a table a new
 * migration adds is listed here, so a merge can never silently drop its rows.
 */
export const TABLE_PLAN: Readonly<Record<string, { merged: true } | { skip: string }>> = {
  users: { merged: true },
  inboxes: { merged: true },
  inbox_members: { merged: true },
  ai_agents: { merged: true },
  ai_documents: { merged: true },
  ai_setup_versions: { merged: true },
  reply_phrases: { merged: true },
  ai_chat_state: { merged: true },
  ai_group_chats: { merged: true },
  chats: { merged: true },
  messages: { merged: true },
  message_reactions: { merged: true },
  chat_events: { merged: true },
  notes: { merged: true },
  customer_profiles: { merged: true },
  customer_tags: { merged: true },
  contacts: { merged: true },
  jid_aliases: { merged: true },
  quick_replies: { merged: true },
  fix_english_words: { merged: true },
  audit_log: { merged: true },
  calendar_agent_settings: { merged: true },
  calendar_offers: { merged: true },
  calendar_bookings: { merged: true },
  calendar_activity: { merged: true },
  connector_connections: { merged: true },
  connector_agent_settings: { merged: true },
  connector_activity: { merged: true },
  connector_calls: { merged: true },
  connector_values: { merged: true },
  safety_items: { merged: true },
  safety_downloads: { merged: true },
  safety_numbers: { merged: true },
  settings: {
    skip: "install-wide settings stay the target's; only per-agent keys (ai_phrases_state:<id>) and Lite's own address (when the target has none, merge-address.ts) are copied",
  },
  sessions: { skip: 'not imported: everyone signs in again' },
  push_subscriptions: { skip: 'not imported: phones subscribe again' },
  api_tokens: { skip: 'not imported: AI assistants are reconnected (after-import checklist)' },
  oauth_clients: { skip: 'not imported: AI assistants are reconnected (after-import checklist)' },
  sqlite_sequence: { skip: 'SQLite internal' },
};

export interface MergeCounts {
  chats: number;
  messages: number;
  usersAdded: number;
  usersMatched: number;
  usersSkipped: number;
  agents: number;
  contacts: number;
  quickReplies: number;
  auditRows: number;
}

export interface MergeInput {
  target: DB;
  lite: DB;
  inboxId: number;
  inboxName: string;
  ownJid: string | null;
  plan: LiteImportPlan;
  maxAgents: number;
  /** null when Lite has no secret.key: its encrypted values cannot be read and are left out. */
  liteSecret: SecretBox | null;
  targetSecret: SecretBox;
  /** `media_path` prefix of the copied files (`inbox-<N>/`). */
  mediaPrefix: string;
  now: number;
  progress: (done: number, total: number) => void;
}

export interface MergeOutcome {
  counts: MergeCounts;
  agentImported: boolean;
  agentOff: boolean;
  renamedShortcuts: string[];
  /** Lite's own address (hostname) that moved to the target; null when it did not. */
  address: string | null;
}

type Row = Record<string, unknown>;

const columnsOf = (db: DB, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

/** An INSERT of every target column but `omit`; missing values become NULL. */
function inserter(db: DB, table: string, opts: { omit?: string[]; verb?: string } = {}) {
  const cols = columnsOf(db, table).filter((c) => !opts.omit?.includes(c));
  const stmt = db.prepare(
    `${opts.verb ?? 'INSERT'} INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
      .map((c) => `@${c}`)
      .join(', ')})`,
  );
  return (row: Row) => stmt.run(Object.fromEntries(cols.map((c) => [c, row[c] ?? null])));
}

const rows = (db: DB, sql: string, ...params: unknown[]) =>
  db.prepare(sql).iterate(...params) as IterableIterator<Row>;

const usernameTaken = (db: DB, name: string) =>
  db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(name) !== undefined;

/** `name`, else `name-lite`, `name-lite2`, … (the first free one). */
function freeName(db: DB, name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  for (let i = 1; ; i++) {
    const next = i === 1 ? `${name}-lite` : `${name}-lite${i}`;
    if (!taken(next)) return next;
  }
}

/** Decrypts with Lite's key and seals with the target's; null when it cannot be read. */
function reseal(blob: unknown, input: MergeInput): string | null {
  if (typeof blob !== 'string' || !input.liteSecret) return null;
  try {
    return input.targetSecret.encrypt(input.liteSecret.decrypt(blob));
  } catch {
    return null;
  }
}

function googleAccount(db: DB, box: SecretBox | null): string | null {
  if (!box) return null;
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'google_calendar_tokens'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  try {
    const account = (JSON.parse(box.decrypt(row.value)) as { account?: unknown }).account;
    return typeof account === 'string' && account ? account.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Copies Lite's data into the target as inbox N. Must run inside one transaction of `target`
 * (the caller's): any throw leaves the target as it was.
 */
export function mergeTables(input: MergeInput): MergeOutcome {
  const { target, lite, now } = input;
  const maps = new IdMaps(input.inboxId);
  const counts: MergeCounts = {
    chats: 0,
    messages: 0,
    usersAdded: 0,
    usersMatched: 0,
    usersSkipped: 0,
    agents: 0,
    contacts: 0,
    quickReplies: 0,
    auditRows: 0,
  };
  const phases: Array<() => void> = [];
  const phase = (fn: () => void) => phases.push(fn);
  let agentImported = false;
  let agentOff = false;
  const renamedShortcuts: string[] = [];
  /** Imported agents that came in off and unbound (no slot): their chats are released. */
  const offAgentUsers: number[] = [];
  const importedHumans: number[] = [];
  let address: string | null = null;

  // ── Users ──────────────────────────────────────────────────────────────────────────────────
  phase(() => {
    const choices = new Map(input.plan.team.map((c) => [c.liteUserId, c]));
    const addUser = inserter(target, 'users', { omit: ['id'] });
    for (const u of rows(lite, "SELECT * FROM users WHERE kind = 'human' ORDER BY id")) {
      const liteId = u.id as number;
      const username = u.username as string;
      const choice = choices.get(liteId);
      let action = choice?.action;
      let matchId = choice?.matchUserId ?? null;
      if (!action) {
        const same = target
          .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND kind = 'human'")
          .get(username) as { id: number } | undefined;
        action = same ? 'match' : 'add';
        matchId = same?.id ?? null;
      }
      if (action === 'match') {
        const hit = target
          .prepare("SELECT id FROM users WHERE id = ? AND kind = 'human'")
          .get(matchId) as { id: number } | undefined;
        if (!hit) throw new Error('import plan matches an unknown user');
        maps.users.set(liteId, hit.id);
        importedHumans.push(hit.id);
        counts.usersMatched++;
        continue;
      }
      const name = freeName(target, username, (n) => usernameTaken(target, n));
      // skip: a disabled row without inbox access, so names on old messages and notes still show
      const skip = action === 'skip';
      const role: LiteRole = skip ? 'agent' : (choice?.role ?? (u.role as LiteRole));
      const id = Number(
        addUser({
          ...u,
          username: name,
          role,
          disabled_at: skip ? now : u.disabled_at,
        }).lastInsertRowid,
      );
      maps.users.set(liteId, id);
      if (skip) counts.usersSkipped++;
      else {
        importedHumans.push(id);
        counts.usersAdded++;
      }
    }
  });

  // ── Inbox N and its members ────────────────────────────────────────────────────────────────
  phase(() => {
    const repo = new InboxRepo(target);
    const row = repo.insert(input.inboxName, repo.nextTone(), now);
    if (row.id !== input.inboxId) throw new Error('inbox id changed during the import');
    repo.setOwnJid(row.id, input.ownJid);
    const add = target.prepare(
      'INSERT OR IGNORE INTO inbox_members (inbox_id, user_id) VALUES (?, ?)',
    );
    for (const id of importedHumans) add.run(row.id, id);
  });

  // ── AI agents (their users, Business context, versions, phrases, per-agent settings) ────────
  phase(() => {
    const addUser = inserter(target, 'users', { omit: ['id'] });
    const addAgent = inserter(target, 'ai_agents', { omit: ['id'] });
    const liveAgents = (
      target
        .prepare(
          'SELECT COUNT(*) AS n FROM ai_agents a JOIN users u ON u.id = a.user_id WHERE u.ai_deleted_at IS NULL',
        )
        .get() as { n: number }
    ).n;
    let slots = Math.max(0, input.maxAgents - liveAgents);
    const addAiUser = (u: Row, patch: Row): number => {
      const name = freeName(target, u.username as string, (n) => usernameTaken(target, n));
      const id = Number(addUser({ ...u, ...patch, username: name }).lastInsertRowid);
      maps.users.set(u.id as number, id);
      return id;
    };
    // The agent of inbox 1 first: it takes the free slot, if any.
    const agents = lite
      .prepare(
        `SELECT a.*, u.id AS u_id FROM ai_agents a JOIN users u ON u.id = a.user_id
         WHERE u.ai_deleted_at IS NULL ORDER BY a.inbox_id IS NULL, a.id`,
      )
      .all() as Row[];
    const userRow = lite.prepare('SELECT * FROM users WHERE id = ?');
    agents.forEach((agent, i) => {
      const bind = i === 0 && slots > 0;
      if (bind) slots--;
      const u = userRow.get(agent.user_id) as Row;
      const userId = addAiUser(u, { disabled_at: bind ? u.disabled_at : (u.disabled_at ?? now) });
      if (!bind) offAgentUsers.push(userId);
      agentImported = true;
      if (i === 0) agentOff = !bind;
      const agentId = Number(
        addAgent({
          ...agent,
          user_id: userId,
          inbox_id: bind ? input.inboxId : null,
          updated_at: now,
        }).lastInsertRowid,
      );
      maps.agents.set(agent.id as number, agentId);
      counts.agents++;
    });
    // Users of deleted agents: names on old messages only.
    for (const u of rows(lite, "SELECT * FROM users WHERE kind = 'ai' ORDER BY id")) {
      if (maps.users.has(u.id as number)) continue;
      addAiUser(u, { disabled_at: u.disabled_at ?? now, ai_deleted_at: u.ai_deleted_at ?? now });
    }

    const addDoc = inserter(target, 'ai_documents', { omit: ['id'] });
    for (const d of rows(
      lite,
      'SELECT * FROM ai_documents WHERE agent_id IS NOT NULL ORDER BY id',
    )) {
      const agentId = maps.agent(d.agent_id);
      if (agentId === null) continue;
      maps.documents.set(
        d.id as number,
        Number(addDoc({ ...d, agent_id: agentId }).lastInsertRowid),
      );
    }
    const addVersion = inserter(target, 'ai_setup_versions', { omit: ['id'] });
    for (const v of rows(lite, 'SELECT * FROM ai_setup_versions ORDER BY id')) {
      const agentId = maps.agent(v.agent_id);
      if (agentId === null) continue;
      const itemId = typeof v.item_id === 'number' ? (maps.documents.get(v.item_id) ?? null) : null;
      if (v.item_id !== null && itemId === null) continue;
      addVersion({
        ...v,
        agent_id: agentId,
        item_id: itemId,
        user_id: maps.user(v.user_id),
        token_id: null,
      });
    }
    const addPhrase = inserter(target, 'reply_phrases', { omit: ['id'] });
    for (const p of rows(lite, 'SELECT * FROM reply_phrases ORDER BY id')) {
      const agentId = maps.agent(p.agent_id);
      if (agentId === null) continue;
      maps.phrases.set(
        p.id as number,
        Number(addPhrase({ ...p, agent_id: agentId }).lastInsertRowid),
      );
    }
    const setSetting = target.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const s of rows(
      lite,
      "SELECT key, value FROM settings WHERE key LIKE 'ai_phrases_state:%'",
    )) {
      const agentId = maps.agent(Number((s.key as string).slice('ai_phrases_state:'.length)));
      if (agentId !== null) setSetting.run(`ai_phrases_state:${agentId}`, s.value);
    }
  });

  // ── Own address (only when the target has none) ────────────────────────────────────────────
  phase(() => {
    address = moveOwnAddress(target, lite, input.liteSecret, input.targetSecret);
  });

  // ── Connectors: connections (target wins), per-agent settings, Google Calendar settings ────
  let sameGoogle = false;
  phase(() => {
    const addConnection = inserter(target, 'connector_connections');
    const has = target.prepare('SELECT 1 FROM connector_connections WHERE connector_id = ?');
    for (const c of rows(lite, 'SELECT * FROM connector_connections')) {
      if (has.get(c.connector_id)) continue;
      const secret = c.secret === null ? null : reseal(c.secret, input);
      const lost = c.secret !== null && secret === null;
      addConnection({
        ...c,
        secret,
        state: lost && c.state === 'connected' ? 'needs_sign_in' : c.state,
        updated_at: now,
      });
    }
    const addSettings = inserter(target, 'connector_agent_settings');
    for (const s of rows(lite, 'SELECT * FROM connector_agent_settings')) {
      const agentId = maps.agent(s.agent_id);
      if (agentId === null || !has.get(s.connector_id)) continue;
      addSettings({ ...s, agent_id: agentId });
    }
    const liteAccount = googleAccount(lite, input.liteSecret);
    sameGoogle = liteAccount !== null && liteAccount === googleAccount(target, input.targetSecret);
    if (sameGoogle) {
      const addCal = inserter(target, 'calendar_agent_settings');
      for (const s of rows(lite, 'SELECT * FROM calendar_agent_settings')) {
        const agentId = maps.agent(s.agent_id);
        if (agentId !== null) addCal({ ...s, agent_id: agentId });
      }
    }
  });

  // ── Shared tables: contacts, aliases, Safety numbers (target wins, empty fields filled) ─────
  phase(() => {
    const addContact = inserter(target, 'contacts', { verb: 'INSERT OR IGNORE' });
    const fill = target.prepare(
      `UPDATE contacts SET
         push_name = COALESCE(NULLIF(push_name, ''), @push_name),
         saved_name = COALESCE(NULLIF(saved_name, ''), @saved_name),
         phone = COALESCE(NULLIF(phone, ''), @phone)
       WHERE jid = @jid`,
    );
    for (const c of rows(lite, 'SELECT * FROM contacts')) {
      if (addContact(c).changes) counts.contacts++;
      else fill.run(c);
    }
    const addAlias = inserter(target, 'jid_aliases', { verb: 'INSERT OR IGNORE' });
    for (const a of rows(lite, 'SELECT * FROM jid_aliases')) addAlias(a);
    const addNumber = inserter(target, 'safety_numbers', { verb: 'INSERT OR IGNORE' });
    for (const n of rows(lite, 'SELECT * FROM safety_numbers'))
      addNumber({ ...n, scam_by: maps.user(n.scam_by), blocked_by: maps.user(n.blocked_by) });
  });

  // ── Chats and everything keyed by chat or message ─────────────────────────────────────────
  const mediaPath = (p: unknown): unknown => {
    if (typeof p !== 'string' || !p) return p;
    return p.startsWith('quarantine/')
      ? `quarantine/${input.mediaPrefix}${p.slice('quarantine/'.length)}`
      : `${input.mediaPrefix}${p}`;
  };
  phase(() => {
    const addChat = inserter(target, 'chats');
    for (const c of rows(lite, 'SELECT * FROM chats')) {
      const jid = maps.chat(c.jid as string);
      if (!jid) continue;
      addChat({
        ...c,
        jid,
        inbox_id: input.inboxId,
        wa_jid: c.wa_jid ?? c.jid,
        assigned_to: maps.user(c.assigned_to),
      });
      counts.chats++;
    }
  });
  phase(() => {
    const addMessage = inserter(target, 'messages');
    for (const m of rows(lite, 'SELECT * FROM messages')) {
      const id = maps.message(m.id as string);
      const chat = maps.chat(m.chat_jid as string);
      if (!id || !chat) continue;
      addMessage({
        ...m,
        id,
        chat_jid: chat,
        quoted_id: maps.message(m.quoted_id as string | null),
        sent_by_user_id: maps.user(m.sent_by_user_id),
        sent_via_token_id: null,
        media_path: mediaPath(m.media_path),
      });
      counts.messages++;
    }
    const addReaction = inserter(target, 'message_reactions');
    for (const r of rows(lite, 'SELECT * FROM message_reactions')) {
      const id = maps.message(r.message_id as string);
      if (id) addReaction({ ...r, message_id: id, sent_by_user_id: maps.user(r.sent_by_user_id) });
    }
  });
  phase(() => {
    const addEvent = inserter(target, 'chat_events', { omit: ['id'] });
    for (const e of rows(lite, 'SELECT * FROM chat_events ORDER BY id')) {
      const chat = maps.chat(e.chat_jid as string);
      if (!chat) continue;
      addEvent({
        ...e,
        chat_jid: chat,
        actor_id: maps.user(e.actor_id),
        payload: remapJson(e.payload as string, maps),
      });
    }
    const addNote = inserter(target, 'notes', { omit: ['id'] });
    for (const n of rows(lite, 'SELECT * FROM notes ORDER BY id')) {
      const chat = maps.chat(n.chat_jid as string);
      if (!chat) continue;
      const userId = maps.user(n.user_id);
      if (userId === null) throw new Error('a note names an unknown Lite user');
      addNote({ ...n, chat_jid: chat, user_id: userId });
    }
    const addState = inserter(target, 'ai_chat_state');
    for (const s of rows(lite, 'SELECT * FROM ai_chat_state')) {
      const chat = maps.chat(s.chat_jid as string);
      if (!chat) continue;
      addState({
        ...s,
        chat_jid: chat,
        last_customer_message_id: maps.message(s.last_customer_message_id as string | null),
        last_replied_message_id: maps.message(s.last_replied_message_id as string | null),
      });
    }
    const addGroup = inserter(target, 'ai_group_chats');
    for (const g of rows(lite, 'SELECT * FROM ai_group_chats')) {
      const chat = maps.chat(g.chat_jid as string);
      if (chat) addGroup({ ...g, chat_jid: chat, updated_by: maps.user(g.updated_by) });
    }
    const addProfile = inserter(target, 'customer_profiles');
    const idTaken = target.prepare('SELECT 1 FROM customer_profiles WHERE id = ?');
    for (const p of rows(lite, 'SELECT * FROM customer_profiles')) {
      const chat = maps.chat(p.chat_jid as string);
      if (!chat) continue;
      addProfile({
        ...p,
        chat_jid: chat,
        id: idTaken.get(p.id) ? randomUUID() : p.id,
        updated_by: maps.user(p.updated_by),
      });
    }
    const addTag = inserter(target, 'customer_tags');
    for (const t of rows(lite, 'SELECT * FROM customer_tags')) {
      const chat = maps.chat(t.chat_jid as string);
      if (chat) addTag({ ...t, chat_jid: chat });
    }
  });

  // ── Calendar and partner connector history ───────────────────────────────────────────────
  phase(() => {
    const byChatAndAgent = (table: string, required: boolean) => {
      const add = inserter(target, table, { omit: ['id'] });
      for (const r of rows(lite, `SELECT * FROM ${table} ORDER BY id`)) {
        const chat = maps.chat(r.chat_jid as string | null);
        if (r.chat_jid !== null && !chat) continue;
        const agentId = maps.agent(r.agent_id);
        if (required && agentId === null) continue;
        add({
          ...r,
          chat_jid: chat,
          agent_id: agentId,
          consent_message_id: maps.message(r.consent_message_id as string | null),
        });
      }
    };
    // Offers and bookings belong to Lite's Google account: only when it is the target's too.
    if (sameGoogle) {
      byChatAndAgent('calendar_offers', true);
      byChatAndAgent('calendar_bookings', true);
    }
    byChatAndAgent('calendar_activity', false);
    byChatAndAgent('connector_activity', false);
    byChatAndAgent('connector_calls', false);
    byChatAndAgent('connector_values', false);
  });

  // ── WhatsApp Safety findings ─────────────────────────────────────────────────────────────
  phase(() => {
    const addItem = inserter(target, 'safety_items', { omit: ['id'] });
    for (const s of rows(lite, 'SELECT * FROM safety_items ORDER BY id')) {
      const id = maps.message(s.message_id as string);
      const chat = maps.chat(s.chat_jid as string);
      if (!id || !chat) continue;
      const newId = addItem({
        ...s,
        message_id: id,
        chat_jid: chat,
        inbox_id: input.inboxId,
        deleted_by: maps.user(s.deleted_by),
      }).lastInsertRowid;
      maps.safetyItems.set(s.id as number, Number(newId));
    }
    const addDownload = inserter(target, 'safety_downloads', { omit: ['id'] });
    for (const d of rows(lite, 'SELECT * FROM safety_downloads ORDER BY id')) {
      const itemId = maps.safetyItems.get(d.item_id as number);
      const userId = maps.user(d.user_id);
      if (itemId !== undefined && userId !== null)
        addDownload({ ...d, item_id: itemId, user_id: userId });
    }
  });

  // ── Union tables: quick replies (clash → `<shortcut>-lite`), Fix English words ────────────
  phase(() => {
    const addReply = inserter(target, 'quick_replies', { omit: ['id'] });
    const existing = target.prepare('SELECT body FROM quick_replies WHERE shortcut = ?');
    const taken = (s: string) => existing.get(s) !== undefined;
    for (const q of rows(lite, 'SELECT * FROM quick_replies ORDER BY id')) {
      const shortcut = q.shortcut as string;
      const same = existing.get(shortcut) as { body: string } | undefined;
      if (same?.body === q.body) continue; // the very same reply: nothing to add
      const name = freeName(target, shortcut, taken);
      if (name !== shortcut) renamedShortcuts.push(name);
      addReply({ ...q, shortcut: name, created_by: maps.user(q.created_by) });
      counts.quickReplies++;
    }
    const addWord = inserter(target, 'fix_english_words', { verb: 'INSERT OR IGNORE' });
    for (const w of rows(lite, 'SELECT * FROM fix_english_words'))
      addWord({ ...w, added_by: maps.user(w.added_by) });
  });

  // ── Audit rows (remapped), then release chats of an agent that came in off ───────────────
  phase(() => {
    const addAudit = inserter(target, 'audit_log', { omit: ['id'] });
    for (const a of rows(lite, 'SELECT * FROM audit_log ORDER BY id')) {
      addAudit({ ...a, user_id: maps.user(a.user_id), meta: remapJson(a.meta as string, maps) });
      counts.auditRows++;
    }
    for (const userId of offAgentUsers) {
      target
        .prepare(
          `UPDATE ai_chat_state SET paused = 1, awaiting_confirmation = 0, due_at = NULL
           WHERE chat_jid IN (SELECT jid FROM chats WHERE assigned_to = ?)`,
        )
        .run(userId);
      target.prepare('UPDATE chats SET assigned_to = NULL WHERE assigned_to = ?').run(userId);
    }
    audit(target, {
      userId: null,
      action: 'lite.import',
      ip: null,
      meta: {
        inbox: input.inboxId,
        counts: { ...counts, agentImported, agentOff, renamedShortcuts: renamedShortcuts.length },
        addressMoved: address !== null,
      },
    });
  });

  phases.forEach((run, i) => {
    run();
    input.progress(i + 1, phases.length);
  });
  return { counts, agentImported, agentOff, renamedShortcuts, address };
}
