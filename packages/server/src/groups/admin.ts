import {
  GROUP_ADD_LIMIT_PER_DAY,
  GROUP_ADD_LIMIT_PER_HOUR,
  GROUP_ADMIN_ERRORS,
  GROUP_CHANGE_ACTIONS,
  GROUP_SETTING_KEYS,
  NO_GROUP_ADMIN_CAPS,
  type AddGroupMemberResponse,
  type EditGroupBody,
  type GroupAdminCaps,
  type GroupAdminError,
  type GroupAdminResponse,
  type GroupChange,
  type GroupChangeAction,
  type GroupJoinRequest,
  type GroupSettingKey,
  type GroupSettingsBody,
} from '@ezychat/shared';
import {
  WaUnavailableError,
  normalizeContactJid,
  type WaAdapter,
  type WaGroupInfo,
  type WaGroupInvite,
  type WaGroupParticipant,
  type WaGroupSettings,
  type WaParticipantResult,
} from '@ezychat/wa';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { HttpError, errors } from '../http/errors.js';
import { WindowLimiter } from '../http/window-limiter.js';
import { getAliases } from '../chats/aliases.js';
import { jidUser } from '../chats/repo.js';
import { capabilitiesOf } from '../inboxes/types.js';
import { PRIMARY_INBOX_ID, parseChatKey } from '../inboxes/keys.js';
import { getChats } from '../wa-bridge/index.js';
import type { GroupService } from './service.js';

/** Remove / make admin / remove as admin per user and minute. */
export const GROUP_MEMBER_CHANGES_PER_MINUTE = 30;
/** Rename, description, settings, link reset and join decisions per user and minute. */
export const GROUP_EDITS_PER_MINUTE = 10;
/** Changes listed in Recent changes. */
export const GROUP_CHANGES_LISTED = 20;
const MAX_STORED_INVITES = 500;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface GroupActor {
  userId: number;
  ip: string | null;
}

/**
 * Group management (design docs/features/group-management/design.md). Every method takes a chat key
 * the caller already checked for inbox access. Mutations run the same checks in order: removed
 * inbox, capability, connection, the linked number is a group admin, the target member, the rate
 * limit, then exactly one WhatsApp call. Audit rows carry ids, setting values and results only.
 */
export interface GroupAdminService {
  state(groupKey: string, viewer: { isAdmin: boolean }): Promise<GroupAdminResponse>;
  edit(groupKey: string, body: EditGroupBody, actor: GroupActor): Promise<void>;
  addMember(groupKey: string, phone: string, actor: GroupActor): Promise<AddGroupMemberResponse>;
  sendInvite(groupKey: string, member: string, actor: GroupActor): Promise<void>;
  removeMember(groupKey: string, member: string, actor: GroupActor): Promise<void>;
  setRole(groupKey: string, member: string, admin: boolean, actor: GroupActor): Promise<void>;
  resetInviteLink(groupKey: string, actor: GroupActor): Promise<string>;
  setSettings(groupKey: string, body: GroupSettingsBody, actor: GroupActor): Promise<void>;
  decideJoin(groupKey: string, member: string, approve: boolean, actor: GroupActor): Promise<void>;
}

type AdminMethod =
  | 'setGroupSubject'
  | 'setGroupDescription'
  | 'updateGroupMembers'
  | 'sendGroupInvite'
  | 'getGroupInviteLink'
  | 'resetGroupInviteLink'
  | 'setGroupSettings'
  | 'listGroupJoinRequests'
  | 'decideGroupJoinRequest';

const has = (wa: WaAdapter, m: AdminMethod) => typeof wa[m] === 'function';

/**
 * What EzyChat may change in groups of this connection: its declared `groupAdmin`, each flag only
 * while the adapter has the method behind it (an edition may spread the linked-phone capabilities
 * without implementing them), and nothing for a connection without groups.
 */
