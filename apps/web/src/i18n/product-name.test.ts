import i18n from 'i18next';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT_NAME, initI18n, setProductName } from './index';

const files = import.meta.glob<Record<string, unknown>>('./locales/*/*.json', {
  eager: true,
  import: 'default',
});
/** Share-the-app texts promote the free Lite app, so they keep its name in every edition. */
const LITE_ONLY = new Set(['share.caption', 'share.imageAlt']);
/** The Lite → Enterprise import names the edition the data comes from, whatever this product is. */
const NAMES_LITE = (key: string) => key.startsWith('liteImport.');

function strings(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
}

describe('product name', () => {
  beforeAll(() => initI18n());
  afterEach(() => setProductName(DEFAULT_PRODUCT_NAME));

  it('shows EzyChat Lite by default', () => {
    expect(i18n.t('appName', { ns: 'common' })).toBe('EzyChat Lite');
    expect(i18n.t('about.title', { ns: 'app' })).toBe('About EzyChat Lite');
  });

  it('shows the name another edition sets, also after init', () => {
    setProductName('EzyChat Enterprise');
    expect(i18n.t('appName', { ns: 'common' })).toBe('EzyChat Enterprise');
    expect(i18n.t('about.title', { ns: 'app' })).toBe('About EzyChat Enterprise');
    // explicit values still win over the default variable
    expect(i18n.t('appName', { ns: 'common', product: 'X' })).toBe('X');
  });

  it.each(['', '   ', 'x'.repeat(61)])('rejects %j', (name) => {
    expect(() => setProductName(name)).toThrow(/productName/);
  });

  it('no catalog string hard-codes the product name except the share texts', () => {
    const offenders = Object.entries(files).flatMap(([file, json]) =>
      strings(json)
        .filter(
          ([key, text]) => text.includes('EzyChat Lite') && !LITE_ONLY.has(key) && !NAMES_LITE(key),
        )
        .map(([key]) => `${file}:${key}`),
    );
    expect(offenders).toEqual([]);
  });
});
