import { describe, expect, it } from 'vitest';
import { PRESERVED_NOTE } from './release-notes.mjs';
import { draftProblems, expectedInstallers, isReleaseVersion, main } from './release-publish.mjs';

const NOTES = `### Added\n\n- Something new.\n\n${PRESERVED_NOTE}\n`;
const draft = (over = {}) => ({
  isDraft: true,
  body: NOTES,
  assets: expectedInstallers('0.1.75').map((name) => ({ name, size: 100, state: 'uploaded' })),
  ...over,
});

describe('isReleaseVersion', () => {
  it('accepts only a plain x.y.z', () => {
    expect(isReleaseVersion('0.1.75')).toBe(true);
    expect(isReleaseVersion('10.20.300')).toBe(true);
    for (const bad of [
      'v0.1.75',
      '0.1',
      '0.1.75-rc.1',
      '0.1.75\n',
      '0.1.75;rm -rf /',
      '$(id)',
      '',
      undefined,
      175,
    ]) {
      expect(isReleaseVersion(bad)).toBe(false);
    }
  });
});

describe('expectedInstallers', () => {
  it('lists the versioned installers and their permanent-link copies', () => {
    expect(expectedInstallers('0.1.75')).toEqual([
      'EzyChat-Lite-0.1.75-win-x64.exe',
      'EzyChat-Lite-0.1.75-mac-arm64.dmg',
      'EzyChat-Lite-0.1.75-mac-x64.dmg',
      'EzyChat-Lite-win-x64.exe',
      'EzyChat-Lite-mac-arm64.dmg',
      'EzyChat-Lite-mac-x64.dmg',
    ]);
  });
});

describe('draftProblems', () => {
  it('accepts a complete draft', () => {
    expect(draftProblems(draft(), '0.1.75')).toEqual([]);
  });

  it('refuses a missing, empty or still uploading installer', () => {
    const assets = draft().assets.slice(1);
    assets[0] = { ...assets[0], size: 0 };
    assets[1] = { ...assets[1], state: 'starter' };
    expect(draftProblems(draft({ assets }), '0.1.75')).toEqual([
      'missing installer EzyChat-Lite-0.1.75-win-x64.exe',
      'empty installer EzyChat-Lite-0.1.75-mac-arm64.dmg',
      'installer EzyChat-Lite-0.1.75-mac-x64.dmg is starter',
    ]);
  });

  it('refuses an installer without a size', () => {
    const assets = draft().assets.map((a, i) => (i === 0 ? { name: a.name } : a));
    expect(draftProblems(draft({ assets }), '0.1.75')).toEqual([
      'empty installer EzyChat-Lite-0.1.75-win-x64.exe',
    ]);
  });

  it('refuses installers of another version', () => {
    expect(draftProblems(draft(), '0.1.76')).toContain(
      'missing installer EzyChat-Lite-0.1.76-win-x64.exe',
    );
  });

  it('refuses a published release, empty notes and notes not written by release-notes.mjs', () => {
    expect(draftProblems(draft({ isDraft: false }), '0.1.75')).toEqual([
      'the release is not a draft (already published?)',
    ]);
    expect(draftProblems(draft({ body: '' }), '0.1.75')).toEqual(['the release notes are empty']);
    expect(draftProblems(draft({ body: `\n${PRESERVED_NOTE}\n` }), '0.1.75')).toEqual([
      'the release notes are empty',
    ]);
    expect(draftProblems(draft({ body: 'Hand-written' }), '0.1.75')).toEqual([
      'the release notes do not come from release-notes.mjs',
    ]);
  });

  it('refuses no release at all', () => {
    expect(draftProblems(null, '0.1.75')).toEqual(['no release found']);
  });
});

describe('main', () => {
  const run = (argv, files = {}) => {
    const out = [];
    const err = [];
    const code = main(argv, {
      read: (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p];
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out, err };
  };

  it('checks the version input before anything else', () => {
    expect(run(['version', '0.1.75']).code).toBe(0);
    const bad = run(['version', '0.1.75 && curl x']);
    expect(bad.code).toBe(2);
    expect(bad.err[0]).toContain('not a release version');
    expect(run(['draft', 'v0.1.75', 'r.json']).code).toBe(2);
  });

  it('passes a complete draft and fails an incomplete one with every reason', () => {
    const ok = run(['draft', '0.1.75', 'r.json'], { 'r.json': JSON.stringify(draft()) });
    expect(ok).toEqual({ code: 0, out: ['v0.1.75: draft has 6 installers and notes'], err: [] });
    const bad = run(['draft', '0.1.75', 'r.json'], {
      'r.json': JSON.stringify(draft({ assets: [] })),
    });
    expect(bad.code).toBe(1);
    expect(bad.err).toHaveLength(6);
    expect(bad.err[0]).toBe('::error::v0.1.75: missing installer EzyChat-Lite-0.1.75-win-x64.exe');
  });

  it('fails on an unreadable file and on unknown commands', () => {
    expect(run(['draft', '0.1.75', 'missing.json']).code).toBe(1);
    expect(run(['draft', '0.1.75', 'r.json'], { 'r.json': '{' }).code).toBe(1);
    expect(run(['publish', '0.1.75']).code).toBe(2);
    expect(run(['draft', '0.1.75']).code).toBe(2);
  });
});
