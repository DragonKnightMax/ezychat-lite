import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { listAgents, migrateMemberSetting } from '../src/ai/agents.js';
import { listSetupVersions } from '../src/ai/setup-versions.js';
import { latestMigration, migrate } from '../src/db/migrate.js';
import { createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

/**
 * The desktop updater jumps straight to the newest release, never through the versions between
 * (docs/LEARNINGS.md). This opens a data folder as the first release left it (schema 1) with the
 * current server: every migration must run in one go and the old data must come back through the API.
 */
const CUSTOMER = '60123456789@s.whatsapp.net';
const CREDS = '{"me":{"id":"60111111111:1@s.whatsapp.net"}}';

function oldestDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wati-oldest-'));
  const db = new Database(join(dir, 'app.db'));
  migrate(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (1, 'aisyah', 'Aisyah', 'x', 'admin', ?)",
  ).run(now);
  db.prepare(
    "INSERT INTO chats (jid, type, name, last_message_at, last_message_preview, status, assigned_to, updated_at) VALUES (?, 'dm', 'Ahmad', ?, 'Kopi for two?', 'open', 1, ?)",
  ).run(CUSTOMER, now, now);
  db.prepare(
    "INSERT INTO messages (id, chat_jid, sender_jid, from_me, type, body, status, timestamp, created_at) VALUES ('OLD-1', ?, ?, 0, 'text', 'Kopi for two?', 'read', ?, ?)",
  ).run(CUSTOMER, CUSTOMER, now, now);
  // our own later reply: not the customer's last message (019 backfills from inbound only)
  db.prepare(
    "INSERT INTO messages (id, chat_jid, sender_jid, from_me, type, body, status, timestamp, created_at) VALUES ('OLD-2', ?, NULL, 1, 'text', 'Sure!', 'read', ?, ?)",
  ).run(CUSTOMER, now + 5000, now + 5000);
  db.prepare(
    "INSERT INTO notes (chat_jid, user_id, body, created_at) VALUES (?, 1, 'Regular customer', ?)",
  ).run(CUSTOMER, now);
  db.prepare(
    "INSERT INTO quick_replies (shortcut, body, created_by, updated_at) VALUES ('hi', 'Hello!', 1, ?)",
  ).run(now);
  db.close();
  mkdirSync(join(dir, 'wa-auth'));
  writeFileSync(join(dir, 'wa-auth', 'creds.json'), CREDS);
  return dir;
}

/**
 * The oldest folder after release 14 (one AI Sales Agent): the AI member, its saved texts in the
 * `ai_sales_member` setting (blank hand-over rules), two Business context items and one saved version.
 */
function aiMemberDataDir(): string {
  const dir = oldestDataDir();
  const db = new Database(join(dir, 'app.db'));
  migrate(db, 14);
  const now = 1_700_000_000_000;
  db.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, role, kind, created_at) VALUES (7, 'ai-x', 'Kopi Bot', '', 'agent', 'ai', ?)",
  ).run(now);
  db.prepare("INSERT INTO settings (key, value) VALUES ('ai_sales_member', ?)").run(
    JSON.stringify({ displayName: 'Kopi Bot', instructions: 'Sell kopi kindly', handoffRules: '' }),
  );
  const items: Array<[string, string]> = [
    ['Prices', 'Kopi RM5'],
    ['Hours', 'Open 8-6'],
  ];
  for (const [name, text] of items)
    db.prepare(
      "INSERT INTO ai_documents (name, kind, size, text, created_at, updated_at) VALUES (?, 'text', ?, ?, ?, ?)",
    ).run(name, text.length, text, now, now);
  db.prepare(
    "INSERT INTO ai_setup_versions (target, item_id, content, via, user_id, created_at) VALUES ('instructions', NULL, 'Sell kopi kindly', 'app', 1, ?)",
  ).run(now);
  db.close();
  return dir;
}

