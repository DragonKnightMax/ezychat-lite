// The composer's POST /chats/:jid/media streams the file to disk (design
// docs/features/mcp-file-upload/design.md): no size cap of the app's own, the chat's WhatsApp number's
// limits and the free disk decide, and nothing is left in the upload folder after a send or a refusal.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeWaAdapter, LINKED_PHONE_CAPABILITIES } from '@ezychat/wa';
import { createUploadStore } from '../src/uploads/store.js';
import { VOICE_NOTE_MAX_BYTES } from '../src/messages/voice-note.js';
import { getMessages } from '../src/wa-bridge/index.js';
import { pdfFixture } from './ai-fixtures.js';
import { authHeaders, createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

const JID = '60177770001@s.whatsapp.net';
const enc = encodeURIComponent;
const PDF = pdfFixture('Menu');
const DOCUMENT_LIMIT = 6 * 1024 * 1024;

let t: TestApp;
let cookie: string;
let uploadDir: string;
let free = 1e12;

function multipart(fields: Record<string, string>, data: Buffer, name: string) {
  const boundary = '----media' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

const upload = (fields: Record<string, string>, data: Buffer, name = 'menu.pdf') => {
  const mp = multipart(fields, data, name);
  return t.app.inject({
    method: 'POST',
    url: `/api/chats/${enc(JID)}/media`,
    headers: { ...authHeaders(cookie), 'content-type': mp.type },
    payload: mp.payload,
  });
};

beforeAll(async () => {
  const wa = new FakeWaAdapter({
    capabilities: {
      ...LINKED_PHONE_CAPABILITIES,
      mediaLimits: { video: 1000, image: DOCUMENT_LIMIT, document: DOCUMENT_LIMIT },
    },
  });
  t = await makeTestApp({
    wa,
    beforeBuild: (ctx) => {
      uploadDir = join(ctx.config.dataDir, 'uploads');
      ctx.services.uploads = createUploadStore(uploadDir, {
        log: pino({ level: 'silent' }),
        freeBytes: () => free,
      });
    },
  });
  ({ cookie } = await createUserAndLogin(t));
  await getMessages(t.ctx).ingest(
    {
      id: 'IN-1',
      chatJid: JID,
      senderJid: JID,
      senderName: 'Gus',
      fromMe: false,
      type: 'text',
      body: 'menu?',
      quotedId: null,
      timestamp: Date.now(),
      media: null,
    },
    'live',
  );
});
afterAll(() => t.close());

describe('POST /chats/:jid/media streams to disk', () => {
  it('moves the file into the message and leaves nothing in the upload folder', async () => {
    const r = await upload({ clientId: 'media-up-1' }, PDF);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      type: 'document',
      mediaName: 'menu.pdf',
      mediaSize: PDF.length,
    });
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it("refuses a file above the number's limit (Forward's code) and keeps nothing", async () => {
    const r = await upload(
      { clientId: 'media-up-2' },
      Buffer.alloc(DOCUMENT_LIMIT + 1, 7),
      'big.bin',
    );
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('too_large_for_whatsapp');
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it('refuses when the disk would get too full (507), and a refused send keeps nothing', async () => {
    free = 0;
    const full = await upload({ clientId: 'media-up-3' }, PDF);
    expect(full.statusCode).toBe(507);
    expect(full.json().error.code).toBe('upload_storage_full');
    free = 1e12;
    // the file arrived, then the send was refused (a voice note with a caption): removed
    const refused = await upload({ clientId: 'media-up-4', caption: 'x', voiceNote: '1' }, PDF);
    expect(refused.statusCode).toBe(400);
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it('reads only a small voice note into memory', async () => {
    const r = await upload(
      { clientId: 'media-up-5', voiceNote: '1' },
      Buffer.alloc(VOICE_NOTE_MAX_BYTES + 1, 1),
      'voice.ogg',
    );
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/voice note/);
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it('needs a file part and multipart form data', async () => {
    const noFile = await t.app.inject({
      method: 'POST',
      url: `/api/chats/${enc(JID)}/media`,
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(noFile.statusCode).toBe(400);
    expect(existsSync(uploadDir)).toBe(true);
  });
});
