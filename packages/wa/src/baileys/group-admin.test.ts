import type { BinaryNode, GroupMetadata } from 'baileys';
import { describe, expect, it } from 'vitest';
import {
  inviteLink,
  iqErrorCode,
  mapGroupSettings,
  mapJoinRequests,
  mapParticipantEntry,
  pickParticipantEntry,
  settingCalls,
} from './group-admin.js';

const PN = '60123456789@s.whatsapp.net';
const LID = '111222333444555@lid';

/** A `participant` node as Baileys returns it in `content` (recorded shape). */
const participantNode = (
  attrs: Record<string, string>,
  children: BinaryNode[] = [],
): BinaryNode => ({
  tag: 'participant',
  attrs,
  content: children,
});

describe('mapParticipantEntry', () => {
  it('maps 200 to ok', () => {
    expect(mapParticipantEntry(PN, { status: '200', jid: PN })).toEqual({ jid: PN, status: 'ok' });
  });

  it('maps a 403 privacy refusal with add_request to invite_needed (expiration seconds → ms)', () => {
    const content = participantNode({ jid: PN, error: '403' }, [
      { tag: 'add_request', attrs: { code: 'AbC123xyz', expiration: '1762300000' } },
    ]);
    expect(mapParticipantEntry(PN, { status: '403', jid: PN, content })).toEqual({
      jid: PN,
      status: 'invite_needed',
      invite: { code: 'AbC123xyz', expiresAt: 1_762_300_000_000 },
    });
  });

  it('fails closed on a malformed add_request', () => {
    const noExpiry = participantNode({ jid: PN, error: '403' }, [
      { tag: 'add_request', attrs: { code: 'AbC' } },
    ]);
    const noCode = participantNode({ jid: PN, error: '403' }, [
      { tag: 'add_request', attrs: { expiration: '1762300000' } },
    ]);
    expect(mapParticipantEntry(PN, { status: '403', content: noExpiry }).status).toBe('failed');
    expect(mapParticipantEntry(PN, { status: '403', content: noCode }).status).toBe('failed');
  });

  it('maps 403 without an invite and 401 to not_allowed', () => {
    expect(mapParticipantEntry(PN, { status: '403' }).status).toBe('not_allowed');
    expect(
      mapParticipantEntry(PN, { status: '403', content: participantNode({ jid: PN }) }).status,
    ).toBe('not_allowed');
    expect(mapParticipantEntry(PN, { status: '401' }).status).toBe('not_allowed');
  });

  it('maps 409 already, 404 not_member, 500/406 full', () => {
    expect(mapParticipantEntry(PN, { status: '409' }).status).toBe('already');
    expect(mapParticipantEntry(PN, { status: '404' }).status).toBe('not_member');
    expect(mapParticipantEntry(PN, { status: '500' }).status).toBe('full');
    expect(mapParticipantEntry(PN, { status: '406' }).status).toBe('full');
  });

  it('fails closed on unknown codes and missing entries', () => {
    expect(mapParticipantEntry(PN, { status: '408' })).toEqual({ jid: PN, status: 'failed' });
    expect(mapParticipantEntry(PN, {})).toEqual({ jid: PN, status: 'failed' });
    expect(mapParticipantEntry(PN, undefined)).toEqual({ jid: PN, status: 'failed' });
  });

  it('always reports the address that was asked for', () => {
    expect(mapParticipantEntry(PN, { status: '200', jid: LID }).jid).toBe(PN);
  });
});

describe('pickParticipantEntry', () => {
  it('finds the requested person by normalized address', () => {
    const list = [
      { status: '409', jid: '60999999999@s.whatsapp.net' },
      { status: '200', jid: '60123456789:3@s.whatsapp.net' },
    ];
    expect(pickParticipantEntry(PN, list)).toBe(list[1]);
  });

  it('takes a single entry in the other address form', () => {
    const list = [{ status: '200', jid: LID }];
    expect(pickParticipantEntry(PN, list)).toBe(list[0]);
  });

  it('returns nothing for no list, an empty list or several unmatched entries', () => {
    expect(pickParticipantEntry(PN, undefined)).toBeUndefined();
    expect(pickParticipantEntry(PN, [])).toBeUndefined();
    expect(
      pickParticipantEntry(PN, [
        { status: '200', jid: LID },
        { status: '200', jid: '60999999999@s.whatsapp.net' },
      ]),
    ).toBeUndefined();
  });
});

