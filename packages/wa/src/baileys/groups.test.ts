import type { GroupMetadata } from 'baileys';
import { describe, expect, it } from 'vitest';
import { aboutFromStatusResult, mapGroupMetadata } from './groups.js';

const meta = (over: Partial<GroupMetadata> = {}): GroupMetadata =>
  ({
    id: '120363000000000001@g.us',
    subject: 'SME Founders',
    desc: 'Weekly meetup',
    creation: 1_710_200_000,
    owner: '111222333444555@lid',
    ownerPn: '60161112222@s.whatsapp.net',
    size: 965,
    participants: [],
    ...over,
  }) as GroupMetadata;

describe('mapGroupMetadata', () => {
  it('maps group details and keeps WhatsApp’s member count', () => {
    const g = mapGroupMetadata(meta());
    expect(g).toMatchObject({
      jid: '120363000000000001@g.us',
      name: 'SME Founders',
      description: 'Weekly meetup',
      createdAt: 1_710_200_000_000,
      ownerJid: '111222333444555@lid',
      size: 965,
    });
  });

  it('maps phone-number and WhatsApp ID members, roles and usernames', () => {
    const g = mapGroupMetadata(
      meta({
        participants: [
          { id: '60123456789@s.whatsapp.net', lid: '999888777666555@lid', admin: 'superadmin' },
          { id: '111222333444555@lid', phoneNumber: '60167778888@s.whatsapp.net', admin: 'admin' },
          { id: '222333444555666@lid', username: 'acikwowo', admin: null },
          { id: '60123456789:12@s.whatsapp.net' },
        ] as GroupMetadata['participants'],
      }),
    );
    expect(g.participants).toEqual([
      {
        jid: '60123456789@s.whatsapp.net',
        phoneJid: '60123456789@s.whatsapp.net',
        lidJid: '999888777666555@lid',
        username: null,
        role: 'superadmin',
      },
      {
        jid: '111222333444555@lid',
        phoneJid: '60167778888@s.whatsapp.net',
        lidJid: '111222333444555@lid',
        username: null,
        role: 'admin',
      },
      {
        jid: '222333444555666@lid',
        phoneJid: null,
        lidJid: '222333444555666@lid',
        username: 'acikwowo',
        role: 'member',
      },
    ]);
  });

  it('never reports fewer members than it lists, and tolerates missing fields', () => {
    const g = mapGroupMetadata(
      meta({
        subject: '',
        desc: undefined,
        creation: undefined,
        owner: undefined,
        ownerPn: undefined,
        size: undefined,
        participants: [{ id: '60123456789@s.whatsapp.net' }] as GroupMetadata['participants'],
      }),
    );
    expect(g).toMatchObject({
      name: null,
      description: null,
      createdAt: null,
      ownerJid: null,
      size: 1,
    });
    expect(g.settings).toEqual({});
  });

  it('maps the group settings WhatsApp reports', () => {
    const g = mapGroupMetadata(
      meta({ announce: true, restrict: true, memberAddMode: false, joinApprovalMode: true }),
    );
    expect(g.settings).toEqual({
      announce: true,
      locked: true,
      memberAdd: 'admins',
      approval: true,
    });
  });
});

it('falls back to the creator’s number only when WhatsApp gives no WhatsApp ID', () => {
  expect(mapGroupMetadata(meta({ owner: undefined })).ownerJid).toBe('60161112222@s.whatsapp.net');
});

describe('aboutFromStatusResult', () => {
  it('returns the About text, or null when hidden or unset', () => {
    expect(
      aboutFromStatusResult([{ id: 'x', status: { status: 'Busy', setAt: new Date() } }]),
    ).toBe('Busy');
    expect(
      aboutFromStatusResult([{ id: 'x', status: { status: '', setAt: new Date() } }]),
    ).toBeNull();
    expect(aboutFromStatusResult([{ id: 'x', status: { status: null } }])).toBeNull();
  });

  it('treats a missing result (a timed-out query) as a failure, not as no About', () => {
    expect(() => aboutFromStatusResult(undefined)).toThrow();
  });
});
