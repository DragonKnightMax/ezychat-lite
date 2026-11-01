import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiteImportNotice } from '@ezychat/shared';
import { getApiTokens } from '../src/api-tokens/index.js';
import { LITE_IMPORT_NOTICE_KEY, readNotice, writeNotice } from '../src/lite-import/notice.js';
import { MCP_ENABLED_SETTING } from '../src/mcp/settings.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { mcpClient, rpc } from './mcp-helpers.js';

const notice: LiteImportNotice = {
  checklist: {
    inboxId: 3,
    inboxName: 'Lite – +60123',
    liteUsers: 2,
    tokens: [{ name: 'Claude', kind: 'oauth' }],
    items: { share: false, signin: false, notifications: false, mcp: false },
  },
  mcp: { reason: 'merge', mcpUrl: 'https://inbox.example.com/mcp' },
};

describe('/api/lite-import/notice', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('answers nulls when no import happened', async () => {
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/lite-import/notice',
      headers: authHeaders(admin.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ checklist: null, mcp: null });
  });

  it('is for admins only', async () => {
    writeNotice(t.ctx.settings, notice);
    const agent = await createUserAndLogin(t, { role: 'agent' });
    const get = await t.app.inject({
      method: 'GET',
      url: '/api/lite-import/notice',
      headers: authHeaders(agent.cookie),
    });
    expect(get.statusCode).toBe(403);
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/lite-import/notice',
      headers: authHeaders(agent.cookie),
      payload: { dismiss: 'mcp' },
    });
    expect(put.statusCode).toBe(403);
    const anon = await t.app.inject({ method: 'GET', url: '/api/lite-import/notice' });
    expect(anon.statusCode).toBe(401);
    expect(readNotice(t.ctx.settings)).toEqual(notice);
  });

  it('ticks items and dismisses each part; an empty notice removes the setting', async () => {
    writeNotice(t.ctx.settings, notice);
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const put = (payload: Record<string, unknown>) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/lite-import/notice',
        headers: authHeaders(admin.cookie),
        payload,
      });

    const ticked = await put({ item: 'share', done: true });
    expect(ticked.statusCode).toBe(200);
    expect(ticked.json().checklist.items).toEqual({
      share: true,
      signin: false,
      notifications: false,
      mcp: false,
    });
    const unticked = await put({ item: 'share', done: false });
    expect(unticked.json().checklist.items.share).toBe(false);
    expect((await put({ item: 'signin' })).json().checklist.items.signin).toBe(true);

    const get = await t.app.inject({
      method: 'GET',
      url: '/api/lite-import/notice',
      headers: authHeaders(admin.cookie),
    });
    expect(get.json().checklist.items.signin).toBe(true);

    expect((await put({ dismiss: 'checklist' })).json()).toEqual({
      checklist: null,
      mcp: notice.mcp,
    });
    expect((await put({ dismiss: 'mcp' })).json()).toEqual({ checklist: null, mcp: null });
    expect(t.ctx.settings.get(LITE_IMPORT_NOTICE_KEY, 'missing')).toBe('missing');
  });

  it('refuses a bad body', async () => {
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/lite-import/notice',
      headers: authHeaders(admin.cookie),
      payload: { item: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a ticked item without a checklist changes nothing; a damaged setting reads as empty', async () => {
    writeNotice(t.ctx.settings, { checklist: null, mcp: notice.mcp });
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/lite-import/notice',
      headers: authHeaders(admin.cookie),
      payload: { item: 'share', done: true },
    });
    expect(res.json()).toEqual({ checklist: null, mcp: notice.mcp });
    t.ctx.settings.set(LITE_IMPORT_NOTICE_KEY, { checklist: 'x' });
    expect(readNotice(t.ctx.settings)).toEqual({ checklist: null, mcp: null });
  });

  it('the first AI assistant call through the new address clears the MCP flag only', async () => {
    t.ctx.settings.set(MCP_ENABLED_SETTING, true);
    const admin = await createUserAndLogin(t, { role: 'admin' });
    const { secret } = getApiTokens(t.ctx).create(
      admin.user.id,
      { name: 'Claude', expiresInDays: null },
      '127.0.0.1',
    );
    const mcp = mcpClient(() => t);

    // a failed sign-in keeps the flag
    writeNotice(t.ctx.settings, notice);
    const bad = await mcp.post(rpc('tools/list'), 'ezc_pat_wrong');
    expect(bad.statusCode).toBe(401);
    expect(readNotice(t.ctx.settings).mcp).not.toBeNull();

    const ok = await mcp.post(rpc('tools/list'), secret);
    expect(ok.statusCode).toBe(200);
    expect(readNotice(t.ctx.settings)).toEqual({ checklist: notice.checklist, mcp: null });

    // nothing to clear afterwards: the call still works
    expect((await mcp.post(rpc('tools/list'), secret)).statusCode).toBe(200);
  });
});
