import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMediaKeys, type WAMessage } from 'baileys';
import { downloadBoundedMessage } from './bounded-download.js';
import { BaileysAdapter } from './adapter.js';
import { mapWAMessage } from './mapping.js';
import { FakeWaAdapter } from '../fake/fake-adapter.js';
import type { WaIncomingMessage } from '../types.js';
afterEach(() => vi.unstubAllGlobals());
async function fixture(
  text: Buffer | string,
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker' = 'image',
) {
  const plain = Buffer.isBuffer(text) ? text : Buffer.from(text),
    mediaKey = randomBytes(32);
  const { iv, cipherKey, macKey } = await getMediaKeys(mediaKey, type);
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const wire = Buffer.concat([
    encrypted,
    createHmac('sha256', macKey!).update(iv).update(encrypted).digest().subarray(0, 10),
  ]);
  const raw = {
    key: { id: 'media-1', remoteJid: '60123456789@s.whatsapp.net' },
    message: {
      [type + 'Message']: {
        url: 'https://mmg.whatsapp.net/fixture',
        mimetype: 'application/octet-stream',
        mediaKey,
        fileSha256: createHash('sha256').update(plain).digest(),
        fileEncSha256: createHash('sha256').update(wire).digest(),
      },
    },
  } as WAMessage;
  return { plain, wire, raw };
}
function respond(bytes: Uint8Array) {
  return new Response(bytes);
}
function transport(wire: Uint8Array) {
  const f = vi.fn(async () => respond(wire));
  vi.stubGlobal('fetch', f);
  return f;
}
describe('bounded Baileys public hook', () => {
  it('closes an actual HTTP response while an oversized encrypted body is still streaming', async () => {
    const f = await fixture(Buffer.alloc(10000));
    let closedResolve!: () => void;
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });
    const server = createServer((_req, res) => {
      let offset = 0;
      const timer = setInterval(() => {
        res.write(f.wire.subarray(offset, offset + 64));
        offset = (offset + 64) % f.wire.length;
      }, 1);
      res.on('close', () => {
        clearInterval(timer);
        closedResolve();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (_url: URL, options: RequestInit) =>
      nativeFetch('http://127.0.0.1:' + (server.address() as AddressInfo).port, options),
    );
    try {
      await expect(downloadBoundedMessage(f.raw, { maxBytes: 5 })).rejects.toMatchObject({
        code: 'media_too_large',
      });
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('HTTP stream was not cancelled')), 1000);
          timer.unref();
        }),
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['image', 'video', 'audio', 'document', 'sticker'] as const)(
    'decrypts real %s wire fixtures and verifies hashes',
    async (type) => {
      const f = await fixture('decrypted fixture', type);
      const request = transport(f.wire);
      await expect(downloadBoundedMessage(f.raw, { maxBytes: f.plain.length })).resolves.toEqual(
        f.plain,
      );
      expect(request).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
      );
    },
  );
  it('counts actual bytes, cancels the body on overflow, and ignores a forged declared length', async () => {
    const f = await fixture(Buffer.alloc(100000));
    const cancel = vi.fn();
    let sent = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                if (!sent) {
                  sent = true;
                  c.enqueue(f.wire);
                }
              },
              cancel,
            }),
            { headers: { 'content-length': '1' } },
          ),
      ),
    );
    await expect(downloadBoundedMessage(f.raw, { maxBytes: 10 })).rejects.toMatchObject({
      code: 'media_too_large',
    });
    expect(cancel).toHaveBeenCalled();
  });
  it('rejects a decrypted overflow even if encoded bytes fit padding slack', async () => {
    const f = await fixture(Buffer.alloc(6));
    transport(f.wire);
    await expect(downloadBoundedMessage(f.raw, { maxBytes: 5 })).rejects.toMatchObject({
      code: 'media_too_large',
    });
  });
  it('cancels setup and a stalled body, rejecting no partial bytes', async () => {
    const f = await fixture('secret');
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, opts) =>
          new Promise((_resolve, reject) => {
            signal = opts.signal;
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
          }),
      ),
    );
    const starting = downloadBoundedMessage(f.raw, { maxBytes: 100, signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
    const stalled = new AbortController(),
      cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    const waiting = downloadBoundedMessage(f.raw, { maxBytes: 100, signal: stalled.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stalled.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalled();
  });
  it('refuses invalid options or origins before fetch and does not follow redirects', async () => {
    const f = await fixture('bytes');
    const fetch = transport(f.wire);
    await expect(downloadBoundedMessage(f.raw, { maxBytes: 0 })).rejects.toThrow(RangeError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      downloadBoundedMessage(f.raw, { maxBytes: 10, signal: aborted.signal }),
    ).rejects.toThrow();
    const media = f.raw.message!.imageMessage!;
    for (const url of [
      'http://mmg.whatsapp.net/x',
      'https://evil.invalid/x',
      'https://mmg.whatsapp.net:444/x',
      'https://user@mmg.whatsapp.net/x',
    ]) {
      media.url = url;
      await expect(downloadBoundedMessage(f.raw, { maxBytes: 10 })).rejects.toThrow(
        'Unsupported media origin',
      );
    }
    media.url = 'https://mmg.whatsapp.net/x';
    media.directPath = '//evil.invalid/x';
    await expect(downloadBoundedMessage(f.raw, { maxBytes: 10 })).rejects.toThrow(
      'Invalid media path',
    );
    media.directPath = '/\\evil.invalid/x';
    await expect(downloadBoundedMessage(f.raw, { maxBytes: 10 })).rejects.toThrow(
      'Invalid media path',
    );
    for (const separator of [
      String.fromCharCode(9),
      String.fromCharCode(10),
      String.fromCharCode(13),
    ]) {
      media.directPath = '/' + separator + '/evil.invalid/x';
      await expect(downloadBoundedMessage(f.raw, { maxBytes: 10 })).rejects.toThrow(
        'Invalid media path',
      );
    }
    expect(fetch).not.toHaveBeenCalled();
    media.directPath = '/valid';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
      ),
    );
    await expect(downloadBoundedMessage(f.raw, { maxBytes: 10 })).rejects.toThrow(
      'Media download request failed',
    );
  });
  it('checks HMAC and provided plaintext/encrypted SHA256 and never returns tampered bytes', async () => {
    const f = await fixture('integrity fixture');
    const corrupt = Buffer.from(f.wire);
    corrupt[0] = corrupt[0]! ^ 1;
    transport(corrupt);
    await expect(downloadBoundedMessage(f.raw, { maxBytes: 100 })).rejects.toThrow(
      'Invalid media integrity',
    );
    transport(f.wire);
    f.raw.message!.imageMessage!.fileSha256 = Buffer.alloc(32);
    await expect(downloadBoundedMessage(f.raw, { maxBytes: 100 })).rejects.toThrow(
      'Invalid media integrity',
    );
    f.raw.message!.imageMessage!.fileSha256 = undefined;
    f.raw.message!.imageMessage!.fileEncSha256 = Buffer.alloc(31);
    await expect(downloadBoundedMessage(f.raw, { maxBytes: 100 })).rejects.toThrow(
      'Invalid media integrity',
    );
  });
  it('reuploads expired media once using the socket context and keeps cancellation active', async () => {
    const f = await fixture('renewed');
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(respond(f.wire));
    vi.stubGlobal('fetch', request);
    const reuploadRequest = vi.fn(async () => f.raw);
    await expect(
      downloadBoundedMessage(f.raw, { maxBytes: 10 }, { reuploadRequest }),
    ).resolves.toEqual(f.plain);
    expect(reuploadRequest).toHaveBeenCalledOnce();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const controller = new AbortController();
    const pending = downloadBoundedMessage(
      f.raw,
      { maxBytes: 10, signal: controller.signal },
      { reuploadRequest: () => new Promise(() => {}) },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('exposes bounded incoming and cached hooks without advertising custom legacy-only downloaders', async () => {
    const f = await fixture('img');
    transport(f.wire);
    const mapped = mapWAMessage(f.raw)!;
    await expect(mapped.media!.downloadBounded!({ maxBytes: 3 })).resolves.toEqual(f.plain);
    const legacy = mapWAMessage(f.raw, async () => Buffer.from('legacy'))!;
    expect(legacy.media?.downloadBounded).toBeUndefined();
    await expect(legacy.media!.download()).resolves.toEqual(Buffer.from('legacy'));
    const adapter = new BaileysAdapter({ authDir: 'unused-auth-dir', historyDays: 0 });
    const received: WaIncomingMessage[] = [];
    adapter.on('message', (m) => received.push(m));
    adapter.handleUpsert([f.raw], 'notify');
    await expect(adapter.downloadMediaBounded('media-1', { maxBytes: 3 })).resolves.toEqual(
      f.plain,
    );
    await expect(received[0]!.media!.downloadBounded!({ maxBytes: 3 })).resolves.toEqual(f.plain);
    await expect(adapter.downloadMediaBounded('missing', { maxBytes: 3 })).resolves.toBeNull();
  });
  it('keeps the fake adapter bounded and backward compatible using in-memory fixtures', async () => {
    const fake = new FakeWaAdapter();
    fake.setMedia('fixture', Buffer.from('fake'));
    await expect(fake.downloadMediaBounded('fixture', { maxBytes: 4 })).resolves.toEqual(
      Buffer.from('fake'),
    );
    await expect(fake.downloadMediaBounded('fixture', { maxBytes: 3 })).rejects.toMatchObject({
      code: 'media_too_large',
    });
    await expect(fake.downloadMediaBounded('missing', { maxBytes: 4 })).resolves.toBeNull();
    const incoming = fake.simulateIncoming({
      chatJid: '60123456789@s.whatsapp.net',
      body: 'fake',
      media: { mime: 'image/jpeg', fileName: null, download: async () => Buffer.from('fake') },
    });
    await expect(incoming.media!.downloadBounded!({ maxBytes: 4 })).resolves.toEqual(
      Buffer.from('fake'),
    );
  });
});
