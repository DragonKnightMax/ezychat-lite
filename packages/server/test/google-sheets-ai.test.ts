import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SHEETS_SETTINGS,
  SHEETS_LEAD_COLUMNS,
  type SheetsAgentSettings,
} from '@ezychat/shared';
import type { ToolSet } from 'ai';
import { listAgents } from '../src/ai/agents.js';
import { agentLookupsAvailable, agentTurnTools } from '../src/ai/agent/turn-tools.js';
import { FAKE_SPREADSHEET_ID } from '../src/connectors/google-sheets/fake.js';
import { mergeSheetsRows } from '../src/connectors/google-sheets/repo.js';
import { getMessages } from '../src/wa-bridge/index.js';
import { makeTestApp, type TestApp } from './helpers.js';

const jid = '60123456789@s.whatsapp.net';
const groupJid = '120363000000000001@g.us';

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

async function setUp(settings: Partial<SheetsAgentSettings> = {}, connect = true) {
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
      {
        ...DEFAULT_SHEETS_SETTINGS,
        spreadsheetId: FAKE_SPREADSHEET_ID,
        lookupTab: 'Prices',
        ...settings,
      },
      { userId: adminId, ip: null },
    );
  }
  return svc;
}

async function customerSays(id: string, text: string, chatJid = jid, senderName = 'Mei Ying') {
  await getMessages(t.ctx).ingest(
    {
      id,
      chatJid,
      body: text,
      type: 'text',
      fromMe: false,
      senderJid: chatJid === jid ? jid : '60111111111@s.whatsapp.net',
      senderName,
      timestamp: Date.now(),
      quotedId: null,
      media: null,
    },
    'live',
  );
}

const turn = (chatJid: string | null, lookupsOnly = false) => {
  const onFailure = vi.fn();
  return agentTurnTools(
    t.ctx,
    t.ctx.log,
    { agent: 'sales', agentId, chatJid, signal: new AbortController().signal },
    { onFailure, lookupsOnly },
  ).then((tools) => ({ ...tools, onFailure }));
};

