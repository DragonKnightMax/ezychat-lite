import type { Logger } from 'pino';
import type { Message } from '@ezychat/shared';
import { normalizeContactJid } from '@ezychat/wa';
import type { AppContext } from '../context.js';
import { errors } from '../http/errors.js';
import { getAliases, type AliasStore } from '../chats/aliases.js';
import { jidUser, rowToChat, type ChatRow } from '../chats/repo.js';
import { inboxOfKey, parseChatKey } from '../inboxes/keys.js';
import { previewOf, rowToMessage, type MessageRow } from './repo.js';

// Whole numeric tags only. Emails, usernames and URLs are ordinary text.
const TAG = /(?<![\p{L}\p{N}_@])@(\d+)(?![\p{L}\p{N}_])/gu;
const URL = /(https?:\/\/[^\s<>]+)/g;

/**
 * The members a sent text tags, checked: each is a person's WhatsApp address (phone number or
 * LID) written in the text as a whole `@<number>` tag, as WhatsApp writes a mention. Duplicates
 * are dropped; anything else is refused (400), so a send never tags someone the text does not show.
 */
export function outgoingMentions(text: string, jids: readonly string[]): string[] {
  const tagged = new Set(tokens(text));
  const out: string[] = [];
  for (const raw of jids) {
    const jid = normalizeContactJid(raw);
    if (!jid) throw errors.validation('mentions: not a WhatsApp address');
    if (!tagged.has(jidUser(jid))) throw errors.validation('mentions: the text has no @tag for it');
    if (!out.includes(jid)) out.push(jid);
  }
  return out;
}

function textParts(body: string): string[] {
  return body.split(URL);
}

function tokens(body: string): string[] {
  return [
    ...new Set(
      textParts(body).flatMap((part, index) =>
        index % 2 ? [] : [...part.matchAll(TAG)].map((m) => m[1]!),
      ),
    ),
  ];
}

function storedMentions(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.flatMap((jid: unknown) => {
          const normalized = normalizeContactJid(jid);
          return normalized ? [normalized] : [];
        })
      : [];
  } catch {
    // Corrupt metadata must never turn ordinary text into a guessed mention.
    return [];
  }
}

interface KnownIdentity {
  jid: string;
  saved_name: string | null;
  push_name: string | null;
  chat_name: string | null;
  profile_name: string | null;
}

interface MentionPlan {
  index: number;
  /** the inbox of the message: its own number is named from that inbox's session */
  inboxId: number;
  legacy: boolean;
  byToken: Map<string, Set<string>>;
}

interface MentionName {
  identity: string;
  known: boolean;
  name: string | null;
}

function planMentions(
  row: MessageRow,
  index: number,
  aliases: AliasStore,
  wanted: Set<string>,
): MentionPlan | null {
  if (!row.body || row.type === 'system' || row.deleted_at != null) return null;
  const legacy = row.mentioned_jids == null;
  if (legacy && !parseChatKey(row.chat_jid).waJid.endsWith('@g.us')) return null;
  const tags = tokens(row.body);
  if (!tags.length) return null;
  const byToken = new Map<string, Set<string>>();
  const add = (token: string, jid: string) => {
    const candidates = byToken.get(token) ?? new Set<string>();
    candidates.add(jid);
    byToken.set(token, candidates);
    for (const id of aliases.group(jid)) {
      if (!aliases.movedAway(id)) wanted.add(id);
    }
  };
  if (legacy) {
    for (const tag of tags) {
      add(tag, `${tag}@lid`);
      add(tag, `${tag}@s.whatsapp.net`);
    }
  } else {
    addStoredCandidates(row.mentioned_jids!, tags, aliases, add);
  }
  return { index, inboxId: inboxOfKey(row.chat_jid), legacy, byToken };
}

function addStoredCandidates(
  metadata: string,
  tags: string[],
  aliases: AliasStore,
  add: (token: string, jid: string) => void,
) {
  for (const jid of storedMentions(metadata)) {
    if (aliases.movedAway(jid)) continue;
    // The body may use the person's phone digits while metadata uses their LID or vice versa.
    for (const id of aliases.group(jid)) {
      if (!aliases.movedAway(id) && tags.includes(jidUser(id))) add(jidUser(id), jid);
    }
  }
}

function replacementsFor(plan: MentionPlan, nameFor: (jid: string) => MentionName) {
  const replacements = new Map<string, string>();
  for (const [token, candidates] of plan.byToken) {
    const choices = new Map<string, string | null>();
    for (const jid of candidates) {
      const result = nameFor(jid);
      if (!plan.legacy || result.known) choices.set(result.identity, result.name);
    }
    if (choices.size === 1) {
      const name = [...choices.values()][0];
      if (name) replacements.set(token, name);
    }
  }
  return replacements;
}

function replaceMentions(body: string, replacements: Map<string, string>) {
  let count = 0;
  const presented = textParts(body)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(TAG, (tag, token: string) => {
            const name = replacements.get(token);
            if (!name) return tag;
            count++;
            return `@${name}`;
          }),
    )
    .join('');
  return { body: presented, count };
}

/**
 * Name mentions only in presentation. The original body remains in SQLite for sends and quotes.
 * New messages use explicit WhatsApp metadata. Old group messages can use an exact known identity
 * when their numeric tag is unambiguous across the phone and LID namespaces. No network lookups.
 */
