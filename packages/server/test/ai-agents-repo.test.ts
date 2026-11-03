import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/crypto/secret.js';
import type { DB } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { SettingsStore } from '../src/db/settings.js';
import {
  AgentError,
  agentById,
  agentByUserId,
  agentForInbox,
  agentsForInbox,
  createAgentRow,
  defaultAgent,
  deleteAgentRow,
  inboxHasDirectAgent,
  listAgents,
  migrateMemberSetting,
  releaseAgentGroups,
  setAgentAnswerDirect,
  setAgentAnswerGroups,
  setAgentInbox,
  updateAgentTexts,
} from '../src/ai/agents.js';
import {
  getSetupVersion,
  listSetupVersions,
  recordSetupVersion,
} from '../src/ai/setup-versions.js';

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
const dbs: DB[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A database as release `version` left it (migrations 001..version applied). In memory: every
 * migration on a file synced to disk took > 30 s on a busy Windows CI runner.
 */
function dbAt(version: number): { db: DB; settings: SettingsStore } {
  const dir = mkdtempSync(join(tmpdir(), 'wati-agents-'));
  dirs.push(dir);
  const db = new Database(':memory:');
  dbs.push(db);
  db.pragma('foreign_keys = ON');
  migrate(db, version);
  const settings = new SettingsStore(db, SecretBox.loadOrCreate(join(dir, 'secret.key')));
  return { db, settings };
}

function insertAiUser(db: DB, name = 'Sales Agent', disabledAt: number | null = null): number {
  return Number(
    db
      .prepare(
        "INSERT INTO users(username, display_name, password_hash, role, kind, disabled_at, created_at) VALUES (?, ?, '', 'agent', 'ai', ?, ?)",
      )
      .run(`ai-${Math.random()}`, name, disabledAt, NOW).lastInsertRowid,
  );
}

function insertItem(db: DB, name: string, text: string, agentId?: number): number {
  const cols = agentId === undefined ? '' : ', agent_id';
  const vals = agentId === undefined ? '' : ', ?';
  const args: unknown[] = [name, text.length, text, NOW, NOW];
  if (agentId !== undefined) args.push(agentId);
  return Number(
    db
      .prepare(
        `INSERT INTO ai_documents(name, kind, size, text, created_at, updated_at${cols}) VALUES (?, 'text', ?, ?, ?, ?${vals})`,
      )
      .run(...args).lastInsertRowid,
  );
}

function addInbox(db: DB, id: number, removed = false): void {
  db.prepare(
    "INSERT INTO inboxes(id, name, tone, auth_dir, created_at, removed_at) VALUES (?, ?, 'info', ?, ?, ?)",
  ).run(id, `Inbox ${id}`, `wa-auth-inboxes/${id}`, NOW, removed ? NOW : null);
}

/** Today's data dir: an AI member with two items and history, upgraded to 015. */
function upgradedWithMember(): { db: DB; settings: SettingsStore; userId: number } {
  const { db, settings } = dbAt(14);
  const userId = insertAiUser(db);
  insertItem(db, 'Prices', 'Kopi RM5');
  insertItem(db, 'Hours', 'Open 8-6');
  db.prepare(
    "INSERT INTO ai_setup_versions(target, item_id, content, via, created_at) VALUES ('instructions', NULL, 'Be kind', 'app', ?)",
  ).run(NOW);
  migrate(db);
  return { db, settings, userId };
}

describe('migration 015', { timeout: 30_000 }, () => {
  it('turns the AI member into agent 1 on inbox 1 with NULL texts, its items and its history', () => {
    const { db, userId } = upgradedWithMember();
    const agents = listAgents(db);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      userId,
      inboxId: 1,
      preset: 'sales',
      instructions: null,
      handoffRules: null,
      displayName: 'Sales Agent',
      enabled: true,
    });
    const id = agents[0]!.id;
    expect(
      db.prepare('SELECT agent_id AS a, internal AS i FROM ai_documents ORDER BY id').all(),
    ).toEqual([
      { a: id, i: 0 },
      { a: id, i: 0 },
    ]);
    expect(listSetupVersions(db, id, 'instructions', null, 10).map((v) => v.content)).toEqual([
      'Be kind',
    ]);
    // Several AI users are allowed now.
    expect(() => insertAiUser(db, 'FAQ')).not.toThrow();
  });

  it('creates no agent when there is no AI member', () => {
    const { db } = dbAt(14);
    insertItem(db, 'Prices', 'Kopi RM5');
    migrate(db);
    expect(listAgents(db)).toEqual([]);
    expect(defaultAgent(db)).toBeNull();
    expect(db.prepare('SELECT agent_id AS a FROM ai_documents').get()).toEqual({ a: null });
  });
});

