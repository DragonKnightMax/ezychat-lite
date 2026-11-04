import { describe, expect, it } from 'vitest';
import {
  AddGroupMemberBody,
  EditGroupBody,
  FakeGroupBody,
  GroupChangeSchema,
  GroupSettingsBody,
  NO_GROUP_ADMIN_CAPS,
  GroupAdminCapsSchema,
} from './groups.js';

describe('group management contract', () => {
  it('edit needs a name or a description and trims the name', () => {
    expect(EditGroupBody.safeParse({}).success).toBe(false);
    expect(EditGroupBody.parse({ name: '  Team  ' })).toEqual({ name: 'Team' });
    expect(EditGroupBody.safeParse({ name: '   ' }).success).toBe(false);
    expect(EditGroupBody.parse({ description: '' })).toEqual({ description: '' });
    expect(EditGroupBody.safeParse({ name: 'x'.repeat(129) }).success).toBe(false);
  });

  it('add takes exactly one number of digits', () => {
    expect(AddGroupMemberBody.safeParse({ phone: '60123456789' }).success).toBe(true);
    expect(AddGroupMemberBody.safeParse({ phone: '+60123456789' }).success).toBe(false);
    expect(AddGroupMemberBody.safeParse({ phone: ['60123456789'] }).success).toBe(false);
  });

  it('settings need at least one value', () => {
    expect(GroupSettingsBody.safeParse({}).success).toBe(false);
    expect(GroupSettingsBody.parse({ announce: true })).toEqual({ announce: true });
    expect(GroupSettingsBody.safeParse({ memberAdd: 'everyone' }).success).toBe(false);
  });

  it('a change defaults setting and value to null', () => {
    expect(
      GroupChangeSchema.parse({
        at: 1,
        byUserId: 1,
        byName: 'A',
        action: 'rename',
        memberJid: null,
        memberName: null,
      }),
    ).toMatchObject({ setting: null, value: null });
  });

  it('read-only caps parse and change nothing', () => {
    const caps = GroupAdminCapsSchema.parse(NO_GROUP_ADMIN_CAPS);
    expect(Object.entries(caps).filter(([, v]) => v === true)).toEqual([]);
    expect(caps.settings).toEqual([]);
  });

  it('the fake group defaults the linked number to the creator', () => {
    const b = FakeGroupBody.parse({ groupJid: '1@g.us', name: 'G' });
    expect(b).toMatchObject({ meRole: 'superadmin', joinRequests: [], privacyRefuses: [] });
  });
});
