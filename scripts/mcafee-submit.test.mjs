import { describe, expect, it } from 'vitest';
import {
  checkReporter,
  checkVersion,
  liteAssets,
  pickAssets,
  powershellEnv,
  reportText,
  selectKinds,
  signatureProblem,
} from './mcafee-submit.mjs';

const sha = 'a'.repeat(64);
const file = (name) => ({ name, url: `https://x/${name}`, sha256: sha, size: 10 });
const enterprise = ['win-x64.exe', 'mac-arm64.dmg', 'mac-x64.dmg'].map((s) =>
  file(`EzyChat-Enterprise-0.1.28-${s}`),
);

describe('checkVersion', () => {
  it('accepts x.y.z', () => {
    expect(checkVersion('0.1.79')).toBe('0.1.79');
  });

  it.each(['../../etc', '0.1.79/../..', '0.1', 'v0.1.79', '0.1.79\n', '', undefined])(
    'stops for %j, which would reach a URL or a folder name',
    (version) => {
      expect(() => checkVersion(version)).toThrow('not a version');
    },
  );
});

describe('powershellEnv', () => {
  it('drops the module path of PowerShell 7, in any case, and keeps the rest', () => {
    const parent = { PSModulePath: 'a', PSMODULEPATH: 'b', PATH: 'c' };
    expect(powershellEnv(parent, { TARGET_FILE: 'f' })).toEqual({ PATH: 'c', TARGET_FILE: 'f' });
  });
});

describe('pickAssets', () => {
  it('keeps only the versioned installers, ignoring the permanent names', () => {
    const assets = [...enterprise, file('EzyChat-Enterprise-win-x64.exe')];
    expect(pickAssets('enterprise', '0.1.28', assets).map((a) => [a.kind, a.name])).toEqual([
      ['win', 'EzyChat-Enterprise-0.1.28-win-x64.exe'],
      ['mac-arm64', 'EzyChat-Enterprise-0.1.28-mac-arm64.dmg'],
      ['mac-x64', 'EzyChat-Enterprise-0.1.28-mac-x64.dmg'],
    ]);
  });

  it('stops when an installer of the release is missing', () => {
    expect(() => pickAssets('enterprise', '0.1.28', enterprise.slice(0, 2))).toThrow(
      'EzyChat-Enterprise-0.1.28-mac-x64.dmg',
    );
  });

  it('stops when a file has no hash to check it against', () => {
    const noHash = enterprise.map((a) => ({ ...a, sha256: '' }));
    expect(() => pickAssets('enterprise', '0.1.28', noHash)).toThrow('no SHA-256');
  });
});

describe('liteAssets', () => {
  it('reads the hash from the GitHub digest', () => {
    const [asset] = liteAssets({
      assets: [
        {
          name: 'a.exe',
          browser_download_url: 'https://g/a.exe',
          size: 5,
          digest: `sha256:${sha}`,
        },
      ],
    });
    expect(asset).toEqual({ name: 'a.exe', url: 'https://g/a.exe', size: 5, sha256: sha });
  });
});

describe('selectKinds', () => {
  it('defaults to every file and refuses an unknown type', () => {
    expect(selectKinds(undefined)).toEqual(['win', 'mac-arm64', 'mac-x64']);
    expect(selectKinds('win, mac-x64')).toEqual(['win', 'mac-x64']);
    expect(() => selectKinds('linux')).toThrow('linux');
  });
});

describe('signatureProblem', () => {
  it('accepts only a valid signature of our company', () => {
    expect(
      signatureProblem('Valid', 'CN=Anchor Sprint Pte. Ltd., O=Anchor Sprint Pte. Ltd.'),
    ).toBeNull();
    expect(signatureProblem('NotSigned', '')).toContain('NotSigned');
    expect(signatureProblem('Valid', 'CN=Someone Else')).toContain('Someone Else');
  });
});

describe('reportText', () => {
  const [win, mac] = pickAssets('enterprise', '0.1.28', enterprise);

  it('claims a signature only for a Windows file', () => {
    expect(reportText({ edition: 'enterprise', asset: win })).toContain(
      'valid Authenticode signature',
    );
    expect(reportText({ edition: 'enterprise', asset: mac, zipName: 'm.zip' })).not.toMatch(
      /signature|signed/i,
    );
  });

  it('names the installer and its hash, and the ZIP only when one is attached', () => {
    const text = reportText({ edition: 'enterprise', asset: mac, zipName: `${mac.name}.zip` });
    expect(text).toContain(`Attached: ${mac.name}.zip`);
    expect(text).toContain(`File: ${mac.name}`);
    expect(text).toContain(`SHA-256: ${sha}`);
    expect(reportText({ edition: 'enterprise', asset: win })).not.toContain('Attached:');
  });

  it('does not say McAfee blocks a file nobody saw blocked', () => {
    expect(reportText({ edition: 'lite', asset: win })).not.toMatch(/McAfee blocks/);
    expect(reportText({ edition: 'lite', asset: win })).toContain('EzyChat Lite');
  });
});

describe('checkReporter', () => {
  it('needs a name, an email and a company', () => {
    const reporter = { fullName: 'A', email: 'a@b.c', company: 'C' };
    expect(checkReporter(reporter)).toBe(reporter);
    expect(() => checkReporter({ ...reporter, email: ' ' })).toThrow('email');
  });
});
