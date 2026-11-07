import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaStore, chatMediaDir, sanitizeSegment } from './media-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('media store', () => {
  it('keeps inbox 1 folders as before and gives other inboxes their own folder', () => {
    expect(chatMediaDir('6012@s.whatsapp.net')).toBe('6012_s_whatsapp_net');
    expect(chatMediaDir('6012@s.whatsapp.net#2')).toBe('inbox-2/6012_s_whatsapp_net');
    expect(chatMediaDir('g1@g.us#13')).toBe('inbox-13/g1_g_us');
    expect(sanitizeSegment('../x')).toBe('___x');
  });

  it('saves the same JID and message id of two inboxes to two files', () => {
    const root = mkdtempSync(join(tmpdir(), 'media-store-'));
    dirs.push(root);
    const store = new MediaStore(root);
    const one = store.save('6012@s.whatsapp.net', 'ABC', Buffer.from('one'), 'JPEG');
    const two = store.save('6012@s.whatsapp.net#2', 'ABC#2', Buffer.from('two'), 'jpeg');
    expect(one).toBe('6012_s_whatsapp_net/ABC.jpeg');
    expect(two).toBe('inbox-2/6012_s_whatsapp_net/ABC.jpeg');
    expect(readFileSync(store.abs(one), 'utf8')).toBe('one');
    expect(readFileSync(store.abs(two), 'utf8')).toBe('two');
    expect(store.save('6012@s.whatsapp.net#2', 'local-c1', Buffer.from('x'), '')).toBe(
      'inbox-2/6012_s_whatsapp_net/local-c1.bin',
    );
    // a local id is never read as a message key, whatever its clientId holds
    expect(store.save('6012@s.whatsapp.net', 'local-a#b', Buffer.from('y'), 'ogg')).toBe(
      '6012_s_whatsapp_net/local-a_b.ogg',
    );
    expect(store.save('6012@s.whatsapp.net', 'local-x#2', Buffer.from('z'), 'ogg')).toBe(
      '6012_s_whatsapp_net/local-x_2.ogg',
    );
    expect(() => store.abs('../outside')).toThrow('escapes');
  });

  it('copies a stored file for another message as a hard link; saving again never writes through it', () => {
    const root = mkdtempSync(join(tmpdir(), 'media-store-'));
    dirs.push(root);
    const store = new MediaStore(root);
    const src = store.save('6012@s.whatsapp.net', 'SRC', Buffer.from('video'), 'mp4');
    const copy = store.copy('6013@s.whatsapp.net#2', 'local-fw:0', src, 'mp4');
    expect(copy).toBe('inbox-2/6013_s_whatsapp_net/local-fw_0.mp4');
    expect(readFileSync(store.abs(copy), 'utf8')).toBe('video');
    expect(statSync(store.abs(copy)).ino).toBe(statSync(store.abs(src)).ino);
    // copying again replaces the entry
    expect(store.copy('6013@s.whatsapp.net#2', 'local-fw:0', src, 'mp4')).toBe(copy);
    // a new save of the source is a new file: the copy keeps its bytes
    store.save('6012@s.whatsapp.net', 'SRC', Buffer.from('other'), 'mp4');
    expect(readFileSync(store.abs(copy), 'utf8')).toBe('video');
    expect(() => store.copy('6013@s.whatsapp.net', 'X', '../outside', 'bin')).toThrow('escapes');
  });
});
