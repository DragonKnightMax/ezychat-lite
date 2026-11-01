import { describe, expect, it } from 'vitest';
import { installedAppCandidates, movedChoice, movedProductName } from './moved.js';

describe('movedProductName', () => {
  it('reads the product from a valid marker', () => {
    expect(
      movedProductName(
        JSON.stringify({ to: 'enterprise', product: 'EzyChat Enterprise', at: 'x', version: '1' }),
      ),
    ).toBe('EzyChat Enterprise');
  });

  it.each([
    null,
    '',
    'not json',
    'null',
    JSON.stringify({ to: 'lite', product: 'EzyChat Enterprise' }),
    JSON.stringify({ to: 'enterprise', product: 42 }),
    JSON.stringify({ to: 'enterprise', product: '..\\..\\evil' }),
    JSON.stringify({ to: 'enterprise', product: 'A/B' }),
  ])('ignores %j', (raw) => expect(movedProductName(raw)).toBeNull());
});

describe('installedAppCandidates', () => {
  it('Windows: Program Files, then the per-user install', () => {
    expect(
      installedAppCandidates('EzyChat Enterprise', 'win32', {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      }),
    ).toEqual([
      'C:\\Program Files\\EzyChat Enterprise\\EzyChat Enterprise.exe',
      'C:\\Users\\a\\AppData\\Local\\Programs\\EzyChat Enterprise\\EzyChat Enterprise.exe',
    ]);
    expect(installedAppCandidates('EzyChat Enterprise', 'win32', {})).toEqual([]);
  });

  it('macOS: /Applications, then ~/Applications', () => {
    expect(installedAppCandidates('EzyChat Enterprise', 'darwin', { HOME: '/Users/a' })).toEqual([
      '/Applications/EzyChat Enterprise.app',
      '/Users/a/Applications/EzyChat Enterprise.app',
    ]);
    expect(installedAppCandidates('EzyChat Enterprise', 'darwin', {})).toEqual([
      '/Applications/EzyChat Enterprise.app',
    ]);
  });

  it('has none elsewhere or for an unsafe name', () => {
    expect(installedAppCandidates('EzyChat Enterprise', 'linux', {})).toEqual([]);
    expect(installedAppCandidates('a/../b', 'darwin', {})).toEqual([]);
  });
});

describe('movedChoice', () => {
  it('maps the dialog buttons', () => {
    expect([0, 1, 2, -1].map(movedChoice)).toEqual(['open', 'use-lite', 'close', 'close']);
  });
});
