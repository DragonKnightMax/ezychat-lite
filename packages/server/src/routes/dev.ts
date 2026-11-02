import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateInboxBody,
  FakeGroupBody,
  FakeIncomingBody,
  FakeLinkBody,
  FakeMessageChangeBody,
  FakeReactionBody,
  type Message,
} from '@ezychat/shared';
import type { WaGroupParticipant } from '@ezychat/wa';
import type { FakeWaAdapter } from '@ezychat/wa';
import { requireAdmin, requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { errors, parse } from '../http/errors.js';
import {
  PRIMARY_INBOX_ID,
  chatKey,
  inboxOfKey,
  messageKey,
  parseChatKey,
  waMessageId,
} from '../inboxes/keys.js';
import { getChats } from '../wa-bridge/index.js';
import { clientIp } from '../http/client-ip.js';
import { FAKE_API_TYPE } from '../inboxes/fake-api.js';
import { getInboxService } from '../inboxes/service.js';

/** fake WA only: `quotedId` is a stored message id of the same chat (the member replies to it). */
const FakeIncomingDevBody = FakeIncomingBody.extend({
  quotedId: z.string().min(1).max(512).optional(),
});

const FakeWindowBody = z.object({
  chatJid: z.string().min(1).max(256),
  /** The customer's last live message this many hours ago (0 = now). */
  hoursAgo: z
    .number()
    .min(0)
    .max(24 * 365),
});

const INGEST_WAIT_MS = 2000;

function isFake(wa: unknown): wa is FakeWaAdapter {
  return typeof (wa as { simulateIncoming?: unknown }).simulateIncoming === 'function';
}

/**
 * POST /api/dev/fake-incoming: only registered with --fake-wa. Simulates an inbound WhatsApp
 * message on the FakeWaAdapter of an inbox (default 1). When the messages service is present,
 * waits (bounded) until the WA bridge has ingested it so callers (e2e tests) can immediately see
 * the chat. Answers the stored message id and chat key.
 */
export default async function devRoutes(app: FastifyInstance, ctx: AppContext) {
  if (!ctx.config.fakeWa || !isFake(ctx.wa)) return;

  /** The fake phone of an active inbox; 404 for an unknown or removed one. */
  const fakeOf = (inboxId: number): FakeWaAdapter => {
    let wa: unknown;
    try {
      wa = ctx.inboxes.connections.adapter(inboxId);
    } catch {
      throw errors.notFound('Inbox');
    }
    if (!isFake(wa)) throw errors.notFound('Inbox');
    return wa;
  };

  app.post('/dev/fake-incoming', { preHandler: requireUser(ctx) }, async (req) => {
    const body = parse(FakeIncomingDevBody, req.body ?? {});
    const inboxId = body.inboxId ?? PRIMARY_INBOX_ID;
    const wa = fakeOf(inboxId);
    const direct = chatKey(inboxId, body.chatJid);
    const waitIngest = Boolean(ctx.services.messages);
    let expectId: string | null = null;
    const earlyMessages = new Map<string, string>();
    let ingestedChatJid: string | null = null;
    let onNew: ((m: Message) => void) | null = null;
    let done: () => void = () => undefined;
    const ingested = new Promise<void>((resolve) => {
      done = resolve;
    });
    let timer: NodeJS.Timeout | null = null;
    if (waitIngest) {
      timer = setTimeout(done, INGEST_WAIT_MS);
      onNew = (m: Message) => {
        // Presentation may replace mentions with names; match the generated id, never display text.
        // The bridge can emit synchronously before simulateIncoming returns that id.
        const routed = ctx.services.aliases?.route(inboxId, body.chatJid) ?? direct;
        if (expectId === null && (m.chatJid === routed || m.chatJid === direct) && !m.fromMe)
          earlyMessages.set(m.id, m.chatJid);
        const match = m.id === expectId;
        if (match) {
          ingestedChatJid = m.chatJid;
          done();
        }
      };
      ctx.bus.on('message:new', onNew);
    } else {
      done();
    }
    try {
      const msg = wa.simulateIncoming({
        chatJid: body.chatJid,
        ...(body.chatJidAlt ? { chatJidAlt: body.chatJidAlt } : {}),
        body: body.text,
        senderName: body.senderName ?? null,
        ...(body.senderJid ? { senderJid: body.senderJid } : {}),
        ...(body.mentionedJids !== undefined ? { mentionedJids: body.mentionedJids } : {}),
        ...(body.quotedId ? { quotedId: waMessageId(body.quotedId) } : {}),
        type: body.type ?? 'text',
        // A simulated voice note or photo: the fake adapter serves these bytes as the download.
        media: body.media
          ? {
              mime: body.media.mime,
              fileName: body.media.fileName ?? null,
              download: async () => Buffer.from(body.media!.base64, 'base64'),
            }
          : null,
      });
      expectId = messageKey(inboxId, msg.id);
      if (earlyMessages.has(expectId)) {
        ingestedChatJid = earlyMessages.get(expectId)!;
        done();
      }
      await ingested;
      return { id: expectId, chatJid: ingestedChatJid ?? direct, timestamp: msg.timestamp };
    } finally {
      if (timer) clearTimeout(timer);
      if (onNew) ctx.bus.off('message:new', onNew);
    }
  });

  /**
   * POST /api/dev/fake-reaction: the fake phone of the message's inbox delivers a reaction (or its
   * change or removal) to a stored message, in that message's chat, as WhatsApp would.
   */
  app.post('/dev/fake-reaction', { preHandler: requireUser(ctx) }, async (req) => {
    const body = parse(FakeReactionBody, req.body ?? {});
    const message = ctx.db
      .prepare('SELECT chat_jid, wa_remote_jid FROM messages WHERE id = ?')
      .get(body.messageId) as { chat_jid: string; wa_remote_jid: string | null } | undefined;
    if (!message) throw errors.notFound('Message');
    const inboxId = inboxOfKey(body.messageId);
    const wa = fakeOf(inboxId);
    const chatJid = message.wa_remote_jid ?? parseChatKey(message.chat_jid).waJid;
    if (chatJid.endsWith('@g.us') && !body.fromMe && !body.senderJid)
      throw errors.validation('A group reaction needs senderJid');
    const reaction = wa.simulateReaction({
      chatJid,
      targetId: waMessageId(body.messageId),
      emoji: body.emoji,
      fromMe: body.fromMe ?? false,
      ...(body.senderJid ? { senderJid: body.senderJid } : {}),
      ...(body.senderName ? { senderName: body.senderName } : {}),
    });
    return { messageId: body.messageId, chatJid: message.chat_jid, timestamp: reaction.timestamp };
  });

  /**
   * POST /api/dev/fake-edit and /api/dev/fake-revoke: the fake phone of the message's inbox delivers
   * an edit or a delete for everyone of a stored message, in that message's chat, as WhatsApp would.
   */
  for (const kind of ['edit', 'revoke'] as const)
    app.post(`/dev/fake-${kind}`, { preHandler: requireUser(ctx) }, async (req) => {
      const body = parse(FakeMessageChangeBody, req.body ?? {});
      const message = ctx.db
        .prepare('SELECT chat_jid, wa_remote_jid, sender_jid FROM messages WHERE id = ?')
        .get(body.messageId) as
        { chat_jid: string; wa_remote_jid: string | null; sender_jid: string | null } | undefined;
      if (!message) throw errors.notFound('Message');
      if (kind === 'edit' && body.body === undefined) throw errors.validation('body is required');
      const wa = fakeOf(inboxOfKey(body.messageId));
      const chatJid = message.wa_remote_jid ?? parseChatKey(message.chat_jid).waJid;
      const change = {
        chatJid,
        targetId: waMessageId(body.messageId),
        fromMe: body.fromMe ?? false,
        // a group change comes from the message's own author unless another member is named
        ...(chatJid.endsWith('@g.us') && !body.fromMe
          ? { senderJid: body.senderJid ?? message.sender_jid }
          : body.senderJid
            ? { senderJid: body.senderJid }
            : {}),
      };
      const sent =
        kind === 'edit'
          ? wa.simulateEdit({ ...change, body: body.body! })
          : wa.simulateRevoke(change);
      return { messageId: body.messageId, chatJid: message.chat_jid, timestamp: sent.timestamp };
    });

  /**
   * POST /api/dev/fake-group: a group with members for the Group info panel. Every 4th generated
   * member has a known name, every 7th only a WhatsApp ID (number hidden), every 11th a username.
   */
  app.post('/dev/fake-group', { preHandler: requireUser(ctx) }, async (req) => {
    const body = parse(FakeGroupBody, req.body ?? {});
    const inboxId = body.inboxId ?? PRIMARY_INBOX_ID;
    const wa = fakeOf(inboxId);
    const participants: WaGroupParticipant[] = [];
    const contacts: Array<{ jid: string; pushName: string | null; savedName: null }> = [];
    const me = wa.status.me?.jid.replace(/:\d+@/, '@');
    if (me)
      participants.push({
        jid: me,
        phoneJid: me,
        lidJid: null,
        username: null,
        role: 'superadmin',
      });
    const add = (m: {
      phone?: string;
      lid?: string;
      name?: string;
      username?: string;
      about?: string;
      role: WaGroupParticipant['role'];
    }) => {
      const phoneJid = m.phone ? `${m.phone}@s.whatsapp.net` : null;
      const lidJid = m.lid ? `${m.lid}@lid` : null;
      const jid = lidJid ?? phoneJid;
      if (!jid) return;
      participants.push({ jid, phoneJid, lidJid, username: m.username ?? null, role: m.role });
      if (m.name) contacts.push({ jid: phoneJid ?? jid, pushName: m.name, savedName: null });
      if (m.about) wa.setAbout(phoneJid ?? jid, m.about);
    };
    for (const m of body.members) add(m);
    for (let i = 1; i <= body.generated; i++) {
      const hidden = i % 7 === 0;
      add({
        phone: hidden ? undefined : `6011${String(10_000_000 + i).slice(-8)}`,
        lid: hidden ? `9${String(100_000_000_000_000 + i)}` : undefined,
        name: i % 4 === 0 ? `Demo Member ${i}` : undefined,
        username: i % 11 === 0 ? `demo.member.${i}` : undefined,
        role: i <= 2 ? 'admin' : 'member',
      });
    }
    wa.setGroupInfo({
      jid: body.groupJid,
      name: body.name,
      description: null,
      createdAt: Date.now() - 200 * 86_400_000,
      ownerJid: participants[1]?.phoneJid ?? participants[1]?.jid ?? null,
      size: participants.length,
      participants,
    });
    getChats(ctx).upsertContacts(contacts);
    getChats(ctx).upsertFromWa({ jid: body.groupJid, type: 'group', name: body.name }, inboxId);
    wa.simulateGroupChanged(body.groupJid);
    return { groupJid: chatKey(inboxId, body.groupJid), members: participants.length };
  });

  /** POST /api/dev/fake-link: the inbox's fake phone links (the e2e stand-in for a QR scan). */
  app.post('/dev/fake-link', { preHandler: requireUser(ctx) }, async (req) => {
    const body = parse(FakeLinkBody, req.body ?? {});
    const wa = fakeOf(body.inboxId);
    wa.setConnected(true);
    return { inboxId: body.inboxId, state: wa.status.state };
  });

  // Business API stand-ins: only with --mode dev and --fake-wa (never a packaged build)
  if (ctx.config.mode !== 'dev') return;

  /**
   * POST /api/dev/fake-api-inbox: adds an inbox of the built-in `fake-api` type (a fake Business
   * API number: 24-hour reply window, three templates), within the inbox limit (409 `inbox_limit`).
   */
  app.post('/dev/fake-api-inbox', { preHandler: requireAdmin(ctx) }, async (req, reply) => {
    const body = parse(CreateInboxBody, req.body ?? {});
    const inbox = await getInboxService(ctx).create(
      body,
      { userId: req.user!.id, ip: clientIp(req) },
      { type: FAKE_API_TYPE },
    );
    return reply.status(201).send(inbox);
  });

  /** POST /api/dev/fake-window: moves a chat's last customer message to `hoursAgo` (open/close its window). */
  app.post('/dev/fake-window', { preHandler: requireUser(ctx) }, async (req) => {
    const body = parse(FakeWindowBody, req.body ?? {});
    const chats = getChats(ctx);
    let jid: string;
    try {
      jid = chats.resolveJid(body.chatJid);
    } catch {
      throw errors.notFound('Chat');
    }
    const at = Date.now() - Math.round(body.hoursAgo * 3_600_000);
    const changed = ctx.db
      .prepare('UPDATE chats SET last_inbound_at = ? WHERE jid = ?')
      .run(at, jid).changes;
    if (!changed) throw errors.notFound('Chat');
    const chat = chats.get(jid);
    if (chat) ctx.bus.emit('chat:updated', chat);
    return { chatJid: jid, lastInboundAt: at };
  });
}
