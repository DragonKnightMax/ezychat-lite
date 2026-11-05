import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DRIVE_SETTINGS } from '@ezychat/shared';
import { DriveClient } from '../src/connectors/google-drive/drive.js';
import { FAKE_DRIVE_DOC_ID, FAKE_DRIVE_FOLDER_ID } from '../src/connectors/google-drive/fake.js';
import { createGoogleDriveService } from '../src/connectors/google-drive/service.js';
import {
  DRIVE_PATHS,
  connectorRequests,
  connectorTestApp,
  connectThroughFake,
  expectAdminOnly,
  expectCallbackHostOnly,
  expectPickerHostOnly,
} from './google-connector-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

async function setUp() {
  const app = await connectorTestApp();
  t = app.t;
  return app;
}

const get = (url: string, cookie: string) => connectorRequests(t).get(url, cookie);
const post = (url: string, cookie: string, payload: unknown = {}) =>
  connectorRequests(t).post(url, cookie, payload);
const put = (url: string, cookie: string, payload: unknown) =>
  connectorRequests(t).put(url, cookie, payload);
const local = { origin: 'http://localhost', host: 'localhost' };

const connect = (cookie: string, choice: 'allow' | 'cancel' = 'allow') =>
  connectThroughFake(t, DRIVE_PATHS, cookie, choice);

/** Starts a picker and returns its fake page URL and token. */
async function pick(admin: string, body: object) {
  const start = await post('/api/connectors/google-drive/picker', admin, body);
  expect(start.statusCode).toBe(200);
  const { requestId, pickerUrl } = start.json() as { requestId: string; pickerUrl: string };
  const url = new URL(pickerUrl);
  expect(url.pathname).toBe('/api/dev/fake-google-drive/picker');
  return { requestId, token: url.searchParams.get('token')!, url };
}
const progress = async (admin: string, requestId: string) =>
  (await get(`/api/connectors/google-drive/picker/${requestId}`, admin)).json();

