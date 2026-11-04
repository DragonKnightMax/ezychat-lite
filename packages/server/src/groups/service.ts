import type { GroupInfoResponse, GroupMember } from '@ezychat/shared';
import {
  normalizeContactJid,
  type WaAdapter,
  type WaGroupInfo,
  type WaGroupParticipant,
} from '@ezychat/wa';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { errors } from '../http/errors.js';
import { getAliases } from '../chats/aliases.js';
import { isFallbackName } from '../chats/service.js';
import { jidUser } from '../chats/repo.js';
import { PRIMARY_INBOX_ID, chatKey, parseChatKey } from '../inboxes/keys.js';
import { getChats } from '../wa-bridge/index.js';

/** How long a member list read from WhatsApp is reused before reading it again. */
export const GROUP_INFO_TTL_MS = 5 * 60_000;
const ABOUT_TTL_MS = 30 * 60_000;
const MAX_CACHED_GROUPS = 50;
const MAX_CACHED_ABOUTS = 2000;

/**
 * Group chats are addressed by chat key (`<groupJid>#<inboxId>`; plain for inbox 1). Every read goes
 * through the group's own inbox: its phone, its own number ("me") and its direct chats.
 */
export interface GroupService {
  /** Members of a group chat, with names we already know and links to existing direct chats. */
  info(groupJid: string): Promise<GroupInfoResponse>;
  /** A member's WhatsApp About text (fetched on demand, cached). */
  about(groupJid: string, memberJid: string): Promise<string | null>;
  /**
   * Whose photo to fetch (a chat key in the group's inbox, after checking they are in the group),
   * and a cache key that changes when the number moves to another person.
   */
  photoTarget(groupJid: string, memberJid: string): Promise<{ jid: string; key: string }>;
  /** The direct chat with a member in the group's inbox: the existing one, or a new empty chat. */
  startChat(
    groupJid: string,
    memberJid: string,
    actor: { userId: number; ip: string | null },
  ): Promise<string>;
  /** The group's member list as WhatsApp listed it (cached like `info`). */
  rawInfo(groupJid: string): Promise<WaGroupInfo>;
  /** Drop the cached member list of a group (after a change made here). */
  invalidate(groupJid: string): void;
  /** The participant entry of the linked number, when it is in the list. */
  me(groupJid: string, info: WaGroupInfo): WaGroupParticipant | null;
  /** Names we already know (saved contact name, then WhatsApp profile name), by JID. */
  knownNames(jids: string[]): Map<string, string>;
  shutdown(): void;
}

interface Cached {
  /** epoch ms when the list was read */
  at: number;
  until: number;
  info: Promise<WaGroupInfo>;
}

function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size >= max) map.delete(map.keys().next().value as K);
}

