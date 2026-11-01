import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPasswordSync } from '../src/auth/passwords.js';
import { SecretBox } from '../src/crypto/secret.js';
import { openDb, type DB } from '../src/db/index.js';
import { InboxRepo } from '../src/inboxes/repo.js';

const dirs: string[] = [];

export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export function cleanupDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
}

export const NOW = Date.now();
export const TARGET_PASSWORD = 'target-pass-1';

export function addUser(
  db: DB,
  username: string,
  role: 'admin' | 'agent',
  opts: { kind?: 'human' | 'ai'; password?: string } = {},
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, role, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        username,
        username.toUpperCase(),
        opts.kind === 'ai' ? '' : hashPasswordSync(opts.password ?? 'lite-pass-1'),
        role,
        opts.kind ?? 'human',
        NOW - 10_000,
      ).lastInsertRowid,
  );
}

function addAgent(
  db: DB,
  name: string,
  inboxId: number | null,
): { userId: number; agentId: number } {
  const userId = addUser(db, `ai-${name}`, 'agent', { kind: 'ai' });
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, userId);
  const agentId = Number(
    db
      .prepare(
        `INSERT INTO ai_agents (user_id, inbox_id, preset, instructions, created_at, updated_at)
         VALUES (?, ?, 'sales', ?, ?, ?)`,
      )
      .run(userId, inboxId, `${name} instructions`, NOW, NOW).lastInsertRowid,
  );
  return { userId, agentId };
}

function addChat(
  db: DB,
  jid: string,
  opts: { inboxId?: number; type?: 'dm' | 'group'; assignedTo?: number | null } = {},
) {
  const inboxId = opts.inboxId ?? 1;
  const waJid = jid.split('#')[0]!;
  db.prepare(
    `INSERT INTO chats (jid, type, name, status, assigned_to, updated_at, inbox_id, wa_jid, last_message_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    opts.type ?? 'dm',
    `Chat ${waJid}`,
    opts.assignedTo ?? null,
    NOW,
    inboxId,
    waJid,
    NOW - 3_000_000,
  );
}

function addMessage(
  db: DB,
  id: string,
  chatJid: string,
  opts: {
    fromMe?: boolean;
    userId?: number | null;
    media?: string | null;
    quoted?: string;
    at?: number;
  } = {},
) {
  const at = opts.at ?? NOW - 3_600_000;
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender_jid, from_me, sent_by_user_id, type, body, media_path,
       media_status, quoted_id, status, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'hello', ?, ?, ?, 'sent', ?, ?)`,
  ).run(
    id,
    chatJid,
    opts.fromMe ? null : chatJid.split('#')[0],
    opts.fromMe ? 1 : 0,
    opts.userId ?? null,
    opts.media ? 'image' : 'text',
    opts.media ?? null,
    opts.media ? 'ok' : 'none',
    opts.quoted ?? null,
    at,
    at,
  );
}

export interface Target {
  dir: string;
  bossId: number;
  amyId: number;
}

/** An Enterprise data folder with data: 2 inboxes, users, an AI agent, chats and a shared contact. */
export function seedTarget(opts: { inboxes?: number; googleAccount?: string } = {}): Target {
  const dir = tempDir('lite-merge-target-');
  const secret = SecretBox.loadOrCreate(join(dir, 'secret.key'));
  const db = openDb(join(dir, 'app.db'));
  const repo = new InboxRepo(db);
  repo.setOwnJid(1, '60111@s.whatsapp.net');
  for (let i = 2; i <= (opts.inboxes ?? 2); i++) {
    const row = repo.insert(`Inbox ${i}`, repo.nextTone(), NOW);
    repo.setOwnJid(row.id, `60${i}${i}${i}@s.whatsapp.net`);
  }
  const bossId = addUser(db, 'boss', 'admin', { password: TARGET_PASSWORD });
  const amyId = addUser(db, 'amy', 'agent', { password: TARGET_PASSWORD });
  repo.setMembers(1, [amyId]);
  addAgent(db, 'Target AI', 1);
  addChat(db, '60500@s.whatsapp.net', { assignedTo: amyId });
  addMessage(db, 'T1', '60500@s.whatsapp.net');
  db.prepare(
    "INSERT INTO contacts (jid, push_name, saved_name, phone) VALUES ('60999@s.whatsapp.net', NULL, 'Target Name', NULL)",
  ).run();
  db.prepare(
    "INSERT INTO quick_replies (shortcut, body, created_by, updated_at) VALUES ('hi', 'Hello from target', ?, ?)",
  ).run(bossId, NOW);
  db.prepare(
    "INSERT INTO fix_english_words (word, added_by, created_at) VALUES ('ezychat', NULL, ?)",
  ).run(NOW);
  if (opts.googleAccount) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('google_calendar_tokens', ?)").run(
      secret.encrypt(
        JSON.stringify({ account: opts.googleAccount, refreshToken: 'r', accessToken: 'a' }),
      ),
    );
  }
  db.close();
  return { dir, bossId, amyId };
}