export function groupAdminCaps(wa: WaAdapter | null): GroupAdminCaps {
  const none = { ...NO_GROUP_ADMIN_CAPS, settings: [] };
  if (!wa) return none;
  const c = capabilitiesOf(wa);
  const g = c.groupAdmin;
  if (!c.groups || !g) return none;
  const members = has(wa, 'updateGroupMembers');
  return {
    editInfo: g.editInfo && has(wa, 'setGroupSubject') && has(wa, 'setGroupDescription'),
    addMembers: g.addMembers && members,
    inviteOnly: g.inviteOnly,
    removeMembers: g.removeMembers && members,
    admins: g.admins && members,
    inviteLink: g.inviteLink && has(wa, 'getGroupInviteLink'),
    resetInviteLink: g.resetInviteLink && has(wa, 'resetGroupInviteLink'),
    settings: has(wa, 'setGroupSettings')
      ? GROUP_SETTING_KEYS.filter((k) => g.settings.includes(k))
      : [],
    joinRequests:
      g.joinRequests && has(wa, 'listGroupJoinRequests') && has(wa, 'decideGroupJoinRequest'),
    maxMembers: g.maxMembers,
    nameMax: g.nameMax,
    descriptionMax: g.descriptionMax,
  };
}

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const notSupported = () =>
  conflict('not_supported', 'This WhatsApp connection cannot make this change');
const notGroupAdmin = () =>
  conflict('not_group_admin', 'Your WhatsApp number is not an admin of this group');
const notMember = () => conflict('not_member', 'This person is not in the group');
const changeFailed = () =>
  new HttpError(502, 'group_change_failed', 'WhatsApp did not make this change');

/** Natural status of each group-management error code an adapter may throw as `err.code`. */
const ADAPTER_ERROR_STATUS: Record<GroupAdminError, number> = {
  not_group_admin: 409,
  not_supported: 409,
  already_member: 409,
  not_member: 409,
  cannot_change_owner: 409,
  group_full: 409,
  invite_expired: 409,
  not_on_whatsapp: 422,
  too_many_adds: 429,
  rate_limited: 429,
  wa_unavailable: 503,
  group_change_failed: 502,
};

/**
 * A thrown adapter error as an answer: a `GROUP_ADMIN_ERRORS` code passes through with its status
 * (e.g. the Business API adapter), offline is 503, WhatsApp's 401/403 refusal (Baileys Boom `data`
 * or `output.statusCode`) is not_group_admin, anything else 502.
 */
export function adapterError(err: unknown): HttpError {
  if (err instanceof WaUnavailableError) return errors.waUnavailable();
  const e = (err ?? {}) as { code?: unknown; data?: unknown; output?: { statusCode?: unknown } };
  if (typeof e.code === 'string' && (GROUP_ADMIN_ERRORS as readonly string[]).includes(e.code)) {
    const c = e.code as GroupAdminError;
    if (c === 'wa_unavailable') return errors.waUnavailable();
    if (c === 'rate_limited') return errors.rateLimited(60);
    return new HttpError(ADAPTER_ERROR_STATUS[c], c, messageOf(c));
  }
  const status = e.data ?? e.output?.statusCode;
  if (status === 401 || status === 403) return notGroupAdmin();
  return changeFailed();
}

const MESSAGES: Partial<Record<GroupAdminError, string>> = {
  not_group_admin: 'Your WhatsApp number is not an admin of this group',
  not_supported: 'This WhatsApp connection cannot make this change',
  already_member: 'This person is already in the group',
  not_member: 'This person is not in the group',
  cannot_change_owner: 'The group creator cannot be changed',
  group_full: 'This group is full',
  invite_expired: 'Add this person again to get a new invite',
  not_on_whatsapp: 'This number is not on WhatsApp',
  too_many_adds: 'This WhatsApp number added or invited too many people',
};
const messageOf = (c: GroupAdminError) => MESSAGES[c] ?? 'WhatsApp did not make this change';

const isGroupAdmin = (p: WaGroupParticipant | null) =>
  p?.role === 'admin' || p?.role === 'superadmin';

function memberJidParam(member: string): string {
  const jid = normalizeContactJid(member);
  if (!jid) throw errors.validation('member: not a WhatsApp number or ID');
  return jid;
}

