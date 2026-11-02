import { describe, expect, it } from 'vitest';
import { googleOAuthDefine } from './google-oauth-define.mjs';

const id = '123-abc.apps.googleusercontent.com';

describe('googleOAuthDefine', () => {
  it('adds nothing when the build has no Google app (local builds, forks)', () => {
    expect(googleOAuthDefine({})).toEqual({});
    expect(
      googleOAuthDefine({ GOOGLE_OAUTH_CLIENT_ID: ' ', GOOGLE_OAUTH_CLIENT_SECRET: '' }),
    ).toEqual({});
  });

  it('defines the app as one JSON value', () => {
    const define = googleOAuthDefine({
      GOOGLE_OAUTH_CLIENT_ID: ` ${id} `,
      GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-test',
    });
    expect(JSON.parse(define.__EZYCHAT_GOOGLE_OAUTH__)).toEqual({
      clientId: id,
      clientSecret: 'GOCSPX-test',
    });
  });

  it('refuses half a pair or a wrong client id, without echoing the values', () => {
    expect(() => googleOAuthDefine({ GOOGLE_OAUTH_CLIENT_ID: id })).toThrow('or neither');
    expect(() => googleOAuthDefine({ GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-test' })).toThrow(
      'or neither',
    );
    expect(() =>
      googleOAuthDefine({ GOOGLE_OAUTH_CLIENT_ID: 'x', GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-test' }),
    ).toThrow(/^GOOGLE_OAUTH_CLIENT_ID is not a Google OAuth client id$/);
  });

  it("adds Google's file picker key and project number when both are set", () => {
    const base = { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-test' };
    const define = googleOAuthDefine({
      ...base,
      GOOGLE_PICKER_API_KEY: ' AIza-test ',
      GOOGLE_PICKER_APP_ID: '123456789012',
    });
    expect(JSON.parse(define.__EZYCHAT_GOOGLE_OAUTH__)).toMatchObject({
      pickerApiKey: 'AIza-test',
      pickerAppId: '123456789012',
    });
    expect(() => googleOAuthDefine({ ...base, GOOGLE_PICKER_API_KEY: 'AIza-test' })).toThrow(
      'or neither',
    );
    expect(() =>
      googleOAuthDefine({ ...base, GOOGLE_PICKER_API_KEY: 'k', GOOGLE_PICKER_APP_ID: 'abc' }),
    ).toThrow(/^GOOGLE_PICKER_APP_ID is not a Google Cloud project number$/);
  });
});
