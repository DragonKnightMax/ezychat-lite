import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from './i18n.js';
import {
  LITE_PRODUCT,
  activeProduct,
  defineProduct,
  escapeRegExp,
  resetActiveProductForTests,
  setActiveProduct,
  type Product,
} from './product.js';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');

afterEach(() => resetActiveProductForTests());

describe('LITE_PRODUCT upgrade contracts', () => {
  it('pins every installer identity value to what shipped (never change these)', () => {
    expect({ ...LITE_PRODUCT }).toEqual({
      edition: 'lite',
      productName: 'EzyChat Lite',
      appUserModelId: 'org.ossmalaysia.wateaminbox',
      appDirName: 'wa-team-inbox',
      profileDirName: 'WA Team Inbox',
      serviceId: 'wa-team-inbox',
      serviceName: 'EzyChat Lite Server',
      launchdLabel: 'org.ossmalaysia.wateaminbox.server',
      healthApp: 'wa-team-inbox',
      releaseRepository: 'ossmalaysia/ezychat-lite',
      releaseRepositories: ['ossmalaysia/ezychat-lite', 'ossmalaysia/wa-team-inbox'],
      artifactPrefixes: ['EzyChat-Lite', 'WA-Team-Inbox'],
      executableNames: ['EzyChat Lite', 'WA Team Inbox'],
      upgradeInstallerFeed: 'https://dl.ezychat.ai/enterprise/latest.json',
    });
    // Lite adopts no other product's data; only Enterprise passes adoptFrom: LITE_PRODUCT.
    expect(LITE_PRODUCT.adoptFrom).toBeUndefined();
  });

  it('is frozen and passes its own validation', () => {
    expect(Object.isFrozen(LITE_PRODUCT)).toBe(true);
    expect(Object.isFrozen(LITE_PRODUCT.releaseRepositories)).toBe(true);
    expect({ ...defineProduct(LITE_PRODUCT) }).toEqual({ ...LITE_PRODUCT });
  });

  it('is the active product unless an edition entry selects another', () => {
    expect(activeProduct()).toBe(LITE_PRODUCT);
  });

  it('matches electron-builder.yml (appId, productName, artifact and executable names)', () => {
    const yml = readFileSync(join(desktop, 'electron-builder.yml'), 'utf8');
    const value = (key: string) => yml.match(new RegExp(`^\\s*${key}: (.+)$`, 'm'))?.[1]?.trim();
    expect(value('appId')).toBe(LITE_PRODUCT.appUserModelId);
    expect(value('productName')).toBe(LITE_PRODUCT.productName);
    expect(value('artifactName')).toBe(
      `${LITE_PRODUCT.artifactPrefixes[0]}-\${version}-\${os}-\${arch}.\${ext}`,
    );
    expect(value('executableName')).toBe(LITE_PRODUCT.executableNames[0]);
    expect(value('shortcutName')).toBe(LITE_PRODUCT.productName);
  });

  it('matches package.json productName (Electron app name)', () => {
    const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as {
      productName: string;
    };
    expect(pkg.productName).toBe(LITE_PRODUCT.productName);
  });
});

const enterprise: Product = {
  edition: 'enterprise',
  productName: 'EzyChat Enterprise',
  appUserModelId: 'com.example.ezychat.enterprise',
  appDirName: 'ezychat-enterprise',
  profileDirName: 'EzyChat Enterprise',
  serviceId: 'ezychat-enterprise',
  serviceName: 'EzyChat Enterprise Server',
  launchdLabel: 'com.example.ezychat.enterprise.server',
  healthApp: 'wa-team-inbox',
  releaseRepository: 'example/ezychat-enterprise-releases',
  releaseRepositories: ['example/ezychat-enterprise-releases'],
  artifactPrefixes: ['EzyChat-Enterprise'],
  executableNames: ['EzyChat Enterprise'],
};