/** Per-person refusals of a member change, as answers. */
function participantError(r: WaParticipantResult | undefined): HttpError {
  switch (r?.status) {
    case 'already':
      return conflict('already_member', 'This person is already in the group');
    case 'not_member':
      return notMember();
    case 'not_allowed':
      return notGroupAdmin();
    case 'full':
      return conflict('group_full', 'This group is full');
    default:
      return changeFailed();
  }
}

const MEMBER_AUDIT_ACTION: Record<'remove' | 'promote' | 'demote', GroupChangeAction> = {
  remove: 'member_remove',
  promote: 'admin_promote',
  demote: 'admin_demote',
};

export function createGroupAdminService(
  ctx: AppContext,
  groups: GroupService,
  deps?: { now?: () => number },
): GroupAdminService {
  const now = deps?.now ?? Date.now;
  const log = ctx.log.child({ mod: 'groups' });
  const memberLimiter = new WindowLimiter({
    windowMs: 60_000,
    max: GROUP_MEMBER_CHANGES_PER_MINUTE,
    now,
  });
  const editLimiter = new WindowLimiter({ windowMs: 60_000, max: GROUP_EDITS_PER_MINUTE, now });
  /** Private invites from `invite_needed` adds, by `inboxId|groupJid|memberJid`, until they expire. */
  const invites = new Map<string, WaGroupInvite>();
  /** Adds / invites under way per inbox: they hold a slot of the limit until they finish. */
  const pendingAdds = new Map<number, number>();

  const removed = (inboxId: number): boolean => {
    if (inboxId === PRIMARY_INBOX_ID) return false;
    const row = ctx.inboxes.repo.get(inboxId);
    return !row || row.removed_at !== null;
  };

  const adapterOf = (inboxId: number): WaAdapter | null => {
    try {
      return ctx.inboxes.connections.adapter(inboxId);
    } catch {
      return null;
    }
  };

  function where(groupKey: string): { inboxId: number; groupJid: string } {
    let parsed: { inboxId: number; waJid: string };
    try {
      parsed = parseChatKey(groupKey);
    } catch {
      throw errors.notFound('Group');
    }
    const chat = getChats(ctx).get(groupKey);
    if (chat?.type !== 'group') throw errors.notFound('Group');
    return { inboxId: parsed.inboxId, groupJid: parsed.waJid };
  }

  interface Checked {
    inboxId: number;
    groupJid: string;
    wa: WaAdapter;
    caps: GroupAdminCaps;
    info: WaGroupInfo;
  }

  /** Steps 1–4 of every change: removed inbox, capability, connection, our admin role. */
  async function check(groupKey: string, allowed: (caps: GroupAdminCaps) => boolean) {
    const { inboxId, groupJid } = where(groupKey);
    if (removed(inboxId)) throw conflict('inbox_removed', 'This inbox was removed');
    const wa = adapterOf(inboxId);
    const caps = groupAdminCaps(wa);
    if (!wa || !allowed(caps)) throw notSupported();
    if (wa.status.state !== 'open') throw errors.waUnavailable();
    const info = await groups.rawInfo(groupKey);
    if (!isGroupAdmin(groups.me(groupKey, info))) throw notGroupAdmin();
    return { inboxId, groupJid, wa, caps, info } satisfies Checked;
  }

  /** The member a change is about, by any of its JIDs (and the phone/WhatsApp ID pairs we know). */
  function findMember(info: WaGroupInfo, jid: string): WaGroupParticipant | null {
    const want = new Set([jid, ...getAliases(ctx).group(jid)]);
    return (
      info.participants.find((p) =>
        [p.jid, p.phoneJid, p.lidJid].some((j) => !!j && want.has(j)),
      ) ?? null
    );
  }

  function limit(limiter: WindowLimiter, actor: GroupActor): void {
    const r = limiter.hit(String(actor.userId));
    if (!r.allowed) throw errors.rateLimited(r.retryAfterSec);
  }

  /** Successful adds and sent invites of an inbox since `since` (from the audit log: survives restarts). */
  function addsSince(inboxId: number, since: number): number {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log
          WHERE action IN ('group.member_add', 'group.member_invite') AND at >= ?
            AND json_extract(meta, '$.inboxId') = ?
            AND json_extract(meta, '$.result') IN ('added', 'sent')`,
      )
      .get(since, inboxId) as { n: number };
    return row.n;
  }

  /**
   * Reserve one add/invite slot of the inbox (synchronously with the check, so two requests in
   * flight cannot both take the last one); the caller releases it when the WhatsApp call ends.
   */
  function reserveAdd(inboxId: number): () => void {
    const pending = pendingAdds.get(inboxId) ?? 0;
    const t = now();
    const hour = addsSince(inboxId, t - HOUR_MS) + pending;
    const day = addsSince(inboxId, t - DAY_MS) + pending;
    if (day >= GROUP_ADD_LIMIT_PER_DAY || hour >= GROUP_ADD_LIMIT_PER_HOUR) {
      log.info({ inboxId, hour, day }, 'group add limit reached');
      throw new HttpError(
        429,
        'too_many_adds',
        day >= GROUP_ADD_LIMIT_PER_DAY
          ? 'This WhatsApp number added or invited 20 people today'
          : 'This WhatsApp number added or invited 6 people in the last hour',
        { 'retry-after': String(day >= GROUP_ADD_LIMIT_PER_DAY ? 3600 : 600) },
      );
    }
    pendingAdds.set(inboxId, pending + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (pendingAdds.get(inboxId) ?? 1) - 1;
      if (n <= 0) pendingAdds.delete(inboxId);
      else pendingAdds.set(inboxId, n);
    };
  }

  /** One WhatsApp call: offline stays 503, anything else is logged and answered 502. */
  async function call<T>(action: string, fn: () => Promise<T>): Promise<T> {
    const t0 = now();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const mapped = adapterError(err);
      log.warn({ action, result: mapped.code, ms: now() - t0 }, 'group change failed');
      throw mapped;
    }
  }

  function record(
    c: Pick<Checked, 'inboxId'>,
    groupKey: string,
    actor: GroupActor,
    action: GroupChangeAction,
    meta: {
      memberJid?: string;
      setting?: GroupSettingKey;
      value?: boolean | string;
      result: string;
    },
    t0: number,
  ): void {
    audit(ctx.db, {
      userId: actor.userId,
      action: `group.${action}`,
      ip: actor.ip,
      meta: { chatJid: groupKey, inboxId: c.inboxId, ...meta },
    });
    log.info({ action, result: meta.result, ms: now() - t0 }, 'group change');
  }

  /** After a change: read the member list again and tell open panels. */
  function changed(groupKey: string): void {
    groups.invalidate(groupKey);
    ctx.bus.emit('group:changed', { chatJid: groupKey });
  }

  function memberName(inboxId: number, jid: string, names: Map<string, string>): string | null {
    const aliases = getAliases(ctx);
    for (const j of [jid, ...aliases.group(jid)]) {
      const n = names.get(j);
      if (n) return n;
    }
    const chat = getChats(ctx).get(aliases.route(inboxId, jid));
    if (chat?.type === 'dm' && chat.name && chat.name !== jidUser(chat.jid)) return chat.name;
    return jid.endsWith('@s.whatsapp.net') ? `+${jidUser(jid)}` : null;
  }

  function changes(groupKey: string, inboxId: number): GroupChange[] {
    const rows = ctx.db
      .prepare(
        `SELECT a.user_id, a.action, a.meta, a.at, u.display_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.action LIKE 'group.%' AND json_extract(a.meta, '$.chatJid') = ?
          ORDER BY a.at DESC, a.id DESC LIMIT ?`,
      )
      .all(groupKey, GROUP_CHANGES_LISTED) as Array<{
      user_id: number | null;
      action: string;
      meta: string;
      at: number;
      display_name: string | null;
    }>;
    const parsed = rows.flatMap((r) => {
      const action = r.action.slice('group.'.length) as GroupChangeAction;
      if (!GROUP_CHANGE_ACTIONS.includes(action)) return [];
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(r.meta) as Record<string, unknown>;
      } catch {
        /* a row we cannot read lists without its details */
      }
      return [{ r, action, meta }];
    });
    const memberJids = parsed
      .map((p) => p.meta.memberJid)
      .filter((j): j is string => typeof j === 'string');
    const aliases = getAliases(ctx);
    const names = groups.knownNames([...new Set(memberJids.flatMap((j) => aliases.group(j)))]);
    return parsed.map(({ r, action, meta }) => {
      const member = typeof meta.memberJid === 'string' ? meta.memberJid : null;
      const setting =
        typeof meta.setting === 'string' &&
        (GROUP_SETTING_KEYS as readonly string[]).includes(meta.setting)
          ? (meta.setting as GroupSettingKey)
          : null;
      const value =
        typeof meta.value === 'boolean' || meta.value === 'admins' || meta.value === 'all'
          ? meta.value
          : null;
      return {
        at: r.at,
        byUserId: r.user_id,
        byName: r.display_name,
        action,
        memberJid: member,
        memberName: member ? memberName(inboxId, member, names) : null,
        setting,
        value,
      };
    });
  }

  async function requests(
    groupKey: string,
    groupJid: string,
    wa: WaAdapter,
  ): Promise<GroupJoinRequest[]> {
    try {
      const list = await wa.listGroupJoinRequests!(groupJid);
      const names = groups.knownNames(
        list.flatMap((r) => [r.jid, r.phoneJid].filter((j): j is string => !!j)),
      );
      return list.map((r) => {
        const phoneJid = r.phoneJid ?? (r.jid.endsWith('@s.whatsapp.net') ? r.jid : null);
        return {
          jid: r.jid,
          phone: phoneJid ? jidUser(phoneJid) : null,
          name: names.get(r.jid) ?? (r.phoneJid ? names.get(r.phoneJid) : undefined) ?? null,
          at: r.at,
        };
      });
    } catch (err) {
      log.warn({ err, chatJid: groupKey }, 'group join requests unavailable');
      return [];
    }
  }

  const settingsOf = (info: WaGroupInfo | null): Partial<WaGroupSettings> => {
    const out: Partial<WaGroupSettings> = {};
    const s = info?.settings;
    if (!s) return out;
    if (typeof s.announce === 'boolean') out.announce = s.announce;
    if (typeof s.locked === 'boolean') out.locked = s.locked;
    if (s.memberAdd === 'admins' || s.memberAdd === 'all') out.memberAdd = s.memberAdd;
    if (typeof s.approval === 'boolean') out.approval = s.approval;
    return out;
  };

  /** Steps 5–7 of remove / promote / demote. */
  async function changeMember(
    groupKey: string,
    member: string,
    action: 'remove' | 'promote' | 'demote',
    actor: GroupActor,
  ): Promise<void> {
    const memberJid = memberJidParam(member);
    const c = await check(groupKey, (caps) =>
      action === 'remove' ? caps.removeMembers : caps.admins,
    );
    const p = findMember(c.info, memberJid);
    if (!p) throw notMember();
    if (p.role === 'superadmin')
      throw conflict('cannot_change_owner', 'The group creator cannot be changed');
    if (groups.me(groupKey, c.info) === p)
      throw conflict('not_supported', 'Your own number cannot be changed here');
    limit(memberLimiter, actor);
    const t0 = now();
    const [r] = await call(action, () => c.wa.updateGroupMembers!(c.groupJid, [p.jid], action));
    const auditAction = MEMBER_AUDIT_ACTION[action];
    if (r?.status === 'already' && action !== 'remove') {
      log.info({ action: auditAction, result: 'already', ms: now() - t0 }, 'group change');
      return;
    }
    if (r?.status !== 'ok') {
      log.info(
        { action: auditAction, result: r?.status ?? 'none', ms: now() - t0 },
        'group change',
      );
      throw participantError(r);
    }
    record(c, groupKey, actor, auditAction, { memberJid: p.jid, result: 'ok' }, t0);
    changed(groupKey);
  }

  const service: GroupAdminService = {
    async state(groupKey, viewer) {
      const { inboxId, groupJid } = where(groupKey);
      const wa = removed(inboxId) ? null : adapterOf(inboxId);
      const caps = groupAdminCaps(wa);
      const online = wa?.status.state === 'open';
      let info: WaGroupInfo | null = null;
      if (wa) {
        // the cached list answers while offline; no list = role and settings unknown
        info = await groups.rawInfo(groupKey).catch(() => null);
      }
      const me = info ? groups.me(groupKey, info) : null;
      const myRole = me?.role ?? null;
      let inviteLink: string | null = null;
      let joinRequests: GroupJoinRequest[] = [];
      if (viewer.isAdmin && wa && online && isGroupAdmin(me)) {
        if (caps.inviteLink) {
          inviteLink = await wa.getGroupInviteLink!(groupJid).catch((err: unknown) => {
            log.warn({ err, chatJid: groupKey }, 'group invite link unavailable');
            return null;
          });
        }
        if (caps.joinRequests) joinRequests = await requests(groupKey, groupJid, wa);
      }
      return {
        caps,
        canManage: viewer.isAdmin,
        online,
        myRole,
        settings: settingsOf(info),
        inviteLink,
        requests: joinRequests,
        changes: viewer.isAdmin ? changes(groupKey, inboxId) : [],
        size: info ? info.size : null,
      };
    },

    async edit(groupKey, body, actor) {
      const c = await check(groupKey, (caps) => caps.editInfo);
      if (body.name !== undefined && body.name.length > c.caps.nameMax)
        throw errors.validation(`name: at most ${c.caps.nameMax} characters`);
      if (body.description !== undefined && body.description.length > c.caps.descriptionMax)
        throw errors.validation(`description: at most ${c.caps.descriptionMax} characters`);
      limit(editLimiter, actor);
      let done = false;
      try {
        if (body.name !== undefined) {
          const t0 = now();
          const name = body.name;
          await call('rename', () => c.wa.setGroupSubject!(c.groupJid, name));
          record(c, groupKey, actor, 'rename', { result: 'ok' }, t0);
          done = true;
        }
        if (body.description !== undefined) {
          const t0 = now();
          const text = body.description.trim() ? body.description : null;
          await call('description', () => c.wa.setGroupDescription!(c.groupJid, text));
          record(c, groupKey, actor, 'description', { result: text ? 'ok' : 'cleared' }, t0);
          done = true;
        }
      } finally {
        // a rename that went through before the description failed still shows
        if (done) changed(groupKey);
      }
    },

    async addMember(groupKey, phone, actor) {
      const c = await check(groupKey, (caps) => caps.addMembers);
      const t0 = now();
      const found = await call('check_number', () => c.wa.checkNumber(phone));
      const jid = normalizeContactJid(found);
      if (!jid) throw new HttpError(422, 'not_on_whatsapp', 'This number is not on WhatsApp');
      if (findMember(c.info, jid))
        throw conflict('already_member', 'This person is already in the group');
      if (c.caps.maxMembers !== null && c.info.size - 1 >= c.caps.maxMembers)
        throw conflict('group_full', 'This group is full');
      const release = reserveAdd(c.inboxId);
      try {
        const [r] = await call('member_add', () =>
          c.wa.updateGroupMembers!(c.groupJid, [jid], 'add'),
        );
        if (r?.status === 'ok') {
          record(c, groupKey, actor, 'member_add', { memberJid: jid, result: 'added' }, t0);
          changed(groupKey);
          return { result: 'added', memberJid: jid };
        }
        if (r?.status === 'invite_needed' && r.invite && r.invite.expiresAt > now()) {
          const key = `${c.inboxId}|${c.groupJid}|${jid}`;
          invites.delete(key);
          while (invites.size >= MAX_STORED_INVITES) {
            invites.delete(invites.keys().next().value as string);
          }
          invites.set(key, { ...r.invite });
          log.info(
            { action: 'member_add', result: 'invite_needed', ms: now() - t0 },
            'group change',
          );
          return { result: 'invite_needed', memberJid: jid };
        }
        log.info(
          { action: 'member_add', result: r?.status ?? 'none', ms: now() - t0 },
          'group change',
        );
        throw participantError(r);
      } finally {
        release();
      }
    },

    async sendInvite(groupKey, member, actor) {
      const memberJid = memberJidParam(member);
      const c = await check(groupKey, (caps) => caps.addMembers);
      if (!has(c.wa, 'sendGroupInvite')) throw notSupported();
      const key = `${c.inboxId}|${c.groupJid}|${memberJid}`;
      const invite = invites.get(key);
      if (!invite || invite.expiresAt <= now()) {
        invites.delete(key);
        throw conflict('invite_expired', 'Add this person again to get a new invite');
      }
      const release = reserveAdd(c.inboxId);
      try {
        const t0 = now();
        await call('member_invite', () => c.wa.sendGroupInvite!(c.groupJid, memberJid, invite));
        invites.delete(key);
        record(c, groupKey, actor, 'member_invite', { memberJid, result: 'sent' }, t0);
      } finally {
        release();
      }
      changed(groupKey);
    },

    removeMember: (groupKey, member, actor) => changeMember(groupKey, member, 'remove', actor),

    setRole: (groupKey, member, admin, actor) =>
      changeMember(groupKey, member, admin ? 'promote' : 'demote', actor),

    async resetInviteLink(groupKey, actor) {
      const c = await check(groupKey, (caps) => caps.resetInviteLink);
      limit(editLimiter, actor);
      const t0 = now();
      const link = await call('invite_reset', () => c.wa.resetGroupInviteLink!(c.groupJid));
      record(c, groupKey, actor, 'invite_reset', { result: 'ok' }, t0);
      changed(groupKey);
      return link;
    },

    async setSettings(groupKey, body, actor) {
      const keys = GROUP_SETTING_KEYS.filter((k) => body[k] !== undefined);
      const c = await check(
        groupKey,
        (caps) => keys.length > 0 && keys.every((k) => caps.settings.includes(k)),
      );
      limit(editLimiter, actor);
      const t0 = now();
      const settings: Partial<WaGroupSettings> = {};
      for (const k of keys) Object.assign(settings, { [k]: body[k] });
      await call('setting', () => c.wa.setGroupSettings!(c.groupJid, settings));
      for (const k of keys)
        record(c, groupKey, actor, 'setting', { setting: k, value: body[k], result: 'ok' }, t0);
      changed(groupKey);
    },

    async decideJoin(groupKey, member, approve, actor) {
      const memberJid = memberJidParam(member);
      const c = await check(groupKey, (caps) => caps.joinRequests);
      limit(editLimiter, actor);
      const t0 = now();
      const r = await call('join', () =>
        c.wa.decideGroupJoinRequest!(c.groupJid, memberJid, approve),
      );
      const action: GroupChangeAction = approve ? 'join_approve' : 'join_reject';
      if (r.status !== 'ok') {
        log.info({ action, result: r.status, ms: now() - t0 }, 'group change');
        throw r.status === 'not_member'
          ? conflict('not_member', 'This join request is no longer waiting')
          : participantError(r);
      }
      record(c, groupKey, actor, action, { memberJid, result: 'ok' }, t0);
      changed(groupKey);
    },
  };
  return withRefusalRefresh(service, groups.invalidate);
}

/**
 * When a change is refused because the linked number is not (or no longer) a group admin, the cached
 * member list may hold a stale role: drop it so Group info reads the group again.
 */
export function withRefusalRefresh(
  service: GroupAdminService,
  invalidate: (groupKey: string) => void,
): GroupAdminService {
  const wrapped = { ...service };
  for (const name of Object.keys(service) as Array<keyof GroupAdminService>) {
    if (name === 'state') continue;
    const fn = service[name] as (groupKey: string, ...rest: unknown[]) => Promise<unknown>;
    (wrapped as Record<string, unknown>)[name] = async (groupKey: string, ...rest: unknown[]) => {
      try {
        return await fn(groupKey, ...rest);
      } catch (err) {
        if (err instanceof HttpError && err.code === 'not_group_admin') invalidate(groupKey);
        throw err;
      }
    };
  }
  return wrapped;
}