export function createMentionPresenter(ctx: AppContext, log: Pick<Logger, 'debug'>) {
  const identities = ctx.db.prepare(`
    SELECT ids.value AS jid, c.saved_name, c.push_name, ch.name AS chat_name, p.name AS profile_name
    FROM json_each(?) ids
    LEFT JOIN contacts c ON c.jid = ids.value
    LEFT JOIN chats ch ON ch.jid = ids.value AND ch.type = 'dm'
    LEFT JOIN customer_profiles p ON p.chat_jid = ids.value
    WHERE c.jid IS NOT NULL OR ch.jid IS NOT NULL OR p.chat_jid IS NOT NULL
  `);

  return (rows: MessageRow[], messages: Message[]): Message[] => {
    const aliases = getAliases(ctx);
    const wanted = new Set<string>();
    const plans = rows.flatMap((row, index) => {
      const plan = planMentions(row, index, aliases, wanted);
      return plan ? [plan] : [];
    });
    if (!plans.length) return messages;

    const known = new Map<string, KnownIdentity>();
    const ids = [...wanted];
    for (let i = 0; i < ids.length; i += 500) {
      for (const row of identities.all(JSON.stringify(ids.slice(i, i + 500))) as KnownIdentity[]) {
        known.set(row.jid, row);
      }
    }

    // The linked account itself is never a contact or chat: name it from the WhatsApp session of
    // the message's inbox (a removed inbox keeps only its remembered number, without a name).
    const owners = new Map<number, { own: Set<string>; name: string | null }>();
    const sessionOf = (
      inboxId: number,
    ): { jid?: string; lid?: string | null; name?: string | null } | null => {
      try {
        return ctx.inboxes.connections.adapter(inboxId).status.me ?? null;
      } catch {
        const jid = ctx.inboxes.repo.get(inboxId)?.own_jid;
        return jid ? { jid } : null;
      }
    };
    const ownOf = (inboxId: number) => {
      const cached = owners.get(inboxId);
      if (cached) return cached;
      const me = sessionOf(inboxId);
      const entry = {
        own: new Set(
          [me?.jid, me?.lid].flatMap((j) => {
            const n = normalizeContactJid(j);
            return n ? [n] : [];
          }),
        ),
        name: me?.name?.trim() || null,
      };
      owners.set(inboxId, entry);
      return entry;
    };

    const nameFor = (jid: string, inboxId: number): MentionName => {
      const identity = aliases.resolve(jid);
      const { own, name: ownName } = ownOf(inboxId);
      if (own.has(jid) || own.has(identity))
        return { identity: [...own][0]!, known: true, name: ownName };
      // Stored phone contact/chat names may belong to the previous owner of a recycled number.
      if (aliases.movedAway(jid)) return { identity: jid, known: true, name: null };
      const group = aliases.group(jid).filter((id) => !aliases.movedAway(id));
      const records = group.flatMap((id) => (known.get(id) ? [known.get(id)!] : []));
      const meaningful = (name: string | null, id: string) => {
        const trimmed = name?.trim();
        return trimmed && trimmed !== id && trimmed !== jidUser(id) ? trimmed : null;
      };
      const best = (field: keyof Omit<KnownIdentity, 'jid'>) =>
        records.map((row) => meaningful(row[field], row.jid)).find(Boolean);
      return {
        identity,
        known: records.length > 0 || group.length > 1,
        name:
          best('profile_name') ||
          best('saved_name') ||
          best('chat_name') ||
          best('push_name') ||
          null,
      };
    };

    let resolvedMentionCount = 0;
    const out = [...messages];
    for (const plan of plans) {
      const replacements = replacementsFor(plan, (jid) => nameFor(jid, plan.inboxId));
      const message = messages[plan.index]!;
      const { body, count } = replaceMentions(message.body!, replacements);
      resolvedMentionCount += count;
      if (body !== message.body) out[plan.index] = { ...message, body };
    }
    log.debug(
      {
        messageCount: plans.length,
        legacyMessageCount: plans.filter((p) => p.legacy).length,
        resolvedMentionCount,
      },
      'message mention presentation',
    );
    return out;
  };
}

/** Rebuild mention previews at read time, so newly learned names do not leave stale numeric tags. */
export function createChatPresenter(ctx: AppContext, log: Pick<Logger, 'debug'>) {
  const withMentionNames = createMentionPresenter(ctx, log);
  const latest = ctx.db.prepare(`
    SELECT m.* FROM json_each(?) ids JOIN messages m ON m.rowid = (
      SELECT rowid FROM messages WHERE chat_jid = ids.value AND hidden_at IS NULL
      ORDER BY timestamp DESC, rowid DESC LIMIT 1
    )
  `);
  return (rows: ChatRow[]) => {
    const chats = rows.map((row) => rowToChat(row));
    const jids = rows
      .filter((row) => row.last_message_preview?.includes('@'))
      .map((row) => row.jid);
    if (!jids.length) return chats;
    const messages: MessageRow[] = [];
    for (let i = 0; i < jids.length; i += 500) {
      messages.push(...(latest.all(JSON.stringify(jids.slice(i, i + 500))) as MessageRow[]));
    }
    const presented = withMentionNames(
      messages,
      messages.map((row) => rowToMessage(row)),
    );
    const previews = new Map(
      presented.map((message, index) => [
        message.chatJid,
        previewOf({ ...messages[index]!, body: message.body }),
      ]),
    );
    return chats.map((chat) =>
      previews.has(chat.jid) ? { ...chat, lastMessagePreview: previews.get(chat.jid)! } : chat,
    );
  };
}