describe('defineProduct', () => {
  it('accepts a complete product and freezes it', () => {
    const p = defineProduct(enterprise);
    expect({ ...p }).toEqual(enterprise);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.executableNames)).toBe(true);
  });

  it.each([
    ['edition', ''],
    ['edition', 'Enterprise!'],
    ['productName', ''],
    ['productName', "Ezy'Chat"],
    ['productName', ' padded '],
    ['appUserModelId', ''],
    ['appUserModelId', 'nodots'],
    ['appUserModelId', 'com..example'],
    ['appDirName', ''],
    ['appDirName', '../escape'],
    ['appDirName', 'Has Space'],
    ['profileDirName', ''],
    ['profileDirName', 'a/b'],
    ['serviceId', ''],
    ['serviceId', 'svc;rm'],
    ['serviceName', ''],
    ['launchdLabel', ''],
    ['launchdLabel', 'label with space'],
    ['healthApp', ''],
    ['releaseRepository', ''],
    ['releaseRepository', 'no-slash'],
  ] as const)('rejects %s = %j', (field, value) => {
    expect(() => defineProduct({ ...enterprise, [field]: value })).toThrow(
      new RegExp(`product ${field}`),
    );
  });

  it('rejects missing fields', () => {
    const { serviceId: _omit, ...rest } = enterprise;
    expect(() => defineProduct(rest as Product)).toThrow(/serviceId/);
  });

  it('requires the lists to start with the current value and have no duplicates', () => {
    expect(() => defineProduct({ ...enterprise, releaseRepositories: ['other/repo'] })).toThrow(
      /releaseRepositories/,
    );
    expect(() => defineProduct({ ...enterprise, executableNames: [] })).toThrow(/executableNames/);
    expect(() => defineProduct({ ...enterprise, executableNames: ['Something Else'] })).toThrow(
      /executableNames/,
    );
    expect(() =>
      defineProduct({
        ...enterprise,
        artifactPrefixes: ['EzyChat-Enterprise', 'EzyChat-Enterprise'],
      }),
    ).toThrow(/duplicate/);
    expect(() => defineProduct({ ...enterprise, artifactPrefixes: ['bad name'] })).toThrow(
      /artifactPrefixes/,
    );
  });
});

describe('setActiveProduct', () => {
  it('switches the product before anything reads it', () => {
    setActiveProduct(enterprise);
    expect(activeProduct().serviceId).toBe('ezychat-enterprise');
  });

  it('refuses a late switch once the product has been read', () => {
    activeProduct();
    expect(() => setActiveProduct(enterprise)).toThrow(/already in use/);
    expect(activeProduct()).toBe(LITE_PRODUCT);
  });

  it('validates the product it is given', () => {
    expect(() => setActiveProduct({ ...enterprise, serviceId: '' })).toThrow(/serviceId/);
  });
});

describe('defaultPort', () => {
  it('is optional (Lite keeps 7420) and kept when valid', () => {
    expect(LITE_PRODUCT.defaultPort).toBeUndefined();
    expect(defineProduct({ ...enterprise, defaultPort: 7440 }).defaultPort).toBe(7440);
  });

  it.each([80, 70000, 7440.5, '7440'])('refuses %s', (port) => {
    expect(() => defineProduct({ ...enterprise, defaultPort: port as number })).toThrow(
      /defaultPort/,
    );
  });
});

describe('desktop texts name the active edition', () => {
  it('fills {{product}} in every catalog with the productName', () => {
    setActiveProduct(enterprise);
    expect(t('en', 'page.startingTitle')).toBe('Starting EzyChat Enterprise…');
    expect(t('ms', 'page.startingTitle')).toBe('Memulakan EzyChat Enterprise…');
    expect(t('zh-CN', 'page.startingTitle')).toBe('正在启动 EzyChat Enterprise…');
    expect(t('en', 'status.documentTitle')).toBe('EzyChat Enterprise — Status & Service');
  });

  it('names Lite when no edition is set', () => {
    expect(t('en', 'page.startingTitle')).toBe('Starting EzyChat Lite…');
  });
});

