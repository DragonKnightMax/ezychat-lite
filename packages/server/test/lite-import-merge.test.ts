import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiteImportProgress } from '@ezychat/shared';
import { FakeWaAdapter } from '@ezychat/wa';
import { buildApp } from '../src/app.js';
import { SecretBox } from '../src/crypto/secret.js';
import { openDb, type DB } from '../src/db/index.js';
import { LiteImportRefused } from '../src/lite-import/errors.js';
import { WORK_DIR, mergeLiteInbox } from '../src/lite-import/merge.js';
import { silentLogger } from '../src/logger.js';
import { createContext, runInitializers, shutdownServices } from '../src/main.js';
import { computeReport } from '../src/reports/report.js';
import { sessionCookieFrom } from './auth-helpers.js';
import {
  LITE_CHAT,
  LITE_GROUP,
  NOW,
  TARGET_PASSWORD,
  cleanupDirs,
  seedLite,
  seedTarget,
} from './lite-import-merge-helpers.js';

afterEach(cleanupDirs);

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function merge(
  targetDir: string,
  liteDir: string,
  extra: Partial<Parameters<typeof mergeLiteInbox>[0]> = {},
) {
  const progress: LiteImportProgress[] = [];
  const result = await mergeLiteInbox({
    targetDataDir: targetDir,
    liteDataDir: liteDir,
    plan: { team: [] },
    maxInboxes: 3,
    log: silentLogger(),
    progress: (p) => progress.push(p),
    ...extra,
  });
  return { result, progress };
}

const open = (dir: string): DB => openDb(join(dir, 'app.db'));

