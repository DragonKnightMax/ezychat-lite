import { extname } from 'node:path';
import { statSync } from 'node:fs';
import {
  FORWARD_PER_MINUTE,
  forwardedManyTimes,
  type ForwardMessageBody,
  type Message,
  type MessageType,
  type User,
} from '@ezychat/shared';
import type { WaAdapter, WaMediaLimits } from '@ezychat/wa';
import type { Logger } from 'pino';
import type { AppContext } from '../context.js';
import { HttpError, errors } from '../http/errors.js';
import { requireChatAccess } from '../inboxes/service.js';
import { inboxOfKey } from '../inboxes/keys.js';
import { capabilitiesOf } from '../inboxes/types.js';
import type { MediaStore } from './media-store.js';
import type { MessageRepo, MessageRow } from './repo.js';

/**
 * Forward a message (design docs/features/forward-message/design.md → Server): one stored message to
 * 1–5 existing chats the person may open, each copy through the normal outgoing path (claim, row,
 * send queue) from the target chat's own WhatsApp number, as WhatsApp "Forwarded". Every chat is
 * checked before anything is sent.
 */

/** The person forwarding (never the AI member). */
export type ForwardUser = Pick<User, 'id' | 'role' | 'kind'>;

export type MediaLimitKind = keyof WaMediaLimits;

const MB = 1024 * 1024;
const mb = (bytes: number) => `${Math.round(bytes / MB)} MB`;

/** Which of WhatsApp's per-message limits a file of this type falls under. */
export function mediaLimitKind(type: MessageType, asDocument = false): MediaLimitKind {
  if (asDocument) return 'document';
  if (type === 'video') return 'video';
  if (type === 'image' || type === 'sticker') return 'image';
  if (type === 'audio') return 'audio';
  return 'document';
}

/**
 * A file this connection cannot take (413), or null: above the document limit nothing goes
 * (`too_large_for_whatsapp`); a video above the video limit can still go as a file
 * (`too_large_as_video`); another type above its own limit is `too_large_for_whatsapp`. A missing
 * limit = none known (WhatsApp's answer decides).
 */
export function mediaLimitRefusal(
  limits: WaMediaLimits | undefined,
  size: number,
  kind: MediaLimitKind,
): HttpError | null {
  if (!limits) return null;
  if (limits.document !== undefined && size > limits.document)
    return new HttpError(
      413,
      'too_large_for_whatsapp',
      `Too large for this WhatsApp number: files up to ${mb(limits.document)}`,
    );
  const limit = limits[kind];
  if (kind === 'document' || limit === undefined || size <= limit) return null;
  if (kind === 'video')
    return new HttpError(
      413,
      'too_large_as_video',
      `Too large to send as a video to this WhatsApp number (up to ${mb(limit)}): send it as a file`,
    );
  return new HttpError(
    413,
    'too_large_for_whatsapp',
    `Too large for this WhatsApp number: up to ${mb(limit)}`,
  );
}

/** The internals of the message service a forward re-uses (the composer's outgoing path). */
export interface ForwardDeps {
  ctx: AppContext;
  repo: MessageRepo;
  media: MediaStore;
  log: Logger;
  now: () => number;
  present(row: MessageRow): Message;
  adapterOf(inboxId: number): WaAdapter | null;
  /** 409 `inbox_removed` / `inbox_not_connected` */
  refuseSend(inboxId: number): void;
  chatNumberMoved(jid: string): boolean;
  windowOpen(jid: string): boolean;
  claimOnReply(jid: string, userId: number, t: number): void;
  insertOutgoing(row: MessageRow): Message;
  replyTarget(jid: string): string;
  ownJidOf(jid: string): string | null;
  ensureMedia(id: string): Promise<{ path: string } | null | 'unavailable'>;
}

const FORWARD_WINDOW_MS = 60_000;

/** Messages a person may forward as a copy (nothing else is stored as a message). */
const FORWARDABLE: ReadonlySet<MessageType> = new Set<MessageType>([
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
]);

