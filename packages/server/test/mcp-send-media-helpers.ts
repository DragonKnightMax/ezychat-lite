// Shared by the send_image and send_file tests: the stored row of a send, the tool list of a token, the
// resolved principal of a token and a local https server for the guarded download.
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { AddressInfo } from 'node:net';
import { generateSelfSignedCert } from '../../../e2e/partner-mcp/cert.mjs';
import { getApiTokens, type ApiPrincipal } from '../src/api-tokens/index.js';
import { sendClientId, type MediaSource } from '../src/mcp/send.js';
import { createUploadStore, type UploadStore } from '../src/uploads/store.js';
import type { TestApp } from './helpers.js';
import { rpc } from './mcp-helpers.js';

/** The message a token sent with this requestId, as stored. */
export function sentRow(t: TestApp, tokenId: number, requestId: string) {
  return t.ctx.db
    .prepare(
      `SELECT chat_jid, type, body, media_mime, media_name, sent_by_user_id, sent_via_token_id
       FROM messages WHERE client_id = ?`,
    )
    .get(sendClientId(tokenId, requestId)) as Record<string, unknown> | undefined;
}

type Post = (body: unknown, token: string) => Promise<{ json(): any }>;

/** The tools a token sees, with their annotations. */
export async function listedTools(post: Post, token: string) {
  return (await post(rpc('tools/list'), token)).json().result.tools as Array<{
    name: string;
    annotations: Record<string, boolean>;
  }>;
}

/** The principal of a token, for calling the send port directly. */
export function principalOf(t: TestApp, token: string): ApiPrincipal {
  const resolved = getApiTokens(t.ctx).resolve(token);
  if (!resolved.ok) throw new Error('token');
  return resolved.principal;
}

/**
 * A local https server: `files` answer 200 with their bytes, `/big` answers `bigBytes` bytes, anything else
 * 404. `ca` lets the guarded download trust it (loopback is allowed only with `allowLoopback` in tests).
 */
export async function httpsFixture(files: Record<string, Buffer>, bigBytes: number) {
  const tls = generateSelfSignedCert();
  const server = createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    const body = req.url ? files[req.url] : undefined;
    if (body) return void res.writeHead(200).end(body);
    if (req.url === '/big') return void res.writeHead(200).end(Buffer.alloc(bigBytes));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ca: tls.cert,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The newest `mcp.send` audit row: its raw meta (to check what it never holds) and the parsed meta. */
export function lastSendAudit(t: TestApp): { raw: string; meta: Record<string, unknown> } {
  const { meta } = t.ctx.db
    .prepare("SELECT meta FROM audit_log WHERE action = 'mcp.send' ORDER BY id DESC LIMIT 1")
    .get() as { meta: string };
  return { raw: meta, meta: JSON.parse(meta) };
}

/** An upload store in a new temporary folder (link downloads land there). */
export function testUploadStore(
  deps: { now?: () => number; freeBytes?: (dir: string) => number } = {},
): { store: UploadStore; dir: string } {
  const dir = join(mkdtempSync(join(tmpdir(), 'mcp-uploads-')), 'uploads');
  return {
    store: createUploadStore(dir, {
      log: pino({ level: 'silent' }),
      freeBytes: () => 1e12,
      ...deps,
    }),
    dir,
  };
}

/** The bytes of a downloaded file (a path on disk) or of a buffer. */
export function bytesOf(source: MediaSource): Buffer {
  return Buffer.isBuffer(source) ? source : readFileSync(source.path);
}