describe('mergeLiteInbox', () => {
  it('adds Lite as a new inbox with its chats, team, AI agent and history', async () => {
    const t = seedTarget();
    const lite = seedLite();
    const liteHashBefore = hash(join(lite.dir, 'app.db'));
    const { result, progress } = await merge(t.dir, lite.dir, {
      plan: {
        team: [
          { liteUserId: lite.ids.sam, action: 'skip', matchUserId: null, role: 'agent' },
          { liteUserId: lite.ids.lee, action: 'add', matchUserId: null, role: 'admin' },
        ],
      },
    });

    expect(result).toEqual({
      mode: 'merge',
      inboxId: 3,
      inboxName: 'Lite – +60333',
      chats: 3,
      usersAdded: 1,
      usersMatched: 1,
      agentImported: true,
      agentOff: false,
      renamedShortcuts: ['hi-lite'],
    });
    expect(progress.map((p) => `${p.step}:${p.state}`)).toEqual(
      expect.arrayContaining([
        'migrate:running',
        'migrate:done',
        'merge:running',
        'merge:done',
        'verify:done',
      ]),
    );
    expect(progress.some((p) => p.step === 'merge' && p.total && p.done === p.total)).toBe(true);
    // Lite's folder is only read; the work folder is gone; a pre-import backup exists
    expect(hash(join(lite.dir, 'app.db'))).toBe(liteHashBefore);
    expect(existsSync(join(t.dir, WORK_DIR))).toBe(false);
    expect(
      readdirSync(join(t.dir, 'backups')).some((f) => /^app-pre-import-\d{8}-\d{6}\.db$/.test(f)),
    ).toBe(true);
    // WhatsApp link and media copied beside inbox 3
    expect(readFileSync(join(t.dir, 'wa-auth-inboxes', '3', 'creds.json'), 'utf8')).toBe(
      '{"me":"lite"}',
    );
    expect(
      readFileSync(join(t.dir, 'media', 'inbox-3', '60999_s_whatsapp_net', 'M1.jpg'), 'utf8'),
    ).toBe('jpeg-bytes');
    expect(
      existsSync(
        join(t.dir, 'media', 'quarantine', 'inbox-3', '60888_s_whatsapp_net', 'M4.exe.bin'),
      ),
    ).toBe(true);
    expect(existsSync(join(t.dir, 'media', 'inbox-3', 'quarantine'))).toBe(false);

    const db = open(t.dir);
    try {
      const inbox = db.prepare('SELECT * FROM inboxes WHERE id = 3').get() as Record<
        string,
        unknown
      >;
      expect(inbox).toMatchObject({
        name: 'Lite – +60333',
        auth_dir: 'wa-auth-inboxes/3',
        own_jid: '60333@s.whatsapp.net',
        tone: 'info',
      });

      // Chats and messages under inbox 3 keys
      const users = new Map(
        (
          db
            .prepare('SELECT id, username, role, kind, disabled_at, ai_deleted_at FROM users')
            .all() as Array<Record<string, unknown>>
        ).map((u) => [u.username as string, u]),
      );
      const lee = users.get('lee')!;
      expect(lee).toMatchObject({ role: 'admin', disabled_at: null });
      const sam = users.get('sam')!;
      expect(sam.disabled_at).not.toBeNull();
      const chats = db
        .prepare(
          'SELECT jid, wa_jid, inbox_id, assigned_to FROM chats WHERE inbox_id = 3 ORDER BY jid',
        )
        .all();
      expect(chats).toEqual([
        { jid: `${LITE_GROUP}#3`, wa_jid: LITE_GROUP, inbox_id: 3, assigned_to: null },
        {
          jid: '60888@s.whatsapp.net#3',
          wa_jid: '60888@s.whatsapp.net',
          inbox_id: 3,
          assigned_to: lee.id,
        },
        { jid: `${LITE_CHAT}#3`, wa_jid: LITE_CHAT, inbox_id: 3, assigned_to: expect.any(Number) },
      ]);
      const m2 = db.prepare("SELECT * FROM messages WHERE id = 'M2#3'").get() as Record<
        string,
        unknown
      >;
      expect(m2).toMatchObject({
        chat_jid: `${LITE_CHAT}#3`,
        quoted_id: 'M1#3',
        sent_via_token_id: null,
      });
      expect(db.prepare("SELECT media_path FROM messages WHERE id = 'M1#3'").get()).toEqual({
        media_path: 'inbox-3/60999_s_whatsapp_net/M1.jpg',
      });
      expect(db.prepare("SELECT media_path FROM messages WHERE id = 'M4#3'").get()).toEqual({
        media_path: 'quarantine/inbox-3/60888_s_whatsapp_net/M4.exe.bin',
      });
      expect(
        db.prepare("SELECT sent_by_user_id FROM messages WHERE id = 'local-abc'").get(),
      ).toEqual({ sent_by_user_id: sam.id });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_jid LIKE '%#3'").get(),
      ).toEqual({ n: 7 });
      expect(db.prepare('SELECT message_id, sent_by_user_id FROM message_reactions').get()).toEqual(
        { message_id: 'M1#3', sent_by_user_id: lee.id },
      );
      // edits and deletes keep their message, chat and teammate under the new ids
      expect(
        db.prepare('SELECT message_id, previous_body, edited_by, user_id FROM message_edits').all(),
      ).toEqual([
        { message_id: 'M2#3', previous_body: 'old text', edited_by: 'team', user_id: lee.id },
      ]);
      expect(
        db
          .prepare(
            "SELECT deleted_by, deleted_by_user_id, hidden_by_user_id FROM messages WHERE id = 'M5#3'",
          )
          .get(),
      ).toEqual({ deleted_by: 'team', deleted_by_user_id: lee.id, hidden_by_user_id: lee.id });
      expect(
        db.prepare('SELECT message_id, chat_jid, kind FROM message_changes_pending').all(),
      ).toEqual([{ message_id: 'M9#3', chat_jid: `${LITE_CHAT}#3`, kind: 'delete' }]);
      expect(db.prepare('SELECT user_id, chat_jid FROM notes').get()).toEqual({
        user_id: lee.id,
        chat_jid: '60888@s.whatsapp.net#3',
      });
      const event = db
        .prepare(
          "SELECT actor_id, payload FROM chat_events WHERE chat_jid = '60888@s.whatsapp.net#3'",
        )
        .get() as { actor_id: number; payload: string };
      expect(event.actor_id).toBe(t.amyId);
      expect(JSON.parse(event.payload)).toEqual({ assignedTo: lee.id, previous: null });
      expect(db.prepare('SELECT * FROM ai_chat_state').get()).toMatchObject({
        chat_jid: `${LITE_CHAT}#3`,
        last_customer_message_id: 'M1#3',
        last_replied_message_id: 'M2#3',
      });
      expect(db.prepare('SELECT chat_jid, updated_by FROM ai_group_chats').get()).toEqual({
        chat_jid: `${LITE_GROUP}#3`,
        updated_by: t.amyId,
      });
      expect(db.prepare('SELECT chat_jid, id, updated_by FROM customer_profiles').get()).toEqual({
        chat_jid: `${LITE_CHAT}#3`,
        id: 'profile-1',
        updated_by: lee.id,
      });
      expect(db.prepare('SELECT chat_jid, tag FROM customer_tags').get()).toEqual({
        chat_jid: `${LITE_CHAT}#3`,
        tag: 'VIP',
      });

      // Users: amy matched (no new row), lee added, sam a disabled row; members of inbox 3
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'amy%'").get(),
      ).toEqual({ n: 1 });
      const members = (
        db
          .prepare('SELECT user_id FROM inbox_members WHERE inbox_id = 3 ORDER BY user_id')
          .all() as Array<{ user_id: number }>
      ).map((r) => r.user_id);
      expect(members).toEqual([t.amyId, lee.id as number].sort((a, b) => a - b));

      // One merged contact: the target's saved name wins, empty fields are filled from Lite
      expect(db.prepare('SELECT * FROM contacts WHERE jid = ?').all(LITE_CHAT)).toEqual([
        { jid: LITE_CHAT, push_name: 'Lite Push', saved_name: 'Target Name', phone: '60999' },
      ]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM contacts').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT canonical_jid FROM jid_aliases').get()).toEqual({
        canonical_jid: '777@lid',
      });

      // Quick replies and words: union, clash renamed
      expect(db.prepare('SELECT shortcut, body FROM quick_replies ORDER BY id').all()).toEqual([
        { shortcut: 'hi', body: 'Hello from target' },
        { shortcut: 'hi-lite', body: 'Hello from lite' },
        { shortcut: 'price', body: 'RM 10' },
      ]);
      expect(
        (
          db.prepare('SELECT word FROM fix_english_words ORDER BY word').all() as Array<{
            word: string;
          }>
        ).map((r) => r.word),
      ).toEqual(['ezychat', 'kopi']);

      // AI agent: bound to inbox 3 with context, versions, phrases and its setting
      const agent = db
        .prepare(
          "SELECT a.*, u.display_name, u.disabled_at FROM ai_agents a JOIN users u ON u.id = a.user_id WHERE u.display_name = 'Lite AI'",
        )
        .get() as Record<string, unknown>;
      expect(agent).toMatchObject({
        inbox_id: 3,
        instructions: 'Lite AI instructions',
        disabled_at: null,
      });
      const agentId = agent.id as number;
      const doc = db
        .prepare('SELECT id, text FROM ai_documents WHERE agent_id = ?')
        .get(agentId) as { id: number; text: string };
      expect(doc.text).toBe('RM 10');
      expect(
        db
          .prepare('SELECT item_id, user_id, token_id FROM ai_setup_versions WHERE agent_id = ?')
          .get(agentId),
      ).toEqual({ item_id: doc.id, user_id: t.amyId, token_id: null });
      expect(db.prepare('SELECT text FROM reply_phrases WHERE agent_id = ?').get(agentId)).toEqual({
        text: 'Thanks for asking',
      });
      expect(
        db.prepare('SELECT value FROM settings WHERE key = ?').get(`ai_phrases_state:${agentId}`),
      ).toEqual({ value: '{"builtAt":1}' });
      expect(
        db.prepare('SELECT assigned_to FROM chats WHERE jid = ?').get(`${LITE_CHAT}#3`),
      ).toEqual({ assigned_to: agent.user_id });
      // the deleted agent's user stays a name only
      const gone = users.get('ai-gone')!;
      expect(gone).toMatchObject({ kind: 'ai' });
      expect(gone.ai_deleted_at).not.toBeNull();
      expect(db.prepare("SELECT sent_by_user_id FROM messages WHERE id = 'M5#3'").get()).toEqual({
        sent_by_user_id: gone.id,
      });

      // Install-wide settings stay the target's
      expect(
        db.prepare("SELECT value FROM settings WHERE key = 'ai_timezone'").get(),
      ).toBeUndefined();

      // Connector secret re-encrypted with the target's key
      const conn = db
        .prepare("SELECT state, secret FROM connector_connections WHERE connector_id = 'acme'")
        .get() as { state: string; secret: string };
      expect(conn.state).toBe('connected');
      const targetBox = SecretBox.fromKey(readFileSync(join(t.dir, 'secret.key')));
      expect(targetBox.decrypt(conn.secret)).toBe(lite.connectorSecret);
      expect(
        db
          .prepare("SELECT agent_id FROM connector_agent_settings WHERE connector_id = 'acme'")
          .get(),
      ).toEqual({ agent_id: agentId });
      expect(db.prepare('SELECT chat_jid, consent_message_id FROM connector_calls').get()).toEqual({
        chat_jid: `${LITE_CHAT}#3`,
        consent_message_id: 'M1#3',
      });
      // Different (here: no) Google account: no calendar settings or bookings, activity kept
      expect(db.prepare('SELECT COUNT(*) AS n FROM calendar_agent_settings').get()).toEqual({
        n: 0,
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM calendar_bookings').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT agent_id, chat_jid FROM calendar_activity').get()).toEqual({
        agent_id: agentId,
        chat_jid: `${LITE_CHAT}#3`,
      });
      // Google Sheets likewise: no settings or lead records, activity kept
      expect(db.prepare('SELECT COUNT(*) AS n FROM sheets_agent_settings').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM sheets_leads').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT agent_id, chat_jid FROM sheets_activity').get()).toEqual({
        agent_id: agentId,
        chat_jid: `${LITE_CHAT}#3`,
      });

      // Safety finding follows its message
      const item = db
        .prepare('SELECT id, message_id, chat_jid, inbox_id FROM safety_items')
        .get() as Record<string, unknown>;
      expect(item).toMatchObject({
        message_id: 'M4#3',
        chat_jid: '60888@s.whatsapp.net#3',
        inbox_id: 3,
      });
      expect(db.prepare('SELECT item_id, user_id FROM safety_downloads').get()).toEqual({
        item_id: item.id,
        user_id: t.amyId,
      });
      expect(db.prepare('SELECT scam_by FROM safety_numbers').get()).toEqual({ scam_by: lee.id });

      // Never imported
      expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });

      // Audit: remapped rows plus one lite.import row
      const send = db
        .prepare("SELECT user_id, meta FROM audit_log WHERE action = 'mcp.send'")
        .get() as { user_id: number; meta: string };
      expect(send.user_id).toBe(t.amyId);
      expect(JSON.parse(send.meta)).toEqual({
        tokenId: null,
        chatJid: `${LITE_CHAT}#3`,
        messageId: 'M2#3',
      });
      const imported = db
        .prepare("SELECT meta FROM audit_log WHERE action = 'lite.import'")
        .get() as { meta: string };
      expect(JSON.parse(imported.meta)).toMatchObject({
        inbox: 3,
        counts: { chats: 3, messages: 7, usersAdded: 1, usersMatched: 1, usersSkipped: 1 },
      });

      // Reports count inbox 3 on its own, including the hand-off still waiting
      const report = computeReport(db, { days: 7, timeZone: 'UTC', now: NOW, inboxIds: [3] });
      expect(report.totals.activeChats).toBe(2);
      expect(report.totals.messagesIn).toBe(3);
      expect(report.waitingAfterHandoff.count).toBe(1);
      const all = computeReport(db, { days: 7, timeZone: 'UTC', now: NOW });
      expect(all.totals.activeChats).toBe(3);
    } finally {
      db.close();
    }
  });

  it('starts the real server on the merged data: inbox 3 exists and a matched user signs in with the target password', async () => {
    const t = seedTarget();
    const lite = seedLite();
    await merge(t.dir, lite.dir);
    const ctx = await createContext(
      {
        dataDir: t.dir,
        port: 0,
        host: '127.0.0.1',
        mode: 'dev',
        fakeWa: true,
        webDistDir: null,
        version: '0.0.0-test',
      },
      { wa: new FakeWaAdapter(), log: silentLogger(), maxInboxes: 3, connectStaggerMs: 0 },
    );
    await runInitializers(ctx);
    const app = await buildApp(ctx);
    await app.ready();
    try {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'amy', password: 'lite-pass-1' },
        remoteAddress: '10.9.0.1',
      });
      expect(bad.statusCode).toBe(401);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'amy', password: TARGET_PASSWORD },
        remoteAddress: '10.9.0.2',
      });
      expect(login.statusCode).toBe(200);
      const cookie = sessionCookieFrom(login)!;
      const res = await app.inject({
        method: 'GET',
        url: '/api/inboxes',
        headers: { cookie, host: 'localhost' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as unknown;
      const list = (
        Array.isArray(body) ? body : (body as { inboxes: unknown[] }).inboxes
      ) as Array<{ id: number; name: string }>;
      expect(list.map((i) => i.id)).toContain(3);
      expect(list.find((i) => i.id === 3)?.name).toBe('Lite – +60333');
      // added Lite user signs in with the Lite password
      const lee = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'lee', password: 'lite-pass-1' },
        remoteAddress: '10.9.0.3',
      });
      expect(lee.statusCode).toBe(200);
    } finally {
      await app.close();
      await shutdownServices(ctx);
      await ctx.inboxes.connections.disconnectAll();
      ctx.bus.removeAllListeners();
      ctx.db.close();
    }
  });

  it('imports the agent off and unbound when no AI agent slot is free, and releases its chats', async () => {
    const t = seedTarget({ inboxes: 2 });
    const lite = seedLite();
    // maxInboxes 3 but the target already has 3 live agents → no agent slot
    const db = open(t.dir);
    for (const name of ['x', 'y']) {
      const uid = Number(
        db
          .prepare(
            "INSERT INTO users (username, display_name, password_hash, role, kind, created_at) VALUES (?, ?, '', 'agent', 'ai', 0)",
          )
          .run(`ai-${name}`, name).lastInsertRowid,
      );
      db.prepare(
        'INSERT INTO ai_agents (user_id, inbox_id, created_at, updated_at) VALUES (?, NULL, 0, 0)',
      ).run(uid);
    }
    db.close();
    const { result } = await merge(t.dir, lite.dir);
    expect(result).toMatchObject({ agentImported: true, agentOff: true });
    const after = open(t.dir);
    try {
      const agent = after
        .prepare(
          "SELECT a.inbox_id, u.disabled_at FROM ai_agents a JOIN users u ON u.id = a.user_id WHERE u.display_name = 'Lite AI'",
        )
        .get() as { inbox_id: number | null; disabled_at: number | null };
      expect(agent.inbox_id).toBeNull();
      expect(agent.disabled_at).not.toBeNull();
      expect(
        after.prepare('SELECT assigned_to FROM chats WHERE jid = ?').get(`${LITE_CHAT}#3`),
      ).toEqual({ assigned_to: null });
      expect(after.prepare('SELECT paused FROM ai_chat_state').get()).toEqual({ paused: 1 });
    } finally {
      after.close();
    }
  });

  it('brings Google Sheets settings and lead records only when both use the same Google account', async () => {
    const t = seedTarget({ sheetsAccount: 'Owner@Example.com' });
    const lite = seedLite({ sheetsAccount: 'owner@example.com' });
    await merge(t.dir, lite.dir);
    const db = open(t.dir);
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM sheets_agent_settings').get()).toEqual({ n: 1 });
      expect(
        db.prepare('SELECT chat_jid, tab, message_id, values_hash FROM sheets_leads').get(),
      ).toEqual({
        chat_jid: `${LITE_CHAT}#3`,
        tab: 'Leads',
        // The duplicate guard keeps pointing at the same message under its new key.
        message_id: 'M1#3',
        values_hash: 'h1',
      });
      // The Calendar sign-in differs (none): its settings stay behind.
      expect(db.prepare('SELECT COUNT(*) AS n FROM calendar_agent_settings').get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  });

  it('brings Google Calendar settings and bookings only when both use the same Google account', async () => {
    const t = seedTarget({ googleAccount: 'Owner@Example.com' });
    const lite = seedLite({ googleAccount: 'owner@example.com' });
    await merge(t.dir, lite.dir);
    const db = open(t.dir);
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM calendar_agent_settings').get()).toEqual({
        n: 1,
      });
      expect(db.prepare('SELECT chat_jid FROM calendar_bookings').get()).toEqual({
        chat_jid: `${LITE_CHAT}#3`,
      });
    } finally {
      db.close();
    }
  });

  it('keeps the target connection and asks to sign in again when Lite has no key', async () => {
    const t = seedTarget();
    const lite = seedLite();
    const { rmSync } = await import('node:fs');
    rmSync(join(lite.dir, 'secret.key'));
    await merge(t.dir, lite.dir);
    // nothing was written into Lite's folder
    expect(existsSync(join(lite.dir, 'secret.key'))).toBe(false);
    const db = open(t.dir);
    try {
      expect(
        db
          .prepare("SELECT state, secret FROM connector_connections WHERE connector_id = 'acme'")
          .get(),
      ).toEqual({ state: 'needs_sign_in', secret: null });
    } finally {
      db.close();
    }
  });

  it('matches by plan and names an inbox without a number "EzyChat Lite"', async () => {
    const t = seedTarget();
    const lite = seedLite({ ownJid: '' });
    const { result } = await merge(t.dir, lite.dir, {
      plan: {
        team: [{ liteUserId: lite.ids.lee, action: 'match', matchUserId: t.bossId, role: 'agent' }],
      },
    });
    expect(result.inboxName).toBe('EzyChat Lite');
    expect(result.usersMatched).toBe(2);
    const db = open(t.dir);
    try {
      expect(db.prepare('SELECT user_id FROM notes').get()).toEqual({ user_id: t.bossId });
      expect(db.prepare('SELECT role FROM users WHERE id = ?').get(t.bossId)).toEqual({
        role: 'admin',
      });
    } finally {
      db.close();
    }
  });

  it('suffixes a clashing username on add', async () => {
    const t = seedTarget();
    const lite = seedLite();
    await merge(t.dir, lite.dir, {
      plan: {
        team: [{ liteUserId: lite.ids.amy, action: 'add', matchUserId: null, role: 'agent' }],
      },
    });
    const db = open(t.dir);
    try {
      expect(
        db.prepare("SELECT username FROM users WHERE username LIKE 'amy%' ORDER BY id").all(),
      ).toEqual([{ username: 'amy' }, { username: 'amy-lite' }]);
    } finally {
      db.close();
    }
  });
});