describe('iqErrorCode', () => {
  it('reads the WhatsApp code Baileys puts in Boom data', () => {
    expect(iqErrorCode(Object.assign(new Error('not-authorized'), { data: 401 }))).toBe(401);
    expect(iqErrorCode(new Error('x'))).toBeNull();
    expect(iqErrorCode(Object.assign(new Error('x'), { data: 'nope' }))).toBeNull();
    expect(iqErrorCode(null)).toBeNull();
    expect(iqErrorCode('boom')).toBeNull();
  });
});

describe('inviteLink', () => {
  it('builds the chat.whatsapp.com link from a code', () => {
    expect(inviteLink('Fx1Yz-_9abc')).toBe('https://chat.whatsapp.com/Fx1Yz-_9abc');
  });

  it('throws on a missing or odd code (timed-out query)', () => {
    expect(() => inviteLink(undefined)).toThrow(/no code/);
    expect(() => inviteLink('')).toThrow(/no code/);
    expect(() => inviteLink('a/b')).toThrow(/no code/);
  });
});

describe('mapGroupSettings', () => {
  it('maps announce, restrict, memberAddMode and joinApprovalMode', () => {
    expect(
      mapGroupSettings({
        announce: true,
        restrict: false,
        memberAddMode: true,
        joinApprovalMode: true,
      } as Partial<GroupMetadata>),
    ).toEqual({ announce: true, locked: false, memberAdd: 'all', approval: true });
    expect(
      mapGroupSettings({
        announce: false,
        restrict: true,
        memberAddMode: false,
        joinApprovalMode: false,
      } as Partial<GroupMetadata>),
    ).toEqual({ announce: false, locked: true, memberAdd: 'admins', approval: false });
  });

  it('leaves out what WhatsApp did not send', () => {
    expect(mapGroupSettings({})).toEqual({});
    expect(mapGroupSettings({ announce: true } as Partial<GroupMetadata>)).toEqual({
      announce: true,
    });
  });
});

describe('settingCalls', () => {
  it('turns each setting into its Baileys call in a fixed order', () => {
    expect(
      settingCalls({ approval: true, memberAdd: 'all', locked: true, announce: true }),
    ).toEqual([
      { fn: 'groupSettingUpdate', arg: 'announcement' },
      { fn: 'groupSettingUpdate', arg: 'locked' },
      { fn: 'groupMemberAddMode', arg: 'all_member_add' },
      { fn: 'groupJoinApprovalMode', arg: 'on' },
    ]);
    expect(
      settingCalls({ approval: false, memberAdd: 'admins', locked: false, announce: false }),
    ).toEqual([
      { fn: 'groupSettingUpdate', arg: 'not_announcement' },
      { fn: 'groupSettingUpdate', arg: 'unlocked' },
      { fn: 'groupMemberAddMode', arg: 'admin_add' },
      { fn: 'groupJoinApprovalMode', arg: 'off' },
    ]);
  });

  it('adds nothing for absent or unknown values', () => {
    expect(settingCalls({})).toEqual([]);
    expect(settingCalls({ memberAdd: 'everyone' as never })).toEqual([]);
  });
});

describe('mapJoinRequests', () => {
  it('maps request attributes (time seconds → ms) and the shared phone number', () => {
    expect(
      mapJoinRequests([
        { jid: LID, phone_number: PN, request_method: 'invite_link', request_time: '1762200000' },
        { jid: '60167778888@s.whatsapp.net', request_time: '1762200100' },
        { jid: '222333444555666@lid' },
      ]),
    ).toEqual([
      { jid: LID, phoneJid: PN, at: 1_762_200_000_000 },
      {
        jid: '60167778888@s.whatsapp.net',
        phoneJid: '60167778888@s.whatsapp.net',
        at: 1_762_200_100_000,
      },
      { jid: '222333444555666@lid', phoneJid: null, at: null },
    ]);
  });

  it('drops entries without a usable address and duplicates', () => {
    expect(
      mapJoinRequests([null, {}, { jid: 'garbage' }, { jid: LID }, { jid: LID, t: '1' }]),
    ).toEqual([{ jid: LID, phoneJid: null, at: null }]);
  });

  it('never takes a WhatsApp ID as the phone number', () => {
    expect(mapJoinRequests([{ jid: LID, pn: '999@lid' }])[0]?.phoneJid).toBeNull();
  });

  it('throws on a missing result (timed-out query)', () => {
    expect(() => mapJoinRequests(undefined)).toThrow(/no result/);
  });
});
