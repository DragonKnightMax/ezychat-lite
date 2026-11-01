import {
  PRIMARY_INBOX_ID,
  chatKey,
  inboxOfKey,
  messageKey,
  parseChatKey,
  waMessageId,
} from '../inboxes/keys.js';

/**
 * Id maps of one Lite merge (design §5.8 step 3): Lite's inbox-1 chat keys and message ids become
 * inbox N keys, Lite's row ids become the ids the target database gave the copied rows.
 * Lookups that find nothing return null; the caller decides whether that skips the row or fails.
 */
export class IdMaps {
  readonly users = new Map<number, number>();
  readonly agents = new Map<number, number>();
  readonly documents = new Map<number, number>();
  readonly phrases = new Map<number, number>();
  readonly safetyItems = new Map<number, number>();

  constructor(readonly inboxId: number) {}

  /** Lite chat key (inbox 1) → chat key in inbox N; null for anything else. */
  chat(key: string | null | undefined): string | null {
    if (!key) return null;
    try {
      const { inboxId, waJid } = parseChatKey(key);
      return inboxId === PRIMARY_INBOX_ID ? chatKey(this.inboxId, waJid) : null;
    } catch {
      return null;
    }
  }

  /** Lite message id → message key in inbox N. A `local-` id (not sent yet) keeps its id. */
  message(id: string | null | undefined): string | null {
    if (!id) return null;
    if (id.startsWith('local-')) return id;
    try {
      if (inboxOfKey(id) !== PRIMARY_INBOX_ID) return null;
      return messageKey(this.inboxId, waMessageId(id));
    } catch {
      return null;
    }
  }

  user(id: unknown): number | null {
    return typeof id === 'number' ? (this.users.get(id) ?? null) : null;
  }

  agent(id: unknown): number | null {
    return typeof id === 'number' ? (this.agents.get(id) ?? null) : null;
  }

  /** Lite's inbox id (always 1) → N; other ids stay as they are. */
  inbox(id: unknown): unknown {
    return id === PRIMARY_INBOX_ID ? this.inboxId : id;
  }
}

const USER_KEYS = new Set(['assignedTo', 'previous', 'targetId', 'userId', 'updatedBy', 'by']);

/**
 * Rewrites the ids inside one audit `meta` / chat event `payload` JSON object (top level only):
 * chat keys, message ids, user, agent, inbox, Business context item, phrase and Safety item ids.
 * Token ids are dropped (tokens are never imported). Unknown keys and values stay as they are;
 * a value that does not parse is returned unchanged.
 */
export function remapJson(json: string, maps: IdMaps): string {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return json;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return json;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = remapValue(key, v, maps);
  }
  return JSON.stringify(out);
}

function remapValue(key: string, v: unknown, maps: IdMaps): unknown {
  if (
    key === 'chatJid' ||
    ((key === 'from' || key === 'to') && typeof v === 'string' && v.includes('@'))
  )
    return typeof v === 'string' ? (maps.chat(v) ?? v) : v;
  if (key === 'messageId') return typeof v === 'string' ? (maps.message(v) ?? v) : v;
  if (key === 'agentId') return maps.agent(v) ?? v;
  if (USER_KEYS.has(key)) return maps.user(v) ?? v;
  if (key === 'inboxId') return maps.inbox(v);
  if (key === 'inboxIds' && Array.isArray(v)) return v.map((id) => maps.inbox(id));
  if (key === 'documentId') return typeof v === 'number' ? (maps.documents.get(v) ?? v) : v;
  if (key === 'phraseId') return typeof v === 'number' ? (maps.phrases.get(v) ?? v) : v;
  if (key === 'itemId') return typeof v === 'number' ? (maps.safetyItems.get(v) ?? v) : v;
  if (key === 'tokenId') return null;
  return v;
}
