import Fastify, { type FastifyBaseLogger } from 'fastify';
import { expect, it, vi } from 'vitest';
import { redactLogLine, redactSecretText, scrubLogValue } from '../src/log-redaction.js';
import { createLogger } from '../src/logger.js';

it('redacts JSON-embedded token fields, plain and escaped', () => {
  const plain = redactSecretText(
    '{"refresh_token":"rt-secret","access_token": "at-secret","id_token":"it-secret","code_verifier":"cv-secret","ok":"keep"}',
  );
  expect(plain).not.toMatch(/-secret/);
  expect(plain).toContain('"ok":"keep"');
  const escaped = redactSecretText(String.raw`body {\"refresh_token\":\"rt-secret\",\"x\":1}`);
  expect(escaped).not.toContain('rt-secret');
  expect(escaped).toContain(String.raw`\"x\":1`);
});

it('redacts Bearer tokens but leaves prose alone', () => {
  expect(redactSecretText('Authorization: Bearer abcDEF123456789xyz_-.~+/=')).toBe(
    'Authorization: Bearer [REDACTED]',
  );
  expect(redactSecretText('Bearer secret-bearer')).toBe('Bearer [REDACTED]');
  expect(redactSecretText('the bearer of bad news arrived')).toBe('the bearer of bad news arrived');
  expect(redactSecretText('Bearer token required')).toBe('Bearer token required');
});

it('redacts a JWT whose signature ends in a dash', () => {
  const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzZWNyZXQtc3ViIn0.c2lnbmF0dXJl-';
  const out = redactSecretText(`token ${jwt} end`);
  expect(out).toBe('token [REDACTED_JWT] end');
});

it('redacts code= and state= only as URL query parameters', () => {
  expect(redactSecretText('the state=connected flag')).toBe('the state=connected flag');
  expect(redactSecretText('GET /cb?code=abc&state=xyz&x=1')).toBe(
    'GET /cb?code=[REDACTED]&state=[REDACTED]&x=1',
  );
  expect(redactSecretText('refresh_token=abc')).toBe('refresh_token=[REDACTED]');
});

it('scrubLogValue truncates deep values, keeps the error type and cause, scrubs URLs', () => {
  let deep: Record<string, unknown> = { leaf: 'code=raw' };
  for (let i = 0; i < 10; i++) deep = { next: deep };
  expect(JSON.stringify(scrubLogValue(deep))).toContain('[Truncated]');
  expect(JSON.stringify(scrubLogValue(deep))).not.toContain('code=raw');

  class OAuthError extends Error {}
  const err = new OAuthError('outer', {
    cause: new Error('inner http://localhost:1455/auth/callback?code=cause-secret'),
  });
  const out = scrubLogValue(err) as { errType: string; cause: { message: string } };
  expect(out.errType).toBe('OAuthError');
  expect(out.cause.message).toContain('/auth/callback?[REDACTED]');
  expect(JSON.stringify(out)).not.toContain('cause-secret');

  expect(scrubLogValue(new URL('http://localhost:1455/auth/callback?code=url-secret'))).toBe(
    'http://localhost:1455/auth/callback?[REDACTED]',
  );
});

it('redacts a leading code= in bare bodies and URLSearchParams', () => {
  expect(redactSecretText('code=abc&state=xyz')).toBe('code=[REDACTED]&state=[REDACTED]');
  expect(redactSecretText('http://x/cb#code=abc')).toBe('http://x/cb#code=[REDACTED]');
  expect(scrubLogValue(new URLSearchParams('code=abc&state=xyz&keep=1&refresh_token=rt'))).toBe(
    'code=[REDACTED]&state=[REDACTED]&keep=1&refresh_token=[REDACTED]',
  );
});

it('redacts inbox search and tag terms in logged URLs, live and in support exports', () => {
  expect(redactSecretText('GET /api/chats?status=open&q=Farah%20Aziz&tag=VIP&limit=50')).toBe(
    'GET /api/chats?status=open&q=[REDACTED]&tag=[REDACTED]&limit=50',
  );
  expect(redactSecretText('/api/customer-tags?q=hal')).toBe('/api/customer-tags?q=[REDACTED]');
  expect(redactSecretText('a q=b in prose stays')).toBe('a q=b in prose stays');
  const exported = redactLogLine(
    JSON.stringify({
      msg: 'incoming request',
      req: { url: '/api/chats?q=orders%40farah.my&tag=Halal' },
    }),
  );
  expect(exported).not.toMatch(/farah|Halal/);
  expect(exported).toContain('/api/chats?q=[REDACTED]&tag=[REDACTED]');
});

it('the live request log never contains search or tag terms', async () => {
  const lines: string[] = [];
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  const handle = await createLogger({ stdout: true, level: 'info' });
  const app = Fastify({ loggerInstance: handle.log as FastifyBaseLogger });
  app.get('/api/chats', async () => ({ ok: true }));
  try {
    const r = await app.inject({ method: 'GET', url: '/api/chats?status=open&q=Farah&tag=VIP' });
    expect(r.statusCode).toBe(200);
  } finally {
    await app.close();
    handle.close();
    write.mockRestore();
  }
  const out = lines.join('');
  expect(out).toContain('incoming request');
  expect(out).toContain('/api/chats?status=open&q=[REDACTED]&tag=[REDACTED]');
  expect(out).not.toMatch(/Farah|VIP/);
});

it('redacts Claude access tokens anywhere in text but keeps the display prefix', () => {
  const secret = `ezc_pat_${'Ab3_-'.repeat(8)}xyz`;
  expect(redactSecretText(`pasted ${secret} by mistake`)).toBe(
    'pasted ezc_pat_[REDACTED] by mistake',
  );
  expect(redactLogLine(JSON.stringify({ msg: `token=${secret}` }))).not.toContain(secret);
  expect(redactSecretText('token ezc_pat_Ab3_ was revoked')).toBe('token ezc_pat_Ab3_ was revoked');
});

it('redacts GitHub tokens and device codes', () => {
  const pat = 'github_pat_11ABCDEFG0123456789_abcdefXYZ';
  for (const secret of [pat, 'ghp_abcdEFGH1234ijkl', 'ghu_abcdEFGH1234', 'ghr_1234abcdEFGH'])
    expect(redactSecretText(`pasted ${secret} here`)).toBe('pasted [REDACTED_GITHUB_TOKEN] here');
  expect(redactLogLine(JSON.stringify({ msg: `"device_code":"abc123"`, deviceCode: 'x' }))).toBe(
    JSON.stringify({ msg: `"device_code":"[REDACTED]"`, deviceCode: '[REDACTED]' }) + '\n',
  );
  // Words that only look alike stay.
  expect(redactSecretText('the github_pat_ prefix')).toBe('the github_pat_ prefix');
});