export function createGroupService(ctx: AppContext, deps?: { now?: () => number }): GroupService {
  const now = deps?.now ?? Date.now;
  const log = ctx.log.child({ mod: 'groups' });
  /** Member lists by `<inboxId>|<groupJid>`: two inboxes in one group read it each. */
  const cache = new Map<string, Cached>();
  const cacheKey = (inboxId: number, groupJid: string) => `${inboxId}|${groupJid}`;
  const abouts = new Map<string, { until: number; about: Promise<string | null> }>();
  const listeners = new Map<number, { wa: WaAdapter; fn: (e: { groupJid: string }) => void }>();
  const listen = (inboxId: number, wa: WaAdapter) => {
    if (listeners.has(inboxId)) return;
    const fn = ({ groupJid }: { groupJid: string }) => {
      if (cache.delete(cacheKey(inboxId, groupJid)))
        log.debug({ groupJid, inboxId }, 'group member list invalidated');
      // A change on WhatsApp (or one made here): open Group info panels read it again.
      let key: string;
      try {
        key = chatKey(inboxId, groupJid);
      } catch {
        return;
      }
      ctx.bus.emit('group:changed', { chatJid: key });
    };
    wa.on('groupChanged', fn);
    listeners.set(inboxId, { wa, fn });
  };
  const unlisten = (inboxId: number) => {
    const l = listeners.get(inboxId);
    if (!l) return;
    l.wa.off('groupChanged', l.fn);
    listeners.delete(inboxId);
  };
  listen(PRIMARY_INBOX_ID, ctx.wa);
  for (const [inboxId, wa] of ctx.inboxes.connections.entries()) listen(inboxId, wa);
  ctx.inboxes.connections.on('added', listen);
  ctx.inboxes.connections.on('removed', unlisten);

  /** The group key's inbox, WhatsApp JID and adapter. */
  function target(groupKey: string): { inboxId: number; groupJid: string; wa: WaAdapter } {
    let parsed: { inboxId: number; waJid: string };
    try {
      parsed = parseChatKey(groupKey);
    } catch {
      throw errors.notFound('Group');
    }
    const wa =
      parsed.inboxId === PRIMARY_INBOX_ID
        ? ctx.wa
        : ctx.inboxes.connections.entries().find(([id]) => id === parsed.inboxId)?.[1];
    // a removed inbox has no phone to ask
    if (!wa) throw errors.waUnavailable();
    return { inboxId: parsed.inboxId, groupJid: parsed.waJid, wa };
  }

  function requireGroupChat(groupKey: string): void {
    const chat = getChats(ctx).get(groupKey);
    if (!chat || chat.type !== 'group') throw errors.notFound('Group');
  }

  function raw(groupKey: string): Promise<WaGroupInfo> {
    const { inboxId, groupJid, wa } = target(groupKey);
    const key = cacheKey(inboxId, groupJid);
    const cached = cache.get(key);
    if (cached && cached.until > now()) return cached.info;
    evictOldest(cache, MAX_CACHED_GROUPS);
    const t0 = now();
    const entry = { at: t0, until: t0 + GROUP_INFO_TTL_MS } as Cached; // info is set just below
    const current = () => cache.get(key) === entry;
    entry.info = wa.getGroupInfo(groupJid).then(
      (g) => {
        // Invalidated while in flight: a newer read is authoritative, never this one.
        if (!current()) return raw(groupKey);
        log.info(
          { groupJid, inboxId, size: g.size, listed: g.participants.length, ms: now() - t0 },
          'group members read',
        );
        // The list is live WhatsApp evidence: learn its phone/WhatsApp ID pairs before anything
        // looks up a member's chat, so a recycled number routes to its current owner.
        const pairs = g.participants.flatMap((p) =>
          p.phoneJid && p.lidJid
            ? [{ jid: p.phoneJid, alias: p.lidJid, source: 'lid-mapping' as const }]
            : [],
        );
        if (pairs.length) getChats(ctx).upsertContactAliases(pairs);
        return g;
      },
      (err: unknown) => {
        if (!current()) return raw(groupKey); // a newer read answers instead
        cache.delete(key);
        log.warn({ err, groupJid, inboxId }, 'group members unavailable');
        throw err;
      },
    );
    cache.set(key, entry);
    return entry.info;
  }

  async function member(groupKey: string, memberJid: string): Promise<WaGroupParticipant> {
    requireGroupChat(groupKey);
    const want = normalizeContactJid(memberJid);
    if (!want) throw errors.notFound('Member');
    const g = await raw(groupKey);
    const p = g.participants.find(
      (x) => x.jid === want || x.phoneJid === want || x.lidJid === want,
    );
    if (!p) throw errors.notFound('Member');
    return p;
  }

  /** Names we already know, by JID: saved contact name first, then the WhatsApp profile name. */
  function contactNames(jids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const stmt = ctx.db.prepare(
      `SELECT jid, saved_name, push_name FROM contacts WHERE jid IN (SELECT value FROM json_each(?))`,
    );
    for (let i = 0; i < jids.length; i += 500) {
      const rows = stmt.all(JSON.stringify(jids.slice(i, i + 500))) as Array<{
        jid: string;
        saved_name: string | null;
        push_name: string | null;
      }>;
      for (const r of rows) {
        const name = r.saved_name?.trim() || r.push_name?.trim();
        if (name) out.set(r.jid, name);
      }
    }
    return out;
  }

  /** A member's direct chat; a chat shows its phone number as the name when it has no real name. */
  type MemberChat = { jid: string; name: string; phone: string | null };

  /**
   * Whose About and photo to fetch: the number (the path verified against real WhatsApp) while it
   * still points at this member, else their WhatsApp ID, so a number that moved shows nobody else.
   */
  function detailJid(inboxId: number, p: WaGroupParticipant): string {
    return ownPhone(inboxId, p) ?? p.lidJid ?? p.jid;
  }

  /** The member's number from the group, unless it has since moved to another WhatsApp ID. */
  function ownPhone(inboxId: number, p: WaGroupParticipant): string | null {
    if (!p.phoneJid) return null;
    const aliases = getAliases(ctx);
    return !p.lidJid || aliases.route(inboxId, p.phoneJid) === aliases.route(inboxId, p.lidJid)
      ? p.phoneJid
      : null;
  }

  /** Cache key for one person: the WhatsApp ID survives a phone number moving to someone else. */
  function identityKey(inboxId: number, p: WaGroupParticipant): string {
    const id = `${p.lidJid ?? ''}|${detailJid(inboxId, p)}`;
    return inboxId === PRIMARY_INBOX_ID ? id : `${inboxId}|${id}`;
  }

  /**
   * The name we know for a member: a real chat name, then contact names (WhatsApp ID first). A number
   * shown as a chat name is not a name, and a re-pointed number's contact name is the old owner's.
   */
  function knownName(
    p: WaGroupParticipant,
    names: Map<string, string>,
    chat: MemberChat | null,
  ): string | null {
    const numbers = [p.phoneJid && jidUser(p.phoneJid), chat?.phone].filter(Boolean);
    if (chat && !isFallbackName(chat.name, chat.jid) && !numbers.includes(chat.name))
      return chat.name;
    const lidName = p.lidJid ? names.get(p.lidJid) : undefined;
    if (lidName) return lidName;
    if (p.phoneJid && !getAliases(ctx).movedAway(p.phoneJid)) return names.get(p.phoneJid) ?? null;
    return null;
  }

  /** The existing direct chat for a member in the inbox (by phone number or WhatsApp ID), if any. */
  function existingChat(inboxId: number, p: WaGroupParticipant): MemberChat | null {
    const chats = getChats(ctx);
    const aliases = getAliases(ctx);
    for (const j of [p.lidJid, p.phoneJid]) {
      if (!j) continue;
      // The number may since belong to someone else (a newer read of another group): only trust a
      // chat found through it while it still points at this member's WhatsApp ID.
      if (j === p.phoneJid && !ownPhone(inboxId, p)) continue;
      const chat = chats.get(aliases.route(inboxId, j));
      if (chat && chat.type === 'dm' && chat.inboxId === inboxId)
        return { jid: chat.jid, name: chat.name, phone: chat.phone };
    }
    return null;
  }

  /** The own number (and its known aliases and LID) of the phone the group is read through. */
  function myJids(wa: WaAdapter): Set<string> {
    const me = normalizeContactJid(wa.status.me?.jid);
    const out = new Set<string>();
    if (!me) return out;
    out.add(me);
    for (const a of getAliases(ctx).group(me)) out.add(a);
    // Own pairs are never learned as aliases (aliases.ts): the session knows the account's LID.
    const lid = normalizeContactJid(wa.status.me?.lid);
    if (lid) out.add(lid);
    return out;
  }

  const ROLE_ORDER: Record<GroupMember['role'], number> = { superadmin: 0, admin: 0, member: 1 };

  return {
    async info(groupJid) {
      requireGroupChat(groupJid);
      const { inboxId, wa, groupJid: waGroupJid } = target(groupJid);
      const g = await raw(groupJid);
      const names = contactNames(
        g.participants.flatMap((p) => [p.phoneJid, p.lidJid].filter((j): j is string => !!j)),
      );
      const mine = myJids(wa);
      const members: GroupMember[] = g.participants.map((p) => {
        const chat = existingChat(inboxId, p);
        const known = knownName(p, names, chat);
        const own = ownPhone(inboxId, p);
        return {
          jid: p.jid,
          // A hidden number the team already knows from its own chat with this person.
          phone: own ? jidUser(own) : (chat?.phone ?? null),
          lid: p.lidJid,
          name: known,
          username: p.username,
          role: p.role,
          isMe: [p.jid, p.phoneJid, p.lidJid].some((j) => !!j && mine.has(j)),
          chatJid: chat?.jid ?? null,
        };
      });
      members.sort(
        (a, b) =>
          Number(b.isMe) - Number(a.isMe) ||
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          Number(!a.name) - Number(!b.name) ||
          (a.name ?? a.phone ?? a.lid ?? '').localeCompare(b.name ?? b.phone ?? b.lid ?? ''),
      );
      const owner = g.ownerJid
        ? (members.find(
            (m) =>
              m.jid === g.ownerJid ||
              m.lid === g.ownerJid ||
              (m.phone && `${m.phone}@s.whatsapp.net` === g.ownerJid),
          ) ?? null)
        : null;
      return {
        group: {
          jid: g.jid,
          name: g.name ?? getChats(ctx).get(groupJid)?.name ?? null,
          description: g.description,
          createdAt: g.createdAt,
          createdBy: g.ownerJid
            ? {
                jid: g.ownerJid,
                name: owner?.name ?? null,
                phone:
                  owner?.phone ??
                  (g.ownerJid.endsWith('@s.whatsapp.net') ? jidUser(g.ownerJid) : null),
              }
            : null,
          size: g.size,
          adminCount: members.filter((m) => m.role !== 'member').length,
        },
        members,
        fetchedAt: cache.get(cacheKey(inboxId, waGroupJid))?.at ?? now(),
      };
    },

    async about(groupJid, memberJid) {
      const p = await member(groupJid, memberJid);
      const { inboxId, wa } = target(groupJid);
      const jid = detailJid(inboxId, p);
      const key = identityKey(inboxId, p);
      // Offline reads come back empty: never cache that as "no About".
      if (wa.status.state !== 'open') throw errors.waUnavailable();
      let entry = abouts.get(key);
      if (!entry || entry.until <= now()) {
        evictOldest(abouts, MAX_CACHED_ABOUTS);
        // A failed lookup is dropped from the cache and answered as "unavailable", never as empty.
        const about = wa.getAbout(jid).catch(() => {
          if (abouts.get(key)?.about === about) abouts.delete(key);
          throw errors.waUnavailable('WhatsApp could not read this About right now');
        });
        entry = { until: now() + ABOUT_TTL_MS, about };
        abouts.set(key, entry);
      }
      return entry.about;
    },

    async photoTarget(groupJid, memberJid) {
      const p = await member(groupJid, memberJid);
      const { inboxId } = target(groupJid);
      return { jid: chatKey(inboxId, detailJid(inboxId, p)), key: identityKey(inboxId, p) };
    },

    async startChat(groupJid, memberJid, actor) {
      const p = await member(groupJid, memberJid);
      const { inboxId, wa } = target(groupJid);
      const mine = myJids(wa);
      if ([p.jid, p.phoneJid, p.lidJid].some((j) => !!j && mine.has(j))) {
        throw errors.validation('You cannot start a chat with your own number');
      }
      const existing = existingChat(inboxId, p);
      if (existing) return existing.jid;
      // Chats are keyed by the WhatsApp ID once known (the pair was learned when the list was read).
      const memberTarget = p.lidJid ?? p.phoneJid ?? p.jid;
      const names = contactNames([p.phoneJid, p.lidJid].filter((j): j is string => !!j));
      const name = knownName(p, names, null);
      const chat = getChats(ctx).upsertFromWa({ jid: memberTarget, type: 'dm', name }, inboxId);
      audit(ctx.db, {
        userId: actor.userId,
        action: 'chat.start_from_group',
        ip: actor.ip,
        meta: { groupJid, chatJid: chat.jid },
      });
      log.info(
        { groupJid, chatJid: chat.jid, userId: actor.userId },
        'direct chat started from group',
      );
      return chat.jid;
    },

    async rawInfo(groupJid) {
      requireGroupChat(groupJid);
      return raw(groupJid);
    },

    invalidate(groupJid) {
      let parsed: { inboxId: number; waJid: string };
      try {
        parsed = parseChatKey(groupJid);
      } catch {
        return;
      }
      cache.delete(cacheKey(parsed.inboxId, parsed.waJid));
    },

    me(groupJid, info) {
      const mine = myJids(target(groupJid).wa);
      return (
        info.participants.find((p) =>
          [p.jid, p.phoneJid, p.lidJid].some((j) => !!j && mine.has(j)),
        ) ?? null
      );
    },

    knownNames: contactNames,

    shutdown() {
      for (const inboxId of [...listeners.keys()]) unlisten(inboxId);
      ctx.inboxes.connections.off('added', listen);
      ctx.inboxes.connections.off('removed', unlisten);
      cache.clear();
      abouts.clear();
    },
  };
}