describe('upgrade from the oldest data folder', { timeout: 30_000 }, () => {
  let t: TestApp | null = null;
  let dir: string | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    dir = null;
  });

  it('runs every migration in one start and keeps chats, messages, notes and quick replies', async () => {
    dir = oldestDataDir();
    t = await makeTestApp({ config: { dataDir: dir } });
    expect(t.ctx.db.pragma('user_version', { simple: true })).toBe(latestMigration());

    const { cookie } = await createUserAndLogin(t, { role: 'admin' });
    const chats = (
      await t.app.inject({ method: 'GET', url: '/api/chats', headers: { cookie } })
    ).json().chats as Array<{ jid: string; name: string; assignedTo: number | null }>;
    // 014: the chat keeps its key and becomes part of inbox 1 (the number linked today).
    // 019: the customer's last message starts the reply window (ignored by a linked phone).
    expect(chats.find((c) => c.jid === CUSTOMER)).toMatchObject({
      name: 'Ahmad',
      assignedTo: 1,
      inboxId: 1,
      waJid: CUSTOMER,
      lastInboundAt: 1_700_000_000_000,
    });
    expect(t.ctx.inboxes.repo.active().map((i) => [i.id, i.auth_dir, i.type])).toEqual([
      [1, 'wa-auth', 'linked_phone'],
    ]);
    const inboxes = (
      await t.app.inject({ method: 'GET', url: '/api/inboxes', headers: { cookie } })
    ).json().inboxes as Array<{ type: string; capabilities: { qrLink: boolean } }>;
    expect(inboxes.map((i) => [i.type, i.capabilities.qrLink])).toEqual([['linked_phone', true]]);

    const chatUrl = `/api/chats/${encodeURIComponent(CUSTOMER)}`;
    const messages = (
      await t.app.inject({ method: 'GET', url: `${chatUrl}/messages`, headers: { cookie } })
    ).json().messages as Array<{ id: string; body: string; template?: unknown }>;
    expect(messages.map((m) => m.body)).toContain('Kopi for two?');
    expect(messages.every((m) => m.template === undefined)).toBe(true);
    const notes = (
      await t.app.inject({ method: 'GET', url: `${chatUrl}/notes`, headers: { cookie } })
    ).json() as unknown;
    expect(JSON.stringify(notes)).toContain('Regular customer');
    const replies = (
      await t.app.inject({ method: 'GET', url: '/api/quick-replies', headers: { cookie } })
    ).json() as unknown;
    expect(JSON.stringify(replies)).toContain('Hello!');

    // 020: an install that existed before reply suggestions starts with them off (they cost money).
    expect(t.ctx.settings.get('ai_reply_suggestions', null)).toBe(false);
    expect(t.ctx.settings.get('ai_reply_suggestions_upgraded', null)).toBe(true);
    // 025: the same for Fix English (its grammar check calls the AI provider while people type).
    expect(t.ctx.settings.get('fix_english', null)).toBe(false);
    expect(t.ctx.settings.get('fix_english_upgraded', null)).toBe(true);
    // 027: every existing agent keeps answering direct chats.
    expect(listAgents(t.ctx.db).every((agent) => agent.answerDirect)).toBe(true);

    // The linked WhatsApp session is left exactly as it was: no relink after an update.
    expect(readFileSync(join(dir, 'wa-auth', 'creds.json'), 'utf8')).toBe(CREDS);
  });

  it('015 turns the one AI Sales Agent into agent 1 with the same texts, items and history', async () => {
    dir = aiMemberDataDir();
    t = await makeTestApp({ config: { dataDir: dir } });
    const db = t.ctx.db;
    // The permanent start-up step (idempotent; a no-op when start-up already ran it).
    migrateMemberSetting(db, t.ctx.settings);
    const agents = listAgents(db);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      userId: 7,
      inboxId: 1,
      preset: 'sales',
      displayName: 'Kopi Bot',
      instructions: 'Sell kopi kindly',
      handoffRules: '',
    });
    const agentId = agents[0]!.id;
    expect(
      db.prepare('SELECT name, agent_id AS agentId FROM ai_documents ORDER BY id').all(),
    ).toEqual([
      { name: 'Prices', agentId },
      { name: 'Hours', agentId },
    ]);
    expect(listSetupVersions(db, agentId, 'instructions', null, 10).map((v) => v.content)).toEqual([
      'Sell kopi kindly',
    ]);

    const { cookie } = await createUserAndLogin(t, { role: 'admin' });
    const ai = (
      await t.app.inject({ method: 'GET', url: '/api/ai', headers: { cookie } })
    ).json() as {
      settings: { instructions: string; handoffRules: string };
      documents: Array<{ name: string }>;
    };
    expect(ai.settings).toMatchObject({ instructions: 'Sell kopi kindly', handoffRules: '' });
    expect(ai.documents.map((d) => d.name)).toEqual(['Prices', 'Hours']);
  });

  it('after a downgrade and a new update, a chat the older version made is found, not duplicated', async () => {
    dir = oldestDataDir();
    t = await makeTestApp({ config: { dataDir: dir } });
    await t.close();
    t = null;
    // An older release (no inboxes) running on the migrated folder adds a chat as it always did:
    // no inbox_id (the column default, 1) and no wa_jid. Migration 014 does not run again later.
    const OTHER = '60199990000@s.whatsapp.net';
    const db = new Database(join(dir, 'app.db'));
    db.prepare(
      "INSERT INTO chats (jid, type, name, status, updated_at) VALUES (?, 'dm', 'Siti', 'open', 1)",
    ).run(OTHER);
    db.close();

    t = await makeTestApp({ config: { dataDir: dir } });
    t.wa.simulateIncoming({ chatJid: OTHER, body: 'Back again', senderName: 'Siti' });
    const rows = () =>
      t!.ctx.db.prepare('SELECT jid, inbox_id FROM chats WHERE jid LIKE ?').all(`${OTHER}%`);
    for (
      let i = 0;
      i < 100 && !t.ctx.db.prepare("SELECT 1 FROM messages WHERE body = 'Back again'").get();
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    expect(rows()).toEqual([{ jid: OTHER, inbox_id: 1 }]);
    const { cookie } = await createUserAndLogin(t, { role: 'admin' });
    const chat = (
      await t.app.inject({
        method: 'GET',
        url: `/api/chats/${encodeURIComponent(OTHER)}`,
        headers: { cookie },
      })
    ).json() as { chat: { inboxId: number; waJid: string } };
    expect(chat.chat).toMatchObject({ inboxId: 1, waJid: OTHER });
  });
});