describe('mergeLiteInbox refusals and rollback', () => {
  it('a failure mid-transaction leaves the target byte-for-byte unchanged and removes the copied folders', async () => {
    const t = seedTarget();
    const lite = seedLite();
    // a note by a user Lite does not have: the merge fails after chats and messages were written
    const db = openDb(join(lite.dir, 'app.db'));
    db.pragma('foreign_keys = OFF');
    db.prepare(
      "INSERT INTO notes (chat_jid, user_id, body, created_at) VALUES (?, 999, 'x', 0)",
    ).run(LITE_CHAT);
    db.close();
    const before = hash(join(t.dir, 'app.db'));
    const progress: LiteImportProgress[] = [];
    await expect(
      mergeLiteInbox({
        targetDataDir: t.dir,
        liteDataDir: lite.dir,
        plan: { team: [] },
        maxInboxes: 3,
        log: silentLogger(),
        progress: (p) => progress.push(p),
      }),
    ).rejects.toThrow('unknown Lite user');
    expect(hash(join(t.dir, 'app.db'))).toBe(before);
    expect(existsSync(join(t.dir, 'wa-auth-inboxes', '3'))).toBe(false);
    expect(existsSync(join(t.dir, 'media', 'inbox-3'))).toBe(false);
    expect(existsSync(join(t.dir, 'media', 'quarantine', 'inbox-3'))).toBe(false);
    expect(existsSync(join(t.dir, WORK_DIR))).toBe(false);
    expect(progress.at(-1)).toEqual({ step: 'merge', state: 'failed' });
  });

  it('the undo of a committed merge restores the pre-import data and removes the copied folders', async () => {
    const t = seedTarget();
    const lite = seedLite();
    const count = (sql: string) => {
      const db = openDb(join(t.dir, 'app.db'));
      try {
        return (db.prepare(sql).get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    const chatsBefore = count('SELECT COUNT(*) AS n FROM chats');
    const usersBefore = count('SELECT COUNT(*) AS n FROM users');
    let undo: (() => void) | null = null;
    const r = await mergeLiteInbox({
      targetDataDir: t.dir,
      liteDataDir: lite.dir,
      plan: { team: [] },
      maxInboxes: 3,
      log: silentLogger(),
      progress: () => {},
      onCommitted: (u) => (undo = u),
    });
    expect(count(`SELECT COUNT(*) AS n FROM inboxes WHERE id = ${r.inboxId}`)).toBe(1);
    expect(existsSync(join(t.dir, 'wa-auth-inboxes', String(r.inboxId)))).toBe(true);
    expect(undo).not.toBeNull();
    (undo as unknown as () => void)();
    expect(count(`SELECT COUNT(*) AS n FROM inboxes WHERE id = ${r.inboxId}`)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM chats')).toBe(chatsBefore);
    expect(count('SELECT COUNT(*) AS n FROM users')).toBe(usersBefore);
    expect(existsSync(join(t.dir, 'wa-auth-inboxes', String(r.inboxId)))).toBe(false);
    expect(existsSync(join(t.dir, 'media', `inbox-${r.inboxId}`))).toBe(false);
  });

  it('rejects an invalid plan match without changing the target', async () => {
    const t = seedTarget();
    const lite = seedLite();
    const before = hash(join(t.dir, 'app.db'));
    await expect(
      merge(t.dir, lite.dir, {
        plan: {
          team: [{ liteUserId: lite.ids.lee, action: 'match', matchUserId: 4242, role: 'agent' }],
        },
      }),
    ).rejects.toThrow('unknown user');
    expect(hash(join(t.dir, 'app.db'))).toBe(before);
  });

  const refused = async (p: Promise<unknown>, code: string) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LiteImportRefused);
    expect((err as LiteImportRefused).code).toBe(code);
  };

  it("refuses same_number when Lite's number is already an inbox (alias-resolved)", async () => {
    const t = seedTarget();
    // Lite knows its own number only as a LID; its alias table maps the target's inbox 2 number to it
    const lite = seedLite({ ownJid: '222@lid' });
    const db = openDb(join(lite.dir, 'app.db'));
    db.prepare(
      "INSERT INTO jid_aliases (alias_jid, canonical_jid, source, learned_at) VALUES ('60222@s.whatsapp.net', '222@lid', 'lid-mapping', 0)",
    ).run();
    db.close();
    const before = hash(join(t.dir, 'app.db'));
    await refused(merge(t.dir, lite.dir), 'same_number');
    expect(hash(join(t.dir, 'app.db'))).toBe(before);
    expect(existsSync(join(t.dir, WORK_DIR))).toBe(false);
    expect(existsSync(join(t.dir, 'backups'))).toBe(false);
  });

  it('refuses same_number for the plain number with a device part', async () => {
    const t = seedTarget();
    const lite = seedLite({ ownJid: '60111:3@s.whatsapp.net' });
    await refused(merge(t.dir, lite.dir), 'same_number');
  });

  it('refuses no_slot when every inbox slot is taken', async () => {
    const t = seedTarget();
    const lite = seedLite();
    await refused(merge(t.dir, lite.dir, { maxInboxes: 2 }), 'no_slot');
  });

  it("refuses lite_newer when Lite's data is newer than this build", async () => {
    const t = seedTarget();
    const lite = seedLite();
    const db = openDb(join(lite.dir, 'app.db'));
    db.pragma('user_version = 999');
    db.close();
    await refused(merge(t.dir, lite.dir), 'lite_newer');
    expect(existsSync(join(t.dir, WORK_DIR))).toBe(false);
  });

  it('migrates an older Lite copy before merging, never Lite itself', async () => {
    const t = seedTarget();
    const lite = seedLite();
    // pretend Lite stopped three migrations earlier: undo 028 (safety tables), 029 (message
    // changes) and 030 (Google Sheets)
    const db = openDb(join(lite.dir, 'app.db'));
    db.exec(
      'DROP TABLE sheets_agent_settings; DROP TABLE sheets_leads; DROP TABLE sheets_activity;',
    );
    db.exec('DROP TABLE safety_downloads; DROP TABLE safety_items; DROP TABLE safety_numbers;');
    db.exec('DROP TABLE message_edits; DROP TABLE message_changes_pending;');
    for (const column of [
      'edited_at',
      'deleted_at',
      'deleted_by',
      'deleted_by_user_id',
      'hidden_at',
      'hidden_by_user_id',
    ])
      db.exec(`ALTER TABLE messages DROP COLUMN ${column}`);
    // and 032 (group agents: its index and ai_group_chats columns; the agents table rebuild reruns)
    db.exec('DROP INDEX idx_ai_group_chats_agent; DROP INDEX idx_ai_agents_inbox;');
    db.exec(
      'ALTER TABLE ai_group_chats DROP COLUMN listen; ALTER TABLE ai_group_chats DROP COLUMN agent_id;',
    );
    db.pragma('user_version = 27');
    db.close();
    const { result } = await merge(t.dir, lite.dir);
    expect(result.chats).toBe(3);
    const check = openDb(join(t.dir, 'app.db'));
    try {
      expect(check.prepare('SELECT COUNT(*) AS n FROM safety_items').get()).toEqual({ n: 0 });
      expect(check.prepare('SELECT COUNT(*) AS n FROM message_edits').get()).toEqual({ n: 0 });
      expect(check.prepare('SELECT COUNT(*) AS n FROM sheets_leads').get()).toEqual({ n: 0 });
    } finally {
      check.close();
    }
  });
});
