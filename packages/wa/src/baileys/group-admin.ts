import { getBinaryNodeChild, type BinaryNode, type GroupMetadata } from 'baileys';
import type { WaGroupJoinRequest, WaGroupSettings, WaParticipantResult } from '../types.js';
import { normalizeContactJid } from './contact-aliases.js';

/** WhatsApp's invite links: `https://chat.whatsapp.com/<code>`. */
export const INVITE_LINK_PREFIX = 'https://chat.whatsapp.com/';

/** The invite link for a code from `groupInviteCode` / `groupRevokeInvite`; throws on no code. */
export function inviteLink(code: unknown): string {
  // A timed-out query resolves to undefined instead of throwing: a failure, never a link.
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error('Invite link query returned no code');
  }
  return INVITE_LINK_PREFIX + code;
}

/** One entry of Baileys' `groupParticipantsUpdate` / `groupRequestParticipantsUpdate` result. */
export interface BaileysParticipantEntry {
  status?: string;
  jid?: string;
  content?: BinaryNode;
}

/**
 * A Baileys per-person result → ours. The codes are WhatsApp's `error` attribute on each
 * `participant` node (`'200'` when there is none, `Socket/groups.js`), as WhatsApp Web reads them:
 * 200 done; 403 with an `add_request` child = the person's privacy settings refuse adds, the child
 * carries a private invite (`code`, `expiration` in seconds); 403 without one or 401 = not allowed
 * (not an admin, the creator); 409 = already a member (or already that role); 404 = not in the
 * group; 500 / 406 = the group is full. Anything else, or a malformed invite, fails closed.
 */
export function mapParticipantEntry(
  requestedJid: string,
  entry: BaileysParticipantEntry | undefined,
): WaParticipantResult {
  const jid = requestedJid;
  if (!entry) return { jid, status: 'failed' };
  switch (String(entry.status ?? '')) {
    case '200':
      return { jid, status: 'ok' };
    case '403': {
      const req = entry.content ? getBinaryNodeChild(entry.content, 'add_request') : undefined;
      if (!req) return { jid, status: 'not_allowed' };
      const code = req.attrs?.code;
      const expiration = Number(req.attrs?.expiration);
      if (!code || !Number.isFinite(expiration) || expiration <= 0)
        return { jid, status: 'failed' };
      return { jid, status: 'invite_needed', invite: { code, expiresAt: expiration * 1000 } };
    }
    case '401':
      return { jid, status: 'not_allowed' };
    case '409':
      return { jid, status: 'already' };
    case '404':
      return { jid, status: 'not_member' };
    case '500':
    case '406':
      return { jid, status: 'full' };
    default:
      return { jid, status: 'failed' };
  }
}

/**
 * The single requested person's result from a Baileys list. WhatsApp may answer with the other
 * address form (phone number ↔ WhatsApp ID), so a one-entry answer counts for the one person asked.
 */
export function pickParticipantEntry(
  requestedJid: string,
  list: unknown,
): BaileysParticipantEntry | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const entries = list as BaileysParticipantEntry[];
  const match = entries.find((e) => normalizeContactJid(e?.jid) === requestedJid);
  if (match) return match;
  return entries.length === 1 ? entries[0] : undefined;
}

/** The WhatsApp error code of a whole-request (iq) refusal, from Baileys' Boom (`data` = code). */
export function iqErrorCode(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const data = (err as { data?: unknown }).data;
  return typeof data === 'number' && Number.isFinite(data) ? data : null;
}

/** The settings WhatsApp reported in group metadata; keys it did not send are left out. */
export function mapGroupSettings(meta: Partial<GroupMetadata>): Partial<WaGroupSettings> {
  const out: Partial<WaGroupSettings> = {};
  if (typeof meta.announce === 'boolean') out.announce = meta.announce;
  if (typeof meta.restrict === 'boolean') out.locked = meta.restrict;
  if (typeof meta.memberAddMode === 'boolean')
    out.memberAdd = meta.memberAddMode ? 'all' : 'admins';
  if (typeof meta.joinApprovalMode === 'boolean') out.approval = meta.joinApprovalMode;
  return out;
}

/** One Baileys call that applies one setting. */
export type GroupSettingCall =
  | { fn: 'groupSettingUpdate'; arg: 'announcement' | 'not_announcement' | 'locked' | 'unlocked' }
  | { fn: 'groupMemberAddMode'; arg: 'admin_add' | 'all_member_add' }
  | { fn: 'groupJoinApprovalMode'; arg: 'on' | 'off' };

/** The Baileys calls for a settings change, in a fixed order; unknown or absent keys add none. */
export function settingCalls(settings: Partial<WaGroupSettings>): GroupSettingCall[] {
  const calls: GroupSettingCall[] = [];
  if (typeof settings.announce === 'boolean')
    calls.push({
      fn: 'groupSettingUpdate',
      arg: settings.announce ? 'announcement' : 'not_announcement',
    });
  if (typeof settings.locked === 'boolean')
    calls.push({ fn: 'groupSettingUpdate', arg: settings.locked ? 'locked' : 'unlocked' });
  if (settings.memberAdd === 'all' || settings.memberAdd === 'admins')
    calls.push({
      fn: 'groupMemberAddMode',
      arg: settings.memberAdd === 'all' ? 'all_member_add' : 'admin_add',
    });
  if (typeof settings.approval === 'boolean')
    calls.push({ fn: 'groupJoinApprovalMode', arg: settings.approval ? 'on' : 'off' });
  return calls;
}

/**
 * Baileys' `groupRequestParticipantsList` (the attributes of each `membership_approval_request`
 * node: `jid`, `request_time` in seconds, sometimes `phone_number`) → ours. Entries without a
 * usable address are dropped.
 */
export function mapJoinRequests(list: unknown): WaGroupJoinRequest[] {
  // A timed-out query resolves to undefined instead of throwing: a failure, never "no requests".
  if (!Array.isArray(list)) throw new Error('Join request query returned no result');
  const out: WaGroupJoinRequest[] = [];
  const seen = new Set<string>();
  for (const raw of list as Array<Record<string, unknown> | null | undefined>) {
    const jid = normalizeContactJid(raw?.jid);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    const pn = normalizeContactJid(raw?.phone_number ?? raw?.pn);
    let phoneJid: string | null = jid;
    if (jid.endsWith('@lid')) phoneJid = pn && !pn.endsWith('@lid') ? pn : null;
    const t = Number(raw?.request_time ?? raw?.t);
    out.push({ jid, phoneJid, at: Number.isFinite(t) && t > 0 ? t * 1000 : null });
  }
  return out;
}
