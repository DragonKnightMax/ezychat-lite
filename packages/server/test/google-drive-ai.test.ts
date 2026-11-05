import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRIVE_SETTINGS, type DriveAgentSettings } from '@ezychat/shared';
import type { ToolSet } from 'ai';
import { listAgents } from '../src/ai/agents.js';
import { CORE_AGENT_TOOL_NAMES } from '../src/ai/agent/extension-tools.js';
import { agentLookupsAvailable, agentTurnTools } from '../src/ai/agent/turn-tools.js';
import { FOLDER_MIME } from '../src/connectors/google-drive/drive.js';
import { FAKE_DRIVE_DOC_ID, FAKE_DRIVE_FOLDER_ID } from '../src/connectors/google-drive/fake.js';
import { mergeDriveRows } from '../src/connectors/google-drive/repo.js';
import { DRIVE_TOOL_NAMES, saveRefusal } from '../src/connectors/google-drive/tools.js';
import type { SheetRecordContext } from '../src/connectors/google-sheets/record.js';
import { getMessages } from '../src/wa-bridge/index.js';
import { makeTestApp, type TestApp } from './helpers.js';

const jid = '60123456789@s.whatsapp.net';
const groupJid = '120363000000000001@g.us';
const ali = '60111111111@s.whatsapp.net';
const siti = '60122222222@s.whatsapp.net';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png-pixels'),
]);
const TEXT_ID = 'demo-text-faq-000000000001';
const SHEET_ID = 'demo-sheet-stock-000000001';
const IMAGE_ID = 'demo-image-flyer-000000001';

let t: TestApp;
let adminId: number;
let agentId: number;
afterEach(async () => {
  vi.restoreAllMocks();
  await t?.close();
});

async function call(tools: ToolSet, name: string, input: object): Promise<string> {
  const execute = tools[name]?.execute as
    ((input: object, options: object) => Promise<string>) | undefined;
  if (!execute) throw new Error(`tool ${name} not offered`);
  return execute(input, { toolCallId: `call-${name}`, messages: [], abortSignal: undefined });
}

const fileOf = (id: string) => {
  const item = t.ctx.services.googleDrive!.fake!.items.get(id)!;
  return { id, name: item.name, mimeType: item.mimeType, kind: 'text' as const };
};

async function setUp(settings: Partial<DriveAgentSettings> | null = {}) {
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
  const svc = t.ctx.services.googleDrive!;
  if (settings) {
    const start = svc.startConnect('http://127.0.0.1:7420/api/connectors/google-drive/callback', {
      userId: adminId,
      ip: null,
    });
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const target = new URL(svc.fakeConsent(state, true)!);
    expect((await svc.callback(Object.fromEntries(target.searchParams))).status).toBe(200);
    // Like drive.file: the admin picked the folder and these files in Google's file picker.
    for (const id of [FAKE_DRIVE_FOLDER_ID, FAKE_DRIVE_DOC_ID, TEXT_ID, SHEET_ID, IMAGE_ID])
      svc.fake!.grant(id);
    await svc.putSettings(
      agentId,
      {
        ...DEFAULT_DRIVE_SETTINGS,
        folder: { id: FAKE_DRIVE_FOLDER_ID, name: 'x' },
        ...settings,
      },
      { userId: adminId, ip: null },
    );
  }
  return svc;
}

async function sends(
  id: string,
  options: {
    chatJid?: string;
    senderJid?: string;
    senderName?: string;
    bytes?: Buffer;
    mime?: string;
    type?: 'image' | 'document';
    timestamp?: number;
    fileName?: string;
  } = {},
) {
  const chatJid = options.chatJid ?? jid;
  await getMessages(t.ctx).ingest(
    {
      id,
      chatJid,
      body: null,
      type: options.type ?? 'image',
      fromMe: false,
      senderJid: options.senderJid ?? chatJid,
      senderName: options.senderName ?? 'Mei Ying',
      timestamp: options.timestamp ?? Date.now(),
      quotedId: null,
      media: {
        mime: options.mime ?? 'image/png',
        fileName: options.fileName ?? 'my receipt.png',
        download: async () => options.bytes ?? PNG,
      },
    },
    'live',
  );
  // The live download runs in the background: wait until the file is stored.
  await vi.waitFor(() => expect(getMessages(t.ctx).mediaPath(id)).not.toBeNull());
}

