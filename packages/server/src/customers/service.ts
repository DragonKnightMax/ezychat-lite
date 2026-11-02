import type {
  Chat,
  CustomerProfile,
  CustomerProfileBody,
  CustomerProfileResponse,
  Message,
  SenderProfile,
} from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { errors } from '../http/errors.js';
import { PRIMARY_INBOX_ID, chatKey, inboxOfKey, parseChatKey } from '../inboxes/keys.js';
import { getChats } from '../wa-bridge/index.js';
import { linkedChats, seedAllFromLinked } from './linked.js';
import { CustomerRepo, PROFILE_FIELDS, type ProfileFields } from './repo.js';

export interface CustomerService {
  /** The direct chat's profile (empty when never saved). Throws 404 for a missing chat, 400 for a group. */
  profile(chatJid: string, viewer?: Viewer): CustomerProfileResponse;
  /**
   * Replaces the whole profile; the contact fields (not the tags) also go to the same person's chats
   * in the other inboxes (`linked.ts`). Audits which fields changed (never values). No change, no write.
   */
  save(
    chatJid: string,
    body: CustomerProfileBody,
    actor: { userId: number; ip: string | null; isAdmin?: boolean },
  ): CustomerProfileResponse;
  /** Tag suggestions; `inboxIds` limits them to tags used on chats of those inboxes. */
  suggestTags(q?: string, inboxIds?: readonly number[]): string[];
  /**
   * Group messages: sender JID → their direct chat's profile name (only when one is set). Only the
   * direct chats of `inboxId` (the group's inbox, default 1) count.
   */
  senderProfiles(senderJids: string[], inboxId?: number): Map<string, SenderProfile>;
  /** Attaches `senderProfile` to inbound group messages (one batched lookup); others unchanged. */
  withSenderProfiles(messages: Message[]): Message[];
}

declare module '../context.js' {
  interface Services {
    customers?: CustomerService;
  }
}

/** Who is reading: only admins get the WhatsApp ID (LID). */
export interface Viewer {
  isAdmin: boolean;
}

const EMPTY: CustomerProfile = {
  id: null,
  name: null,
  company: null,
  email: null,
  otherPhone: null,
  address: null,
  tags: [],
  updatedAt: null,
  updatedBy: null,
};

