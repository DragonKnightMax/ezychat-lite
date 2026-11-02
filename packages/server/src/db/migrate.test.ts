import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { latestMigration, migrate, migrationsDir } from './migrate.js';
import { openDb } from './index.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TABLES = [
  'users',
  'sessions',
  'chats',
  'fix_english_words',
  'contacts',
  'messages',
  'notes',
  'chat_events',
  'quick_replies',
  'push_subscriptions',
  'settings',
  'audit_log',
  'ai_documents',
  'ai_chat_state',
  'jid_aliases',
  'customer_profiles',
  'customer_tags',
  'api_tokens',
  'ai_setup_versions',
  'inboxes',
  'inbox_members',
  'ai_agents',
  'message_reactions',
  'oauth_clients',
  'reply_phrases',
  'calendar_agent_settings',
  'calendar_offers',
  'calendar_bookings',
  'calendar_activity',
  'safety_items',
  'safety_numbers',
  'safety_downloads',
  'message_edits',
  'message_changes_pending',
];
const LATEST = latestMigration();

describe('migrate', () => {
  it('keeps chat events (ids, payload) and accepts ai_tool_used after the rebuild', () => {
    const db = new Database(':memory:');
    try {
      migrate(db, 11);
      db.prepare(
        "INSERT INTO chat_events (id, chat_jid, type, payload, at) VALUES (7, 'a@s.whatsapp.net', 'resolved', '{\"x\":1}', 5)",
      ).run();
      expect(() =>
        db
          .prepare(
            "INSERT INTO chat_events (chat_jid, type, payload, at) VALUES ('a@s.whatsapp.net', 'ai_tool_used', '{}', 6)",
          )
          .run(),
      ).toThrow();
      migrate(db);
      expect(db.prepare('SELECT id, type, payload FROM chat_events').all()).toEqual([
        { id: 7, type: 'resolved', payload: '{"x":1}' },
      ]);
      db.prepare(
        "INSERT INTO chat_events (chat_jid, type, payload, at) VALUES ('a@s.whatsapp.net', 'ai_tool_used', '{}', 6)",
      ).run();
      expect(() =>
        db
          .prepare(
            "INSERT INTO chat_events (chat_jid, type, payload, at) VALUES ('a@s.whatsapp.net', 'other', '{}', 6)",
          )
          .run(),
      ).toThrow();
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_chat_events_chat'").get(),
      ).toEqual({ name: 'idx_chat_events_chat' });
    } finally {
      db.close();
    }
  });
  it('preserves old message text and marks its mention metadata as unknown on upgrade', () => {
    const db = new Database(':memory:');
    try {
      migrate(db, 10);
      db.prepare(
        "INSERT INTO messages (id, chat_jid, type, body, timestamp, created_at) VALUES ('old', '1203@g.us', 'text', 'Hi @123', 1, 1)",
      ).run();
      migrate(db);
      expect(
        db.prepare("SELECT body, mentioned_jids FROM messages WHERE id = 'old'").get(),
      ).toEqual({ body: 'Hi @123', mentioned_jids: null });
      expect(() => migrate(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
  it('creates all tables and sets user_version to the latest migration', () => {
    const db = new Database(':memory:');
    migrate(db);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
    const cols = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('client_id');
    expect(cols).toContain('mentioned_jids');
    expect(cols).toEqual(
      expect.arrayContaining(['transcript', 'transcript_lang', 'transcript_status']),
    );
    const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(userCols).toContain('locale');
    expect(userCols).toContain('kind');
    db.close();
  });

  it('customer tables never cascade from chats (user-written data survives a chat delete)', () => {
    const db = new Database(':memory:');
    migrate(db);
    const fks = (t: string) =>
      (db.prepare(`PRAGMA foreign_key_list(${t})`).all() as Array<{ table: string }>).map(
        (f) => f.table,
      );
    expect(fks('customer_profiles')).toEqual(['users']);
    expect(fks('customer_tags')).toEqual([]);
    const cols = (
      db.prepare('PRAGMA table_info(customer_profiles)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('id');
    db.close();
  });

  it('numbers migrations 1..latest with no gap or duplicate', () => {
    const versions = readdirSync(migrationsDir())
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .map((f) => parseInt(f, 10))
      .sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1));
    expect(latestMigration()).toBe(versions[versions.length - 1]);
  });

  it('stops after the upTo migration and continues from there on the next run', () => {
    const db = new Database(':memory:');
    try {
      migrate(db, 27);
      expect(db.pragma('user_version', { simple: true })).toBe(27);
      const hasSafety = () =>
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'safety_items'").get();
      expect(hasSafety()).toBeUndefined();
      migrate(db, 0);
      expect(db.pragma('user_version', { simple: true })).toBe(27);
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
      expect(hasSafety()).toEqual({ name: 'safety_items' });
    } finally {
      db.close();
    }
  });

  it('is idempotent on second run', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("INSERT INTO settings(key, value) VALUES ('a', '1')").run();
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 1 });
    db.close();
  });

  it('upgrades a main-branch locale database while preserving existing users and their language', () => {
    const db = new Database(':memory:');
    try {
      migrate(db, 2);
      db.prepare(
        "INSERT INTO users(username, display_name, password_hash, role, locale, created_at) VALUES ('existing', 'Existing', 'hash', 'agent', 'ms', 1)",
      ).run();
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
      expect(
        db.prepare("SELECT username, locale, kind FROM users WHERE username = 'existing'").get(),
      ).toEqual({ username: 'existing', locale: 'ms', kind: 'human' });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_chat_state'").get(),
      ).toEqual({ name: 'ai_chat_state' });
      expect(() => migrate(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('turns stored AI documents into file context items with kind, size and dates', () => {
    const db = new Database(':memory:');
    try {
      migrate(db, 3);
      db.prepare(
        "INSERT INTO ai_documents(name, size, text, created_at) VALUES ('hours.pdf', 2048, 'Open 9am', 1700)",
      ).run();
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
      expect(
        db.prepare('SELECT name, kind, size, text, created_at, updated_at FROM ai_documents').get(),
      ).toEqual({
        name: 'hours.pdf',
        kind: 'file',
        size: 2048,
        text: 'Open 9am',
        created_at: 1700,
        updated_at: 1700,
      });
      expect(() =>
        db
          .prepare(
            "INSERT INTO ai_documents(name, kind, size, text, created_at, updated_at) VALUES ('x', 'note', 1, 'x', 1, 1)",
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('openDb enables WAL + foreign keys + busy_timeout and migrates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wati-db-'));
    try {
      const db = openDb(join(dir, 'app.db'));
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('004 adds jid_aliases and backfills wa_remote_jid and chats.phone on an existing v3 database', () => {
    const db = new Database(':memory:');
    try {
      migrate(db, 3);
      db.exec(`
        INSERT INTO chats (jid, type, name, updated_at) VALUES
          ('60111@s.whatsapp.net', 'dm', 'A', 1), ('999@lid', 'dm', '', 1),
          ('888@lid', 'dm', '', 1), ('1-2@g.us', 'group', 'G', 1);
        INSERT INTO contacts (jid, phone) VALUES ('999@lid', '60222'), ('888@lid', NULL);
        INSERT INTO messages (id, chat_jid, type, timestamp, created_at) VALUES
          ('m1', '60111@s.whatsapp.net', 'text', 1, 1), ('m2', '999@lid', 'text', 2, 2);
      `);
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
      expect(db.prepare('SELECT id, wa_remote_jid FROM messages ORDER BY id').all()).toEqual([
        { id: 'm1', wa_remote_jid: '60111@s.whatsapp.net' },
        { id: 'm2', wa_remote_jid: '999@lid' },
      ]);
      expect(db.prepare('SELECT jid, phone FROM chats ORDER BY jid').all()).toEqual([
        { jid: '1-2@g.us', phone: null },
        { jid: '60111@s.whatsapp.net', phone: '60111' },
        { jid: '888@lid', phone: null },
        { jid: '999@lid', phone: '60222' },
      ]);
      expect(
        (db.prepare('PRAGMA table_info(jid_aliases)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      ).toEqual(['alias_jid', 'canonical_jid', 'source', 'learned_at', 'repointed_from']);
      expect(() => migrate(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('020 turns reply suggestions off only for an install that already has users', () => {
    const upTo19 = (db: Database.Database) => {
      migrate(db, 19);
    };
    const settings = (db: Database.Database) =>
      db
        .prepare(
          "SELECT key, value FROM settings WHERE key LIKE 'ai_reply_suggestions%' ORDER BY key",
        )
        .all();
    const existing = new Database(':memory:');
    const fresh = new Database(':memory:');
    try {
      upTo19(existing);
      existing
        .prepare(
          "INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'A', 'x', 'admin', 1)",
        )
        .run();
      migrate(existing);
      expect(settings(existing)).toEqual([
        { key: 'ai_reply_suggestions', value: 'false' },
        { key: 'ai_reply_suggestions_upgraded', value: 'true' },
      ]);
      upTo19(fresh);
      migrate(fresh);
      expect(settings(fresh)).toEqual([]);
    } finally {
      existing.close();
      fresh.close();
    }
  });

  it('026 adds the resolution question switch, off for every existing agent', () => {
    const db = new Database(':memory:');
    try {
      migrate(db, 25);
      const user = (name: string) =>
        Number(
          db
            .prepare(
              "INSERT INTO users (username, display_name, password_hash, role, kind, created_at) VALUES (?, ?, '', 'agent', 'ai', 1)",
            )
            .run(name, name).lastInsertRowid,
        );
      for (const [name, preset] of [
        ['s', 'sales'],
        ['f', 'faq'],
        ['c', 'custom'],
      ] as const)
        db.prepare(
          'INSERT INTO ai_agents (user_id, preset, created_at, updated_at) VALUES (?, ?, 1, 1)',
        ).run(user(name), preset);
      migrate(db);
      expect(
        db.prepare('SELECT preset, resolution_check AS on_ FROM ai_agents ORDER BY id').all(),
      ).toEqual([
        { preset: 'sales', on_: 0 },
        { preset: 'faq', on_: 0 },
        { preset: 'custom', on_: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it('025 turns Fix English off only for an install that already has users, and adds team words', () => {
    const upTo24 = (db: Database.Database) => {
      migrate(db, 24);
    };
    const settings = (db: Database.Database) =>
      db
        .prepare("SELECT key, value FROM settings WHERE key LIKE 'fix_english%' ORDER BY key")
        .all();
    const existing = new Database(':memory:');
    const fresh = new Database(':memory:');
    try {
      upTo24(existing);
      existing
        .prepare(
          "INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'A', 'x', 'admin', 1)",
        )
        .run();
      migrate(existing);
      expect(settings(existing)).toEqual([
        { key: 'fix_english', value: 'false' },
        { key: 'fix_english_upgraded', value: 'true' },
      ]);
      upTo24(fresh);
      migrate(fresh);
      expect(settings(fresh)).toEqual([]);
      // One row per word whatever its case.
      fresh.prepare("INSERT INTO fix_english_words (word, created_at) VALUES ('Cendol', 1)").run();
      expect(() =>
        fresh
          .prepare("INSERT INTO fix_english_words (word, created_at) VALUES ('cendol', 2)")
          .run(),
      ).toThrow(/UNIQUE/);
    } finally {
      existing.close();
      fresh.close();
    }
  });

  it('021 adds the phrase list, removed with its agent', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      migrate(db);
      const now = 1;
      db.prepare(
        "INSERT INTO users (username, display_name, password_hash, role, created_at, kind) VALUES ('ai', 'AI', '', 'agent', 1, 'ai')",
      ).run();
      const userId = (
        db.prepare("SELECT id FROM users WHERE username = 'ai'").get() as { id: number }
      ).id;
      db.prepare(
        "INSERT INTO ai_agents (user_id, preset, created_at, updated_at) VALUES (?, 'sales', ?, ?)",
      ).run(userId, now, now);
      const agentId = (db.prepare('SELECT id FROM ai_agents').get() as { id: number }).id;
      const add = db.prepare(
        'INSERT INTO reply_phrases (agent_id, language, text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      add.run(agentId, 'en', 'Thank you for your message.', 'team', now, now);
      expect(() => add.run(agentId, 'fr', 'Merci.', 'team', now, now)).toThrow();
      expect(() => add.run(agentId, 'en', 'Hello there.', 'robot', now, now)).toThrow();
      db.prepare('DELETE FROM ai_agents WHERE id = ?').run(agentId);
      expect(db.prepare('SELECT COUNT(*) AS n FROM reply_phrases').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('022 adds the calendar tables: settings and offers go with their agent, history stays', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      migrate(db);
      db.prepare(
        "INSERT INTO users (username, display_name, password_hash, role, created_at, kind) VALUES ('ai', 'AI', '', 'agent', 1, 'ai')",
      ).run();
      db.prepare(
        "INSERT INTO ai_agents (user_id, preset, created_at, updated_at) VALUES ((SELECT id FROM users WHERE username = 'ai'), 'sales', 1, 1)",
      ).run();
      const agentId = (db.prepare('SELECT id FROM ai_agents').get() as { id: number }).id;
      db.prepare(
        'INSERT INTO calendar_agent_settings (agent_id, settings, updated_at) VALUES (?, ?, 1)',
      ).run(agentId, '{}');
      db.prepare(
        "INSERT INTO calendar_offers (agent_id, chat_jid, start_at, end_at, offered_at) VALUES (?, 'c@s.whatsapp.net', 10, 20, 1)",
      ).run(agentId);
      const book = db.prepare(
        "INSERT INTO calendar_bookings (agent_id, chat_jid, event_id, calendar_id, start_at, end_at, created_at) VALUES (?, 'c@s.whatsapp.net', 'e1', 'cal', 10, 20, 1)",
      );
      book.run(agentId);
      // one booking per chat and start time
      expect(() => book.run(agentId)).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO calendar_activity (kind, agent_id, chat_jid, at) VALUES ('sent', ?, NULL, 1)",
          )
          .run(agentId),
      ).toThrow();
      db.prepare(
        "INSERT INTO calendar_activity (kind, agent_id, chat_jid, at) VALUES ('booked', ?, 'c@s.whatsapp.net', 1)",
      ).run(agentId);
      db.prepare('DELETE FROM ai_agents WHERE id = ?').run(agentId);
      const count = (table: string) =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('calendar_agent_settings')).toBe(0);
      expect(count('calendar_offers')).toBe(0);
      expect(count('calendar_bookings')).toBe(1);
      expect(count('calendar_activity')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('019 keeps inboxes as phones and starts each chat window at its newest customer message', () => {
    const db = new Database(':memory:');
    try {
      migrate(db, 18);
      db.exec(`
        INSERT INTO chats (jid, type, name, updated_at) VALUES
          ('a@s.whatsapp.net', 'dm', 'A', 1), ('b@s.whatsapp.net', 'dm', 'B', 1);
        INSERT INTO messages (id, chat_jid, type, timestamp, created_at, from_me) VALUES
          ('in1', 'a@s.whatsapp.net', 'text', 100, 100, 0),
          ('in2', 'a@s.whatsapp.net', 'text', 300, 300, 0),
          ('out', 'a@s.whatsapp.net', 'text', 500, 500, 1),
          ('mine', 'b@s.whatsapp.net', 'text', 200, 200, 1);
      `);
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
      expect(db.prepare('SELECT jid, last_inbound_at FROM chats ORDER BY jid').all()).toEqual([
        { jid: 'a@s.whatsapp.net', last_inbound_at: 300 },
        { jid: 'b@s.whatsapp.net', last_inbound_at: null },
      ]);
      expect(db.prepare('SELECT id, type FROM inboxes').all()).toEqual([
        { id: 1, type: 'linked_phone' },
      ]);
      expect(
        db.prepare("SELECT template_name, template_params FROM messages WHERE id = 'in1'").get(),
      ).toEqual({ template_name: null, template_params: null });
    } finally {
      db.close();
    }
  });
});