describe('agents repo', { timeout: 30_000 }, () => {
  it('finds an agent by id, user and inbox', () => {
    const { db, userId } = upgradedWithMember();
    const agent = listAgents(db)[0]!;
    expect(agentById(db, agent.id)).toEqual(agent);
    expect(agentByUserId(db, userId)).toEqual(agent);
    expect(agentForInbox(db, 1)).toEqual(agent);
    expect(agentById(db, 999)).toBeNull();
    expect(agentByUserId(db, 999)).toBeNull();
    expect(agentForInbox(db, 2)).toBeNull();
  });

  it('creates an agent, updates only the given texts and keeps a saved blank', () => {
    const { db } = upgradedWithMember();
    addInbox(db, 2);
    const userId = insertAiUser(db, 'Helpdesk', NOW);
    const agent = createAgentRow(
      db,
      { userId, inboxId: 2, preset: 'faq', instructions: 'Answer FAQs', handoffRules: null },
      NOW + 5,
    );
    expect(agent).toMatchObject({
      userId,
      inboxId: 2,
      preset: 'faq',
      instructions: 'Answer FAQs',
      handoffRules: null,
      displayName: 'Helpdesk',
      enabled: false,
      createdAt: NOW + 5,
      updatedAt: NOW + 5,
    });
    updateAgentTexts(db, agent.id, { handoffRules: '' }, NOW + 9);
    expect(agentById(db, agent.id)).toMatchObject({
      preset: 'faq',
      instructions: 'Answer FAQs',
      handoffRules: '',
      updatedAt: NOW + 9,
    });
    updateAgentTexts(db, agent.id, { preset: 'custom', instructions: null }, NOW + 10);
    expect(agentById(db, agent.id)).toMatchObject({ preset: 'custom', instructions: null });
    expect(() => updateAgentTexts(db, 999, { instructions: 'x' }, NOW)).toThrow(AgentError);
  });

  it('a second agent on an inbox starts group-only; a second direct agent is refused', () => {
    const { db } = upgradedWithMember();
    const first = listAgents(db)[0]!;
    const second = createAgentRow(
      db,
      {
        userId: insertAiUser(db, 'Claims'),
        inboxId: 1,
        preset: 'custom',
        instructions: null,
        handoffRules: null,
      },
      NOW,
    );
    expect(second).toMatchObject({ inboxId: 1, answerDirect: false });
    expect(agentsForInbox(db, 1).map((a) => a.id)).toEqual([first.id, second.id]);
    expect(inboxHasDirectAgent(db, 1, second.id)).toBe(true);
    expect(inboxHasDirectAgent(db, 1, first.id)).toBe(false);
    expect(inboxHasDirectAgent(db, null, null)).toBe(false);
    let error: unknown;
    try {
      createAgentRow(
        db,
        {
          userId: insertAiUser(db, 'Other'),
          inboxId: 1,
          preset: 'sales',
          instructions: null,
          handoffRules: null,
          answerDirect: true,
        },
        NOW,
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('inbox_has_direct_agent');
    expect(() => setAgentAnswerDirect(db, second.id, true, NOW)).toThrow(
      expect.objectContaining({ code: 'inbox_has_direct_agent' }),
    );
    expect(() => setAgentAnswerDirect(db, 999, false, NOW)).toThrow(
      expect.objectContaining({ code: 'agent_not_found' }),
    );
    // the main agent of the inbox is its direct one, even when a group-only one is older
    setAgentAnswerDirect(db, first.id, false, NOW);
    setAgentAnswerDirect(db, second.id, true, NOW);
    expect(agentForInbox(db, 1)?.id).toBe(second.id);
  });

  it("releases an agent's groups when it moves, its groups go off or it is deleted", () => {
    const { db } = upgradedWithMember();
    addInbox(db, 2);
    const agent = listAgents(db)[0]!;
    const row = (jid: string) =>
      db
        .prepare(
          'SELECT enabled, agent_id AS agentId, listen FROM ai_group_chats WHERE chat_jid = ?',
        )
        .get(jid);
    const give = (jid: string) =>
      db
        .prepare(
          'INSERT OR REPLACE INTO ai_group_chats (chat_jid, enabled, agent_id, listen, updated_at) VALUES (?, 1, ?, 1, 0)',
        )
        .run(jid, agent.id);
    give('g1@g.us');
    setAgentAnswerGroups(db, agent.id, true, NOW);
    expect(row('g1@g.us')).toEqual({ enabled: 1, agentId: agent.id, listen: 1 });
    setAgentAnswerGroups(db, agent.id, false, NOW);
    expect(row('g1@g.us')).toEqual({ enabled: 0, agentId: null, listen: 0 });
    expect(() => setAgentAnswerGroups(db, 999, false, NOW)).toThrow(
      expect.objectContaining({ code: 'agent_not_found' }),
    );
    give('g2@g.us');
    setAgentInbox(db, agent.id, 2, NOW);
    expect(row('g2@g.us')).toEqual({ enabled: 0, agentId: null, listen: 0 });
    give('g3@g.us');
    expect(releaseAgentGroups(db, 999)).toBe(0);
    deleteAgentRow(db, agent.id, NOW);
    expect(row('g3@g.us')).toEqual({ enabled: 0, agentId: null, listen: 0 });
  });

  it('setAgentInbox refuses a second direct agent and allows free inboxes and NULL', () => {
    const { db } = upgradedWithMember();
    addInbox(db, 2);
    addInbox(db, 3);
    const first = listAgents(db)[0]!;
    const second = createAgentRow(
      db,
      {
        userId: insertAiUser(db, 'B'),
        inboxId: 2,
        preset: 'sales',
        instructions: null,
        handoffRules: null,
      },
      NOW,
    );
    expect(() => setAgentInbox(db, second.id, 1, NOW)).toThrow(
      expect.objectContaining({ code: 'inbox_has_direct_agent' }),
    );
    expect(agentById(db, second.id)?.inboxId).toBe(2);
    setAgentInbox(db, second.id, 2, NOW); // its own inbox: no error
    setAgentInbox(db, second.id, 3, NOW + 1);
    expect(agentById(db, second.id)).toMatchObject({ inboxId: 3, updatedAt: NOW + 1 });
    setAgentInbox(db, first.id, null, NOW);
    expect(agentForInbox(db, 1)).toBeNull();
    setAgentInbox(db, second.id, 1, NOW);
    expect(agentForInbox(db, 1)?.id).toBe(second.id);
    expect(() => setAgentInbox(db, 999, null, NOW)).toThrow(
      expect.objectContaining({ code: 'agent_not_found' }),
    );
  });

  it('deleteAgentRow cascades its items, hides the agent and keeps the user row disabled', () => {
    const { db, userId } = upgradedWithMember();
    addInbox(db, 2);
    const other = createAgentRow(
      db,
      {
        userId: insertAiUser(db, 'B'),
        inboxId: 2,
        preset: 'sales',
        instructions: null,
        handoffRules: null,
      },
      NOW,
    );
    insertItem(db, 'B item', 'kept', other.id);
    const first = listAgents(db)[0]!;
    deleteAgentRow(db, first.id, NOW + 1);
    expect(listAgents(db).map((a) => a.id)).toEqual([other.id]);
    expect(agentById(db, first.id)).toBeNull();
    expect(agentByUserId(db, userId)).toBeNull();
    expect(db.prepare('SELECT name FROM ai_documents').all()).toEqual([{ name: 'B item' }]);
    expect(
      db.prepare('SELECT disabled_at AS d, ai_deleted_at AS x FROM users WHERE id = ?').get(userId),
    ).toEqual({ d: NOW + 1, x: NOW + 1 });
    expect(() => deleteAgentRow(db, first.id)).toThrow(
      expect.objectContaining({ code: 'agent_not_found' }),
    );
  });

  it('defaultAgent: the only agent, else the agent of inbox 1, else the lowest id', () => {
    const { db } = upgradedWithMember();
    addInbox(db, 2);
    addInbox(db, 3);
    const first = listAgents(db)[0]!;
    // The only agent, even when it serves no inbox.
    setAgentInbox(db, first.id, null, NOW);
    expect(defaultAgent(db)?.id).toBe(first.id);
    const second = createAgentRow(
      db,
      {
        userId: insertAiUser(db, 'B'),
        inboxId: 1,
        preset: 'sales',
        instructions: null,
        handoffRules: null,
      },
      NOW,
    );
    expect(defaultAgent(db)?.id).toBe(second.id);
    setAgentInbox(db, second.id, 3, NOW);
    expect(defaultAgent(db)?.id).toBe(first.id);
  });

  it('AgentError carries its code', () => {
    const error = new AgentError('internal_too_large');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('internal_too_large');
    expect(error.message).toBe('internal_too_large');
  });
});

describe('migrateMemberSetting', { timeout: 30_000 }, () => {
  it('keeps blank hand-over rules and leaves never-saved instructions NULL (Review Focus 1)', () => {
    const { db, settings } = upgradedWithMember();
    settings.set('ai_sales_member', { displayName: 'Sales Agent', handoffRules: '' });
    migrateMemberSetting(db, settings);
    expect(listAgents(db)[0]).toMatchObject({ instructions: null, handoffRules: '' });
    expect(settings.get('ai_agents_migrated', false)).toBe(true);
  });

  it('copies saved texts, turns non-strings into NULL and runs only once', () => {
    const { db, settings } = upgradedWithMember();
    settings.set('ai_sales_member', { instructions: 'Sell kopi', handoffRules: 42 });
    migrateMemberSetting(db, settings);
    const agent = listAgents(db)[0]!;
    expect(agent).toMatchObject({ instructions: 'Sell kopi', handoffRules: null });
    // A later change of the stale setting is never copied again.
    settings.set('ai_sales_member', { instructions: 'Stale', handoffRules: 'Stale' });
    migrateMemberSetting(db, settings);
    expect(listAgents(db)).toEqual([agent]);
    expect(db.prepare('SELECT count(*) AS n FROM ai_documents').get()).toEqual({ n: 2 });
  });

  it('works without a stored setting or an agent and still sets the flag', () => {
    const { db, settings } = dbAt(14);
    migrate(db);
    migrateMemberSetting(db, settings);
    expect(listAgents(db)).toEqual([]);
    expect(settings.get('ai_agents_migrated', false)).toBe(true);
  });

  it('adopts items and history written without an agent', () => {
    const { db, settings } = upgradedWithMember();
    const orphan = insertItem(db, 'Legacy', 'from the legacy context');
    db.prepare(
      "INSERT INTO ai_setup_versions(target, item_id, content, via, created_at) VALUES ('context_text', ?, 'x', 'app', ?)",
    ).run(orphan, NOW);
    migrateMemberSetting(db, settings);
    const id = listAgents(db)[0]!.id;
    expect(db.prepare('SELECT agent_id AS a FROM ai_documents WHERE id = ?').get(orphan)).toEqual({
      a: id,
    });
    expect(listSetupVersions(db, id, 'context_text', orphan, 5)).toHaveLength(1);
  });

  it('with inboxes 1-3 active creates agents for 2 and 3 with copied texts and items', () => {
    const { db, settings, userId } = upgradedWithMember();
    db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(NOW, userId);
    db.prepare('UPDATE ai_documents SET internal = 1 WHERE name = ?').run('Hours');
    addInbox(db, 2);
    addInbox(db, 3);
    addInbox(db, 4, true); // removed: gets no agent
    settings.set('ai_sales_member', { instructions: 'Sell kopi', handoffRules: '' });
    // Chats the one AI member owned in every inbox before the upgrade.
    const chat = db.prepare(
      "INSERT INTO chats(jid, type, assigned_to, inbox_id, wa_jid, updated_at) VALUES (?, 'dm', ?, ?, ?, ?)",
    );
    chat.run('a@s.whatsapp.net', userId, 1, 'a@s.whatsapp.net', NOW);
    chat.run('b@s.whatsapp.net#2', userId, 2, 'b@s.whatsapp.net', NOW);
    chat.run('c@s.whatsapp.net#3', null, 3, 'c@s.whatsapp.net', NOW);
    migrateMemberSetting(db, settings);
    const agents = listAgents(db);
    expect(agents.map((a) => a.inboxId)).toEqual([1, 2, 3]);
    // Each chat stays with the AI that answers its inbox; an unassigned chat stays unassigned.
    expect(db.prepare('SELECT jid, assigned_to AS a FROM chats ORDER BY jid').all()).toEqual([
      { jid: 'a@s.whatsapp.net', a: userId },
      { jid: 'b@s.whatsapp.net#2', a: agents[1]!.userId },
      { jid: 'c@s.whatsapp.net#3', a: null },
    ]);
    for (const agent of agents.slice(1)) {
      expect(agent).toMatchObject({
        preset: 'sales',
        instructions: 'Sell kopi',
        handoffRules: '',
        displayName: 'Sales Agent',
        enabled: false,
      });
      expect(agent.userId).not.toBe(userId);
      expect(
        db
          .prepare(
            'SELECT name, text, internal FROM ai_documents WHERE agent_id = ? ORDER BY created_at, id',
          )
          .all(agent.id),
      ).toEqual([
        { name: 'Prices', text: 'Kopi RM5', internal: 0 },
        { name: 'Hours', text: 'Open 8-6', internal: 1 },
      ]);
      expect(db.prepare('SELECT kind, role FROM users WHERE id = ?').get(agent.userId)).toEqual({
        kind: 'ai',
        role: 'agent',
      });
    }
    migrateMemberSetting(db, settings);
    expect(listAgents(db)).toHaveLength(3);
    expect(db.prepare('SELECT count(*) AS n FROM ai_documents').get()).toEqual({ n: 6 });
  });
});

describe('setup versions per agent', { timeout: 30_000 }, () => {
  it("stores a baseline for agent 2's first save although agent 1 has history", () => {
    const { db } = upgradedWithMember();
    addInbox(db, 2);
    const first = listAgents(db)[0]!;
    const second = createAgentRow(
      db,
      {
        userId: insertAiUser(db, 'B'),
        inboxId: 2,
        preset: 'sales',
        instructions: null,
        handoffRules: null,
      },
      NOW,
    );
    recordSetupVersion(
      db,
      second.id,
      'instructions',
      null,
      'Default',
      'Mine',
      { userId: null, via: 'app' },
      NOW + 10,
    );
    expect(
      listSetupVersions(db, second.id, 'instructions', null, 10).map((v) => [v.content, v.via]),
    ).toEqual([
      ['Mine', 'app'],
      ['Default', 'baseline'],
    ]);
    // Agent 1's history is unchanged and separate.
    expect(listSetupVersions(db, first.id, 'instructions', null, 10).map((v) => v.content)).toEqual(
      ['Be kind'],
    );
    // A second save of agent 2 stores no further baseline.
    recordSetupVersion(
      db,
      second.id,
      'instructions',
      null,
      'Mine',
      'Mine 2',
      { userId: null, via: 'mcp', tokenId: null, reason: 'r' },
      NOW + 20,
    );
    const versions = listSetupVersions(db, second.id, 'instructions', null, 10);
    expect(versions.map((v) => v.content)).toEqual(['Mine 2', 'Mine', 'Default']);
    expect(getSetupVersion(db, versions[0]!.id)).toMatchObject({
      agentId: second.id,
      content: 'Mine 2',
      via: 'mcp',
      reason: 'r',
    });
    expect(getSetupVersion(db, 999_999)).toBeNull();
  });
});
