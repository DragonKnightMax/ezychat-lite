import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import mime from 'mime-types';
import type {
  Message,
  MessageDeletedBy,
  MessageEditedBy,
  MessageEditsResponse,
  MessageListQuery,
  MessageLocateResponse,
  MessageReaction,
  MessageStatus,
  MessageTemplate,
  MessageType,
  SendTemplateBody,
  SendTextBody,
} from '@ezychat/shared';
import type {
  SendResult,
  WaIncomingMessage,
  WaMessageEdit,
  WaMessageRevoke,
  WaMessageStatusUpdate,
  WaQuotedRef,
  WaReaction,
  WaSendOptions,
} from '@ezychat/wa';
import type { AppContext } from '../context.js';
import { errors, HttpError } from '../http/errors.js';
import { getAliases } from '../chats/aliases.js';
import { ChatRepo } from '../chats/repo.js';
import { isFallbackName } from '../chats/service.js';
import {
  PRIMARY_INBOX_ID,
  chatKey,
  inboxOfKey,
  messageKey,
  parseChatKey,
  waMessageId,
} from '../inboxes/keys.js';
import { MediaStore } from './media-store.js';
import { MessageRepo, previewOf, rowToMessage, STATUS_RANK, type MessageRow } from './repo.js';
import { SendQueue, type SendJob } from './send-queue.js';
import { DownloadLimiter } from './download-limiter.js';
import { createMentionPresenter, outgoingMentions } from './mentions.js';
import { OWN_REACTOR, createReactionPresenter, reactionRow } from './reactions.js';
import { VOICE_NOTE_MAX_SECONDS, voiceNoteSeconds, voiceNoteWaveform } from './voice-note.js';
import { TemplateCatalog, fillTemplate, templatesUnsupported } from './templates.js';
import { WINDOW_CLOSED, replyWindowOpen, windowClosedError } from '../inboxes/reply-window.js';
import { capabilitiesOf } from '../inboxes/types.js';
import { DELETE_WINDOW_MS, EDIT_WINDOW_MS, MessageChangeRepo, changeAuthor } from './changes.js';

/** The signed-in user who edits or deletes (permission checks). */
export interface ChangeUser {
  id: number;
  role: 'admin' | 'agent';
}

export interface MediaFile {
  path: string;
  mime: string;
  name: string | null;
}

/** live media downloads (and on-demand redownloads) running at once */
export const MEDIA_DOWNLOAD_CONCURRENCY = 2;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;

/** A group message WhatsApp took but reported an error for (some members' phones, not the send). */
export const GROUP_DELIVERY_ERROR = 'Some members may not have received this';

export interface MessageService {
  list(jid: string, q: MessageListQuery): { messages: Message[]; nextBefore: string | null };
  /**
   * Finds a stored message in this chat for "jump to the quoted message": never another chat's
   * message and never one hidden for the team (`found: false`).
   */
  locate(jid: string, id: string): MessageLocateResponse;
  /**
   * Stores a message WhatsApp delivered through `inboxId` (default inbox 1): chat key and message
   * id get the inbox suffix (keys.ts), so the same customer or group in two inboxes stays apart.
   */
  ingest(
    m: WaIncomingMessage,
    source: 'live' | 'history',
    inboxId?: number,
  ): Promise<Message | null>;
  /** `viaTokenId`: the MCP access token whose AI assistant sends it (marks it "via AI assistant"). */
  sendText(
    jid: string,
    body: SendTextBody,
    userId: number,
    opts?: { viaTokenId?: number },
  ): Message;
  /**
   * Sends an approved template (also outside the reply window): the stored message is the filled
   * body with the template's name and language, sent through the queue in order. 409
   * `templates_unsupported`, 400 `template_not_found` / `template_not_sendable` / `template_params`,
   * 503 offline (the template list is read from the connection).
   */
  sendTemplate(jid: string, body: SendTemplateBody, userId: number): Promise<Message>;
  /** `GET /inboxes/:id/templates`: the inbox's approved templates (cached 5 minutes). */
  listTemplates(inboxId: number, refresh?: boolean): Promise<MessageTemplate[]>;
  /** The message sent earlier with this clientId (send idempotency), or null. */
  byClientId(clientId: string): Message | null;
  sendMedia(
    jid: string,
    file: {
      buffer: Buffer;
      fileName: string;
      caption?: string;
      quotedId?: string;
      voiceNote?: boolean;
    },
    userId: number,
    clientId: string,
    opts?: { viaTokenId?: number },
  ): Promise<Message>;
  retry(id: string, userId: number): Message;
  /** A WhatsApp receipt from `inboxId` (default inbox 1); `u.id` is the WhatsApp message id. */
  applyStatus(u: WaMessageStatusUpdate, inboxId?: number): void;
  /**
   * A reaction WhatsApp delivered through `inboxId` (default inbox 1): stored by the reacted
   * message's key (kept until that message arrives when it is not stored yet), `emoji` '' removes
   * it. Emits `message:reactions` when a stored message's reactions changed. Never notifies.
   */
  applyReaction(r: WaReaction, source: 'live' | 'history', inboxId?: number): void;
  /**
   * `userId` reacts to a stored message as the linked number (`emoji` '' removes the reaction),
   * straight away, never queued: a late reaction confuses. Same refusals as a reply (removed inbox,
   * moved number, `local-` message); WhatsApp offline → WaUnavailableError (503). Emits
   * `message:reactions` and returns the message's reactions.
   */
  sendReaction(messageId: string, emoji: string, userId: number): Promise<MessageReaction[]>;
  /**
   * An edit WhatsApp delivered through `inboxId` (the customer's, or the linked phone's): applied
   * only by the message's own author in the same chat, kept until the message arrives when it is not
   * stored yet. Emits `message:updated`. Never notifies.
   */
  applyRemoteEdit(e: WaMessageEdit, source: 'live' | 'history', inboxId?: number): void;
  /** A delete for everyone WhatsApp delivered (its author, our phone or a group admin), as above. */
  applyRemoteDelete(r: WaMessageRevoke, source: 'live' | 'history', inboxId?: number): void;
  /**
   * `user` edits the text or caption of a message the team sent (the teammate who sent it, or an
   * admin), within `EDIT_WINDOW_MS`, straight away (never queued). 409 `not_supported` /
   * `edit_window_closed`; WhatsApp offline → WaUnavailableError (503). Emits `message:updated`.
   */
  editMessage(id: string, text: string, user: ChangeUser): Promise<Message>;
  /**
   * `everyone`: the teammate who sent it or an admin deletes it on WhatsApp too, within
   * `DELETE_WINDOW_MS` (409 `delete_window_closed`). `me`: admins hide it for the team and delete it on
   * the linked phone. A message still waiting to be sent is cancelled locally. Emits `message:updated`.
   */
  deleteMessage(id: string, scope: 'everyone' | 'me', user: ChangeUser): Promise<Message>;
  /** Earlier versions; the original of a deleted message (and its versions) only for admins. */
  messageEdits(id: string, isAdmin: boolean): MessageEditsResponse;
  mediaPath(id: string): MediaFile | null;
  redownload(id: string): Promise<Message>;
  /**
   * The one way to turn stored rows into outbound Messages (REST and socket): maps each row and
   * attaches `senderProfile` to inbound group messages (one batched lookup). Every path that returns
   * or emits a Message goes through this.
   */
  present(row: MessageRow): Message;
  presentAll(rows: MessageRow[]): Message[];
  /**
   * Media file for serving. A 'pending' (not yet fetched, e.g. history) message is downloaded on
   * demand first. Returns null when the message has no servable media, 'unavailable' when it was
   * pending but the download failed.
   */
  ensureMedia(id: string): Promise<MediaFile | null | 'unavailable'>;
  /** the outbound queue of inbox 1 (`queueFor(1)`) */
  readonly queue: SendQueue;
  /**
   * The outbound queue of one inbox (the bridge calls onConnected() on it): one phone offline never
   * holds back the others. Throws for an inbox without a WhatsApp connection (removed, unknown).
   */
  queueFor(inboxId: number): SendQueue;
  /** stops every queue */
  shutdown(): void;
}