export function createForwarder(deps: ForwardDeps) {
  const { ctx, repo } = deps;
  /** user id → times of the chats they forwarded to in the last minute (each chat counts one). */
  const recent = new Map<number, number[]>();

  const rateLimit = (userId: number, count: number): void => {
    const t = deps.now();
    const kept = (recent.get(userId) ?? []).filter((at) => at > t - FORWARD_WINDOW_MS);
    if (kept.length + count > FORWARD_PER_MINUTE) {
      recent.set(userId, kept);
      const oldest = kept[0] ?? t;
      throw errors.rateLimited(Math.ceil((oldest + FORWARD_WINDOW_MS - t) / 1000));
    }
    for (let i = 0; i < count; i++) kept.push(t);
    recent.set(userId, kept);
    if (recent.size > 1000) {
      for (const [id, times] of recent)
        if (!times.some((at) => at > t - FORWARD_WINDOW_MS)) recent.delete(id);
    }
  };

  /** The copies an earlier request with this clientRequestId made, or null. */
  const earlier = (body: ForwardMessageBody, userId: number): Message[] | null => {
    const rows: MessageRow[] = [];
    for (let n = 0; n < body.to.length; n++) {
      const r = repo.byClientId(`${body.clientRequestId}:${n}`);
      if (r) rows.push(r);
    }
    if (!rows.length) return null;
    if (rows.some((r) => r.sent_by_user_id !== userId))
      throw new HttpError(409, 'duplicate_request', 'This request id was already used');
    return rows.map((r) => deps.present(r));
  };

  /** The source must be a message WhatsApp has, that still shows and that Safety does not lock. */
  const checkSource = (r: MessageRow): void => {
    if (r.deleted_at != null || r.hidden_at != null)
      throw new HttpError(409, 'message_deleted', 'This message was deleted');
    if (!FORWARDABLE.has(r.type))
      throw new HttpError(409, 'message_not_forwardable', 'This message cannot be forwarded');
    if (
      r.id.startsWith('local-') ||
      (r.from_me === 1 && (r.status === 'pending' || r.status === 'failed'))
    )
      throw new HttpError(409, 'message_not_sent', 'This message has not been sent yet');
    // Fail closed, admins too: High (locked, released or deleted) and files the AI check may still raise.
    const safety = ctx.services.safety;
    if (safety && (safety.levelOf(r.id) === 'high' || !safety.cacheable(r.id)))
      throw new HttpError(409, 'safety_locked', 'This message is locked by WhatsApp Safety');
  };

  /** One chosen chat, resolved and checked; 404 when the person may not open it (never a hint which). */
  const checkTarget = (user: ForwardUser, key: string): { jid: string; wa: WaAdapter } => {
    const chat = requireChatAccess(ctx, user, key);
    const jid = chat.jid;
    const inboxId = inboxOfKey(jid);
    deps.refuseSend(inboxId);
    if (deps.chatNumberMoved(jid))
      throw new HttpError(
        409,
        'chat_number_moved',
        'This phone number now belongs to a different WhatsApp account',
      );
    if (!deps.windowOpen(jid))
      throw new HttpError(
        409,
        'window_closed',
        'The reply window of this chat is closed: only an approved template can be sent until the customer writes again',
      );
    const wa = deps.adapterOf(inboxId);
    if (!wa || wa.status.state !== 'open')
      throw new HttpError(503, 'wa_disconnected', 'This WhatsApp number is not connected');
    return { jid, wa };
  };

  return async function forward(
    id: string,
    body: ForwardMessageBody,
    user: ForwardUser,
  ): Promise<{ messages: Message[]; repeated: boolean }> {
    const started = Date.now();
    if (user.kind === 'ai') throw errors.forbidden('The AI cannot forward messages');
    const source = repo.get(id);
    if (!source) throw errors.notFound('Message');

    const again = earlier(body, user.id);
    if (again) return { messages: again, repeated: true };

    checkSource(source);

    // Every chosen chat is checked before anything is sent: one bad chat sends nothing.
    const targets: Array<{ jid: string; wa: WaAdapter }> = [];
    for (const key of body.to) {
      const target = checkTarget(user, key);
      if (!targets.some((t) => t.jid === target.jid)) targets.push(target);
    }
    const sourceScore = source.forwarding_score ?? 0;
    if (forwardedManyTimes(sourceScore) && targets.length > 1)
      throw new HttpError(
        400,
        'forward_many_times',
        'A message forwarded many times can go to one chat at a time',
      );

    // The file: downloaded first when it is history media; checked against each number's limits.
    const isMedia = source.type !== 'text';
    let sourceRel: string | null = null;
    let size = 0;
    const asDocument = source.type === 'video' && body.sendAs === 'file';
    if (isMedia) {
      const file = await deps.ensureMedia(source.id);
      const fresh = repo.get(source.id);
      if (!file || file === 'unavailable' || !fresh?.media_path)
        throw new HttpError(
          502,
          'media_unavailable',
          'The file could not be downloaded from WhatsApp',
        );
      sourceRel = fresh.media_path;
      size = statSync(file.path).size;
      const kind = mediaLimitKind(source.type, asDocument);
      for (const t of targets) {
        const refused = mediaLimitRefusal(capabilitiesOf(t.wa).mediaLimits, size, kind);
        if (refused) throw refused;
      }
      // the download took a while: the chats may have changed meanwhile
      for (const t of targets) checkTarget(user, t.jid);
    }

    rateLimit(user.id, targets.length);

    const score = sourceScore + 1;
    const ext = sourceRel ? extname(sourceRel).slice(1) : '';
    const sentAs: MessageType = asDocument ? 'document' : source.type;
    const fileName = source.media_name ?? (asDocument ? `video.${ext || 'mp4'}` : null);
    const messages: Message[] = [];
    targets.forEach((target, n) => {
      const clientId = `${body.clientRequestId}:${n}`;
      const rowId = `local-${clientId}`;
      const rel = sourceRel ? deps.media.copy(target.jid, rowId, sourceRel, ext) : null;
      const t = deps.now();
      deps.claimOnReply(target.jid, user.id, t);
      messages.push(
        deps.insertOutgoing({
          id: rowId,
          chat_jid: target.jid,
          sender_jid: deps.ownJidOf(target.jid),
          sender_name: null,
          from_me: 1,
          sent_by_user_id: user.id,
          type: sentAs,
          // text: the body as plain text (group tags are not carried); a file: its caption
          body: source.type === 'audio' || source.type === 'sticker' ? null : source.body,
          media_path: rel,
          media_mime: rel ? source.media_mime : null,
          media_name: rel ? fileName : null,
          media_status: rel ? 'ok' : 'none',
          media_size: rel ? size : null,
          quoted_id: null,
          status: 'pending',
          error: null,
          timestamp: t,
          created_at: t,
          client_id: clientId,
          wa_remote_jid: deps.replyTarget(target.jid),
          voice_note: source.voice_note === 1 ? 1 : 0,
          mentioned_jids: '[]',
          forwarding_score: score,
        }),
      );
    });
    deps.log.info(
      {
        userId: user.id,
        messageId: source.id,
        count: messages.length,
        type: sentAs,
        ms: Date.now() - started,
      },
      'forward',
    );
    return { messages, repeated: false };
  };
}