export interface Lite {
  dir: string;
  ids: { amy: number; lee: number; sam: number; ai: number; agent: number };
  connectorSecret: string;
}

export const LITE_CHAT = '60999@s.whatsapp.net';
export const LITE_GROUP = '1203@g.us';

/** A Lite data folder: overlapping username, the same contact, the same shortcut, an AI agent. */
export function seedLite(opts: { ownJid?: string; googleAccount?: string } = {}): Lite {
  const dir = tempDir('lite-merge-lite-');
  const secret = SecretBox.loadOrCreate(join(dir, 'secret.key'));
  const db = openDb(join(dir, 'app.db'));
  db.prepare('UPDATE inboxes SET own_jid = ? WHERE id = 1').run(
    opts.ownJid ?? '60333:7@s.whatsapp.net',
  );
  const amy = addUser(db, 'amy', 'agent');
  const lee = addUser(db, 'lee', 'agent');
  const sam = addUser(db, 'sam', 'agent');
  const { userId: ai, agentId: agent } = addAgent(db, 'Lite AI', 1);
  // a deleted agent's user: only names on old messages
  const gone = addUser(db, 'ai-gone', 'agent', { kind: 'ai' });
  db.prepare('UPDATE users SET ai_deleted_at = ? WHERE id = ?').run(NOW, gone);

  addChat(db, LITE_CHAT, { assignedTo: ai });
  addChat(db, '60888@s.whatsapp.net', { assignedTo: lee });
  addChat(db, LITE_GROUP, { type: 'group' });
  mkdirSync(join(dir, 'media', '60999_s_whatsapp_net'), { recursive: true });
  writeFileSync(join(dir, 'media', '60999_s_whatsapp_net', 'M1.jpg'), 'jpeg-bytes');
  mkdirSync(join(dir, 'media', 'quarantine', '60888_s_whatsapp_net'), { recursive: true });
  writeFileSync(join(dir, 'media', 'quarantine', '60888_s_whatsapp_net', 'M4.exe.bin'), 'bad');
  addMessage(db, 'M1', LITE_CHAT, { media: '60999_s_whatsapp_net/M1.jpg' });
  addMessage(db, 'M2', LITE_CHAT, { fromMe: true, userId: ai, quoted: 'M1', at: NOW - 3_500_000 });
  addMessage(db, 'M3', '60888@s.whatsapp.net', { at: NOW - 3_400_000 });
  addMessage(db, 'M4', '60888@s.whatsapp.net', {
    media: 'quarantine/60888_s_whatsapp_net/M4.exe.bin',
    at: NOW - 3_300_000,
  });
  addMessage(db, 'M5', '60888@s.whatsapp.net', { fromMe: true, userId: gone, at: NOW - 3_200_000 });
  addMessage(db, 'local-abc', '60888@s.whatsapp.net', {
    fromMe: true,
    userId: sam,
    at: NOW - 3_100_000,
  });
  addMessage(db, 'G1', LITE_GROUP, { at: NOW - 3_000_000 });
  db.prepare(
    `INSERT INTO message_reactions (message_id, reactor, chat_wa_jid, emoji, from_me, reacted_at, sent_by_user_id)
     VALUES ('M1', 'me', ?, '👍', 1, ?, ?)`,
  ).run(LITE_CHAT, NOW, lee);
  db.prepare(
    "INSERT INTO notes (chat_jid, user_id, body, created_at) VALUES (?, ?, 'call back', ?)",
  ).run('60888@s.whatsapp.net', lee, NOW);
  db.prepare(
    "INSERT INTO chat_events (chat_jid, type, actor_id, payload, at) VALUES (?, 'assigned', ?, ?, ?)",
  ).run('60888@s.whatsapp.net', amy, JSON.stringify({ assignedTo: lee, previous: null }), NOW);
  db.prepare(
    "INSERT INTO ai_chat_state (chat_jid, paused, last_customer_message_id, last_replied_message_id) VALUES (?, 0, 'M1', 'M2')",
  ).run(LITE_CHAT);
  db.prepare(
    'INSERT INTO ai_group_chats (chat_jid, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)',
  ).run(LITE_GROUP, NOW, amy);
  db.prepare(
    `INSERT INTO customer_profiles (chat_jid, id, name, email, updated_at, updated_by)
     VALUES (?, 'profile-1', 'Customer One', 'one@example.com', ?, ?)`,
  ).run(LITE_CHAT, NOW, lee);
  db.prepare(
    "INSERT INTO customer_tags (chat_jid, tag, tag_key, created_at) VALUES (?, 'VIP', 'vip', ?)",
  ).run(LITE_CHAT, NOW);
  db.prepare(
    "INSERT INTO contacts (jid, push_name, saved_name, phone) VALUES (?, 'Lite Push', 'Lite Saved', '60999')",
  ).run(LITE_CHAT);
  db.prepare(
    "INSERT INTO contacts (jid, push_name, saved_name, phone) VALUES ('60888@s.whatsapp.net', 'Other', NULL, '60888')",
  ).run();
  db.prepare(
    "INSERT INTO jid_aliases (alias_jid, canonical_jid, source, learned_at) VALUES ('60777@s.whatsapp.net', '777@lid', 'message', ?)",
  ).run(NOW);
  db.prepare(
    "INSERT INTO quick_replies (shortcut, body, created_by, updated_at) VALUES ('hi', 'Hello from lite', ?, ?)",
  ).run(lee, NOW);
  db.prepare(
    "INSERT INTO quick_replies (shortcut, body, created_by, updated_at) VALUES ('price', 'RM 10', ?, ?)",
  ).run(lee, NOW);
  db.prepare(
    "INSERT INTO fix_english_words (word, added_by, created_at) VALUES ('EzyChat', ?, ?)",
  ).run(lee, NOW);
  db.prepare(
    "INSERT INTO fix_english_words (word, added_by, created_at) VALUES ('kopi', ?, ?)",
  ).run(lee, NOW);
  // AI agent: Business context, a version, a phrase and its per-agent setting
  const doc = Number(
    db
      .prepare(
        "INSERT INTO ai_documents (name, size, text, created_at, kind, agent_id) VALUES ('Prices', 5, 'RM 10', ?, 'text', ?)",
      )
      .run(NOW, agent).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO ai_setup_versions (agent_id, target, item_id, content, via, user_id, token_id, created_at)
     VALUES (?, 'context_text', ?, 'RM 10', 'app', ?, NULL, ?)`,
  ).run(agent, doc, amy, NOW);
  db.prepare(
    `INSERT INTO reply_phrases (agent_id, language, text, source, created_at, updated_at)
     VALUES (?, 'en', 'Thanks for asking', 'context', ?, ?)`,
  ).run(agent, NOW, NOW);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    `ai_phrases_state:${agent}`,
    '{"builtAt":1}',
  );
  db.prepare("INSERT INTO settings (key, value) VALUES ('ai_timezone', '\"Asia/Tokyo\"')").run();
  // Partner connector with a secret sealed by Lite's key, and its per-agent settings
  const connectorSecret = JSON.stringify({ apiKey: 'sk-lite-123' });
  db.prepare(
    `INSERT INTO connector_connections (connector_id, state, entry_json, secret, key_end, updated_at)
     VALUES ('acme', 'connected', '{}', ?, '123', ?)`,
  ).run(secret.encrypt(connectorSecret), NOW);
  db.prepare(
    "INSERT INTO connector_agent_settings (connector_id, agent_id, updated_at) VALUES ('acme', ?, ?)",
  ).run(agent, NOW);
  db.prepare(
    "INSERT INTO connector_calls (connector_id, tool, chat_jid, consent_message_id, at) VALUES ('acme', 'lookup', ?, 'M1', ?)",
  ).run(LITE_CHAT, NOW);
  // Google Calendar per-agent settings and a booking
  if (opts.googleAccount) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('google_calendar_tokens', ?)").run(
      secret.encrypt(
        JSON.stringify({ account: opts.googleAccount, refreshToken: 'r', accessToken: 'a' }),
      ),
    );
  }
  db.prepare(
    "INSERT INTO calendar_agent_settings (agent_id, settings, updated_at) VALUES (?, '{}', ?)",
  ).run(agent, NOW);
  db.prepare(
    `INSERT INTO calendar_bookings (agent_id, chat_jid, event_id, calendar_id, start_at, end_at, created_at)
     VALUES (?, ?, 'ev1', 'primary', ?, ?, ?)`,
  ).run(agent, LITE_CHAT, NOW + 1e6, NOW + 2e6, NOW);
  db.prepare(
    "INSERT INTO calendar_activity (kind, agent_id, chat_jid, at) VALUES ('booked', ?, ?, ?)",
  ).run(agent, LITE_CHAT, NOW);
  // Safety finding on M4, with a download record
  const item = Number(
    db
      .prepare(
        `INSERT INTO safety_items (message_id, chat_jid, inbox_id, rules, score, rule_level, critical, level,
           status, existing_customer, has_file, quarantined, created_at, updated_at)
         VALUES ('M4', '60888@s.whatsapp.net', 1, '[]', 90, 'high', 1, 'high', 'open', 0, 1, 1, ?, ?)`,
      )
      .run(NOW, NOW).lastInsertRowid,
  );
  db.prepare(
    'INSERT INTO safety_downloads (item_id, user_id, allowed, at) VALUES (?, ?, 0, ?)',
  ).run(item, amy, NOW);
  db.prepare(
    "INSERT INTO safety_numbers (wa_jid, scam_by, scam_at) VALUES ('60888@s.whatsapp.net', ?, ?)",
  ).run(lee, NOW);
  // Never imported
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES ('lite-session', ?, ?, ?)",
  ).run(amy, NOW, NOW);
  db.prepare(
    "INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at) VALUES (?, 'Claude', 'lite-token', 'ezc_pat_x', ?)",
  ).run(amy, NOW);
  db.prepare(
    "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, 'https://fcm.googleapis.com/x', 'p', 'a', ?)",
  ).run(amy, NOW);
  // Audit: an AI hand-off (reports read it) and a token-made send
  db.prepare(
    "INSERT INTO audit_log (user_id, action, ip, meta, at) VALUES (NULL, 'ai.handoff', NULL, ?, ?)",
  ).run(
    JSON.stringify({ chatJid: LITE_CHAT, agentId: agent, reason: 'asked_for_human' }),
    NOW - 3_000_000,
  );
  db.prepare(
    "INSERT INTO audit_log (user_id, action, ip, meta, at) VALUES (?, 'mcp.send', NULL, ?, ?)",
  ).run(amy, JSON.stringify({ tokenId: 1, chatJid: LITE_CHAT, messageId: 'M2' }), NOW);
  db.close();
  mkdirSync(join(dir, 'wa-auth'), { recursive: true });
  writeFileSync(join(dir, 'wa-auth', 'creds.json'), '{"me":"lite"}');
  return { dir, ids: { amy, lee, sam, ai, agent }, connectorSecret };
}