export function encodeBefore(ts: number, id: string): string {
  return `${ts}_${id}`;
}

export function decodeBefore(s: string): { ts: number; id: string } | null {
  const i = s.indexOf('_');
  if (i <= 0) return null;
  const ts = Number(s.slice(0, i));
  const id = s.slice(i + 1);
  return Number.isFinite(ts) && id ? { ts, id } : null;
}

export function messageTypeForMime(m: string): MessageType {
  if (m === 'image/webp') return 'image';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

/** The tags a stored outgoing message carries (a damaged value tags nobody). */
function sentMentions(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((j): j is string => typeof j === 'string') : [];
  } catch {
    return [];
  }
}

function extFor(mimeType: string, fileName: string | null): string {
  const fromName = fileName && /\.([a-zA-Z0-9]{1,10})$/.exec(fileName)?.[1];
  return (mime.extension(mimeType) || fromName || 'bin').toString();
}

export interface MessageServiceDeps {
  now?: () => number;
  /** overrides for the queue (tests) */
  queue?: { spacingMs?: number; maxAgeMs?: number; sleep?: (ms: number) => Promise<void> };
  /** overrides for the media download limiter (tests) */
  downloads?: { concurrency?: number; timeoutMs?: number };
}

export function createMessageService(ctx: AppContext, deps?: MessageServiceDeps): MessageService {
  const repo = new MessageRepo(ctx.db);
  const chats = new ChatRepo(ctx.db);
  const media = new MediaStore(join(ctx.config.dataDir, 'media'));
  const now = deps?.now ?? Date.now;
  const log = ctx.log.child({ mod: 'messages' });
  const withMentionNames = createMentionPresenter(ctx, log);
  const reactions = createReactionPresenter(ctx);
  const changeRepo = new MessageChangeRepo(ctx.db);

  /** WA statuses that arrived before the local row was renamed to the WA id. */
  const earlyStatus = new Map<string, WaMessageStatusUpdate['status']>();
  /** chat jid → in-flight send promise (used to de-duplicate echoes of our own sends). */
  const inflight = new Map<string, Promise<unknown>>();
  const reconciliations = new Map<string, () => void>();

  /**
   * Rows → Messages, with each inbound group sender's customer profile and every message's
   * reactions (one batched lookup each).
   */
  const presentAll = (rows: MessageRow[]): Message[] => {
    const list = withMentionNames(
      rows,
      rows.map((row) => rowToMessage(row)),
    );
    const presented = reactions.attach(ctx.services.customers?.withSenderProfiles(list) ?? list);
    const edits = changeRepo.editCounts(
      rows.filter((r) => r.edited_at != null && r.deleted_at == null).map((r) => r.id),
    );
    // A deleted message shows no reactions (WhatsApp drops them with the message).
    const shown = presented.map((m) =>
      m.deletedAt != null
        ? { ...m, reactions: [] }
        : edits.has(m.id)
          ? { ...m, editCount: edits.get(m.id)! }
          : m,
    );
    // Nor a Safety finding: its reasons name the file and text the deletion hides.
    return (ctx.services.safety?.attach(shown) ?? shown).map((m) =>
      m.deletedAt != null && m.safety ? { ...m, safety: null } : m,
    );
  };
  const present = (row: MessageRow): Message => presentAll([row])[0]!;

  const emitChat = (jid: string) => {
    const chat = ctx.services.chats?.get(jid) ?? null;
    if (chat) ctx.bus.emit('chat:updated', chat);
    return chat;
  };

  const emitStatus = (r: MessageRow, newId?: string) => {
    ctx.bus.emit('message:status', {
      id: r.id,
      clientId: r.client_id,
      chatJid: r.chat_jid,
      status: r.status,
      error: r.error,
      ...(newId ? { newId } : {}),
    });
  };

  /** Bumps chat last-message fields if this message is the newest. */
  const touchChat = (r: MessageRow, t: number) => {
    const chat = chats.get(r.chat_jid);
    if (!chat) return;
    if (chat.last_message_at === null || r.timestamp >= chat.last_message_at) {
      chats.update(r.chat_jid, {
        last_message_at: r.timestamp,
        last_message_preview: previewOf(r),
        updated_at: t,
      });
    } else {
      chats.update(r.chat_jid, { updated_at: t });
    }
  };

  const { connections } = ctx.inboxes;
  /** The inbox's adapter, or null once the inbox is removed (or unknown). */
  const adapterOf = (inboxId: number) => {
    try {
      return connections.adapter(inboxId);
    } catch {
      return null;
    }
  };
  /** An inbox that never sends again: removed (or unknown). */
  const inboxRemoved = (inboxId: number): boolean => {
    if (inboxId === PRIMARY_INBOX_ID) return false;
    const row = ctx.inboxes.repo.get(inboxId);
    return !row || row.removed_at !== null;
  };
  /**
   * An active inbox without a WhatsApp connection in this build (over the edition's inbox limit).
   * Its pending sends stay pending; new sends are refused.
   */
  const inboxUnconnected = (inboxId: number): boolean =>
    inboxId !== PRIMARY_INBOX_ID && !inboxRemoved(inboxId) && adapterOf(inboxId) === null;
  /** Sending into a chat of this inbox is refused now (409 with a reason code). */
  const refuseSend = (inboxId: number): void => {
    if (inboxRemoved(inboxId)) throw new HttpError(409, 'inbox_removed', 'This inbox was removed');
    if (inboxUnconnected(inboxId))
      throw new HttpError(
        409,
        'inbox_not_connected',
        'This inbox is not connected in this edition',
      );
  };
  const ownJidOf = (chatJid: string): string | null =>
    adapterOf(inboxOfKey(chatJid))?.status.me?.jid ?? null;
  /** The WhatsApp JID of a chat key (no inbox suffix). */
  const waJidOf = (chatJid: string): string => parseChatKey(chatJid).waJid;

  /**
   * Pending rows a person re-sent with Retry. The AI's own send check guards only its automatic
   * replies: once WhatsApp first took a reply, the AI counts the question as answered and that check
   * would refuse every retry. Kept in memory: after a restart the check applies again.
   */
  const manualRetries = new Set<string>();

  /**
   * Text for an ERROR ack. In a group WhatsApp reports one error for the whole message even when
   * only some members' phones could not take it, so it is not called a plain failure there.
   */
  const deliveryError = (chatJid: string): string =>
    waJidOf(chatJid).endsWith('@g.us') ? GROUP_DELIVERY_ERROR : 'Delivery failed';

  /** Receipts that prove a phone took the message. */
  const RECEIVED: ReadonlySet<MessageStatus> = new Set<MessageStatus>(['delivered', 'read']);

  const logAckError = (id: string, u: WaMessageStatusUpdate): void => {
    log.warn({ id, chatJid: u.chatJid, code: u.error ?? null }, 'whatsapp error ack');
  };

  /**
   * A receipt for a send whose result has not been stored yet. A failure outranks a plain server ack
   * (they may arrive in any order), but a delivered or read receipt proves someone has the message.
   */
  const rememberEarlyStatus = (id: string, status: WaMessageStatusUpdate['status']): void => {
    if (earlyStatus.size > 500) earlyStatus.clear();
    const prev = earlyStatus.get(id);
    if (prev === 'failed' && !RECEIVED.has(status)) return;
    if (!prev || status === 'failed' || STATUS_RANK[status] > STATUS_RANK[prev])
      earlyStatus.set(id, status);
  };

  /** The row change a receipt makes to a stored outgoing message, or null for none. */
  const nextStatus = (
    r: MessageRow,
    status: WaMessageStatusUpdate['status'],
  ): { status: MessageStatus; error?: string | null } | null => {
    if (status === 'failed') {
      // In a group the error may concern only some members' phones.
      if (r.status !== 'pending' && r.status !== 'sent') return null;
      return { status, error: r.error ?? deliveryError(r.chat_jid) };
    }
    // Someone received it after all: it is not failed (a plain server ack proves nothing).
    if (r.status === 'failed') return RECEIVED.has(status) ? { status, error: null } : null;
    return STATUS_RANK[status] > STATUS_RANK[r.status] ? { status } : null;
  };

  const sendJob = async (job: SendJob): Promise<SendResult> => {
    const inboxId = inboxOfKey(job.chatJid);
    const wa = connections.adapter(inboxId);
    const row = repo.get(job.localId);
    if (!row || row.status !== 'pending') throw new Error('Message is no longer pending');
    // a free-form message whose reply window closed while it waited is never sent (not retried)
    if (job.kind !== 'template' && !replyWindowOpen(ctx, job.chatJid, now()))
      throw new Error(WINDOW_CLOSED);
    if (
      !manualRetries.has(job.localId) &&
      row.sent_by_user_id &&
      ctx.services.auth?.getUser(row.sent_by_user_id)?.kind === 'ai' &&
      !ctx.services.ai?.canSend(job.chatJid, row.sent_by_user_id, job.quotedId)
    ) {
      throw new Error('AI reply cancelled because chat ownership changed');
    }
    // Echoes must wait until the queue commits sender provenance, not merely until WA returns.
    const guard = new Promise<void>((resolve) => {
      reconciliations.set(job.localId, () => {
        if (inflight.get(job.chatJid) === guard) inflight.delete(job.chatJid);
        reconciliations.delete(job.localId);
        resolve();
      });
    });
    inflight.set(job.chatJid, guard);
    const p = (async () => {
      const resend = job.resendId ? { messageId: job.resendId } : {};
      const withResend = (o: WaSendOptions | undefined): WaSendOptions | undefined =>
        job.resendId ? { ...o, ...resend } : o;
      if (job.kind === 'text') {
        const reply = replyOptions(job.quotedId);
        return wa.sendText(
          job.targetJid,
          job.text ?? '',
          withResend(job.mentions?.length ? { ...reply, mentions: job.mentions } : reply),
        );
      }
      if (job.kind === 'template') {
        if (!wa.sendTemplate || !job.template) throw new Error('templates_unsupported');
        return wa.sendTemplate(job.targetJid, job.template);
      }
      const buffer = readFileSync(media.abs(job.mediaPath!));
      const seconds = job.voiceNote ? voiceNoteSeconds(buffer) : null;
      return wa.sendMedia(
        job.targetJid,
        {
          buffer,
          mime: job.mime ?? 'application/octet-stream',
          fileName: job.fileName ?? 'file',
          ...(job.caption ? { caption: job.caption } : {}),
          // Checked on upload; a file that no longer parses goes out as a plain audio file.
          ...(seconds !== null
            ? { voiceNote: { seconds, waveform: voiceNoteWaveform(buffer) } }
            : {}),
        },
        withResend(replyOptions(job.quotedId)),
      );
    })();
    try {
      const r = await p;
      // stored ids carry the inbox suffix; the queue hands this id to onSent
      return { ...r, id: messageKey(inboxId, r.id) };
    } catch (error) {
      reconciliations.get(job.localId)?.();
      throw error;
    }
  };

  const onSent = (job: SendJob, r: SendResult) => {
    manualRetries.delete(job.localId);
    try {
      const row = repo.get(job.localId);
      if (!row) return;
      const waId = r.id; // the stored message key (sendJob added the inbox suffix)
      ctx.db.transaction(() => {
        if (waId !== job.localId) {
          // an echo of our own send may already have been ingested under the WA id
          if (repo.exists(waId)) repo.delete(waId);
          repo.rename(job.localId, waId);
        }
        const early = earlyStatus.get(waId);
        earlyStatus.delete(waId);
        // A retry under the same WhatsApp id keeps its row, so receipts may already have moved it on.
        const current = repo.get(waId)?.status;
        if (early === 'failed' || current === 'failed') {
          // an ERROR ack arrived before the send result: keep the failure
          repo.update(waId, { status: 'failed', error: deliveryError(job.chatJid) });
        } else {
          let status: MessageStatus = 'sent';
          for (const s of [early, current])
            if (s && STATUS_RANK[s] > STATUS_RANK[status]) status = s;
          repo.update(waId, { status, error: null });
        }
      })();
      const updated = repo.get(waId)!;
      emitStatus({ ...updated, status: 'sent' }, waId);
      if (updated.status !== 'sent') emitStatus(updated);
      // Deleted while WhatsApp was already sending it: delete it there too.
      if (updated.deleted_at != null && updated.deleted_by === 'team') void deleteSentLate(updated);
    } finally {
      reconciliations.get(job.localId)?.();
    }
  };

  const onFailed = (job: SendJob, err: Error) => {
    manualRetries.delete(job.localId);
    try {
      const row = repo.get(job.localId);
      if (!row || row.status !== 'pending') return;
      const msg = err.message || 'Send failed';
      repo.update(job.localId, { status: 'failed', error: msg });
      log.warn({ id: job.localId, chatJid: job.chatJid, err: msg }, 'send failed');
      emitStatus(repo.get(job.localId)!);
    } finally {
      reconciliations.get(job.localId)?.();
    }
  };

  /** One send queue per inbox, each waiting only for its own phone. */
  const queues = new Map<number, SendQueue>();
  let stopped = false;
  const queueFor = (inboxId: number): SendQueue => {
    const existing = queues.get(inboxId);
    if (existing) return existing;
    connections.adapter(inboxId); // throws for a removed or unknown inbox
    // read the adapter on every use: a type change swaps it and the queue keeps its jobs
    const q = new SendQueue({
      send: sendJob,
      onSent,
      onFailed,
      isConnected: () => adapterOf(inboxId)?.status.state === 'open',
      // Access gate closed: nothing is sent and nothing expires; jobs stay pending.
      isPaused: () => !ctx.access.state().open,
      presence: async (job) => adapterOf(inboxId)?.sendPresence(job.targetJid, 'composing'),
      now,
      ...(deps?.queue ?? {}),
    });
    if (stopped) q.stop();
    queues.set(inboxId, q);
    return q;
  };
  const queue = queueFor(PRIMARY_INBOX_ID);

  const INBOX_REMOVED_MESSAGE = 'This inbox was removed';

  /** Pending sends of a removed inbox fail at once: its phone is unlinked and never sends them. */
  const failPendingOf = (inboxId: number): void => {
    for (const r of repo.pendingLocal()) {
      if (inboxOfKey(r.chat_jid) !== inboxId) continue;
      repo.update(r.id, { status: 'failed', error: INBOX_REMOVED_MESSAGE });
      emitStatus(repo.get(r.id)!);
    }
  };

  const onInboxRemoved = (inboxId: number, _wa: unknown, reason: 'removed' | 'replaced'): void => {
    // a type change keeps the inbox: its queue goes on with the new adapter
    if (reason === 'replaced') return;
    const q = queues.get(inboxId);
    queues.delete(inboxId);
    q?.stop();
    try {
      failPendingOf(inboxId);
    } catch (err) {
      log.warn({ err, inboxId }, 'pending sends of a removed inbox not failed');
    }
  };
  connections.on('removed', onInboxRemoved);

  /** `address` still belongs to the person of `chatJid` (not a number recycled to someone else). */
  const addressOf = (address: string, chatJid: string): boolean => {
    const { inboxId, waJid } = parseChatKey(chatJid);
    if (address === waJid) return true;
    const aliases = getAliases(ctx);
    return aliases.resolve(address) === waJid || aliases.route(inboxId, address) === chatJid;
  };

  /**
   * Restored and retried jobs re-check their stored target: a number re-pointed to another person
   * since the message was queued falls back to the chat JID (persisted on the row).
   */
  const jobTarget = (r: MessageRow): string => {
    const chatWaJid = waJidOf(r.chat_jid);
    const stored = r.wa_remote_jid ?? chatWaJid;
    if (addressOf(stored, r.chat_jid)) return stored;
    repo.update(r.id, { wa_remote_jid: chatWaJid });
    log.warn(
      { id: r.id, chatJid: r.chat_jid, stored },
      'send target moved to another WhatsApp ID; sending to the chat instead',
    );
    return chatWaJid;
  };

  const MOVED_NUMBER_MESSAGE =
    'This phone number now belongs to a different WhatsApp account; reply from the current chat.';

  /** The chat's own phone number was re-pointed to another person: nothing may be sent from it. */
  const chatNumberMoved = (chatJid: string): boolean => getAliases(ctx).movedAway(waJidOf(chatJid));

  const failMoved = (r: MessageRow): void => {
    log.warn(
      { id: r.id, chatJid: r.chat_jid },
      'send refused: chat number moved to another WhatsApp ID',
    );
    repo.update(r.id, { status: 'failed', error: MOVED_NUMBER_MESSAGE });
    emitStatus(repo.get(r.id)!);
  };

  /** Queue a row's send, or fail it when its chat's number now belongs to someone else. */
  const enqueueRow = (r: MessageRow): void => {
    if (chatNumberMoved(r.chat_jid)) failMoved(r);
    else queueFor(inboxOfKey(r.chat_jid)).enqueue(jobFromRow(r));
  };

  const jobFromRow = (r: MessageRow): SendJob => {
    const base = {
      localId: r.id,
      chatJid: r.chat_jid,
      targetJid: jobTarget(r),
      createdAt: r.created_at,
      ...(r.quoted_id ? { quotedId: r.quoted_id } : {}),
      ...(r.id.startsWith('local-') ? {} : { resendId: waMessageId(r.id) }),
    };
    if (r.template_name) {
      let params: string[] = [];
      try {
        const parsed = JSON.parse(r.template_params ?? '[]') as unknown;
        if (Array.isArray(parsed)) params = parsed.map(String);
      } catch {
        // a damaged row sends no values; the connection refuses it and the message fails
      }
      return {
        ...base,
        kind: 'template',
        template: { name: r.template_name, language: r.template_language ?? '', params },
      };
    }
    if (r.media_path) {
      return {
        ...base,
        kind: 'media',
        mediaPath: r.media_path,
        mime: r.media_mime ?? 'application/octet-stream',
        fileName: r.media_name ?? 'file',
        ...(r.body ? { caption: r.body } : {}),
        ...(r.voice_note === 1 ? { voiceNote: true } : {}),
      };
    }
    const mentions = sentMentions(r.mentioned_jids);
    return { ...base, kind: 'text', text: r.body ?? '', ...(mentions.length ? { mentions } : {}) };
  };

  /**
   * Where a reply goes: the address of the customer's last inbound message (PN or LID, as WhatsApp
   * delivered it), unless that address now belongs to someone else (a recycled number) → the chat JID.
   */
  const replyTarget = (chatJid: string): string => {
    const last = repo.lastInboundRemoteJid(chatJid);
    return last && addressOf(last, chatJid) ? last : waJidOf(chatJid);
  };

  const requireChat = (jid: string) => {
    const c = chats.get(jid);
    if (!c) throw errors.notFound('Chat');
    return c;
  };

  /**
   * Members a text tags: only in a group, only through a connection that sends WhatsApp mentions
   * (400 otherwise), and each written in the text as its `@<number>` tag.
   */
  const checkMentions = (jid: string, text: string, mentions: string[] | undefined): string[] => {
    if (!mentions?.length) return [];
    if (requireChat(jid).type !== 'group')
      throw errors.validation('mentions: only group messages tag members');
    const wa = adapterOf(inboxOfKey(jid));
    if (!wa || capabilitiesOf(wa).mentions !== true)
      throw errors.validation('mentions: this connection cannot tag members');
    return outgoingMentions(text, mentions);
  };

  /** Sending needs the chat's inbox: a removed inbox keeps its chats read only. */
  const requireSendable = (jid: string) => {
    const c = requireChat(jid);
    refuseSend(inboxOfKey(jid));
    return c;
  };

  /** Free-form messages only while the chat's reply window is open (409 `window_closed`). */
  const requireWindow = (jid: string) => {
    if (!replyWindowOpen(ctx, jid, now())) throw windowClosedError();
  };

  const templates = new TemplateCatalog(now);

  /**
   * A reply may quote only a message of the same chat that WhatsApp knows: pending and failed
   * messages still carry their `local-` id, which no phone could match.
   */
  const checkQuote = (jid: string, quotedId: string | undefined): string | null => {
    if (!quotedId) return null;
    const q = repo.get(quotedId);
    if (!q || q.chat_jid !== jid || q.id.startsWith('local-')) {
      throw errors.validation('The message you are replying to is not in this chat');
    }
    return q.id;
  };

  /** Saved copy of the quoted message, so the quote survives the adapter's small live cache. */
  const quotedRef = (quotedId: string): WaQuotedRef | undefined => {
    const q = repo.get(quotedId);
    if (!q) return undefined;
    return {
      id: waMessageId(q.id),
      fromMe: q.from_me === 1,
      senderJid: q.sender_jid,
      type: q.type,
      text: q.body,
    };
  };
  /** WhatsApp sees its own message ids: the stored key loses its inbox suffix. */
  const replyOptions = (quotedId: string | undefined): WaSendOptions | undefined => {
    if (!quotedId) return undefined;
    const quoted = quotedRef(quotedId);
    const waId = waMessageId(quotedId);
    return quoted ? { quotedId: waId, quoted } : { quotedId: waId };
  };

  const isAiUser = (userId: number) =>
    (
      ctx.db.prepare('SELECT kind FROM users WHERE id = ?').get(userId) as
        { kind: string } | undefined
    )?.kind === 'ai';

  /**
   * Whoever handles a chat owns it: the first teammate to reply in an unassigned chat becomes its
   * owner, and a teammate replying in a chat the AI owns takes it over (the AI then stops). A human
   * owner is kept when another teammate replies; replies from the linked phone (no user) change nothing.
   */
  const claimOnReply = (jid: string, userId: number, t: number) => {
    const chat = requireChat(jid);
    const owner = chat.assigned_to;
    if (owner === userId) return;
    // An AI answer in a WhatsApp group never takes the group: it keeps its assignee (or none).
    if (chat.type === 'group' && isAiUser(userId)) return;
    if (owner !== null && !(isAiUser(owner) && !isAiUser(userId))) return;
    chats.update(jid, { assigned_to: userId, updated_at: t });
    const ev = chats.insertEvent({
      chatJid: jid,
      type: 'assigned',
      actorId: userId,
      payload: { assignedTo: userId, previous: owner, reason: 'reply' },
      at: t,
    });
    ctx.bus.emit('chat:event', ev);
  };

  const insertOutgoing = (row: MessageRow): Message => {
    const t = row.created_at;
    repo.insert(row);
    touchChat(row, t);
    const msg = present(repo.get(row.id)!);
    ctx.bus.emit('message:new', msg);
    emitChat(row.chat_jid);
    enqueueRow(row);
    return msg;
  };

  const downloads = new DownloadLimiter({
    concurrency: deps?.downloads?.concurrency ?? MEDIA_DOWNLOAD_CONCURRENCY,
    timeoutMs: deps?.downloads?.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS,
  });
  const redownloads = new Map<string, Promise<Message>>();

  const doRedownload = async (id: string): Promise<Message> => {
    const r = repo.get(id);
    if (!r || r.deleted_at != null || r.hidden_at != null) throw errors.notFound('Message');
    if (r.type === 'text' || r.type === 'system') throw errors.validation('Message has no media');
    let buf: Buffer | null = null;
    try {
      // the chat's own phone, asked with the WhatsApp id (no inbox suffix)
      buf = await downloads.run(() =>
        connections.forChatKey(r.chat_jid).downloadMedia(waMessageId(id)),
      );
    } catch (err) {
      log.warn({ err, id }, 'media redownload failed');
    }
    if (!buf) {
      repo.update(id, { media_status: 'failed' });
      throw errors.conflict('Media is no longer available');
    }
    const mimeType =
      r.media_mime ??
      (await fileTypeFromBuffer(buf).catch(() => undefined))?.mime ??
      'application/octet-stream';
    const rel = media.save(r.chat_jid, id, buf, extFor(mimeType, r.media_name));
    repo.update(id, { media_path: rel, media_mime: mimeType, media_status: 'ok' });
    return present(repo.get(id)!);
  };

  /** The chat list preview follows the newest message the team still sees. */
  const refreshPreview = (chatJid: string, quiet = false) => {
    const newest = repo.newestVisible(chatJid);
    chats.update(chatJid, {
      last_message_preview: newest ? previewOf(newest) : null,
      updated_at: now(),
    });
    if (!quiet) emitChat(chatJid);
  };
  const emitUpdated = (id: string) => {
    const row = repo.get(id);
    if (row) ctx.bus.emit('message:updated', present(row));
  };

  const recordEdit = (
    row: MessageRow,
    body: string,
    at: number,
    by: MessageEditedBy,
    userId: number | null,
    quiet = false,
  ) => {
    ctx.db.transaction(() => {
      changeRepo.addEdit(row.id, row.body, at, by, userId);
      repo.update(row.id, { body, edited_at: at });
    })();
    refreshPreview(row.chat_jid, quiet);
    if (!quiet) emitUpdated(row.id);
  };

  const recordDelete = (
    row: MessageRow,
    at: number,
    by: MessageDeletedBy,
    userId: number | null,
    quiet = false,
  ) => {
    repo.update(row.id, {
      deleted_at: at,
      deleted_by: by,
      deleted_by_user_id: userId,
      // A message still waiting to be sent is cancelled (the queue skips it).
      ...(row.status === 'pending' ? { status: 'failed', error: 'Deleted before sending' } : {}),
    });
    refreshPreview(row.chat_jid, quiet);
    if (!quiet) emitUpdated(row.id);
  };

  /** The chat key a change WhatsApp delivered belongs to (routed like a message). */
  const changeChat = (chatJid: string, inboxId: number) =>
    chatJid.endsWith('@g.us') ? chatKey(inboxId, chatJid) : getAliases(ctx).route(inboxId, chatJid);

  /** Apply one change WhatsApp reported; false when it is ignored (other chat or author, repeat). */
  const applyRemoteChange = (
    row: MessageRow,
    c: {
      kind: 'edit' | 'delete';
      fromMe: boolean;
      senderJid: string | null;
      body: string;
      timestamp: number;
    },
    chatJid: string,
    quiet = false,
  ): boolean => {
    if (row.chat_jid !== chatJid) {
      log.warn({ messageId: row.id, kind: c.kind }, 'message change from another chat ignored');
      return false;
    }
    if (row.type === 'system' || row.deleted_at != null) return false;
    const isGroup = waJidOf(row.chat_jid).endsWith('@g.us');
    const by = changeAuthor(row, c, c.kind, isGroup, getAliases(ctx));
    if (!by) {
      log.warn({ messageId: row.id, kind: c.kind }, 'message change by another author ignored');
      return false;
    }
    if (c.kind === 'edit') {
      // a repeat (e.g. our own edit's echo) or an older edit arriving late changes nothing
      if (c.body === row.body || c.timestamp < (row.edited_at ?? 0)) return false;
      recordEdit(row, c.body, c.timestamp, by as MessageEditedBy, null, quiet);
    } else {
      recordDelete(row, c.timestamp, by, null, quiet);
    }
    log.info(
      { messageId: row.id, chatJid: row.chat_jid, kind: c.kind, by },
      'message changed on WhatsApp',
    );
    return true;
  };

  const learnChangeAliases = (c: WaMessageRevoke, source: 'live' | 'history') => {
    const aliases = getAliases(ctx);
    const learnedFrom = source === 'history' ? 'history' : 'message';
    if (c.chatJid.endsWith('@g.us')) {
      if (c.senderJid && c.senderJidAlt)
        aliases.learn({ jid: c.senderJid, alias: c.senderJidAlt }, learnedFrom);
    } else if (c.chatJidAlt) {
      aliases.learn({ jid: c.chatJid, alias: c.chatJidAlt }, learnedFrom);
    }
  };

  const remoteChange = (
    kind: 'edit' | 'delete',
    c: WaMessageRevoke & { body?: string },
    source: 'live' | 'history',
    inboxId: number,
  ) => {
    learnChangeAliases(c, source);
    const id = messageKey(inboxId, c.targetId);
    const chatJid = changeChat(c.chatJid, inboxId);
    const change = {
      kind,
      fromMe: c.fromMe,
      senderJid: c.senderJid,
      body: c.body ?? '',
      timestamp: c.timestamp,
    };
    const row = repo.get(id);
    if (row) {
      applyRemoteChange(row, change, chatJid);
      return;
    }
    // Not stored yet (history order): applied when the message arrives.
    changeRepo.savePending({
      message_id: id,
      kind,
      chat_jid: chatJid,
      from_me: c.fromMe ? 1 : 0,
      sender_jid: c.senderJid,
      body: kind === 'edit' ? change.body : null,
      changed_at: c.timestamp,
      received_at: now(),
    });
  };

  /** Edit or delete for everyone: a message the team sent, by its teammate or an admin. */
  const requireOwnChange = (r: MessageRow, user: ChangeUser, verb: 'edited' | 'deleted') => {
    if (r.type === 'system') throw errors.validation(`This message cannot be ${verb}`);
    if (r.deleted_at != null) throw errors.conflict('This message was deleted');
    if (r.from_me !== 1) throw errors.validation(`Only messages the team sent can be ${verb}`);
    if (user.role !== 'admin' && r.sent_by_user_id !== user.id)
      throw errors.forbidden(
        `Only the teammate who sent it or an admin can ${verb.slice(0, -1)} it`,
      );
    requireSendable(r.chat_jid);
    if (chatNumberMoved(r.chat_jid)) throw errors.conflict(MOVED_NUMBER_MESSAGE);
  };

  const NOT_SUPPORTED = 'This WhatsApp connection cannot do this';
  /** The chat's connection, when it can make this change (409 `not_supported` otherwise). */
  const changeAdapter = (
    chatJid: string,
    can: 'editMessage' | 'deleteForEveryone' | 'deleteForMe',
  ) => {
    const wa = connections.adapter(inboxOfKey(chatJid));
    const method =
      can === 'editMessage'
        ? wa.editText
        : can === 'deleteForEveryone'
          ? wa.deleteForEveryone
          : wa.deleteForMe;
    if (!capabilitiesOf(wa)[can] || !method)
      throw new HttpError(409, 'not_supported', NOT_SUPPORTED);
    return wa;
  };

  /** The chat address a stored message lives at (phone number or WhatsApp ID), as for reactions. */
  const messageAddress = (r: MessageRow): string => {
    const stored = r.wa_remote_jid ?? waJidOf(r.chat_jid);
    return addressOf(stored, r.chat_jid) ? stored : waJidOf(r.chat_jid);
  };

  /** A send that finished after the teammate deleted it: delete it on WhatsApp as well. */
  const deleteSentLate = async (r: MessageRow) => {
    try {
      const wa = adapterOf(inboxOfKey(r.chat_jid));
      if (!wa?.deleteForEveryone || !capabilitiesOf(wa).deleteForEveryone) return;
      await wa.deleteForEveryone(messageAddress(r), {
        id: waMessageId(r.id),
        fromMe: true,
        participant: null,
      });
      log.info({ messageId: r.id, chatJid: r.chat_jid }, 'message deleted after a late send');
    } catch (err) {
      log.warn({ err, messageId: r.id }, 'late delete for everyone failed');
    }
  };

  const svc: MessageService = {
    queue,
    queueFor,
    present,
    presentAll,

    list(jid, q) {
      let before: { ts: number; id: string } | null = null;
      if (q.before) {
        before = decodeBefore(q.before);
        if (!before) throw errors.validation('Invalid before cursor');
      }
      const rows = repo.pageDesc(jid, before, q.limit + 1);
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      const oldest = page[page.length - 1];
      return {
        messages: presentAll([...page].reverse()),
        nextBefore: more && oldest ? encodeBefore(oldest.timestamp, oldest.id) : null,
      };
    },

    locate(jid, id) {
      const row = repo.get(id);
      if (!row || row.chat_jid !== jid || row.hidden_at != null) return { found: false, newer: 0 };
      return { found: true, newer: repo.countNewer(jid, row.timestamp, row.id) };
    },

    async ingest(m, source, inboxId = PRIMARY_INBOX_ID) {
      // The same WhatsApp id may arrive through two inboxes (one group, two linked phones).
      const id = messageKey(inboxId, m.id);
      if (repo.exists(id)) return null;
      const isGroup = m.chatJid.endsWith('@g.us');
      const aliases = getAliases(ctx);
      if (isGroup && m.senderJid && m.senderJidAlt) {
        aliases.learn(
          { jid: m.senderJid, alias: m.senderJidAlt },
          source === 'history' ? 'history' : 'message',
        );
      }
      if (!isGroup && m.chatJidAlt) {
        // Persist the pair; routing never merges (a second chat waits for the next start).
        aliases.learn(
          { jid: m.chatJid, alias: m.chatJidAlt },
          source === 'history' ? 'history' : 'message',
        );
      }
      // One person, one chat per inbox: the existing chat of either address (the LID chat first).
      const directKey = chatKey(inboxId, m.chatJid);
      const chatJid = isGroup ? directKey : aliases.route(inboxId, m.chatJid);
      const chatWaJid = waJidOf(chatJid);
      // Our own send may echo before the queue has committed its WhatsApp id and sender. The guard
      // is keyed by the chat the send came from: the routed chat, or a PN chat still kept separate.
      const guard = m.fromMe ? (inflight.get(chatJid) ?? inflight.get(directKey)) : undefined;
      if (guard) {
        await guard;
        if (repo.exists(id)) return null;
      }
      const t = now();
      chats.ensure(inboxId, chatWaJid, { name: !isGroup && !m.fromMe ? m.senderName : null }, t);
      const chatBefore = chats.get(chatJid)!;

      const row: MessageRow = {
        id,
        chat_jid: chatJid,
        sender_jid: m.senderJid,
        sender_name: m.senderName,
        from_me: m.fromMe ? 1 : 0,
        sent_by_user_id: null,
        type: m.type,
        body: m.body,
        mentioned_jids: m.mentionedJids === undefined ? null : JSON.stringify(m.mentionedJids),
        media_path: null,
        media_mime: m.media?.mime ?? null,
        media_name: m.media?.fileName ?? null,
        media_status: m.media ? 'pending' : 'none',
        quoted_id: m.quotedId ? messageKey(inboxId, m.quotedId) : null,
        status: m.fromMe ? 'sent' : 'delivered',
        error: null,
        timestamp: m.timestamp,
        created_at: t,
        client_id: null,
        wa_remote_jid: m.chatJid,
      };
      if (!repo.insert(row)) return null; // concurrent duplicate

      const isNewLiveInbound = source === 'live' && !m.fromMe;
      let reopened = false;
      ctx.db.transaction(() => {
        touchChat(row, t);
        if (isNewLiveInbound) {
          // the customer wrote: a reply window (Business API) runs from this message
          ctx.db
            .prepare(
              'UPDATE chats SET unread_count = unread_count + 1, last_inbound_at = MAX(COALESCE(last_inbound_at, 0), ?) WHERE jid = ?',
            )
            .run(m.timestamp, chatJid);
          const cur = chats.get(chatJid)!;
          if (cur.status === 'resolved') {
            chats.update(chatJid, { status: 'open', updated_at: t });
            reopened = true;
          }
        }
        if (!isGroup && !m.fromMe && m.senderName && isFallbackName(chatBefore.name, chatWaJid)) {
          chats.setName(chatJid, m.senderName, t);
        }
        if (m.senderJid && m.senderName && !m.fromMe) {
          chats.upsertContact({ jid: m.senderJid, pushName: m.senderName, savedName: null });
        }
      })();
      if (reopened) {
        const ev = chats.insertEvent({
          chatJid,
          type: 'reopened',
          actorId: null,
          payload: { reason: 'inbound' },
          at: t,
        });
        ctx.bus.emit('chat:event', ev);
      }

      if (source === 'live') {
        // AI Sales Agent trigger (#18): keyed by the routed chat, where its ai_chat_state lives.
        ctx.bus.emit('message:received', {
          chat: ctx.services.chats!.get(chatJid)!,
          message: present(row),
        });
      }

      // History media stays 'pending' (mime/name kept) and is fetched on demand (ensureMedia /
      // redownload): eagerly pulling every history file from the CDN floods the network and used
      // to crash the server on a single ECONNRESET. Live media downloads through the limiter.
      let mediaBytes: Buffer | null = null;
      let mediaRel: string | null = null;
      if (m.media && source === 'live') {
        const dl = m.media.download;
        try {
          const buf = await downloads.run(() => dl());
          const rel = media.save(chatJid, id, buf, extFor(m.media.mime, m.media.fileName));
          repo.update(id, { media_path: rel, media_status: 'ok' });
          mediaBytes = buf;
          mediaRel = rel;
          // Live customer voice notes are transcribed (marked pending before message:new).
          if (m.type === 'audio' && !m.fromMe) ctx.services.voice?.onAudioStored(id);
        } catch (err) {
          log.warn({ err, id }, 'media download failed');
          repo.update(id, { media_status: 'failed' });
        }
      }

      // WhatsApp Safety: every message from a customer, before the team sees it (history: name and
      // text only, the file is not downloaded yet). It may lock the file and changes no message text.
      if (!m.fromMe && m.type !== 'audio' && m.type !== 'sticker')
        ctx.services.safety?.inspect({
          messageId: id,
          chatJid,
          inboxId,
          senderWaJid: isGroup ? m.senderJid : chatWaJid,
          group: isGroup,
          live: source === 'live',
          text: m.body,
          file: m.media
            ? { name: m.media.fileName, mime: m.media.mime, rel: mediaRel, bytes: mediaBytes }
            : null,
        });

      // Edits and deletes WhatsApp delivered before the message itself (history order).
      for (const p of changeRepo.takePending(id)) {
        const current = repo.get(id);
        if (current)
          applyRemoteChange(
            current,
            {
              kind: p.kind,
              fromMe: p.from_me === 1,
              senderJid: p.sender_jid,
              body: p.body ?? '',
              timestamp: p.changed_at,
            },
            p.chat_jid,
            true,
          );
      }

      const final = repo.get(id);
      if (!final) return null;
      const msg = present(final);
      ctx.bus.emit('message:new', msg);
      const chat = emitChat(chatJid);
      if (isNewLiveInbound && chat) ctx.bus.emit('inbound:notify', { chat, message: msg });
      return msg;
    },

    byClientId(clientId) {
      const row = repo.byClientId(clientId);
      return row ? present(row) : null;
    },

    sendText(jid, body, userId, opts) {
      const existing = repo.byClientId(body.clientId);
      if (existing) return present(existing);
      requireSendable(jid);
      if (chatNumberMoved(jid)) throw errors.conflict(MOVED_NUMBER_MESSAGE);
      requireWindow(jid);
      const quotedId = checkQuote(jid, body.quotedId);
      const mentions = checkMentions(jid, body.text, body.mentions);
      const t = now();
      claimOnReply(jid, userId, t);
      return insertOutgoing({
        id: `local-${body.clientId}`,
        chat_jid: jid,
        sender_jid: ownJidOf(jid),
        sender_name: null,
        from_me: 1,
        sent_by_user_id: userId,
        type: 'text',
        body: body.text,
        media_path: null,
        media_mime: null,
        media_name: null,
        media_status: 'none',
        quoted_id: quotedId,
        status: 'pending',
        error: null,
        timestamp: t,
        created_at: t,
        client_id: body.clientId,
        wa_remote_jid: replyTarget(jid),
        sent_via_token_id: opts?.viaTokenId ?? null,
        // Kept with the message: the queue sends them, and the bubble names the tagged members.
        mentioned_jids: mentions.length ? JSON.stringify(mentions) : '[]',
      });
    },

    async listTemplates(inboxId, refresh = false) {
      const wa = adapterOf(inboxId);
      if (!wa) throw errors.notFound('Inbox');
      return templates.list(inboxId, wa, refresh);
    },

    async sendTemplate(jid, body, userId) {
      const existing = repo.byClientId(body.clientId);
      if (existing) return present(existing);
      requireSendable(jid);
      if (chatNumberMoved(jid)) throw errors.conflict(MOVED_NUMBER_MESSAGE);
      const inboxId = inboxOfKey(jid);
      const wa = connections.adapter(inboxId);
      if (!capabilitiesOf(wa).templates) throw templatesUnsupported();
      const template = (await templates.list(inboxId, wa)).find(
        (t) => t.name === body.name && t.language === body.language,
      );
      if (!template)
        throw new HttpError(
          400,
          'template_not_found',
          'This template is not approved for this inbox',
        );
      if (!template.sendable)
        throw new HttpError(
          400,
          'template_not_sendable',
          'Templates with a media header or buttons cannot be sent yet',
        );
      if (body.params.length !== template.variables)
        throw new HttpError(
          400,
          'template_params',
          `This template needs ${template.variables} value(s), got ${body.params.length}`,
        );
      // the list was read asynchronously: another request may have stored this clientId meanwhile
      const raced = repo.byClientId(body.clientId);
      if (raced) return present(raced);
      const t = now();
      claimOnReply(jid, userId, t);
      return insertOutgoing({
        id: `local-${body.clientId}`,
        chat_jid: jid,
        sender_jid: ownJidOf(jid),
        sender_name: null,
        from_me: 1,
        sent_by_user_id: userId,
        type: 'text',
        body: fillTemplate(template.body, body.params),
        media_path: null,
        media_mime: null,
        media_name: null,
        media_status: 'none',
        quoted_id: null,
        status: 'pending',
        error: null,
        timestamp: t,
        created_at: t,
        client_id: body.clientId,
        wa_remote_jid: replyTarget(jid),
        template_name: template.name,
        template_language: template.language,
        template_params: JSON.stringify(body.params),
      });
    },

    async sendMedia(jid, file, userId, clientId, opts) {
      const existing = repo.byClientId(clientId);
      if (existing) return present(existing);
      requireSendable(jid);
      if (chatNumberMoved(jid)) throw errors.conflict(MOVED_NUMBER_MESSAGE);
      requireWindow(jid);
      if (!file.buffer.length) throw errors.validation('Empty file');
      const quotedId = checkQuote(jid, file.quotedId);
      const sniffed = await fileTypeFromBuffer(file.buffer).catch(() => undefined);
      // A voice note must really be Ogg/Opus within the recorder's length: never trust the label.
      if (file.voiceNote && voiceNoteSeconds(file.buffer) === null)
        throw errors.validation(
          `A voice note must be Ogg/Opus audio of at most ${VOICE_NOTE_MAX_SECONDS / 60} minutes`,
        );
      const mimeType = file.voiceNote
        ? 'audio/ogg; codecs=opus'
        : (sniffed?.mime ?? (mime.lookup(file.fileName) || 'application/octet-stream'));
      const ext = file.voiceNote ? 'ogg' : (sniffed?.ext ?? extFor(mimeType, file.fileName));
      const id = `local-${clientId}`;
      const rel = media.save(jid, id, file.buffer, ext);
      const t = now();
      claimOnReply(jid, userId, t);
      return insertOutgoing({
        id,
        chat_jid: jid,
        sender_jid: ownJidOf(jid),
        sender_name: null,
        from_me: 1,
        sent_by_user_id: userId,
        type: messageTypeForMime(mimeType),
        body: file.caption?.trim() ? file.caption : null,
        media_path: rel,
        media_mime: mimeType,
        media_name: file.voiceNote ? null : file.fileName.slice(0, 255) || null,
        media_status: 'ok',
        quoted_id: quotedId,
        status: 'pending',
        error: null,
        timestamp: t,
        created_at: t,
        client_id: clientId,
        wa_remote_jid: replyTarget(jid),
        voice_note: file.voiceNote ? 1 : 0,
        sent_via_token_id: opts?.viaTokenId ?? null,
      });
    },

    retry(id, _userId) {
      const r = repo.get(id);
      if (!r) throw errors.notFound('Message');
      if (r.status !== 'failed' || !r.from_me)
        throw errors.conflict('Only failed outgoing messages can be retried');
      refuseSend(inboxOfKey(r.chat_jid));
      if (!r.template_name) requireWindow(r.chat_jid);
      const t = now();
      if (!r.id.startsWith('local-')) {
        // WhatsApp already took it (ERROR ack, row carries the WhatsApp id). Re-send under that same id
        // (jobFromRow sets resendId): phones that already have it ignore the copy, so a group that mostly
        // received it never sees it twice. The row keeps its id; pendingLocal() restores it after a restart.
        if (r.type !== 'text' && !r.media_path)
          throw errors.conflict('This message can no longer be re-sent');
        if (r.type === 'text' && !r.body)
          throw errors.conflict('This message can no longer be re-sent');
      }
      repo.update(id, { status: 'pending', error: null, created_at: t });
      const updated = repo.get(id)!;
      emitStatus(updated);
      manualRetries.add(id);
      enqueueRow(updated);
      return present(updated);
    },

    applyStatus(u, inboxId = PRIMARY_INBOX_ID) {
      // a receipt names the WhatsApp id; the row of this inbox carries the inbox suffix
      const id = messageKey(inboxId, u.id);
      if (u.status === 'failed') logAckError(id, u);
      const r = repo.get(id);
      if (!r) {
        rememberEarlyStatus(id, u.status); // may belong to a send whose ack has not been processed yet
        return;
      }
      if (!r.from_me) return;
      const next = nextStatus(r, u.status);
      if (!next) return;
      repo.update(id, next);
      emitStatus(repo.get(id)!);
    },

    applyReaction(r, source, inboxId = PRIMARY_INBOX_ID) {
      const aliases = getAliases(ctx);
      const learnedFrom = source === 'history' ? 'history' : 'message';
      // The same explicit PN/LID pairs a message would teach (never a name match).
      if (r.chatJid.endsWith('@g.us')) {
        if (r.senderJid && r.senderJidAlt)
          aliases.learn({ jid: r.senderJid, alias: r.senderJidAlt }, learnedFrom);
      } else if (r.chatJidAlt) {
        aliases.learn({ jid: r.chatJid, alias: r.chatJidAlt }, learnedFrom);
      }
      const messageId = messageKey(inboxId, r.targetId);
      const row = reactionRow(r, messageId, aliases);
      if (!row || !reactions.repo.apply(row)) return;
      const target = repo.get(messageId);
      // Not stored yet: the reaction waits and shows with the message (present()).
      if (!target) return;
      ctx.bus.emit('message:reactions', {
        chatJid: target.chat_jid,
        messageId,
        reactions: reactions.forMessage(messageId, target.chat_jid),
      });
    },

    async sendReaction(messageId, emoji, userId) {
      const r = repo.get(messageId);
      if (!r) throw errors.notFound('Message');
      if (r.id.startsWith('local-') || r.type === 'system')
        throw errors.validation('This message cannot get a reaction');
      requireSendable(r.chat_jid);
      if (chatNumberMoved(r.chat_jid)) throw errors.conflict(MOVED_NUMBER_MESSAGE);
      requireWindow(r.chat_jid);
      const wa = connections.adapter(inboxOfKey(r.chat_jid));
      // The reaction goes to the chat address the message lives in (phone number or WhatsApp ID).
      const stored = r.wa_remote_jid ?? waJidOf(r.chat_jid);
      const chatWaJid = addressOf(stored, r.chat_jid) ? stored : waJidOf(r.chat_jid);
      const fromMe = r.from_me === 1;
      const sent = await wa.sendReaction(
        chatWaJid,
        {
          id: waMessageId(r.id),
          fromMe,
          participant: chatWaJid.endsWith('@g.us') && !fromMe ? r.sender_jid : null,
        },
        emoji,
      );
      const row = {
        message_id: r.id,
        reactor: OWN_REACTOR,
        chat_wa_jid: chatWaJid,
        emoji,
        sender_jid: null,
        sender_name: null,
        from_me: 1,
        reacted_at: sent.timestamp,
        sent_by_user_id: emoji ? userId : null,
      };
      const changed = reactions.repo.applyOwn(row, userId);
      log.info({ messageId: r.id, chatJid: r.chat_jid, userId, removed: !emoji }, 'reaction sent');
      const list = reactions.forMessage(r.id, r.chat_jid);
      if (changed)
        ctx.bus.emit('message:reactions', {
          chatJid: r.chat_jid,
          messageId: r.id,
          reactions: list,
        });
      return list;
    },

    applyRemoteEdit(e, source, inboxId = PRIMARY_INBOX_ID) {
      remoteChange('edit', e, source, inboxId);
    },

    applyRemoteDelete(r, source, inboxId = PRIMARY_INBOX_ID) {
      remoteChange('delete', r, source, inboxId);
    },

    async editMessage(id, text, user) {
      const r = repo.get(id);
      if (!r) throw errors.notFound('Message');
      requireOwnChange(r, user, 'edited');
      if (r.template_name || (r.type !== 'text' && !r.body))
        throw errors.validation('Only text messages and captions can be edited');
      if (r.id.startsWith('local-'))
        throw errors.conflict('This message is still being sent; try again in a moment');
      const wa = changeAdapter(r.chat_jid, 'editMessage');
      if (now() - r.timestamp > EDIT_WINDOW_MS)
        throw new HttpError(
          409,
          'edit_window_closed',
          'A message can be edited only within 15 minutes of sending',
        );
      const next = text.trim();
      if (next === (r.body ?? '').trim()) return present(r);
      await wa.editText!(
        messageAddress(r),
        { id: waMessageId(r.id), fromMe: true, participant: null },
        next,
      );
      const current = repo.get(id);
      if (!current) throw errors.notFound('Message');
      recordEdit(current, next, now(), 'team', user.id);
      log.info({ messageId: id, chatJid: r.chat_jid, userId: user.id }, 'message edited');
      return present(repo.get(id)!);
    },

    async deleteMessage(id, scope, user) {
      const r = repo.get(id);
      if (!r) throw errors.notFound('Message');
      const local = r.id.startsWith('local-');
      if (scope === 'me') {
        if (user.role !== 'admin')
          throw errors.forbidden('Only admins can delete a message for the team');
        if (r.type === 'system') throw errors.validation('This message cannot be deleted');
        if (r.hidden_at != null) return present(r);
        if (!local) {
          refuseSend(inboxOfKey(r.chat_jid));
          const wa = changeAdapter(r.chat_jid, 'deleteForMe');
          const address = messageAddress(r);
          const fromMe = r.from_me === 1;
          await wa.deleteForMe!(
            address,
            {
              id: waMessageId(r.id),
              fromMe,
              participant: address.endsWith('@g.us') && !fromMe ? r.sender_jid : null,
            },
            r.timestamp,
          );
        }
        repo.update(id, {
          hidden_at: now(),
          hidden_by_user_id: user.id,
          ...(r.status === 'pending' ? { status: 'failed', error: 'Deleted before sending' } : {}),
        });
        refreshPreview(r.chat_jid);
        emitUpdated(id);
        log.info(
          { messageId: id, chatJid: r.chat_jid, userId: user.id },
          'message hidden for the team',
        );
        return present(repo.get(id)!);
      }
      requireOwnChange(r, user, 'deleted');
      if (!local) {
        const wa = changeAdapter(r.chat_jid, 'deleteForEveryone');
        if (now() - r.timestamp > DELETE_WINDOW_MS)
          throw new HttpError(
            409,
            'delete_window_closed',
            'A message can be deleted for everyone only within 2 days of sending',
          );
        await wa.deleteForEveryone!(messageAddress(r), {
          id: waMessageId(r.id),
          fromMe: true,
          participant: null,
        });
      }
      const current = repo.get(id);
      if (!current) throw errors.notFound('Message');
      recordDelete(current, now(), 'team', user.id);
      log.info(
        { messageId: id, chatJid: r.chat_jid, userId: user.id, local },
        'message deleted for everyone',
      );
      return present(repo.get(id)!);
    },

    messageEdits(id, isAdmin) {
      const r = repo.get(id);
      if (!r) throw errors.notFound('Message');
      const deleted = r.deleted_at != null;
      return {
        messageId: id,
        // a deleted message's earlier texts are the original too: admins only
        edits: deleted && !isAdmin ? [] : changeRepo.edits(id),
        original: deleted && isAdmin ? r.body : null,
      };
    },

    mediaPath(id) {
      // a client may still hold the optimistic local id after the row was renamed to the WA id
      const r =
        repo.get(id) ??
        (id.startsWith('local-') ? repo.byClientId(id.slice('local-'.length)) : null);
      // a deleted (or hidden) message's file is never served
      if (!r || !r.media_path || r.deleted_at != null || r.hidden_at != null) return null;
      let p: string;
      try {
        p = media.abs(r.media_path);
      } catch {
        return null;
      }
      if (!existsSync(p)) return null;
      return { path: p, mime: r.media_mime ?? 'application/octet-stream', name: r.media_name };
    },

    redownload(id) {
      // de-duplicate concurrent requests for the same message (e.g. a thumbnail and a viewer)
      const existing = redownloads.get(id);
      if (existing) return existing;
      const p = doRedownload(id).finally(() => redownloads.delete(id));
      redownloads.set(id, p);
      return p;
    },

    async ensureMedia(id) {
      const ready = svc.mediaPath(id);
      if (ready) return ready;
      const r = repo.get(id);
      if (!r || r.media_status !== 'pending') return null;
      try {
        await svc.redownload(id);
      } catch {
        return 'unavailable';
      }
      return svc.mediaPath(id) ?? 'unavailable';
    },

    shutdown() {
      stopped = true;
      ctx.bus.off('access:opened', onAccessOpened);
      connections.off('removed', onInboxRemoved);
      for (const q of queues.values()) q.stop();
    },
  };

  // Access gate opened again: paused chats resume, with the full expiry window from now.
  function onAccessOpened(): void {
    for (const q of queues.values()) q.onResumed();
  }
  ctx.bus.on('access:opened', onAccessOpened);

  // restore persisted pending sends into their inbox's queue (expired ones fail when processed);
  // a removed inbox never sends again, so its leftovers fail now; an inbox not connected in this
  // build (over the edition's inbox limit) keeps its rows pending, with no queue
  const pending = repo.pendingLocal();
  if (pending.length) {
    const byInbox = new Map<number, SendJob[]>();
    for (const r of pending) {
      if (chatNumberMoved(r.chat_jid)) {
        failMoved(r);
        continue;
      }
      const inboxId = inboxOfKey(r.chat_jid);
      if (inboxRemoved(inboxId)) {
        repo.update(r.id, { status: 'failed', error: INBOX_REMOVED_MESSAGE });
        continue;
      }
      if (inboxUnconnected(inboxId)) continue;
      const jobs = byInbox.get(inboxId) ?? [];
      jobs.push(jobFromRow(r));
      byInbox.set(inboxId, jobs);
    }
    for (const [inboxId, jobs] of byInbox) queueFor(inboxId).restore(jobs);
  }

  return svc;
}
