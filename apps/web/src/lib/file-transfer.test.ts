import { afterEach, describe, expect, it } from 'vitest';
import { MEDIA_UPLOAD_LIMIT_BYTES } from '@ezychat/shared';
import {
  MAX_ATTACHMENTS,
  checkAttachments,
  filesFromTransfer,
  formatBytes,
  hasFiles,
  installFileDropGuard,
  safeFileName,
  safeMime,
  setDownloadDrag,
  uploadLimitFor,
  videoNeedsFile,
} from './file-transfer';

/** A file whose `size` reads as `size` without allocating it. */
function sized(name: string, size: number, type = 'application/pdf'): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

function fakeTransfer() {
  const data = new Map<string, string>();
  return {
    data,
    dt: {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: (k: string, v: string) => data.set(k, v),
    } as unknown as DataTransfer,
  };
}

describe('file transfer', () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => uninstall?.());

  it('tells file drags from text or link drags', () => {
    expect(hasFiles({ types: ['Files'] })).toBe(true);
    expect(hasFiles({ types: ['text/plain', 'text/uri-list'] })).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });

  it('names a pasted screenshot after the paste time and keeps real file names', () => {
    const shot = new File(['p'], 'image.png', { type: 'image/png' });
    const doc = new File(['d'], 'quote.pdf', { type: 'application/pdf' });
    const noName = new File(['j'], '', { type: 'image/jpeg' });
    const files = filesFromTransfer(
      { files: [shot, doc, noName] as unknown as FileList },
      () => new Date(2026, 9, 27, 9, 5, 7),
    );
    expect(files.map((f) => f.name)).toEqual([
      'pasted-20261027-090507.png',
      'quote.pdf',
      'pasted-20261027-090507.jpg',
    ]);
    expect(files[0]!.type).toBe('image/png');
    expect(files[1]).toBe(doc);
    expect(filesFromTransfer(null)).toEqual([]);
  });

  it('refuses empty, too large and too many files before any upload', () => {
    const ok = sized('a.pdf', 10);
    const big = sized('big.mov', MEDIA_UPLOAD_LIMIT_BYTES + 1);
    const empty = sized('empty.txt', 0);
    const r = checkAttachments([ok, big, empty], 0);
    expect(r.accepted).toEqual([ok]);
    expect(r.rejected.map((x) => [x.file.name, x.reason])).toEqual([
      ['big.mov', 'too_large'],
      ['empty.txt', 'empty'],
    ]);
    const full = checkAttachments([sized('b.pdf', 1), sized('c.pdf', 1)], MAX_ATTACHMENTS - 1);
    expect(full.accepted.map((f) => f.name)).toEqual(['b.pdf']);
    expect(full.rejected).toEqual([expect.objectContaining({ reason: 'too_many' })]);
    expect(checkAttachments([sized('max.bin', MEDIA_UPLOAD_LIMIT_BYTES)], 0).accepted).toHaveLength(
      1,
    );
  });

  it("a video above the number's video limit goes as a file; nothing else does", () => {
    const MB = 1024 * 1024;
    const cloud = { video: 16 * MB, document: 100 * MB };
    expect(videoNeedsFile(sized('v.mp4', 70 * MB, 'video/mp4'), cloud)).toBe(true);
    expect(videoNeedsFile(sized('v.mp4', 10 * MB, 'video/mp4'), cloud)).toBe(false);
    expect(videoNeedsFile(sized('p.pdf', 70 * MB, 'application/pdf'), cloud)).toBe(false);
    expect(videoNeedsFile(sized('v.mp4', 70 * MB, 'video/mp4'), null)).toBe(false);
    expect(videoNeedsFile(sized('v.mp4', 70 * MB, 'video/mp4'), { document: MB })).toBe(false);
  });

  it("the upload limit is 100 MB, lowered by what the chat's number takes per kind", () => {
    const MB = 1024 * 1024;
    expect(MEDIA_UPLOAD_LIMIT_BYTES).toBe(100 * MB);
    const cloud = { video: 16 * MB, image: 5 * MB, audio: 16 * MB, document: 100 * MB };
    expect(uploadLimitFor('image/jpeg', cloud)).toBe(5 * MB);
    expect(uploadLimitFor('audio/ogg', cloud)).toBe(16 * MB);
    expect(uploadLimitFor('application/pdf', { document: 2 * 1024 * MB })).toBe(100 * MB);
    // A video is checked against the file limit: above the video limit the server decides.
    expect(uploadLimitFor('video/mp4', cloud)).toBe(100 * MB);
    expect(uploadLimitFor('video/mp4', { document: 50 * MB })).toBe(50 * MB);
    expect(uploadLimitFor('image/png')).toBe(100 * MB);
    expect(uploadLimitFor('image/png', null)).toBe(100 * MB);
    const r = checkAttachments(
      [sized('p.jpg', 6 * MB, 'image/jpeg'), sized('v.mp4', 70 * MB, 'video/mp4')],
      0,
      cloud,
    );
    expect(r.accepted.map((f) => f.name)).toEqual(['v.mp4']);
    expect(r.rejected).toEqual([expect.objectContaining({ reason: 'too_large', limit: 5 * MB })]);
  });

  it('formats sizes for the tray', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(64 * 1024 * 1024)).toBe('64 MB');
    expect(formatBytes(3 * 1024 ** 4)).toBe('3072 GB');
  });

  it('drags a media file out as a download with a safe name and an absolute link', () => {
    const { dt, data } = fakeTransfer();
    setDownloadDrag(dt, { url: '/api/media/abc', name: 'a:b/c.pdf', mime: 'application/pdf' });
    const href = new URL('/api/media/abc', window.location.href).href;
    expect(data.get('DownloadURL')).toBe(`application/pdf:a_b_c.pdf:${href}`);
    expect(data.get('text/uri-list')).toBe(href);
    expect(dt.effectAllowed).toBe('copy');
    const other = fakeTransfer();
    setDownloadDrag(other.dt, { url: '/x', name: '', mime: null });
    expect(other.data.get('DownloadURL')).toMatch(/^application\/octet-stream:file:/);
  });

  it("cleans a sender's type and file name before they go into a drag", () => {
    expect(safeMime('image/png')).toBe('image/png');
    expect(safeMime('application/vnd.ms-excel')).toBe('application/vnd.ms-excel');
    for (const bad of [null, '', 'text/html\nx', 'a:b/c', 'image', 'image/png; x=1'])
      expect(safeMime(bad)).toBe('application/octet-stream');
    expect(safeFileName('..\u0000evil<>|?*.exe')).toBe('_evil_____.exe');
    expect(safeFileName(' . .hidden')).toBe('hidden');
    expect(safeFileName('a:b/c\\d"e.pdf')).toBe('a_b_c_d_e.pdf');
    expect(safeFileName('...')).toBe('file');
    const { dt, data } = fakeTransfer();
    setDownloadDrag(dt, { url: '/api/media/x', name: 'r\nport.pdf', mime: 'text/html\nx' });
    expect(data.get('DownloadURL')).toMatch(/^application\/octet-stream:r_port\.pdf:http/);
  });

  it('stops a stray file drop from replacing the app, but leaves drop zones and text alone', () => {
    uninstall = installFileDropGuard(window);
    const drag = (type: string, types: string[], handled = false) => {
      const e = new Event(type, { cancelable: true, bubbles: true }) as DragEvent;
      Object.defineProperty(e, 'dataTransfer', { value: { types, dropEffect: 'copy' } });
      if (handled) e.preventDefault();
      window.dispatchEvent(e);
      return e;
    };
    const stray = drag('dragover', ['Files']);
    expect(stray.defaultPrevented).toBe(true);
    expect(stray.dataTransfer!.dropEffect).toBe('none');
    const zone = drag('dragover', ['Files'], true);
    expect(zone.dataTransfer!.dropEffect).toBe('copy');
    expect(drag('drop', ['Files']).defaultPrevented).toBe(true);
    expect(drag('drop', ['text/plain']).defaultPrevented).toBe(false);
    uninstall();
    uninstall = null;
    expect(drag('drop', ['Files']).defaultPrevented).toBe(false);
  });
});
