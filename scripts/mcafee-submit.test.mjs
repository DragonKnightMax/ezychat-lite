import { describe, expect, it } from 'vitest';
import {
  releaseOfTag,
  osslsigncodeStatus,
  macSignatureProblem,
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

describe('osslsigncodeStatus', () => {
  const output = [
    'Signer #0:',
    '\t\tSubject: CN=Anchor Sprint Pte. Ltd.,O=Anchor Sprint Pte. Ltd.,L=Singapore,C=SG',
    'Timestamp verified using:',
    '\tSigner #0:',
    '\t\tSubject: CN=Microsoft Public RSA Timestamping CA 2020,O=Microsoft Corporation,C=US',
    'Timestamp Server Signature verification: ok',
    'Signature verification: ok',
    'Number of verified signatures: 1',
    'Succeeded',
  ].join('\n');

  it('is Valid only when osslsigncode succeeded, and names the file signer, not the timestamp signer', () => {
    const result = osslsigncodeStatus(output, 0);
    expect(result).toEqual({
      status: 'Valid',
      subject: 'CN=Anchor Sprint Pte. Ltd.,O=Anchor Sprint Pte. Ltd.,L=Singapore,C=SG',
    });
    expect(signatureProblem(result.status, result.subject)).toBeNull();
  });

  it('is not Valid when the check failed or the exit code says so', () => {
    expect(osslsigncodeStatus(output.replace('Succeeded', 'Failed'), 1).status).toBe('NotValid');
    expect(osslsigncodeStatus(output, 1).status).toBe('NotValid');
    expect(osslsigncodeStatus('', 255)).toEqual({ status: 'NotValid', subject: '' });
  });
});

describe('macSignatureProblem', () => {
  const signed = {
    codesign:
      'Authority=Developer ID Application: Anchor Sprint Pte. Ltd. (4N9HTT975Q)\nAuthority=Developer ID Certification Authority',
    spctl: 'EzyChat Lite.app: accepted\nsource=Notarized Developer ID',
    stapled: true,
  };

  it('accepts only our Developer ID, notarized, with the ticket stapled', () => {
    expect(macSignatureProblem(signed)).toBeNull();
    expect(macSignatureProblem({ ...signed, codesign: 'Signature=adhoc' })).toContain(
      'Developer ID',
    );
    expect(
      macSignatureProblem({
        ...signed,
        codesign: 'Authority=Developer ID Application: Someone Else (ABCDE12345)',
      }),
    ).toContain('Developer ID');
    expect(
      macSignatureProblem({ ...signed, spctl: 'rejected\nsource=Unnotarized Developer ID' }),
    ).toContain('notarized');
    expect(macSignatureProblem({ ...signed, stapled: false })).toContain('stapled');
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

  it('claims the Developer ID and notarization for a Mac file only when this run checked it', () => {
    const text = reportText({ edition: 'lite', asset: mac, zipName: 'm.zip', macSigned: true });
    expect(text).toContain('signed business software, Mac installer');
    expect(text).toContain(
      'Developer ID Application: Anchor Sprint Pte. Ltd. (4N9HTT975Q), notarized by Apple',
    );
    expect(
      reportText({ edition: 'lite', asset: mac, zipName: 'm.zip', macSigned: false }),
    ).not.toMatch(/signature|signed|notarized/i);
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

describe('releaseOfTag', () => {
  it('finds a draft by its tag, which releases/tags/ does not, and stops when there is none', () => {
    const list = [
      { tag_name: 'v0.1.83', draft: true },
      { tag_name: 'v0.1.82', draft: false },
    ];
    expect(releaseOfTag(list, '0.1.83')).toEqual({ tag_name: 'v0.1.83', draft: true });
    expect(() => releaseOfTag(list, '0.1.84')).toThrow('no release or draft for v0.1.84');
  });

  it("downloads a draft's files through the API, a published one through its public link", () => {
    const asset = {
      name: 'a.exe',
      browser_download_url: 'https://pub',
      url: 'https://api',
      size: 1,
    };
    expect(liteAssets({ draft: true, assets: [asset] })[0]).toMatchObject({
      url: 'https://pub',
      apiUrl: 'https://api',
    });
    expect(liteAssets({ draft: false, assets: [asset] })[0]?.apiUrl).toBeUndefined();
  });
});
