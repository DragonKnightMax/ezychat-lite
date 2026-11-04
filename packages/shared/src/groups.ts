import { z } from 'zod';

/** A member of a WhatsApp group as the team sees it. Only what WhatsApp shared; nothing inferred. */
export const GroupMemberSchema = z.object({
  /** The member's address as the group lists it (phone-number JID or WhatsApp ID). */
  jid: z.string(),
  /** Phone number digits (e.g. "60123456789"): from the group, else from the team's own chat; null when unknown. */
  phone: z.string().nullable(),
  /** WhatsApp ID (`…@lid`), when known. */
  lid: z.string().nullable(),
  /** Saved or WhatsApp profile name we already know; null when the member never shared one with us. */
  name: z.string().nullable(),
  /** WhatsApp username, only when WhatsApp sends it. */
  username: z.string().nullable(),
  role: z.enum(['superadmin', 'admin', 'member']),
  /** This WhatsApp number (the linked account). */
  isMe: z.boolean(),
  /** The team's existing direct chat with this person, when there is one. */
  chatJid: z.string().nullable(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const GroupInfoResponse = z.object({
  group: z.object({
    jid: z.string(),
    name: z.string().nullable(),
    description: z.string().nullable(),
    /** epoch ms */
    createdAt: z.number().nullable(),
    createdBy: z
      .object({ jid: z.string(), name: z.string().nullable(), phone: z.string().nullable() })
      .nullable(),
    /** Member count reported by WhatsApp. */
    size: z.number().int().nonnegative(),
    adminCount: z.number().int().nonnegative(),
  }),
  /** Me first, then admins, then named members A–Z, then the rest. */
  members: z.array(GroupMemberSchema),
  /** epoch ms when the list was read from WhatsApp */
  fetchedAt: z.number(),
});
export type GroupInfoResponse = z.infer<typeof GroupInfoResponse>;

export const GroupMemberAboutResponse = z.object({ about: z.string().nullable() });
export type GroupMemberAboutResponse = z.infer<typeof GroupMemberAboutResponse>;

/** POST /chats/:jid/members/:member/chat: the direct chat to open (created when needed). */
export const StartMemberChatResponse = z.object({ chatJid: z.string() });
export type StartMemberChatResponse = z.infer<typeof StartMemberChatResponse>;

/** Fake WhatsApp only: create a group with generated members for tests and the Dev Build. */
export const FakeGroupBody = z.object({
  /** The inbox whose fake phone is in the group (default 1). */
  inboxId: z.number().int().positive().optional(),
  groupJid: z.string().regex(/@g\.us$/),
  name: z.string().min(1).max(200),
  /** How many generated members besides the linked number (and any `members` given). */
  generated: z.number().int().min(0).max(2000).default(0),
  members: z
    .array(
      z.object({
        phone: z
          .string()
          .regex(/^\d{6,15}$/)
          .optional(),
        lid: z
          .string()
          .regex(/^\d{6,20}$/)
          .optional(),
        name: z.string().max(200).optional(),
        username: z.string().max(100).optional(),
        about: z.string().max(500).optional(),
        role: z.enum(['superadmin', 'admin', 'member']).default('member'),
      }),
    )
    .max(200)
    .default([]),
  /** The linked number's role (default superadmin, the creator); `member` = not a group admin. */
  meRole: z.enum(['superadmin', 'admin', 'member']).default('superadmin'),
  description: z.string().max(2048).optional(),
  /** Group settings as WhatsApp reports them (group management). */
  settings: z
    .object({
      announce: z.boolean(),
      locked: z.boolean(),
      memberAdd: z.enum(['admins', 'all']),
      approval: z.boolean(),
    })
    .partial()
    .optional(),
  /** Pending join requests (phone digits). */
  joinRequests: z
    .array(z.string().regex(/^\d{6,15}$/))
    .max(50)
    .default([]),
  /** These numbers refuse direct adds (privacy): adding them answers invite_needed. */
  privacyRefuses: z
    .array(z.string().regex(/^\d{6,15}$/))
    .max(50)
    .default([]),
});
export type FakeGroupBody = z.infer<typeof FakeGroupBody>;

// ---------------------------------------------------------------------------------------------
// Group management (design docs/features/group-management/design.md): an EzyChat admin changes a
// WhatsApp group from Group info, only where the connection supports it (`caps`, never a type name).
// ---------------------------------------------------------------------------------------------

/** WhatsApp's group settings EzyChat can change. */
export const GROUP_SETTING_KEYS = ['announce', 'locked', 'memberAdd', 'approval'] as const;
export const GroupSettingKey = z.enum(GROUP_SETTING_KEYS);
export type GroupSettingKey = z.infer<typeof GroupSettingKey>;

/** Longest group name / description WhatsApp takes (linked phone 100; Business API 128 / 2048). */
export const GROUP_NAME_MAX = 128;
export const GROUP_DESCRIPTION_MAX = 2048;

/** Adds and invites per WhatsApp number (inbox), counted on success. */
export const GROUP_ADD_LIMIT_PER_DAY = 20;
export const GROUP_ADD_LIMIT_PER_HOUR = 6;

/** What this group's connection lets EzyChat change. All false/empty = read-only. */
export const GroupAdminCapsSchema = z.object({
  /** Name and description. */
  editInfo: z.boolean(),
  /** Add a member by phone number. */
  addMembers: z.boolean(),
  /** People join only through the invite link (Business API). */
  inviteOnly: z.boolean(),
  removeMembers: z.boolean(),
  /** Make / remove group admin. */
  admins: z.boolean(),
  /** Read the invite link. */
  inviteLink: z.boolean(),
  resetInviteLink: z.boolean(),
  /** The settings this connection can change (empty: none). */
  settings: z.array(GroupSettingKey),
  /** List and approve / reject join requests. */
  joinRequests: z.boolean(),
  /** Members besides the business number; null = WhatsApp's own limit. */
  maxMembers: z.number().int().positive().nullable(),
  nameMax: z.number().int().positive(),
  descriptionMax: z.number().int().positive(),
});
export type GroupAdminCaps = z.infer<typeof GroupAdminCapsSchema>;

/** Nothing can be changed (no `groupAdmin` capability). */
export const NO_GROUP_ADMIN_CAPS: GroupAdminCaps = Object.freeze({
  editInfo: false,
  addMembers: false,
  inviteOnly: false,
  removeMembers: false,
  admins: false,
  inviteLink: false,
  resetInviteLink: false,
  settings: [],
  joinRequests: false,
  maxMembers: null,
  nameMax: 100,
  descriptionMax: GROUP_DESCRIPTION_MAX,
}) as GroupAdminCaps;

export const GroupSettingsSchema = z.object({
  /** Only admins can send messages. */
  announce: z.boolean(),
  /** Only admins can edit the group name, photo and description. */
  locked: z.boolean(),
  /** Who can add members. */
  memberAdd: z.enum(['admins', 'all']),
  /** New members need an admin's approval. */
  approval: z.boolean(),
});
export type GroupSettings = z.infer<typeof GroupSettingsSchema>;

/** Someone asking to join (approval on). Only what WhatsApp shared; names from known contacts. */
export const GroupJoinRequestSchema = z.object({
  jid: z.string(),
  phone: z.string().nullable(),
  name: z.string().nullable(),
  /** epoch ms, null when WhatsApp gave no time */
  at: z.number().nullable(),
});
export type GroupJoinRequest = z.infer<typeof GroupJoinRequestSchema>;

export const GROUP_CHANGE_ACTIONS = [
  'rename',
  'description',
  'member_add',
  'member_invite',
  'member_remove',
  'admin_promote',
  'admin_demote',
  'invite_reset',
  'setting',
  'join_approve',
  'join_reject',
] as const;
export const GroupChangeAction = z.enum(GROUP_CHANGE_ACTIONS);
export type GroupChangeAction = z.infer<typeof GroupChangeAction>;

/** A change made in EzyChat (from the audit log; changes made on the phone are not listed in v1). */
export const GroupChangeSchema = z.object({
  /** epoch ms */
  at: z.number(),
  byUserId: z.number().int().nullable(),
  /** The teammate's current display name; null when the user is gone. */
  byName: z.string().nullable(),
  action: GroupChangeAction,
  /** The member it was about (JID), when any. */
  memberJid: z.string().nullable(),
  /** That member's name or number resolved now; never stored with the change. */
  memberName: z.string().nullable(),
  /** `setting` only: which one and its new value. */
  setting: GroupSettingKey.nullable().default(null),
  value: z
    .union([z.boolean(), z.enum(['admins', 'all'])])
    .nullable()
    .default(null),
});
export type GroupChange = z.infer<typeof GroupChangeSchema>;

/**
 * GET /api/chats/:jid/group (any user with access to the inbox). Admin-only parts (`inviteLink`,
 * `requests`, `changes`) are empty / null for agents.
 */
export const GroupAdminResponse = z.object({
  caps: GroupAdminCapsSchema,
  /** The signed-in user may change groups (an EzyChat admin). */
  canManage: z.boolean(),
  /** WhatsApp of this inbox is connected (changes are never queued). */
  online: z.boolean(),
  /** The linked number's role in the group; null when unknown (offline) or not a member. */
  myRole: z.enum(['superadmin', 'admin', 'member']).nullable(),
  /** Current settings (only those the connection reports). */
  settings: GroupSettingsSchema.partial(),
  inviteLink: z.string().nullable(),
  requests: z.array(GroupJoinRequestSchema),
  changes: z.array(GroupChangeSchema),
  /** Member count reported by WhatsApp; null when unknown. */
  size: z.number().int().nonnegative().nullable(),
});
export type GroupAdminResponse = z.infer<typeof GroupAdminResponse>;

/** PATCH /api/chats/:jid/group: name and/or description ('' clears the description). */
export const EditGroupBody = z
  .object({
    name: z.string().trim().min(1).max(GROUP_NAME_MAX).optional(),
    description: z.string().max(GROUP_DESCRIPTION_MAX).optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined, {
    message: 'Nothing to change',
  });
export type EditGroupBody = z.infer<typeof EditGroupBody>;

/** POST /api/chats/:jid/group/members: exactly one number (digits with country code, no +). */
export const AddGroupMemberBody = z.object({ phone: z.string().regex(/^\d{8,15}$/) });
export type AddGroupMemberBody = z.infer<typeof AddGroupMemberBody>;

export const AddGroupMemberResponse = z.object({
  /** `invite_needed`: the person's privacy settings refused the add; offer Send invite. */
  result: z.enum(['added', 'invite_needed']),
  memberJid: z.string(),
});
export type AddGroupMemberResponse = z.infer<typeof AddGroupMemberResponse>;

/** POST /api/chats/:jid/group/members/:member/invite (after `invite_needed`). */
export const SendGroupInviteResponse = z.object({ result: z.literal('sent') });
export type SendGroupInviteResponse = z.infer<typeof SendGroupInviteResponse>;

/** PUT /api/chats/:jid/group/members/:member/role */
export const SetGroupMemberRoleBody = z.object({ admin: z.boolean() });
export type SetGroupMemberRoleBody = z.infer<typeof SetGroupMemberRoleBody>;

/** POST /api/chats/:jid/group/invite-link/reset */
export const GroupInviteLinkResponse = z.object({ inviteLink: z.string() });
export type GroupInviteLinkResponse = z.infer<typeof GroupInviteLinkResponse>;

/** PUT /api/chats/:jid/group/settings: at least one setting. */
export const GroupSettingsBody = GroupSettingsSchema.partial().refine(
  (b) => Object.values(b).some((v) => v !== undefined),
  { message: 'Nothing to change' },
);
export type GroupSettingsBody = z.infer<typeof GroupSettingsBody>;

/** POST /api/chats/:jid/group/requests/:member */
export const GroupJoinDecisionBody = z.object({ approve: z.boolean() });
export type GroupJoinDecisionBody = z.infer<typeof GroupJoinDecisionBody>;

/** Successful change answers (PATCH, DELETE, PUT role/settings, join decisions). */
export const GroupChangeOkResponse = z.object({ ok: z.literal(true) });
export type GroupChangeOkResponse = z.infer<typeof GroupChangeOkResponse>;

/**
 * Error codes of the group-management routes (body `{ error }`): 409 not_group_admin, not_supported,
 * already_member, not_member, cannot_change_owner, group_full, invite_expired, inbox_removed; 422
 * not_on_whatsapp; 429 too_many_adds, rate_limited; 503 wa_unavailable; 502 group_change_failed.
 */
export const GROUP_ADMIN_ERRORS = [
  'not_group_admin',
  'not_supported',
  'already_member',
  'not_member',
  'cannot_change_owner',
  'group_full',
  'invite_expired',
  'not_on_whatsapp',
  'too_many_adds',
  'rate_limited',
  'wa_unavailable',
  'group_change_failed',
] as const;
export type GroupAdminError = (typeof GROUP_ADMIN_ERRORS)[number];

/** Socket `group:changed`: the group was changed (here or on WhatsApp); refetch Group info. */
export const GroupChangedPayload = z.object({ chatJid: z.string() });
export type GroupChangedPayload = z.infer<typeof GroupChangedPayload>;
