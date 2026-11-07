import { describe, expect, it } from 'vitest';
import type { WAMessage } from 'baileys';
import { decodeMediaRef, encodeMediaRef } from './media-ref.js';

const mediaKey = Uint8Array.from([1, 2, 3, 4]);
const key = { remoteJid: '60111@s.whatsapp.net', id: 'M1', fromMe: false };
const image = {
  url: 'https://mmg.whatsapp.net/x',
  directPath: '/v/x',
  mimetype: 'image/jpeg',
  mediaKey,
  mediaKeyTimestamp: 1700000000,
  fileSha256: Uint8Array.from([5]),
  fileEncSha256: Uint8Array.from([6]),
  caption: 'secret caption',
  jpegThumbnail: Uint8Array.from([7, 8]),
  contextInfo: { quotedMessage: { conversation: 'quoted text' } },
};

describe('media ref', () => {
  it('survives a round trip with what a download needs', () => {
    const ref = encodeMediaRef({ key, message: { imageMessage: image } } as WAMessage)!;
    const back = decodeMediaRef(ref)!;
    expect(back.key).toEqual({ ...key, participant: null });
    const decoded = back.message!.imageMessage!;
    expect(decoded.url).toBe(image.url);
    expect(decoded.directPath).toBe(image.directPath);
    expect(decoded.mediaKeyTimestamp).toBe(1700000000);
    expect([...decoded.mediaKey!]).toEqual([1, 2, 3, 4]);
    expect([...decoded.fileEncSha256!]).toEqual([6]);
  });

  it('leaves out the caption, the quote and the thumbnail', () => {
    const ref = encodeMediaRef({ key, message: { imageMessage: image } } as WAMessage)!;
    expect(ref).not.toContain('secret caption');
    expect(ref).not.toContain('quoted text');
    expect(ref).not.toContain('jpegThumbnail');
  });

  it('keeps url present when WhatsApp sent none: Baileys needs the field to see media', () => {
    const { url: _url, ...noUrl } = image;
    const ref = encodeMediaRef({ key, message: { imageMessage: noUrl } } as WAMessage)!;
    expect(decodeMediaRef(ref)!.message!.imageMessage).toHaveProperty('url', null);
  });

  it('reads the media inside a view-once wrapper', () => {
    const message = { viewOnceMessageV2: { message: { imageMessage: image } } };
    const ref = encodeMediaRef({ key, message } as WAMessage)!;
    expect(decodeMediaRef(ref)!.message!.imageMessage).toBeTruthy();
  });

  it.each([
    ['text only', { conversation: 'hi' }],
    ['no media key', { imageMessage: { url: 'https://x' } }],
    ['an empty media key', { imageMessage: { mediaKey: new Uint8Array() } }],
  ])('gives no ref for %s', (_name, message) => {
    expect(encodeMediaRef({ key, message } as WAMessage)).toBeUndefined();
  });

  it('gives no ref without a message id', () => {
    const message = { imageMessage: image };
    expect(encodeMediaRef({ key: { remoteJid: 'x' }, message } as WAMessage)).toBeUndefined();
  });

  it.each([
    ['not JSON', 'nope'],
    ['JSON null', 'null'],
    [
      'another version',
      JSON.stringify({ v: 2, type: 'imageMessage', mediaKey: 'AQ==', key: { id: 'M' } }),
    ],
    [
      'another type',
      JSON.stringify({ v: 1, type: 'pollMessage', mediaKey: 'AQ==', key: { id: 'M' } }),
    ],
    ['no media key', JSON.stringify({ v: 1, type: 'imageMessage', key: { id: 'M' } })],
    ['no id', JSON.stringify({ v: 1, type: 'imageMessage', mediaKey: 'AQ==', key: {} })],
  ])('reads %s as no ref', (_name, text) => {
    expect(decodeMediaRef(text)).toBeNull();
  });
});
