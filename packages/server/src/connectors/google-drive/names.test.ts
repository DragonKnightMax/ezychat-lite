import { describe, expect, it } from 'vitest';
import { cleanSubfolder, driveFileKind, exportMime, localStamp, savedFileName } from './names.js';

describe('Google Drive names', () => {
  it('names a saved file by date, time, kind and a reference, never the sender name', () => {
    const at = Date.UTC(2026, 10, 5, 6, 32); // 14:32 in Kuala Lumpur
    expect(localStamp(at, 'Asia/Kuala_Lumpur')).toEqual({ day: '2026-11-05', time: '1432' });
    expect(
      savedFileName({ type: 'image', mime: 'image/jpeg', sentAt: at }, 'Asia/Kuala_Lumpur', '7F3A'),
    ).toBe('2026-11-05 1432 Photo 7F3A.jpg');
    expect(
      savedFileName(
        { type: 'audio', mime: 'audio/ogg; codecs=opus', sentAt: at },
        'Asia/Kuala_Lumpur',
        'AB12',
      ),
    ).toBe('2026-11-05 1432 Voice note AB12.ogg');
    expect(
      savedFileName({ type: 'other', mime: 'application/x-weird', sentAt: at }, 'UTC', '0000'),
    ).toBe('2026-11-05 0632 File 0000');
    expect(savedFileName({ type: 'document', mime: null, sentAt: at }, 'UTC')).toMatch(
      /^2026-11-05 0632 Document [0-9A-F]{4}$/,
    );
  });

  it('cleans a sub-folder name to one safe level', () => {
    expect(cleanSubfolder('  Jay/Low\\Co  ')).toBe('Jay-Low-Co');
    expect(cleanSubfolder('Jay\u202eLow\u0000')).toBe('JayLow');
    expect(cleanSubfolder('../..')).toBe('-..');
    expect(cleanSubfolder('...')).toBeNull();
    expect(cleanSubfolder('   ')).toBeNull();
    expect(cleanSubfolder(undefined)).toBeNull();
    expect(cleanSubfolder('x'.repeat(200))).toHaveLength(80);
  });

  it('reads each kind of Drive file the right way', () => {
    expect(driveFileKind('application/vnd.google-apps.document')).toBe('doc');
    expect(driveFileKind('application/vnd.google-apps.presentation')).toBe('doc');
    expect(driveFileKind('application/vnd.google-apps.spreadsheet')).toBe('sheet');
    expect(driveFileKind('application/pdf')).toBe('pdf');
    expect(
      driveFileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('word');
    expect(driveFileKind('text/csv')).toBe('text');
    expect(driveFileKind('image/png')).toBe('other');
    expect(exportMime('application/vnd.google-apps.document')).toBe('text/plain');
    expect(exportMime('application/vnd.google-apps.presentation')).toBe('text/plain');
    expect(exportMime('application/vnd.google-apps.spreadsheet')).toBe('text/csv');
    expect(exportMime('application/pdf')).toBeNull();
  });
});
