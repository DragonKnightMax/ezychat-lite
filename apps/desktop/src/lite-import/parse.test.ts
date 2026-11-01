import { describe, expect, it } from 'vitest';
import {
  LiteImportOutcome,
  LiteImportPlan,
  LiteImportProgress,
  LiteSummary,
} from '@ezychat/shared';
import {
  jsonLine,
  parseLiteImportOutcome,
  parseLiteImportPlan,
  parseLiteImportProgress,
  parseLiteSummary,
} from './parse.js';

const summary = {
  dataDir: '/lite/data',
  schemaVersion: 28,
  number: '+60123456789',
  ownJid: '60123456789@s.whatsapp.net',
  chats: 12,
  customers: 10,
  messages: 400,
  mediaBytes: 1024,
  totalBytes: 4096,
  users: [{ id: 1, username: 'owner', displayName: 'Owner', role: 'admin' }],
  aiAgents: [{ id: 1, name: 'Sales', enabled: true }],
  quickReplyShortcuts: ['hi'],
  tokens: [{ name: 'Claude', kind: 'oauth' }],
  remote: 'quick',
  address: null,
  port: 7420,
};

/** The hand-written check must accept exactly what zod accepts, and return the same value. */
function agrees<T>(
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  parse: (v: unknown) => T | null,
  value: unknown,
) {
  const z = schema.safeParse(value);
  const mine = parse(value);
  expect(mine !== null).toBe(z.success);
  if (z.success) expect(mine).toEqual(z.data);
}

describe('Lite import shape checks mirror the shared zod schemas', () => {
  it.each([
    {},
    { team: [] },
    { team: [{ liteUserId: 1, action: 'match', matchUserId: 3, role: 'admin' }] },
    { team: [{ liteUserId: 1, action: 'add', matchUserId: null, role: 'agent', extra: 1 }] },
    { team: [{ liteUserId: 1, action: 'merge', matchUserId: null, role: 'agent' }] },
    { team: [{ liteUserId: 1.5, action: 'add', matchUserId: null, role: 'agent' }] },
    { team: [{ liteUserId: 1, action: 'add', role: 'agent' }] },
    { team: [{ liteUserId: 1, action: 'add', matchUserId: null, role: 'owner' }] },
    { team: 'all' },
    { team: [null] },
    null,
    [],
    'plan',
  ])('plan %j', (value) => agrees(LiteImportPlan, parseLiteImportPlan, value));

  it.each([
    summary,
    { ...summary, number: null, ownJid: null, port: null, address: 'inbox.example.com' },
    { ...summary, extra: 'dropped' },
    { ...summary, remote: 'vpn' },
    { ...summary, chats: 1.5 },
    { ...summary, mediaBytes: '1' },
    { ...summary, users: [{ id: 1, username: 'a', displayName: 'A', role: 'boss' }] },
    { ...summary, aiAgents: [{ id: 1, name: 'x' }] },
    { ...summary, quickReplyShortcuts: [1] },
    { ...summary, tokens: [{ name: 'x', kind: 'key' }] },
    { ...summary, dataDir: undefined },
    { ...summary, address: undefined },
    null,
  ])('summary %#', (value) => agrees(LiteSummary, parseLiteSummary, value));

  it.each([
    { step: 'copy', state: 'running', done: 1, total: 10 },
    { step: 'verify', state: 'done' },
    { step: 'merge', state: 'failed', extra: true },
    { step: 'copy', state: 'running', done: '1' },
    { step: 'copy', state: 'running', total: null },
    { step: 'unpack', state: 'running' },
    { step: 'copy', state: 'paused' },
    null,
  ])('progress %j', (value) => agrees(LiteImportProgress, parseLiteImportProgress, value));

  const result = {
    mode: 'merge',
    inboxId: 2,
    inboxName: 'Lite – +60…',
    chats: 12,
    usersAdded: 1,
    usersMatched: 1,
    agentImported: true,
    agentOff: false,
    renamedShortcuts: ['hi-lite'],
  };
  it.each([
    { result },
    { result: { ...result, mode: 'copy', renamedShortcuts: [] } },
    { result: { ...result, mode: 'move' } },
    { result: { ...result, chats: undefined } },
    { error: { code: 'same_number' } },
    { error: { code: 'failed', message: 'x' } },
    { error: { code: 1 } },
    { error: { code: 'x', message: 2 } },
    { result: { ...result, mode: 'move' }, error: { code: 'x' } },
    {},
    null,
  ])('outcome %j', (value) => agrees(LiteImportOutcome, parseLiteImportOutcome, value));
});

describe('jsonLine', () => {
  it('parses JSON object lines only', () => {
    expect(jsonLine(' {"a":1} ')).toEqual({ a: 1 });
    expect(jsonLine('starting server')).toBeNull();
    expect(jsonLine('{broken')).toBeNull();
  });
});