describe('Google Drive routes', () => {
  it('are admin only, and the callback answers only on this computer', async () => {
    const { agent, agentId } = await setUp();
    await expectAdminOnly(t, agent, [
      ['GET', '/api/connectors/google-drive'],
      ['POST', '/api/connectors/google-drive/connect'],
      ['GET', '/api/connectors/google-drive/connect/0123456789abcdef01234567'],
      ['POST', '/api/connectors/google-drive/disconnect'],
      ['POST', '/api/connectors/google-drive/picker'],
      ['GET', '/api/connectors/google-drive/picker/0123456789abcdef01234567'],
      ['GET', `/api/connectors/google-drive/agents/${agentId}`],
      ['PUT', `/api/connectors/google-drive/agents/${agentId}`],
      ['GET', '/api/connectors/google-drive/activity'],
      ['GET', '/api/dev/fake-google-drive'],
      ['POST', '/api/dev/fake-google-drive'],
    ]);
    await expectCallbackHostOnly(t, '/api/connectors/google-drive/callback?state=x&code=y');
  });

  it('signs in through the fake Google, then disconnects', async () => {
    const { admin } = await setUp();
    expect((await get('/api/connectors/google-drive', admin)).json()).toMatchObject({
      state: 'disconnected',
      account: null,
    });
    const { requestId, callback } = await connect(admin);
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain('Google Drive connected');
    expect(
      (await get(`/api/connectors/google-drive/connect/${requestId}`, admin)).json(),
    ).toMatchObject({ status: 'done' });
    expect((await get('/api/connectors/google-drive', admin)).json()).toMatchObject({
      state: 'connected',
      account: 'demo.drive@example.com',
    });
    expect(
      (await get(`/api/connectors/google-drive/connect/${'b'.repeat(24)}`, admin)).statusCode,
    ).toBe(404);
    // The fake's switch: Google refuses the sign-in → expired, and back.
    expect(
      (await post('/api/dev/fake-google-drive', admin, { state: 'unavailable' })).statusCode,
    ).toBe(200);
    expect((await get('/api/dev/fake-google-drive', admin)).json().mode).toBe('unavailable');
    const off = await post('/api/connectors/google-drive/disconnect', admin);
    expect(off.json()).toMatchObject({ state: 'disconnected' });
  });

  it('records a cancelled sign-in', async () => {
    const { admin } = await setUp();
    const { requestId, callback } = await connect(admin, 'cancel');
    expect(callback.statusCode).toBe(400);
    expect(
      (await get(`/api/connectors/google-drive/connect/${requestId}`, admin)).json(),
    ).toMatchObject({ status: 'failed', error: 'denied' });
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/dev/fake-google-drive/consent?state=nope' }))
        .statusCode,
    ).toBe(400);
  });

  it('picks a folder, then files inside it, and saves them per agent', async () => {
    const { admin, agentId } = await setUp();
    expect(
      (await post('/api/connectors/google-drive/picker', admin, { kind: 'folder' })).statusCode,
    ).toBe(409);
    await connect(admin);
    // Files need a folder first.
    expect(
      (await post('/api/connectors/google-drive/picker', admin, { kind: 'files' })).statusCode,
    ).toBe(400);
    const folder = await pick(admin, { kind: 'folder' });
    expect(await progress(admin, folder.requestId)).toEqual({
      status: 'pending',
      folder: null,
      files: [],
    });
    const page = await t.app.inject({
      method: 'GET',
      url: folder.url.pathname + folder.url.search,
    });
    expect(page.body).toContain('EzyChat demo folder');
    const href = new RegExp(`class="item" href="([^"]+${FAKE_DRIVE_FOLDER_ID})"`)
      .exec(page.body)![1]!
      .replaceAll('&#38;', '&');
    expect((await t.app.inject({ method: 'GET', url: href })).statusCode).toBe(200);
    expect(await progress(admin, folder.requestId)).toMatchObject({
      status: 'done',
      folder: { id: FAKE_DRIVE_FOLDER_ID, name: 'EzyChat demo folder' },
    });
    // One-time.
    expect((await t.app.inject({ method: 'GET', url: href })).statusCode).toBe(400);

    const files = await pick(admin, { kind: 'files', folderId: FAKE_DRIVE_FOLDER_ID });
    const list = await t.app.inject({ method: 'GET', url: files.url.pathname + files.url.search });
    expect(list.body).toContain('Price list');
    expect(list.body).not.toContain('Shared documents');
    const all = /id="all" href="([^"]+)"/.exec(list.body)![1]!.replaceAll('&#38;', '&');
    expect((await t.app.inject({ method: 'GET', url: all })).statusCode).toBe(200);
    const picked = await progress(admin, files.requestId);
    expect(picked.status).toBe('done');
    expect(picked.files.map((f: { kind: string }) => f.kind).sort()).toEqual([
      'doc',
      'other',
      'sheet',
      'text',
    ]);

    const saved = await put(`/api/connectors/google-drive/agents/${agentId}`, admin, {
      folder: { id: FAKE_DRIVE_FOLDER_ID, name: 'stale name' },
      save: true,
      read: true,
      files: picked.files,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().folder.name).toBe('EzyChat demo folder');
    expect(saved.json().files).toHaveLength(4);
    expect((await get(`/api/connectors/google-drive/agents/${agentId}`, admin)).json()).toEqual(
      saved.json(),
    );
    const audit = t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'google_drive.agent_settings'")
      .all() as Array<{ meta: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.meta)).toMatchObject({
      agentId,
      fields: ['folder', 'save', 'files'],
      files: 4,
    });
    expect(audit[0]!.meta).not.toContain('Price list');
  });

  it('leaves out a file Google no longer opens, and refuses changes while signed out', async () => {
    const { admin, agentId } = await setUp();
    await connect(admin);
    const fake = t.ctx.services.googleDrive!.fake!;
    fake.grant(FAKE_DRIVE_FOLDER_ID);
    fake.grant(FAKE_DRIVE_DOC_ID);
    const doc = { id: FAKE_DRIVE_DOC_ID, name: 'x', mimeType: 'text/plain', kind: 'text' };
    const ghost = { id: 'gone-file-00000000000', name: 'y', mimeType: 'text/plain', kind: 'text' };
    const res = await put(`/api/connectors/google-drive/agents/${agentId}`, admin, {
      ...DEFAULT_DRIVE_SETTINGS,
      folder: { id: FAKE_DRIVE_FOLDER_ID, name: 'x' },
      files: [doc, ghost],
    });
    const savedSettings = res.json() as Record<string, unknown>;
    expect(savedSettings.files).toEqual([
      {
        id: FAKE_DRIVE_DOC_ID,
        name: 'Price list',
        mimeType: 'application/vnd.google-apps.document',
        kind: 'doc',
      },
    ]);
    // A folder that is not a folder, or one Google will not open.
    expect(
      (
        await put(`/api/connectors/google-drive/agents/${agentId}`, admin, {
          ...DEFAULT_DRIVE_SETTINGS,
          folder: { id: FAKE_DRIVE_DOC_ID, name: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await put(`/api/connectors/google-drive/agents/${agentId}`, admin, {
          ...DEFAULT_DRIVE_SETTINGS,
          folder: { id: 'not-granted-folder-0000', name: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    fake.mode = 'unavailable';
    expect(
      (
        await put(`/api/connectors/google-drive/agents/${agentId}`, admin, {
          ...DEFAULT_DRIVE_SETTINGS,
          folder: { id: FAKE_DRIVE_FOLDER_ID, name: 'x' },
        })
      ).statusCode,
    ).toBe(503);
    fake.mode = 'ok';
    await post('/api/connectors/google-drive/disconnect', admin);
    // Signed out: the switches may change, the folder and files may not.
    const switches = await put(`/api/connectors/google-drive/agents/${agentId}`, admin, {
      ...savedSettings,
      read: false,
    });
    expect(switches.statusCode).toBe(200);
    expect(switches.json()).toMatchObject({ read: false, files: [{ id: FAKE_DRIVE_DOC_ID }] });
    expect(
      (
        await put(`/api/connectors/google-drive/agents/${agentId}`, admin, {
          ...savedSettings,
          files: [],
        })
      ).statusCode,
    ).toBe(409);
    // Clearing the folder always works and clears the files.
    const cleared = await put(`/api/connectors/google-drive/agents/${agentId}`, admin, {
      ...savedSettings,
      folder: null,
    });
    expect(cleared.json()).toMatchObject({ folder: null, files: [] });
    expect((await get('/api/connectors/google-drive/agents/9999', admin)).statusCode).toBe(404);
    expect(
      (await put('/api/connectors/google-drive/agents/9999', admin, DEFAULT_DRIVE_SETTINGS))
        .statusCode,
    ).toBe(404);
    expect(
      (await put(`/api/connectors/google-drive/agents/${agentId}`, admin, { save: 'yes' }))
        .statusCode,
    ).toBe(400);
  });

  it('serves the picker page, script and token only on this computer, once', async () => {
    const { admin } = await setUp();
    await connect(admin);
    const { requestId, token, url } = await pick(admin, { kind: 'folder' });
    const script = await expectPickerHostOnly(
      t,
      '/api/connectors/google-drive',
      token,
      url.pathname + url.search,
    );
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/connectors/google-drive/picker-page?token=x',
        })
      ).statusCode,
    ).toBe(400);
    expect(script).toContain('setSelectFolderEnabled');
    const config = await get(`/api/connectors/google-drive/picker-config?token=${token}`, '');
    expect(config.json()).toMatchObject({ developerKey: 'fake-key', appId: '0', mode: 'folder' });
    expect(config.json().oauthToken).toMatch(/^fake-access-/);
    expect(
      (await get(`/api/connectors/google-drive/picker-config?token=${token}`, '')).statusCode,
    ).toBe(404);
    const cancel = await t.app.inject({
      method: 'POST',
      url: '/api/connectors/google-drive/picker-result',
      headers: local,
      payload: { token, cancelled: true },
    });
    expect(cancel.statusCode).toBe(200);
    expect(await progress(admin, requestId)).toMatchObject({ status: 'cancelled' });
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/connectors/google-drive/picker-result',
      headers: local,
      payload: { token, ids: [FAKE_DRIVE_FOLDER_ID] },
    });
    expect(again.statusCode).toBe(400);
    const lanResult = await t.app.inject({
      method: 'POST',
      url: '/api/connectors/google-drive/picker-result',
      headers: local,
      remoteAddress: '192.168.1.20',
      payload: { token, cancelled: true },
    });
    expect(lanResult.statusCode).toBe(404);
  });

  it('marks a pick Google will not open, or files outside the folder, as failed', async () => {
    const { admin } = await setUp();
    await connect(admin);
    const folder = await pick(admin, { kind: 'folder' });
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/connectors/google-drive/picker-result',
      headers: local,
      payload: { token: folder.token, ids: [FAKE_DRIVE_DOC_ID] },
    });
    expect(bad.statusCode).toBe(400);
    expect((await progress(admin, folder.requestId)).status).toBe('failed');
    const files = await pick(admin, { kind: 'files', folderId: 'demo-folder-000000000002' });
    const outside = await t.app.inject({
      method: 'POST',
      url: '/api/connectors/google-drive/picker-result',
      headers: local,
      payload: { token: files.token, ids: [FAKE_DRIVE_DOC_ID] },
    });
    expect(outside.statusCode).toBe(400);
    expect((await progress(admin, files.requestId)).status).toBe('failed');
  });

  it('lists the activity newest first without file names', async () => {
    const { admin, agentId } = await setUp();
    const drive = t.ctx.services.googleDrive!;
    drive.addActivity({ kind: 'saved', agentId, chatJid: null });
    drive.addActivity({ kind: 'skipped', agentId, chatJid: null, reason: 'size' });
    const res = await get('/api/connectors/google-drive/activity', admin);
    expect(res.json().activity).toMatchObject([
      { kind: 'skipped', reason: 'size', agentName: 'Aina' },
      { kind: 'saved', reason: null },
    ]);
  });
});

describe('Google Drive without the fake Google', () => {
  it('is not available without the file picker key', async () => {
    t = await makeTestApp();
    const client = new DriveClient({ clientId: 'id', clientSecret: 'secret' });
    const without = createGoogleDriveService(t.ctx, { fake: null, client });
    expect(without.status().state).toBe('not_configured');
    expect(without.usable(1)).toBeNull();
    without.shutdown();
    t.ctx.config.googlePicker = { apiKey: 'key', appId: '123' };
    const withKey = createGoogleDriveService(t.ctx, { fake: null, client });
    expect(withKey.status().state).toBe('disconnected');
    expect(() =>
      withKey.startPicker('http://127.0.0.1:7420', { kind: 'folder' }, { userId: 1 }),
    ).toThrow('Connect a Google account first');
    withKey.shutdown();
  });
});
