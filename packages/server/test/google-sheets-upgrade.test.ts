import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SHEETS_SETTINGS, presetTexts } from '@ezychat/shared';
import { agentById, listAgents, updateAgentTexts } from '../src/ai/agents.js';
import { listSetupVersions } from '../src/ai/setup-versions.js';
import { FAKE_SPREADSHEET_ID } from '../src/connectors/google-sheets/fake.js';
import {
  legacyLeadsTab,
  mapLegacySettings,
  parseStoredSettings,
  readSettings,
} from '../src/connectors/google-sheets/repo.js';
import {
  leadsInstruction,
  upgradeSheetsSettings,
} from '../src/connectors/google-sheets/upgrade.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const legacy = (over: Record<string, unknown> = {}) => ({
  spreadsheetId: FAKE_SPREADSHEET_ID,
  spreadsheetName: 'Demo price list',
  lookupTab: 'Prices',
  lookup: true,
  leadsTab: 'Leads',
  addLeads: true,
  ...over,
});

async function withAgent(instructions: string | null) {
  t = await makeTestApp();
  const adminId = t.ctx.services.auth!.createUser({
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  }).id;
  t.ctx.services.ai!.saveMember(
    { displayName: 'Aina', enabled: false, instructions: instructions ?? '' },
    { userId: adminId, ip: null },
  );
  const agent = listAgents(t.ctx.db)[0]!;
  if (instructions === null) t.ctx.db.prepare('UPDATE ai_agents SET instructions = NULL').run();
  return agent.id;
}

const store = (agentId: number, settings: unknown) =>
  t.ctx.db
    .prepare(
      'INSERT OR REPLACE INTO sheets_agent_settings (agent_id, settings, updated_at) VALUES (?, ?, 1)',
    )
    .run(agentId, JSON.stringify(settings));

describe('Google Sheets settings from older releases', () => {
  it('maps the look-up and leads tabs to tab access', () => {
    expect(mapLegacySettings(legacy()).tabs).toEqual([
      { title: 'Prices', access: 'read' },
      { title: 'Leads', access: 'add' },
    ]);
    expect(mapLegacySettings(legacy({ lookup: false, addLeads: false })).tabs).toEqual([]);
    // Answer questions was on by default; one tab for both becomes Add rows.
    expect(mapLegacySettings(legacy({ lookup: undefined, leadsTab: 'Prices' })).tabs).toEqual([
      { title: 'Prices', access: 'add' },
    ]);
    expect(mapLegacySettings(legacy({ spreadsheetId: 'bad' }))).toEqual(DEFAULT_SHEETS_SETTINGS);
    expect(legacyLeadsTab(legacy())).toBe('Leads');
    expect(legacyLeadsTab(legacy({ addLeads: false }))).toBeNull();
    expect(legacyLeadsTab(legacy({ spreadsheetId: null }))).toBeNull();
    expect(legacyLeadsTab({ tabs: [] })).toBeNull();
    expect(parseStoredSettings('not json')).toEqual(DEFAULT_SHEETS_SETTINGS);
    expect(parseStoredSettings('{"tabs": "x"}')).toEqual(DEFAULT_SHEETS_SETTINGS);
  });

  it('reads an older save in the new shape before start-up rewrote it', async () => {
    const agentId = await withAgent('Sell kopi');
    store(agentId, legacy({ addLeads: false }));
    expect(readSettings(t.ctx.db, agentId)).toEqual({
      spreadsheetId: FAKE_SPREADSHEET_ID,
      spreadsheetName: 'Demo price list',
      tabs: [{ title: 'Prices', access: 'read' }],
    });
  });

  it('appends the leads line once, as a setup version, and rewrites the settings', async () => {
    const agentId = await withAgent('Sell kopi kindly.');
    store(agentId, legacy());
    expect(upgradeSheetsSettings(t.ctx)).toBe(1);
    const instructions = agentById(t.ctx.db, agentId)!.instructions!;
    expect(instructions).toBe(`Sell kopi kindly.\n\n${leadsInstruction('Leads')}`);
    expect(instructions).toContain(
      'Add customers who want to buy as a new row to the tab "Leads".',
    );
    const versions = listSetupVersions(t.ctx.db, agentId, 'instructions', null, 10);
    expect(versions[0]).toMatchObject({ content: instructions, via: 'app', userId: null });
    expect(versions[0]!.reason).toContain('Google Sheets');
    const stored = t.ctx.db
      .prepare('SELECT settings FROM sheets_agent_settings WHERE agent_id = ?')
      .get(agentId) as { settings: string };
    expect(JSON.parse(stored.settings)).toEqual({
      spreadsheetId: FAKE_SPREADSHEET_ID,
      spreadsheetName: 'Demo price list',
      tabs: [
        { title: 'Prices', access: 'read' },
        { title: 'Leads', access: 'add' },
      ],
    });
    expect(
      t.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'google_sheets.upgrade'")
        .get(),
    ).toEqual({ n: 1 });
    // The leads tab may still be empty: it keeps getting the lead header with its first row.
    expect(t.ctx.settings.get('google_sheets_legacy_leads', null)).toEqual({ [agentId]: 'Leads' });
    // Idempotent: a second start changes nothing.
    expect(upgradeSheetsSettings(t.ctx)).toBe(0);
    expect(agentById(t.ctx.db, agentId)!.instructions).toBe(instructions);
  });

  it('keeps instructions that already name the tab, and fills in the preset text when none was saved', async () => {
    const agentId = await withAgent('Put buyers in the LEADS tab.');
    store(agentId, legacy());
    upgradeSheetsSettings(t.ctx);
    expect(agentById(t.ctx.db, agentId)!.instructions).toBe('Put buyers in the LEADS tab.');
    expect(readSettings(t.ctx.db, agentId).tabs).toHaveLength(2);

    updateAgentTexts(t.ctx.db, agentId, { instructions: null });
    store(agentId, legacy({ leadsTab: 'Buyers', lookup: false }));
    upgradeSheetsSettings(t.ctx);
    const preset = presetTexts(agentById(t.ctx.db, agentId)!.preset).instructions;
    expect(agentById(t.ctx.db, agentId)!.instructions).toBe(
      preset.trim()
        ? `${preset.trimEnd()}\n\n${leadsInstruction('Buyers')}`
        : leadsInstruction('Buyers'),
    );
    expect(readSettings(t.ctx.db, agentId).tabs).toEqual([{ title: 'Buyers', access: 'add' }]);
  });

  it('skips unreadable rows and leaves instructions alone when Add leads was off', async () => {
    const agentId = await withAgent('Answer kindly.');
    t.ctx.db
      .prepare(
        'INSERT INTO sheets_agent_settings (agent_id, settings, updated_at) VALUES (?, ?, 1)',
      )
      .run(agentId, '{broken');
    expect(upgradeSheetsSettings(t.ctx)).toBe(0);
    store(agentId, legacy({ addLeads: false }));
    expect(upgradeSheetsSettings(t.ctx)).toBe(1);
    expect(agentById(t.ctx.db, agentId)!.instructions).toBe('Answer kindly.');
    expect(t.ctx.settings.get('google_sheets_legacy_leads', null)).toBeNull();
  });
});
