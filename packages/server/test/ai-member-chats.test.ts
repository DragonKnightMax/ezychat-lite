// The AI hand-off with limited chat access: an idle agent limited to chosen chats is picked only for
// a chat they chose; for any other chat the AI picks a teammate who may open it (or nobody).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AiMemberBody } from '@ezychat/shared';
import { createAiService, AI_FALLBACK_MS } from '../src/ai/service.js';
import type { AiProvider } from '../src/ai/provider-types.js';
import { createMessageService } from '../src/messages/service.js';
import { getChats, getMessages } from '../src/wa-bridge/index.js';
import { getInboxService } from '../src/inboxes/service.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let provider: AiProvider;
let adminId: number;
const A = '60123456789@s.whatsapp.net';
const B = '60123456780@s.whatsapp.net';
const body: AiMemberBody = {
  displayName: 'Sales Agent',
  enabled: true,
  instructions: 'Be concise',
};

beforeEach(async () => {
  t = await makeTestApp();
  const auth = t.ctx.services.auth!;
  adminId = auth.createUser({
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  }).id;
  const actor = { userId: adminId, ip: null };
  await t.ctx.services.ai!.shutdown();
  t.ctx.services.messages!.shutdown();
  t.ctx.services.messages = createMessageService(t.ctx, {
    now: () => Date.now(),
    queue: { spacingMs: 0 },
  });
  provider = {
    generate: vi.fn().mockResolvedValue({ reply: 'A teammate will help.', action: 'handoff' }),
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: vi.fn(),
    logout: vi.fn(),
    shutdown: vi.fn(),
  };
  t.ctx.services.ai = createAiService(t.ctx, { provider, isOnline: () => true });
  t.ctx.services.ai.saveConnection({ mode: 'api', model: '', apiKey: 'test-api-key-123' }, actor);
  t.ctx.services.ai.saveMember({ ...body, enabled: false }, actor);
  t.ctx.services.ai.addText(null, { name: 'Business context', text: 'Open 9 to 5.' }, actor);
  t.ctx.services.ai.saveMember(body, actor);
});
afterEach(async () => {
  await t.close();
  vi.useRealTimers();
});

function agent(username: string) {
  return t.ctx.services.auth!.createUser({
    username,
    displayName: username,
    role: 'agent',
    password: 'password123',
    mustChangePassword: false,
  });
}

async function incoming(jid: string, id: string) {
  return getMessages(t.ctx).ingest(
    {
      id,
      chatJid: jid,
      body: 'Can a person call me?',
      type: 'text',
      fromMe: false,
      senderJid: jid,
      senderName: 'Customer',
      timestamp: Date.now(),
      quotedId: null,
      media: null,
    },
    'live',
  );
}

it('hands an unchosen chat to a teammate, never to the free limited agent (lower id)', async () => {
  const limitedAgent = agent('limited'); // lower id: picked first without the chat check
  const other = agent('other');
  getChats(t.ctx).upsertFromWa({ jid: A, type: 'dm', name: 'Ann' });
  getInboxService(t.ctx).setMemberChats(
    limitedAgent.id,
    { scope: 'chosen', chats: [A] },
    { userId: adminId, ip: null },
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  await incoming(B, 'in-b');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  expect(provider.generate).toHaveBeenCalledTimes(1);
  expect(getChats(t.ctx).get(B)!.assignedTo).toBe(other.id);
});

it('hands a chosen chat to the free limited agent', async () => {
  const limitedAgent = agent('limited');
  getChats(t.ctx).upsertFromWa({ jid: A, type: 'dm', name: 'Ann' });
  getInboxService(t.ctx).setMemberChats(
    limitedAgent.id,
    { scope: 'chosen', chats: [A] },
    { userId: adminId, ip: null },
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  await incoming(A, 'in-a');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  expect(getChats(t.ctx).get(A)!.assignedTo).toBe(limitedAgent.id);
});

it('leaves an unchosen chat unassigned when only the limited agent is free', async () => {
  const limitedAgent = agent('limited');
  getChats(t.ctx).upsertFromWa({ jid: A, type: 'dm', name: 'Ann' });
  getInboxService(t.ctx).setMemberChats(
    limitedAgent.id,
    { scope: 'chosen', chats: [A] },
    { userId: adminId, ip: null },
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  await incoming(B, 'in-b');
  await vi.advanceTimersByTimeAsync(AI_FALLBACK_MS);
  expect(getChats(t.ctx).get(B)!.assignedTo).toBeNull();
});
