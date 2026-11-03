import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SHEETS_SETTINGS,
  SHEETS_LEAD_COLUMNS,
  type SheetTabSetting,
} from '@ezychat/shared';
import type { ToolSet } from 'ai';
import { listAgents } from '../src/ai/agents.js';
import { CORE_AGENT_TOOL_NAMES } from '../src/ai/agent/extension-tools.js';
import { agentLookupsAvailable, agentTurnTools } from '../src/ai/agent/turn-tools.js';
import { FAKE_SPREADSHEET_ID } from '../src/connectors/google-sheets/fake.js';
import type { SheetRecordContext } from '../src/connectors/google-sheets/record.js';
import { sheetsCanAddRows } from '../src/connectors/google-sheets/record.js';
import { mergeSheetsRows } from '../src/connectors/google-sheets/repo.js';
import { createGoogleSheetsService } from '../src/connectors/google-sheets/service.js';
import { SHEETS_TOOL_NAMES, refusal } from '../src/connectors/google-sheets/tools.js';
import { upgradeSheetsSettings } from '../src/connectors/google-sheets/upgrade.js';
import { getMessages } from '../src/wa-bridge/index.js';
import { makeTestApp, type TestApp } from './helpers.js';

const jid = '60123456789@s.whatsapp.net';
const groupJid = '120363000000000001@g.us';
const ali = '60111111111@s.whatsapp.net';
const siti = '60122222222@s.whatsapp.net';

let t: TestApp;
let adminId: number;
let agentId: number;
afterEach(async () => {
  await t?.close();
});

async function call(tools: ToolSet, name: string, input: object): Promise<string> {
  const execute = tools[name]?.execute as
    ((input: object, options: object) => Promise<string>) | undefined;
  if (!execute) throw new Error(`tool ${name} not offered`);
  return execute(input, { toolCallId: `call-${name}`, messages: [], abortSignal: undefined });
}

const PRICES: SheetTabSetting = { title: 'Prices', access: 'read' };
const CLAIMS: SheetTabSetting = { title: 'Claims', access: 'add' };

async function setUp(tabs: SheetTabSetting[] = [PRICES], connect = true) {
  t = await makeTestApp();
  adminId = t.ctx.services.auth!.createUser({
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  }).id;
  t.ctx.services.ai!.saveMember(
    { displayName: 'Aina', enabled: false, instructions: '' },
    { userId: adminId, ip: null },
  );
  agentId = listAgents(t.ctx.db)[0]!.id;
  const svc = t.ctx.services.googleSheets!;
  if (connect) {
    const start = svc.startConnect('http://127.0.0.1:7420/api/connectors/google-sheets/callback', {
      userId: adminId,
      ip: null,
    });
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const target = new URL(svc.fakeConsent(state, true)!);
    expect((await svc.callback(Object.fromEntries(target.searchParams))).status).toBe(200);
    // Like drive.file: the admin picked the demo sheet in Google's file picker.
    svc.fake!.grant(FAKE_SPREADSHEET_ID);
    await svc.putSettings(
      agentId,
      { ...DEFAULT_SHEETS_SETTINGS, spreadsheetId: FAKE_SPREADSHEET_ID, tabs },
      { userId: adminId, ip: null },
    );
  }
  return svc;
}

async function says(
  id: string,
  text: string,
  chatJid = jid,
  senderJid = chatJid === jid ? jid : ali,
  senderName = 'Mei Ying',
) {
  await getMessages(t.ctx).ingest(
    {
      id,
      chatJid,
      body: text,
      type: 'text',
      fromMe: false,
      senderJid,
      senderName,
      timestamp: Date.now(),
      quotedId: null,
      media: null,
    },
    'live',
  );
}

const turn = (chatJid: string | null, lookupsOnly = false, record?: SheetRecordContext) => {
  const onFailure = vi.fn();
  return agentTurnTools(
    t.ctx,
    t.ctx.log,
    { agent: 'sales', agentId, chatJid, signal: new AbortController().signal },
    { onFailure, lookupsOnly, record },
  ).then((tools) => ({ ...tools, onFailure }));
};

const claims = () => t.ctx.services.googleSheets!.fake!.rows(FAKE_SPREADSHEET_ID, 'Claims');