describe('Google Sheets AI tools', () => {
  it('offers nothing until a sheet is connected and chosen', async () => {
    await setUp({}, false);
    const tools = await turn(jid);
    expect(Object.keys(tools.tools)).not.toContain('read_sheet_rows');
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(false);
  });

  it('looks up matching rows and logs who looked (never the values)', async () => {
    await setUp();
    await customerSays('m1', 'How much is the durian cake?');
    const tools = await turn(jid);
    expect(Object.keys(tools.tools)).toEqual(['read_sheet_rows']);
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(true);
    const out = JSON.parse(await call(tools.tools, 'read_sheet_rows', { query: 'durian cake' }));
    expect(out.columns).toEqual(['Item', 'Price (RM)', 'In stock', 'Notes']);
    expect(out.rows).toContainEqual({
      Item: 'Durian cake (whole)',
      'Price (RM)': '88.00',
      'In stock': 'No',
      Notes: 'Back in stock on Friday',
    });
    // A second look-up in the same minute reads the cached tab.
    await call(tools.tools, 'read_sheet_rows', { query: 'teh' });
    expect(t.ctx.services.googleSheets!.fake!.calls.filter((c) => c === 'values')).toHaveLength(1);
    expect(tools.used()).toEqual([{ title: 'your sheet', sourceLabel: 'Google Sheets' }]);
    expect(tools.calls().map((c) => [c.tool, c.ok])).toEqual([
      ['read_sheet_rows', true],
      ['read_sheet_rows', true],
    ]);
    const activity = t.ctx.services.googleSheets!.activity();
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      kind: 'looked_up',
      agentName: 'Aina',
      customer: 'Mei Ying',
    });
  });

  it('adds one lead row (header first, RAW values) and never twice a day', async () => {
    await setUp({ addLeads: true, leadsTab: 'Leads' });
    await customerSays('m1', 'I want catering for 20 on Saturday, my email is mei@example.com');
    const tools = await turn(jid);
    expect(Object.keys(tools.tools).sort()).toEqual(['add_lead_row', 'read_sheet_rows']);
    // A price question alone added a lead in a Dev Build: the description names the trigger and the exclusion.
    expect(tools.tools.add_lead_row?.description).toMatch(/want to buy or book/);
    expect(tools.tools.add_lead_row?.description).toMatch(
      /question alone \(price.*\) is not a lead/,
    );
    const out = await call(tools.tools, 'add_lead_row', {
      request: 'Catering for 20 on Saturday',
      email: 'mei@example.com',
    });
    expect(out).toContain('Added as a lead');
    const rows = t.ctx.services.googleSheets!.fake!.rows(FAKE_SPREADSHEET_ID, 'Leads');
    expect(rows[0]).toEqual([...SHEETS_LEAD_COLUMNS]);
    expect(rows[1]).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
      'Mei Ying',
      '+60123456789',
      'mei@example.com',
      'Catering for 20 on Saturday',
      'Aina',
    ]);
    expect(await call(tools.tools, 'add_lead_row', { request: 'again' })).toContain(
      'Already added',
    );
    expect(rows).toHaveLength(2);
    const events = t.ctx.db
      .prepare("SELECT payload FROM chat_events WHERE chat_jid = ? AND type = 'ai_tool_used'")
      .all(jid) as Array<{ payload: string }>;
    expect(events.map((e) => JSON.parse(e.payload))).toContainEqual({
      title: 'Add a lead',
      sourceLabel: 'Google Sheets',
    });
  });

  it('refuses a name or email the customer never wrote, and adds no header twice', async () => {
    const svc = await setUp({ addLeads: true, leadsTab: 'Leads' });
    svc.fake!.rows(FAKE_SPREADSHEET_ID, 'Leads').push(['My own header']);
    await customerSays('m1', 'Price of nasi lemak?');
    const tools = await turn(jid);
    expect(
      await call(tools.tools, 'add_lead_row', { request: 'Nasi lemak', name: 'Invented Name' }),
    ).toContain('pass only what the customer wrote');
    expect(
      await call(tools.tools, 'add_lead_row', { request: 'Nasi lemak', email: 'x@example.com' }),
    ).toContain('pass only what the customer wrote');
    await call(tools.tools, 'add_lead_row', { request: '=HYPERLINK("http://x")' });
    const rows = svc.fake!.rows(FAKE_SPREADSHEET_ID, 'Leads');
    expect(rows).toHaveLength(2);
    expect(rows[1]![4]).toBe('=HYPERLINK("http://x")');
  });

  it('asks for a name when the chat has none', async () => {
    await setUp({ addLeads: true, leadsTab: 'Leads' });
    await customerSays('m1', 'hi', jid, '');
    t.ctx.db.prepare("UPDATE chats SET name = '+60 12-345 6789' WHERE jid = ?").run(jid);
    const tools = await turn(jid);
    expect(await call(tools.tools, 'add_lead_row', { request: 'Something' })).toContain(
      'ask the customer for their name',
    );
  });

  it('never adds a row from Try it or in a group answer', async () => {
    const svc = await setUp({ addLeads: true, leadsTab: 'Leads' });
    const tryIt = await turn(null);
    const out = await call(tryIt.tools, 'add_lead_row', { request: 'Test' });
    expect(out).toContain('Test only');
    expect(tryIt.calls()[0]).toMatchObject({ tool: 'add_lead_row', notRun: true });
    const group = await turn(groupJid, true);
    expect(Object.keys(group.tools)).toEqual(['read_sheet_rows']);
    await customerSays('g1', 'hello', groupJid, 'Ali');
    expect(await svc.addLead(agentId, groupJid, { request: 'x' })).toEqual({
      ok: false,
      reason: 'group',
    });
    expect(svc.fake!.rows(FAKE_SPREADSHEET_ID, 'Leads')).toEqual([]);
  });

  it('hands over when Google fails, and moves rows when chats merge', async () => {
    const svc = await setUp();
    await customerSays('m1', 'price?');
    svc.fake!.mode = 'unavailable';
    const tools = await turn(jid);
    await expect(call(tools.tools, 'read_sheet_rows', { query: 'price' })).rejects.toThrow();
    expect(tools.onFailure).toHaveBeenCalledOnce();
    expect(tools.failed()).toBe(true);
    expect(svc.status().state).toBe('unavailable');
    expect(svc.activity()[0]).toMatchObject({ kind: 'failed' });
    expect(mergeSheetsRows(t.ctx.db, jid, 'other@lid')).toBe(1);
    expect(svc.activity()[0]!.chatJid).toBe('other@lid');
  });
});