describe('escapeRegExp', () => {
  it('matches the value literally', () => {
    const value = 'A.B (x)|y';
    expect(new RegExp(`^${escapeRegExp(value)}$`).test(value)).toBe(true);
    expect(new RegExp(`^${escapeRegExp(value)}$`).test('AxB (x)|y')).toBe(false);
  });
});

describe('another edition flows through the identity consumers', () => {
  it('uses its own folders, profile and installer names', async () => {
    const { machineDataDir, serviceRunDir, preserveInstalledProfile } = await import('./paths.js');
    const { updateInstallEligibility } = await import('./updater/install.js');
    setActiveProduct(enterprise);
    expect(machineDataDir('win32', {})).toBe('C:\\ProgramData\\ezychat-enterprise');
    expect(serviceRunDir('darwin', {})).toBe(
      '/Library/Application Support/ezychat-enterprise-runtime',
    );
    const set: string[] = [];
    preserveInstalledProfile(
      { isPackaged: true, getPath: () => '/home', setPath: (_n, p) => set.push(p) },
      () => {},
    );
    expect(set[0]).toBe(join('/home', 'EzyChat Enterprise'));
    const context = {
      platform: 'win32' as const,
      appBundle: null,
      userDataDir: 'C:\\Users\\a\\AppData\\Roaming\\EzyChat Enterprise',
      machineDataDir: 'C:\\ProgramData\\ezychat-enterprise',
      serviceRunDir: 'C:\\ProgramData\\ezychat-enterprise\\run',
      serviceInstalled: false,
      oldPid: 1,
    };
    const env = { ProgramFiles: 'C:\\Program Files' };
    expect(
      updateInstallEligibility(
        { ...context, execPath: 'C:\\Program Files\\EzyChat Enterprise\\EzyChat Enterprise.exe' },
        env,
      ).eligible,
    ).toBe(true);
    const lite = updateInstallEligibility(
      { ...context, execPath: 'C:\\Program Files\\EzyChat Lite\\EzyChat Lite.exe' },
      env,
    );
    expect(lite.eligible).toBe(false);
    expect(lite.reason).toContain('EzyChat Enterprise');
  });
});

describe('Lite → Enterprise fields', () => {
  it('keeps adoptFrom as a validated, frozen copy of another edition', () => {
    const p = defineProduct({ ...enterprise, adoptFrom: LITE_PRODUCT });
    expect({ ...p.adoptFrom }).toEqual({ ...LITE_PRODUCT });
    expect(Object.isFrozen(p.adoptFrom)).toBe(true);
    expect(defineProduct(enterprise).adoptFrom).toBeUndefined();
  });

  it('refuses adopting from itself, a chain or an invalid product', () => {
    expect(() => defineProduct({ ...enterprise, adoptFrom: enterprise })).toThrow(
      /another edition/,
    );
    expect(() =>
      defineProduct({ ...enterprise, adoptFrom: { ...LITE_PRODUCT, adoptFrom: LITE_PRODUCT } }),
    ).toThrow(/cannot adopt/);
    expect(() =>
      defineProduct({ ...enterprise, adoptFrom: { ...LITE_PRODUCT, serviceId: '' } }),
    ).toThrow(/serviceId/);
    expect(() => defineProduct({ ...enterprise, adoptFrom: 'lite' as unknown as Product })).toThrow(
      /adoptFrom/,
    );
  });

  it('takes an https upgradeInstallerFeed or null and refuses anything else', () => {
    expect(defineProduct({ ...enterprise, upgradeInstallerFeed: null }).upgradeInstallerFeed).toBe(
      null,
    );
    expect(
      defineProduct({ ...enterprise, upgradeInstallerFeed: 'https://dl.example.com/x.json' })
        .upgradeInstallerFeed,
    ).toBe('https://dl.example.com/x.json');
    for (const bad of ['http://dl.example.com/x.json', 'https://u:p@x.com/a', 'nope', 42])
      expect(() => defineProduct({ ...enterprise, upgradeInstallerFeed: bad as string })).toThrow(
        /upgradeInstallerFeed/,
      );
  });
});
