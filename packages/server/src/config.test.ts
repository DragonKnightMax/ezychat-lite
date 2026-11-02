import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from './config.js';

describe('parseArgs fake-wa', () => {
  it('enables fake WA only with the explicit flag', () => {
    expect(parseArgs(['--data', 'x', '--fake-wa'], {}).fakeWa).toBe(true);
    expect(parseArgs(['--data', 'x'], {}).fakeWa).toBe(false);
  });
  it('ignores a WATI_FAKE_WA environment variable', () => {
    expect(parseArgs(['--data', 'x'], { WATI_FAKE_WA: '1' }).fakeWa).toBe(false);
  });
  it('refuses --fake-wa in service mode', () => {
    expect(() => parseArgs(['--data', 'x', '--mode', 'service', '--fake-wa'], {})).toThrow(
      /service/,
    );
  });
});

describe('parseArgs Google sign-in app', () => {
  const bundled = {
    clientId: 'bundled.apps.googleusercontent.com',
    clientSecret: 'bundled-secret',
  };
  const g = globalThis as { __EZYCHAT_GOOGLE_OAUTH__?: unknown };
  afterEach(() => {
    delete g.__EZYCHAT_GOOGLE_OAUTH__;
  });

  it('is absent without the environment or a release bundle', () => {
    expect(parseArgs(['--data', 'x'], {}).googleOAuth).toBeNull();
    expect(
      parseArgs(['--data', 'x'], { GOOGLE_OAUTH_CLIENT_ID: 'only-id' }).googleOAuth,
    ).toBeNull();
  });

  it('uses the app the release bundle carries', () => {
    g.__EZYCHAT_GOOGLE_OAUTH__ = bundled;
    expect(parseArgs(['--data', 'x'], {}).googleOAuth).toEqual(bundled);
  });

  it('lets a complete environment pair win over the bundle, and ignores a broken bundle value', () => {
    g.__EZYCHAT_GOOGLE_OAUTH__ = bundled;
    const env = { GOOGLE_OAUTH_CLIENT_ID: ' env-id ', GOOGLE_OAUTH_CLIENT_SECRET: 'env-secret' };
    expect(parseArgs(['--data', 'x'], env).googleOAuth).toEqual({
      clientId: 'env-id',
      clientSecret: 'env-secret',
    });
    // half an environment pair does not replace the bundled app
    expect(parseArgs(['--data', 'x'], { GOOGLE_OAUTH_CLIENT_ID: 'env-id' }).googleOAuth).toEqual(
      bundled,
    );
    g.__EZYCHAT_GOOGLE_OAUTH__ = { clientId: 42 };
    expect(parseArgs(['--data', 'x'], {}).googleOAuth).toBeNull();
  });

  it("reads Google's file picker from the environment, else from the bundle", () => {
    expect(parseArgs(['--data', 'x'], {}).googlePicker).toBeNull();
    g.__EZYCHAT_GOOGLE_OAUTH__ = { ...bundled, pickerApiKey: 'bundled-key', pickerAppId: '42' };
    expect(parseArgs(['--data', 'x'], {}).googlePicker).toEqual({
      apiKey: 'bundled-key',
      appId: '42',
    });
    const env = { GOOGLE_PICKER_API_KEY: ' env-key ', GOOGLE_PICKER_APP_ID: '7' };
    expect(parseArgs(['--data', 'x'], env).googlePicker).toEqual({ apiKey: 'env-key', appId: '7' });
    expect(parseArgs(['--data', 'x'], { GOOGLE_PICKER_API_KEY: 'only-key' }).googlePicker).toEqual({
      apiKey: 'bundled-key',
      appId: '42',
    });
  });
});
