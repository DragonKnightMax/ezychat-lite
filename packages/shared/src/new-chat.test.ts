import { describe, expect, it } from 'vitest';
import {
  NewChatBody,
  NewChatCheckResponse,
  NewChatSettingsBody,
  NewChatStatus,
  countryCodeOf,
  normalizeLocalPhone,
} from './index.js';

describe('normalizeLocalPhone', () => {
  it.each([
    ['012-345 6789', '60123456789'],
    ['011-2345 6789', '601123456789'],
    ['+60 12-345 6789', '60123456789'],
    ['60 12 345 6789', '60123456789'],
    ['0060123456789', '60123456789'],
    ['(012) 345.6789', '60123456789'],
    ['+65 9123 4567', '6591234567'],
    ['+44 20 7946 0958', '442079460958'],
  ])('reads %s as %s', (raw, digits) => {
    expect(normalizeLocalPhone(raw)).toBe(digits);
  });

  it('gives a local number the inbox country', () => {
    expect(normalizeLocalPhone('09123 4567', '65')).toBe('6591234567');
  });

  it.each([
    '',
    '12345',
    'abc',
    '012-345 6789 ext 2',
    '+0 123 456 789',
    '6012345',
    '60123456789012',
    '+1234567890123456',
  ])('refuses %j', (raw) => {
    expect(normalizeLocalPhone(raw)).toBeNull();
  });
});

describe('countryCodeOf', () => {
  it.each([
    ['60123456789', '60'],
    ['6591234567', '65'],
    ['12025550123', '1'],
    ['85291234567', '852'],
    ['8613812345678', '86'],
    ['6281234567890', '62'],
    ['919812345678', '91'],
  ])('%s → %s', (digits, code) => {
    expect(countryCodeOf(digits)).toBe(code);
  });

  it('answers null for an unknown prefix', () => {
    expect(countryCodeOf('999')).toBeNull();
  });
});

describe('new chat contract', () => {
  it('accepts a status and refuses a bad daily limit', () => {
    const status = {
      allowed: true,
      staffEnabled: false,
      dailyLimit: 0,
      perUserPerHour: 5,
      inboxes: [{ inboxId: 1, mode: 'check', usedToday: 3, countryCode: '60' }],
    };
    expect(NewChatStatus.parse(status)).toEqual(status);
    expect(NewChatStatus.safeParse({ ...status, dailyLimit: 1001 }).success).toBe(false);
    expect(NewChatSettingsBody.safeParse({ dailyLimit: -1 }).success).toBe(false);
    expect(NewChatSettingsBody.safeParse({ dailyLimit: 1.5 }).success).toBe(false);
    expect(NewChatSettingsBody.safeParse({ other: true }).success).toBe(false);
    expect(NewChatSettingsBody.parse({ staffEnabled: true, dailyLimit: 0 })).toEqual({
      staffEnabled: true,
      dailyLimit: 0,
    });
  });

  it('parses the check answers and the start body', () => {
    expect(
      NewChatCheckResponse.parse({ next: 'existing', phone: '60123456789', chatJid: 'x' }).next,
    ).toBe('existing');
    expect(NewChatCheckResponse.safeParse({ next: 'existing', phone: '1' }).success).toBe(false);
    const body = NewChatBody.parse({
      phone: ' 012-345 6789 ',
      name: '  Farah ',
      clientRequestId: '6f1c2c1e-5b0a-4f7e-9a39-3f7d2d1f0a11',
      template: { name: 'order_update', language: 'en' },
    });
    expect(body).toMatchObject({ phone: '012-345 6789', name: 'Farah', template: { params: [] } });
    expect(NewChatBody.safeParse({ phone: '1', clientRequestId: 'nope' }).success).toBe(false);
  });
});