describe('Google Sheets AI tools', () => {
  it('offers nothing until a sheet is connected and a tab is on', async () => {
    await setUp([], false);
    expect(Object.keys((await turn(jid)).tools)).not.toContain('read_sheet_rows');
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(false);
    expect(sheetsCanAddRows(t.ctx, agentId)).toBe(false);
    expect(sheetsCanAddRows(t.ctx, null)).toBe(false);
  });

  it('keeps every sheet tool name reserved for the core', () => {
    for (const name of SHEETS_TOOL_NAMES) expect(CORE_AGENT_TOOL_NAMES).toContain(name);
  });

  it('describes only the tabs of each access, with their columns', async () => {
    const svc = await setUp([
      PRICES,
      CLAIMS,
      { title: 'Leads', access: 'off' },
      { title: 'Notes', access: 'add' },
    ]);
    expect(sheetsCanAddRows(t.ctx, agentId)).toBe(true);
    const tools = await turn(jid);
    expect(Object.keys(tools.tools).sort()).toEqual(['add_sheet_row', 'read_sheet_rows']);
    const read = tools.tools.read_sheet_rows!.description!;
    expect(read).toContain('"Prices" (columns: Item, Price (RM), In stock, Notes)');
    expect(read).not.toContain('Claims');
    const add = tools.tools.add_sheet_row!.description!;
    expect(add).toContain(
      '"Claims" (columns: Date, Name, WhatsApp, Group, Policy no, Amount, What happened, Source)',
    );
    // The empty tab (no first row) cannot take rows; an off tab is never listed.
    expect(add).not.toContain('Notes');
    expect(add).not.toContain('Leads');
    expect(add).toContain('EzyChat fills these columns itself');
    expect(add).toContain('Date, Name, WhatsApp, Group, AI agent, Source');
    expect(add).toContain(
      'Use only values the person wrote or that are in a file they sent. Rows are only added, never changed. Report recorded only when this tool says it was added.',
    );
    // Columns are cached: a second turn reads nothing from Google.
    const reads = svc.fake!.calls.filter((c) => c === 'batchGet').length;
    await turn(jid);
    expect(svc.fake!.calls.filter((c) => c === 'batchGet')).toHaveLength(reads);
  });

  it('offers no add tool when every add tab has an empty first row, and no read tool without a read tab', async () => {
    await setUp([{ title: 'Notes', access: 'add' }]);
    expect(Object.keys((await turn(jid)).tools)).toEqual([]);
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(false);
  });

  it('still offers the tabs when Google cannot be read at the start of the turn', async () => {
    const svc = await setUp([PRICES, CLAIMS]);
    svc.fake!.mode = 'unavailable';
    const tools = await turn(jid);
    expect(Object.keys(tools.tools).sort()).toEqual(['add_sheet_row', 'read_sheet_rows']);
    expect(tools.tools.add_sheet_row!.description).toContain('add rows to: "Claims". Pass');
  });

  it('looks up matching rows of a read tab and logs who looked (never the values)', async () => {
    await setUp();
    await says('m1', 'How much is the durian cake?');
    const tools = await turn(jid);
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(true);
    const out = JSON.parse(
      await call(tools.tools, 'read_sheet_rows', { tab: 'Prices', query: 'durian cake' }),
    );
    expect(out.columns).toEqual(['Item', 'Price (RM)', 'In stock', 'Notes']);
    expect(out.rows).toContainEqual({
      Item: 'Durian cake (whole)',
      'Price (RM)': '88.00',
      'In stock': 'No',
      Notes: 'Back in stock on Friday',
    });
    // A second look-up in the same minute reads the cached tab.
    await call(tools.tools, 'read_sheet_rows', { tab: 'Prices', query: 'teh' });
    expect(t.ctx.services.googleSheets!.fake!.calls.filter((c) => c === 'values')).toHaveLength(1);
    expect(tools.used()).toEqual([{ title: 'your sheet', sourceLabel: 'Google Sheets' }]);
    const activity = t.ctx.services.googleSheets!.activity();
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      kind: 'looked_up',
      agentName: 'Aina',
      customer: 'Mei Ying',
      tab: 'Prices',
      group: null,
    });
    // A tab switched off since the turn started.
    await t.ctx.services.googleSheets!.putSettings(
      agentId,
      { ...DEFAULT_SHEETS_SETTINGS, spreadsheetId: FAKE_SPREADSHEET_ID, tabs: [CLAIMS] },
      { userId: adminId, ip: null },
    );
    expect(await call(tools.tools, 'read_sheet_rows', { tab: 'Prices', query: 'x' })).toContain(
      'not available now',
    );
  });

  it('adds a row with the auto columns filled, RAW values, and never the same row twice', async () => {
    await setUp([CLAIMS]);
    await says('m1', 'Claim: policy P-1042, amount RM 1,250.00, the car door was dented');
    const tools = await turn(jid);
    const values = {
      'policy NO': 'P-1042',
      amount: 'RM1250',
      'What happened': 'car door was dented',
    };
    const out = await call(tools.tools, 'add_sheet_row', { tab: 'Claims', values });
    expect(out).toBe('Added to "Claims".');
    const rows = claims();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
      'Mei Ying',
      '+60123456789',
      '',
      'P-1042',
      'RM1250',
      'car door was dented',
      'Message',
    ]);
    // A retry of the same row for the same message adds nothing.
    expect(await call(tools.tools, 'add_sheet_row', { tab: 'Claims', values })).toContain(
      'Already added',
    );
    expect(claims()).toHaveLength(2);
    // Different values from the same message are a second row (one PDF, three invoices).
    await call(tools.tools, 'add_sheet_row', {
      tab: 'claims',
      values: { 'Policy no': 'P-1042', Amount: '1,250' },
    });
    expect(claims()).toHaveLength(3);
    const events = t.ctx.db
      .prepare("SELECT payload FROM chat_events WHERE chat_jid = ? AND type = 'ai_tool_used'")
      .all(jid) as Array<{ payload: string }>;
    expect(events.map((e) => JSON.parse(e.payload))).toContainEqual({
      title: 'Add a row to Claims',
      sourceLabel: 'Google Sheets',
      sheet: { action: 'row_added', tab: 'Claims' },
    });
    const activity = t.ctx.services.googleSheets!.activity();
    expect(activity.map((a) => [a.kind, a.tab])).toEqual([
      ['row_added', 'Claims'],
      ['row_added', 'Claims'],
    ]);
    const stored = t.ctx.db.prepare('SELECT tab, message_id, values_hash FROM sheets_leads').all();
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain('P-1042');
  });

  it('lets the AI change an auto column and writes formulas as text', async () => {
    await setUp([CLAIMS]);
    await says('m1', 'Policy =HYPERLINK("http://x") please');
    const tools = await turn(jid);
    await call(tools.tools, 'add_sheet_row', {
      tab: 'Claims',
      values: { Name: 'Ahmad bin Ali', 'Policy no': '=HYPERLINK("http://x")' },
    });
    expect(claims()[1]![1]).toBe('Ahmad bin Ali');
    expect(claims()[1]![4]).toBe('=HYPERLINK("http://x")');
  });

  it('refuses unknown columns, a tab not on Add rows and a value the person never wrote', async () => {
    await setUp([PRICES, CLAIMS]);
    await says('m1', 'Policy P-7 please, it happened on 3/11/2026');
    const tools = await turn(jid);
    const unknown = await call(tools.tools, 'add_sheet_row', {
      tab: 'Claims',
      values: { Policy: 'P-7' },
    });
    expect(unknown).toContain('has no column "Policy"');
    expect(unknown).toContain('"Policy no"');
    const invented = await call(tools.tools, 'add_sheet_row', {
      tab: 'Claims',
      values: { 'Policy no': 'P-7', Amount: 'RM 900' },
    });
    expect(invented).toContain('"Amount" is not in what the person wrote');
    expect(invented).toContain('Ask the person for it');
    // A date in another form is the same date.
    expect(
      await call(tools.tools, 'add_sheet_row', {
        tab: 'Claims',
        values: { 'Policy no': 'P-7', 'What happened': '2026-11-03' },
      }),
    ).toBe('Added to "Claims".');
    const svc = t.ctx.services.googleSheets!;
    expect(await svc.addRow(agentId, jid, { tab: 'Prices', values: {} }, undefined)).toEqual({
      ok: false,
      reason: 'not_allowed',
      tabs: ['Claims'],
    });
    expect(claims()).toHaveLength(2);
  });

  it('accepts values read from a file the turn was given, and names the file as the source', async () => {
    await setUp([CLAIMS]);
    await says('m1', 'see attached');
    const record: SheetRecordContext = {
      personJids: null,
      messageIds: ['m1'],
      filesGiven: true,
      fileNames: ['invoice-1042.pdf'],
    };
    const tools = await turn(jid, false, record);
    expect(
      await call(tools.tools, 'add_sheet_row', {
        tab: 'Claims',
        values: { 'Policy no': 'INV-1042', Amount: 'RM 1,250.00' },
      }),
    ).toBe('Added to "Claims".');
    expect(claims()[1]!.at(-1)).toBe('invoice-1042.pdf');
  });

  it('in a group: checks values against the sender only, fills the group and the member', async () => {
    const svc = await setUp([CLAIMS]);
    await says('g1', 'Claim policy P-55 amount 300', groupJid, ali, 'Ali');
    await says('g2', 'my policy is P-99', groupJid, siti, 'Siti');
    t.ctx.db.prepare("UPDATE chats SET name = 'Claims KL' WHERE jid = ?").run(groupJid);
    const record: SheetRecordContext = {
      personJids: [ali],
      messageIds: ['g1'],
      filesGiven: false,
      fileNames: [],
    };
    // Group turns keep add_sheet_row (the one write allowed in groups).
    const tools = await turn(groupJid, true, record);
    expect(Object.keys(tools.tools)).toEqual(['add_sheet_row']);
    expect(
      await call(tools.tools, 'add_sheet_row', { tab: 'Claims', values: { 'Policy no': 'P-99' } }),
    ).toContain('not in what the person wrote');
    expect(
      await call(tools.tools, 'add_sheet_row', {
        tab: 'Claims',
        values: { 'Policy no': 'P-55', Amount: '300' },
      }),
    ).toBe('Added to "Claims".');
    expect(claims()[1]).toEqual([
      expect.any(String),
      'Ali',
      '+60111111111',
      'Claims KL',
      'P-55',
      '300',
      '',
      'Message',
    ]);
    expect(svc.activity()[0]).toMatchObject({
      kind: 'row_added',
      tab: 'Claims',
      group: 'Claims KL',
    });
    // Without a record context a group row is the newest sender's (Siti).
    const plain = await turn(groupJid, true);
    expect(
      await call(plain.tools, 'add_sheet_row', { tab: 'Claims', values: { 'Policy no': 'P-99' } }),
    ).toBe('Added to "Claims".');
    expect(claims()[2]!.slice(1, 4)).toEqual(['Siti', '+60122222222', 'Claims KL']);
  });

  it('waits out Google’s per-minute quota and adds the row', async () => {
    await setUp([CLAIMS]);
    const sleep = vi.fn(async () => {});
    const svc = createGoogleSheetsService(t.ctx, {
      fake: t.ctx.services.googleSheets!.fake,
      sleep,
    });
    await says('m1', 'policy P-1');
    svc.fake!.appendStatuses.push(429, 429);
    const result = await svc.addRow(
      agentId,
      jid,
      { tab: 'Claims', values: { 'Policy no': 'P-1' } },
      undefined,
    );
    expect(result).toEqual({ ok: true, already: false, tab: 'Claims' });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(claims()).toHaveLength(2);
    // Past the bounded wait the error is thrown (the tool hands over).
    svc.fake!.appendStatuses.push(429, 429, 429, 429, 429);
    await expect(
      svc.addRow(
        agentId,
        jid,
        { tab: 'Claims', values: { 'Policy no': 'P-1', Amount: '' } },
        {
          personJids: null,
          messageIds: ['other'],
          filesGiven: false,
          fileNames: [],
        },
      ),
    ).rejects.toThrow();
    expect(claims()).toHaveLength(2);
    svc.shutdown();
  });

  it('stops waiting for the quota when the turn is cancelled', async () => {
    const svc = await setUp([CLAIMS]);
    await says('m1', 'policy P-2');
    svc.fake!.appendStatuses.push(429);
    const controller = new AbortController();
    const pending = svc.addRow(
      agentId,
      jid,
      { tab: 'Claims', values: { 'Policy no': 'P-2' } },
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('cancelled')), 20);
    await expect(pending).rejects.toThrow('cancelled');
    expect(claims()).toHaveLength(1);
  });

  it('refuses a tab without column names, and leaves trailing empty cells out', async () => {
    const svc = await setUp([{ title: 'Notes', access: 'add' }]);
    await says('m1', 'note: call me back');
    expect(
      await svc.addRow(agentId, jid, { tab: 'Notes', values: { Note: 'call me back' } }, undefined),
    ).toEqual({ ok: false, reason: 'no_columns', tab: 'Notes' });
    // The admin adds column names and presses Refresh.
    svc.fake!.rows(FAKE_SPREADSHEET_ID, 'Notes').push(['Note', 'Extra']);
    await svc.refresh(agentId);
    expect(
      await svc.addRow(agentId, jid, { tab: 'Notes', values: { Note: 'call me back' } }, undefined),
    ).toMatchObject({ ok: true, already: false });
    expect(svc.fake!.rows(FAKE_SPREADSHEET_ID, 'Notes')[1]).toEqual(['call me back']);
  });

  it('keeps adding leads to an older, still empty leads tab: the lead header comes first', async () => {
    const svc = await setUp([PRICES]);
    const leads = svc.fake!.rows(FAKE_SPREADSHEET_ID, 'Leads');
    leads.length = 0;
    // A save from before tab access, with Add leads on and no lead added yet.
    t.ctx.db.prepare('UPDATE sheets_agent_settings SET settings = ? WHERE agent_id = ?').run(
      JSON.stringify({
        spreadsheetId: FAKE_SPREADSHEET_ID,
        spreadsheetName: 'Demo price list',
        lookupTab: 'Prices',
        lookup: true,
        leadsTab: 'Leads',
        addLeads: true,
      }),
      agentId,
    );
    expect(upgradeSheetsSettings(t.ctx)).toBe(1);
    expect(svc.legacyLeadsTab(agentId)).toBe('Leads');
    await says('m1', 'I want catering for 20, email mei@example.com');
    const tools = await turn(jid);
    expect(tools.tools.add_sheet_row!.description).toContain(
      `"Leads" (columns: ${SHEETS_LEAD_COLUMNS.join(', ')})`,
    );
    expect(
      await call(tools.tools, 'add_sheet_row', {
        tab: 'Leads',
        values: { Email: 'mei@example.com', Request: 'catering for 20' },
      }),
    ).toBe('Added to "Leads".');
    expect(leads[0]).toEqual([...SHEETS_LEAD_COLUMNS]);
    expect(leads[1]).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
      'Mei Ying',
      '+60123456789',
      'mei@example.com',
      'catering for 20',
      'Aina',
    ]);
    // The header is written once.
    await call(tools.tools, 'add_sheet_row', { tab: 'Leads', values: { Request: 'catering' } });
    expect(leads).toHaveLength(3);
    expect(leads.filter((row) => row[0] === 'Date')).toHaveLength(1);
  });

  it('offers no add tool for an empty tab that was never a leads tab', async () => {
    const svc = await setUp([{ title: 'Notes', access: 'add' }]);
    expect(svc.legacyLeadsTab(agentId)).toBeNull();
    t.ctx.settings.set('google_sheets_legacy_leads', ['bad']);
    expect(svc.legacyLeadsTab(agentId)).toBeNull();
    t.ctx.settings.set('google_sheets_legacy_leads', { [agentId]: 'Leads' });
    expect(Object.keys((await turn(jid)).tools)).toEqual([]);
  });

  it('never adds a row from Try it', async () => {
    await setUp([CLAIMS]);
    const tryIt = await turn(null);
    const out = await call(tryIt.tools, 'add_sheet_row', {
      tab: 'Claims',
      values: { 'Policy no': 'X' },
    });
    expect(out).toContain('Test only');
    expect(tryIt.calls()[0]).toMatchObject({ tool: 'add_sheet_row', notRun: true });
    expect(claims()).toHaveLength(1);
  });

  it('explains every refusal without values', () => {
    expect(refusal({ ok: false, reason: 'not_allowed', tabs: [] })).toContain('not available now');
    expect(refusal({ ok: false, reason: 'no_columns', tab: 'X' })).toContain('no column names');
  });

  it('hands over when Google fails, and moves rows when chats merge', async () => {
    const svc = await setUp();
    await says('m1', 'price?');
    const tools = await turn(jid);
    svc.fake!.mode = 'unavailable';
    await expect(
      call(tools.tools, 'read_sheet_rows', { tab: 'Prices', query: 'price' }),
    ).rejects.toThrow();
    expect(tools.onFailure).toHaveBeenCalledOnce();
    expect(tools.failed()).toBe(true);
    expect(svc.status().state).toBe('unavailable');
    expect(svc.activity()[0]).toMatchObject({ kind: 'failed', tab: 'Prices' });
    expect(mergeSheetsRows(t.ctx.db, jid, 'other@lid')).toBe(1);
    expect(svc.activity()[0]!.chatJid).toBe('other@lid');
  });
});
