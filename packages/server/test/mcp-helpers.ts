// Helpers for tests that call the real /mcp route with a bearer token (MCP JSON-RPC over HTTP).
import { expect } from 'vitest';
import type { User } from '@ezychat/shared';
import { setMcpEnabled } from '../src/mcp/settings.js';
import type { TestApp } from './helpers.js';

const ACCEPT = 'application/json, text/event-stream';

export type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

export const rpc = (method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params,
});

/** The JSON a tool returned in its first text content. */
export const data = (r: ToolResult) => JSON.parse(r.content[0]!.text);

/** `app` is read on every call, so a suite can create its app in beforeAll. */
export function mcpClient(app: () => TestApp) {
  const post = (body: unknown, token: string) =>
    app().app.inject({
      method: 'POST',
      url: '/mcp',
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        accept: ACCEPT,
        authorization: `Bearer ${token}`,
      },
      payload: JSON.stringify(body),
    });
  const call = async (
    name: string,
    args: Record<string, unknown>,
    token: string,
  ): Promise<ToolResult> => {
    const res = await post(rpc('tools/call', { name, arguments: args }), token);
    expect(res.statusCode).toBe(200);
    return res.json().result as ToolResult;
  };
  const count = (sql: string, ...params: unknown[]) =>
    (
      app()
        .ctx.db.prepare(sql)
        .get(...params) as { n: number }
    ).n;
  return { post, call, count };
}

export async function waitFor(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 3000) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * An admin owner with a session cookie, a read-only token and a token that can send; MCP turned on.
 * Shared by the send tool suites.
 */
export function sendTokens(t: TestApp): {
  admin: User;
  adminCookie: string;
  readOnly: string;
  sender: string;
  senderId: number;
} {
  const auth = t.ctx.services.auth!;
  const admin = auth.createUser({
    username: 'owner',
    displayName: 'Owner',
    role: 'admin',
    password: 'password123',
    mustChangePassword: false,
  });
  const adminCookie = `sid=${auth.createSession(admin.id, { ip: '127.0.0.1', userAgent: 't' })}`;
  const tokens = t.ctx.services.apiTokens!;
  const readOnly = tokens.create(admin.id, { name: 'reader', expiresInDays: 90 }, 'ip').secret;
  const created = tokens.create(
    admin.id,
    { name: 'sender', expiresInDays: 90, canSend: true },
    'ip',
  );
  setMcpEnabled(t.ctx, true);
  return { admin, adminCookie, readOnly, sender: created.secret, senderId: created.token.id };
}