export function createCustomerService(ctx: AppContext): CustomerService {
  const repo = new CustomerRepo(ctx.db);
  const chats = () => getChats(ctx);

  function directChat(chatJid: string): Chat {
    const chat = chats().get(chatJid);
    if (!chat) throw errors.notFound('Chat');
    if (chat.type !== 'dm') throw errors.validation('Group chats have no customer profile');
    return chat;
  }

  /** Read-only WhatsApp facts across every JID of the person (phone number and LID forms). */
  function whatsappFacts(chat: Chat, viewer: Viewer) {
    // contacts and aliases are keyed by WhatsApp JID, never by the chat key
    const jids = ctx.services.aliases?.group(chat.waJid) ?? [chat.waJid];
    const all = [...new Set([chat.waJid, ...jids])];
    const rows = ctx.db
      .prepare(
        `SELECT push_name, saved_name, phone FROM contacts WHERE jid IN (${all.map(() => '?').join(', ')})`,
      )
      .all(...all) as Array<{
      push_name: string | null;
      saved_name: string | null;
      phone: string | null;
    }>;
    const first = (pick: (r: (typeof rows)[number]) => string | null) =>
      rows.map(pick).find((v) => !!v?.trim()) ?? null;
    return {
      pushName: first((r) => r.push_name),
      savedName: first((r) => r.saved_name),
      phone: chat.phone ?? first((r) => r.phone),
      lid: viewer.isAdmin ? (all.find((jid) => jid.endsWith('@lid')) ?? null) : null,
    };
  }

  const service: CustomerService = {
    profile(chatJid, viewer = { isAdmin: false }) {
      const chat = directChat(chatJid);
      return {
        profile: repo.get(chat.jid) ?? EMPTY,
        whatsappName: chat.whatsappName ?? null,
        whatsappPhone: chat.phone ?? null,
        whatsapp: whatsappFacts(chat, viewer),
      };
    },

    save(chatJid, body, actor) {
      const jid = directChat(chatJid).jid;
      const fields = Object.fromEntries(
        PROFILE_FIELDS.map((f) => [f, body[f].trim() || null]),
      ) as ProfileFields;
      // Compare and write in one synchronous transaction: nothing can interleave.
      const written = ctx.db.transaction((): string[] => {
        const tags = repo.canonicalTags(body.tags, jid);
        const linked = linkedChats(ctx.db, jid);
        const same = (other: string) => {
          const p = repo.get(other) ?? EMPTY;
          return PROFILE_FIELDS.every((f) => p[f] === fields[f]);
        };
        const before = repo.get(jid) ?? EMPTY;
        const diff: string[] = PROFILE_FIELDS.filter((f) => before[f] !== fields[f]);
        if (before.tags.join('\u001f') !== tags.join('\u001f')) diff.push('tags');
        // Linked chats that drifted apart are brought back in line even when this one is unchanged.
        const stale = linked.filter((l) => !same(l));
        if (!diff.length && !stale.length) return [];
        const now = Date.now();
        if (diff.length) repo.save(jid, fields, tags, actor.userId, now);
        // Tags stay per inbox: each linked chat keeps its own.
        for (const other of stale) repo.save(other, fields, repo.tags(other), actor.userId, now);
        const targets = diff.length ? [jid, ...stale] : stale;
        // Which fields changed, never their values (personal data).
        audit(ctx.db, {
          userId: actor.userId,
          action: 'customer.profile_update',
          ip: actor.ip,
          meta: { chatJid: jid, changed: diff, linkedChats: stale.length },
        });
        return targets;
      })();
      for (const target of written) {
        const chat = chats().get(target);
        if (chat) ctx.bus.emit('chat:updated', chat);
      }
      return service.profile(jid, { isAdmin: !!actor.isAdmin });
    },

    suggestTags(q, inboxIds) {
      return repo.suggest(q, 20, inboxIds);
    },

    senderProfiles(senderJids, inboxId = PRIMARY_INBOX_ID) {
      const aliases = ctx.services.aliases;
      const byChat = new Map<string, string[]>();
      for (const sender of new Set(senderJids)) {
        const chatJid = aliases ? aliases.route(inboxId, sender) : chatKey(inboxId, sender);
        byChat.set(chatJid, [...(byChat.get(chatJid) ?? []), sender]);
      }
      const names = repo.namesByChat([...byChat.keys()]);
      const out = new Map<string, SenderProfile>();
      for (const [chatJid, name] of names)
        for (const sender of byChat.get(chatJid) ?? []) out.set(sender, { chatJid, name });
      return out;
    },

    withSenderProfiles(messages) {
      const inGroup = (m: Message) =>
        !m.fromMe && !!m.senderJid && parseChatKey(m.chatJid).waJid.endsWith('@g.us');
      // A sender's profile is the one of their direct chat in the group's own inbox.
      const byInbox = new Map<number, string[]>();
      for (const m of messages.filter(inGroup)) {
        const inboxId = inboxOfKey(m.chatJid);
        byInbox.set(inboxId, [...(byInbox.get(inboxId) ?? []), m.senderJid!]);
      }
      if (!byInbox.size) return messages;
      const profiles = new Map(
        [...byInbox].map(([inboxId, senders]) => [
          inboxId,
          service.senderProfiles(senders, inboxId),
        ]),
      );
      return messages.map((m) =>
        inGroup(m)
          ? {
              ...m,
              senderProfile: profiles.get(inboxOfKey(m.chatJid))?.get(m.senderJid!) ?? null,
            }
          : m,
      );
    },
  };
  return service;
}

export function initCustomers(ctx: AppContext): void {
  ctx.services.customers = createCustomerService(ctx);
  // Permanent start-up step: chats of one person linked before profiles were synced across inboxes.
  const seeded = seedAllFromLinked(ctx.db);
  if (seeded)
    ctx.log
      .child({ mod: 'customers' })
      .info({ seeded }, 'Customer profiles copied to linked chats');
}
