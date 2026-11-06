// Android draws a notification's small icon (the push `badge`) from its alpha channel only. A
// full-colour square icon (icon-192.png) therefore showed as a plain white square on phones.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const publicDir = join(__dirname, '../public');
const sw = readFileSync(join(__dirname, 'sw.ts'), 'utf8');

/** Width, height, colour type and the unfiltered RGBA rows of an 8-bit RGBA PNG. */
function readRgbaPng(bytes: Buffer) {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colourType = bytes[25];
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  const byte = (buf: Buffer, i: number) => buf[i] ?? 0;
  for (let y = 0; y < height; y++) {
    const filter = byte(raw, y * (stride + 1));
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? byte(out, y * stride + x - 4) : 0;
      const b = y > 0 ? byte(out, (y - 1) * stride + x) : 0;
      const c = x >= 4 && y > 0 ? byte(out, (y - 1) * stride + x - 4) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter] ?? 0;
      out[y * stride + x] = (byte(line, x) + pred) & 0xff;
    }
  }
  return { width, height, colourType, pixels: out };
}

describe('push notification badge', () => {
  it('uses the monochrome badge, not the full-colour app icon', () => {
    expect(sw).toMatch(/badge:\s*'\/badge-96\.png'/);
    expect(sw).not.toMatch(/badge:\s*'\/icon-192\.png'/);
  });

  it('is a white shape on a transparent background', () => {
    const png = readRgbaPng(readFileSync(join(publicDir, 'badge-96.png')));
    expect([png.width, png.height, png.colourType]).toEqual([96, 96, 6]);
    let transparent = 0;
    let opaque = 0;
    for (let i = 0; i < png.pixels.length; i += 4) {
      const alpha = png.pixels[i + 3];
      if (alpha === 0) transparent++;
      if (alpha === 255) {
        opaque++;
        // Every visible pixel is white: Android only uses the alpha, other platforms show the colour.
        expect([png.pixels[i], png.pixels[i + 1], png.pixels[i + 2]]).toEqual([255, 255, 255]);
      }
    }
    const total = png.width * png.height;
    // A real silhouette: neither an empty image nor a filled square.
    expect(transparent / total).toBeGreaterThan(0.3);
    expect(opaque / total).toBeGreaterThan(0.2);
  });
});