const turn = (chatJid: string | null, record?: SheetRecordContext, lookupsOnly = false) => {
  const onFailure = vi.fn();
  return agentTurnTools(
    t.ctx,
    t.ctx.log,
    { agent: 'sales', agentId, chatJid, signal: new AbortController().signal },
    { onFailure, record, lookupsOnly },
  ).then((tools) => ({ ...tools, onFailure }));
};

const uploaded = () =>
  [...t.ctx.services.googleDrive!.fake!.items.values()].filter(
    (i) => t.ctx.services.googleDrive!.fake!.created.has(i.id) && i.mimeType !== FOLDER_MIME,
  );
const activity = () => t.ctx.services.googleDrive!.activity().map((a) => [a.kind, a.reason]);

describe('Google Drive AI tools', () => {
  it('keeps every Drive tool name reserved for the core', () => {
    for (const name of DRIVE_TOOL_NAMES) expect(CORE_AGENT_TOOL_NAMES).toContain(name);
  });

  it('offers nothing until a folder is chosen and Save or Read has something to do', async () => {
    const svc = await setUp(null);
    expect(Object.keys((await turn(jid)).tools).filter((n) => n.includes('drive'))).toEqual([]);
    expect(svc.usable(agentId)).toBeNull();
    expect(svc.usable(null)).toBeNull();
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(false);
  });

  it('offers no save tool with Save off, and no read tools without readable files', async () => {
    await setUp({ save: false, read: true, files: [] });
    expect(t.ctx.services.googleDrive!.usable(agentId)).toBeNull();
    await t.ctx.services.googleDrive!.putSettings(
      agentId,
      {
        ...DEFAULT_DRIVE_SETTINGS,
        folder: { id: FAKE_DRIVE_FOLDER_ID, name: 'x' },
        save: true,
        read: true,
        files: [fileOf(IMAGE_ID)],
      },
      { userId: adminId, ip: null },
    );
    await sends('m-photo');
    const tools = Object.keys((await turn(jid)).tools);
    expect(tools).toContain('save_file_to_drive');
    // An image has no text: nothing to read.
    expect(tools).not.toContain('read_drive_file');
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(false);
  });

  it('saves a file the customer sent, named by EzyChat, once, with a chat line', async () => {
    await setUp({ save: true, read: false });
    await sends('m-photo');
    const { tools } = await turn(jid);
    const description = (tools.save_file_to_drive as { description: string }).description;
    expect(description).toContain('file1: photo from Mei Ying, sent 0 min ago');
    // Never the sender's own file name.
    expect(description).not.toContain('receipt');
    expect(await call(tools, 'save_file_to_drive', { file: 'file1' })).toBe(
      'Saved to Google Drive.',
    );
    const [file] = uploaded();
    expect(file!.parents).toEqual([FAKE_DRIVE_FOLDER_ID]);
    expect(file!.name).toMatch(/^\d{4}-\d{2}-\d{2} \d{4} Photo [0-9A-F]{4}\.png$/);
    expect(file!.mimeType).toBe('image/png');
    expect(file!.content.equals(PNG)).toBe(true);
    expect(Object.keys(file!.appProperties)).toEqual(['ezychatKey']);
    // Again: nothing more is uploaded, and the next turn marks it saved.
    expect(await call(tools, 'save_file_to_drive', { file: 'file1' })).toBe(
      'Already saved to Google Drive: nothing more to do.',
    );
    expect(uploaded()).toHaveLength(1);
    const next = (await turn(jid)).tools.save_file_to_drive as { description: string };
    expect(next.description).toContain('(already saved)');
    const events = t.ctx.db
      .prepare("SELECT payload FROM chat_events WHERE chat_jid = ? AND type = 'ai_tool_used'")
      .all(jid) as Array<{ payload: string }>;
    expect(events.map((e) => JSON.parse(e.payload).drive)).toEqual([{ action: 'saved' }]);
    expect(activity()).toEqual([['saved', null]]);
  });

  it('finds a file a crashed save already uploaded instead of uploading it twice', async () => {
    const svc = await setUp({ save: true, read: false });
    await sends('m-photo');
    expect(await svc.saveFile(agentId, jid, 'm-photo', null)).toEqual({
      ok: true,
      already: false,
    });
    // The record is lost (a crash before it was written): Drive's app key still finds the file.
    t.ctx.db.prepare('DELETE FROM drive_saved_files').run();
    expect(await svc.saveFile(agentId, jid, 'm-photo', null)).toEqual({
      ok: true,
      already: false,
    });
    expect(uploaded()).toHaveLength(1);
  });

  it('puts the file in the sub-folder the instructions name, made once and cleaned', async () => {
    const svc = await setUp({ save: true, read: false });
    await sends('m-1');
    await sends('m-2');
    const { tools } = await turn(jid);
    expect(
      await call(tools, 'save_file_to_drive', { file: 'file1', subfolder: ' Jay/Low\u202e ' }),
    ).toBe('Saved to Google Drive.');
    expect(await call(tools, 'save_file_to_drive', { file: 'file2', subfolder: 'Jay-Low' })).toBe(
      'Saved to Google Drive.',
    );
    const fake = svc.fake!;
    const folders = [...fake.items.values()].filter(
      (i) => fake.created.has(i.id) && i.mimeType === FOLDER_MIME,
    );
    expect(folders.map((f) => [f.name, f.parents])).toEqual([['Jay-Low', [FAKE_DRIVE_FOLDER_ID]]]);
    expect(uploaded().map((f) => f.parents[0])).toEqual([folders[0]!.id, folders[0]!.id]);
    // The sub-folder was deleted in Drive since: made again once.
    fake.items.delete(folders[0]!.id);
    await sends('m-3');
    expect(await svc.saveFile(agentId, jid, 'm-3', 'Jay-Low')).toMatchObject({ ok: true });
    const again = [...fake.items.values()].filter(
      (i) => fake.created.has(i.id) && i.mimeType === FOLDER_MIME,
    );
    expect(again).toHaveLength(1);
    expect(again[0]!.id).not.toBe(folders[0]!.id);
  });

  it('never saves a file WhatsApp Safety rated High, nor one over 25 MB', async () => {
    const svc = await setUp({ save: true, read: false });
    // A file name hiding its real type (right-to-left override): Safety rates it High.
    await sends('m-bad', { fileName: 'receipt \u202egpj.exe' });
    expect(t.ctx.services.safety!.levelOf('m-bad')).toBe('high');
    const { tools } = await turn(jid);
    expect(await call(tools, 'save_file_to_drive', { file: 'file1' })).toContain(
      'WhatsApp Safety flagged',
    );
    await sends('m-big', {
      type: 'document',
      mime: 'application/pdf',
      bytes: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(25 * 1024 * 1024)]),
    });
    expect(await svc.saveFile(agentId, jid, 'm-big', null)).toEqual({
      ok: false,
      reason: 'size',
    });
    expect(await svc.saveFile(agentId, jid, 'no-such-message', null)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(uploaded()).toHaveLength(0);
    expect(activity()).toEqual([
      ['skipped', 'size'],
      ['skipped', 'safety'],
    ]);
    expect(saveRefusal({ ok: false, reason: 'size' })).toContain('25 MB');
    expect(saveRefusal({ ok: false, reason: 'unavailable' })).toContain('send it again');
    expect(saveRefusal({ ok: false, reason: 'not_found' })).toContain('no longer');
    expect(saveRefusal({ ok: false, reason: 'not_allowed' })).toContain('not available');
  });

  it('offers only files of the last 24 hours, and in a group only those of the batch senders', async () => {
    await setUp({ save: true, read: false });
    await sends('m-old', { timestamp: Date.now() - 25 * 60 * 60_000 });
    expect((await turn(jid)).tools.save_file_to_drive).toBeUndefined();
    await sends('g-ali', { chatJid: groupJid, senderJid: ali, senderName: 'Ali' });
    await sends('g-siti', { chatJid: groupJid, senderJid: siti, senderName: 'Siti' });
    const record: SheetRecordContext = {
      personJids: [siti],
      messageIds: ['g-siti'],
      filesGiven: false,
      fileNames: [],
    };
    const { tools } = await turn(groupJid, record, true);
    const description = (tools.save_file_to_drive as { description: string }).description;
    expect(description).toContain('from Siti');
    expect(description).not.toContain('from Ali');
    expect(await call(tools, 'save_file_to_drive', { file: 'file1' })).toBe(
      'Saved to Google Drive.',
    );
    expect(t.ctx.services.googleDrive!.activity()[0]).toMatchObject({ kind: 'saved' });
  });

  it('never saves in Try it', async () => {
    await setUp({ save: true, read: false });
    const { tools, calls } = await turn(null);
    expect(await call(tools, 'save_file_to_drive', { file: 'file1' })).toContain('Test only');
    expect(calls()).toMatchObject([{ tool: 'save_file_to_drive', notRun: true, ok: true }]);
    expect(uploaded()).toHaveLength(0);
  });

  it('lists and reads the picked files as facts, once per turn in Activity', async () => {
    await setUp({
      read: true,
      files: [fileOf(FAKE_DRIVE_DOC_ID), fileOf(TEXT_ID), fileOf(SHEET_ID), fileOf(IMAGE_ID)],
    });
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(true);
    const { tools, used, calls } = await turn(jid);
    expect(tools.save_file_to_drive).toBeUndefined();
    const listed = JSON.parse(await call(tools, 'list_drive_files', { query: 'delivery' }));
    expect(listed.files.map((f: { id: string }) => f.id)).toEqual([TEXT_ID]);
    // No match: every readable file (the image is not one).
    const all = JSON.parse(await call(tools, 'list_drive_files', { query: 'zzz' }));
    expect(all.files).toHaveLength(3);
    const doc = JSON.parse(await call(tools, 'read_drive_file', { fileId: FAKE_DRIVE_DOC_ID }));
    expect(doc.text).toContain('Catering for 20 people RM 450');
    const sheet = JSON.parse(await call(tools, 'read_drive_file', { fileId: SHEET_ID }));
    expect(sheet.text).toContain('Durian cake');
    const text = JSON.parse(await call(tools, 'read_drive_file', { fileId: TEXT_ID }));
    expect(text.text).toContain('free above RM 50');
    expect(used()).toEqual([{ title: 'your Drive files', sourceLabel: 'Google Drive' }]);
    expect(calls().every((c) => c.ok)).toBe(true);
    expect(activity()).toEqual([['read', null]]);
  });

  it('cuts a long file and says so', async () => {
    const svc = await setUp({ read: true, files: [fileOf(TEXT_ID)] });
    svc.fake!.items.get(TEXT_ID)!.content = Buffer.from('a'.repeat(25_000));
    const { tools } = await turn(jid);
    const read = JSON.parse(await call(tools, 'read_drive_file', { fileId: TEXT_ID }));
    expect(read.text).toHaveLength(20_000);
    expect(read.note).toContain('first part');
    svc.fake!.items.get(TEXT_ID)!.content = Buffer.from('   ');
    expect(await svc.readFile(svc.usable(agentId)!, 'other-id-0000000000', undefined)).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
  });

  it('hands over when Google fails, and records it', async () => {
    const svc = await setUp({ read: true, files: [fileOf(TEXT_ID)] });
    svc.fake!.mode = 'unavailable';
    const { tools, onFailure, failed } = await turn(jid);
    await expect(call(tools, 'read_drive_file', { fileId: TEXT_ID })).rejects.toThrow();
    expect(onFailure).toHaveBeenCalled();
    expect(failed()).toBe(true);
    expect(activity()).toEqual([['failed', null]]);
  });

  it('moves its rows when two chats are merged', async () => {
    const svc = await setUp({ save: true, read: false });
    await sends('m-photo');
    await svc.saveFile(agentId, jid, 'm-photo', null);
    expect(mergeDriveRows(t.ctx.db, jid, '123456@lid')).toBe(2);
    expect(
      t.ctx.services.googleDrive!.saveCandidates('123456@lid', FAKE_DRIVE_FOLDER_ID, null),
    ).toEqual([]);
  });
});
