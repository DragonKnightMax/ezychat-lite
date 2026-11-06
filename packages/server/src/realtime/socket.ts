import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type {
  Chat,
  ChatEvent,
  ClientToServerEvents,
  InboxStatusPayload,
  Message,
  MessageReactionsPayload,
  MessageStatusPayload,
  Note,
  ServerToClientEvents,
  TunnelStatus,
  User,
  VoiceStatus,
  WaStatus,
} from '@ezychat/shared';
import { SESSION_COOKIE } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { contextHostPolicy, hostAllowed } from '../http/host.js';
import { isTrustedTunnelPeer } from '../http/client-ip.js';
import { canOpen, chosenChats, scopeFor, visibleInboxIds } from '../inboxes/access.js';
import { PRIMARY_INBOX_ID } from '../inboxes/keys.js';
import { inboxOfKeyOrNull as inboxOf } from '../inboxes/service.js';

export interface SocketData {
  userId: number;
  displayName: string;
  role: User['role'];
  token: string;
}

export type IoServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type IoSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

declare module '../context.js' {
  interface Services {
    /** set by attachRealtime() once the HTTP server is listening */
    realtime?: RealtimeService;
  }
}

export interface RealtimeService {
  io: IoServer;
  close(): void;
  isOnline(userId: number): boolean;
}

export const TYPING_THROTTLE_MS = 2000;

/** Extracts one cookie value from a Cookie header (URL-decoded, tolerant of bad encodings). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const raw = part
      .slice(i + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** Same rule as the HTTP origin hook: if an Origin header is present its host must equal Host. */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = (req.headers.host ?? '').toLowerCase();
  if (!host || origin === 'null') return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** Room of the users who may open one inbox (admins join every inbox room). */
export const inboxRoom = (inboxId: number) => `inbox:${inboxId}`;
/** Room of the agents limited to chosen chats who chose this chat (they join no inbox room). */
export const chatRoom = (chatJid: string) => `chat:${chatJid}`;
/** Connection state of one inbox for limited agents with a chosen chat there (no chat data). */
export const inboxStatusRoom = (inboxId: number) => `inbox-status:${inboxId}`;

/**
 * Attaches Socket.IO to the HTTP server. Cookie-authenticated handshake; rooms `user:<id>`, `all`,
 * `admins` and `inbox:<id>` for each inbox the user may open (rebuilt when access changes).
 * Bridges domain bus events to clients and kicks sockets of disabled / revoked users.
 * Registers itself as ctx.services.realtime (used by push to skip online users).
 */
export function attachRealtime(server: HttpServer, ctx: AppContext): RealtimeService {
  const hostPolicy = contextHostPolicy(ctx);
  const io: IoServer = new Server(server, {
    path: '/socket.io',
    serveClient: false,
    allowRequest: (req, cb) => {
      const trustedTunnel = isTrustedTunnelPeer(
        req.socket.remoteAddress,
        req.headers['cf-connecting-ip'],
      );
      cb(null, hostAllowed(req.headers.host, hostPolicy, trustedTunnel) && originAllowed(req));
    },
  });
  const online = new Map<number, number>();
  const lastTyping = new Map<string, number>();

  io.use((socket, next) => {
    // Access gate closed by an edition: refuse with its code before looking at the session.
    const gate = ctx.access.state();
    if (!gate.open) {
      next(new Error(gate.code));
      return;
    }
    const auth = ctx.services.auth;
    const token = readCookie(socket.request.headers.cookie, SESSION_COOKIE);
    const user = auth && token ? auth.resolveSession(token) : null;
    if (!user || !token || user.disabled || user.mustChangePassword) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data = { userId: user.id, displayName: user.displayName, role: user.role, token };
    next();
  });

  /** Inboxes the socket's user may open (admins: every inbox, removed ones too). */
  const scopeOf = (s: IoSocket) =>
    scopeFor(ctx, { id: s.data.userId, role: s.data.role, kind: 'human' });

  const userOf = (s: IoSocket) => ({
    id: s.data.userId,
    role: s.data.role,
    kind: 'human' as const,
  });

  /**
   * Joins the rooms of the user's access and leaves the others; no reconnect needed. Inbox rooms for
   * the inboxes they open; for an agent limited to chosen chats, one `chat:<jid>` room per chosen chat
   * and the status rooms of those chats' inboxes instead.
   */
  const syncInboxRooms = (s: IoSocket) => {
    const scope = scopeOf(s);
    const want = new Set(
      ctx.inboxes.repo
        .list()
        .filter((r) => canOpen(scope, r.id))
        .map((r) => inboxRoom(r.id)),
    );
    const chosen = chosenChats(ctx, userOf(s));
    if (chosen) {
      for (const jid of chosen) want.add(chatRoom(jid));
      const visible = visibleInboxIds(ctx, userOf(s));
      if (visible !== 'all') for (const id of visible) want.add(inboxStatusRoom(id));
    }
    for (const room of s.rooms)
      if (
        (room.startsWith('inbox:') ||
          room.startsWith('chat:') ||
          room.startsWith('inbox-status:')) &&
        !want.has(room)
      )
        void s.leave(room);
    void s.join([...want]);
  };

  /** May this socket's user open the chat (its inbox, or one of their chosen chats)? */
  const opensChat = (s: IoSocket, chatJid: string, inboxId: number) => {
    const chosen = chosenChats(ctx, userOf(s));
    return chosen ? chosen.has(chatJid) : canOpen(scopeOf(s), inboxId);
  };

  io.on('connection', (socket: IoSocket) => {
    const { userId } = socket.data;
    void socket.join([
      `user:${userId}`,
      'all',
      ...(socket.data.role === 'admin' ? ['admins'] : []),
    ]);
    syncInboxRooms(socket);
    online.set(userId, (online.get(userId) ?? 0) + 1);

    socket.on('typing', (p) => {
      const chatJid = p && typeof p === 'object' ? (p as { chatJid?: unknown }).chatJid : undefined;
      if (typeof chatJid !== 'string' || !chatJid || chatJid.length > 256) return;
      // typing reaches only the people who may open that chat's inbox, and only from them
      const inboxId = inboxOf(chatJid);
      if (inboxId === null || !opensChat(socket, chatJid, inboxId)) return;
      const key = `${userId}\u0000${chatJid}`;
      const now = Date.now();
      const last = lastTyping.get(key);
      if (last !== undefined && now - last < TYPING_THROTTLE_MS) return;
      lastTyping.set(key, now);
      if (lastTyping.size > 5000) {
        for (const [k, at] of lastTyping) if (now - at >= TYPING_THROTTLE_MS) lastTyping.delete(k);
      }
      socket
        .to([inboxRoom(inboxId), chatRoom(chatJid), 'admins'])
        .except(`user:${userId}`)
        .emit('typing', { chatJid, userId, displayName: socket.data.displayName });
    });

    socket.on('disconnect', () => {
      const n = (online.get(userId) ?? 1) - 1;
      if (n <= 0) online.delete(userId);
      else online.set(userId, n);
    });
  });

  const kick = (s: { emit: IoSocket['emit']; disconnect(close?: boolean): unknown }) => {
    s.emit('session:revoked');
    s.disconnect(true);
  };

  // bus → clients. Chat data goes to the chat's inbox room, the room of the limited agents who chose
  // it (and admins, also while a new inbox's rooms are being built); a key that does not parse
  // reaches admins only.
  const toChat = (chatJid: string) => {
    const inboxId = inboxOf(chatJid);
    return io.to(inboxId === null ? ['admins'] : [inboxRoom(inboxId), chatRoom(chatJid), 'admins']);
  };
  const onMessageNew = (m: Message) => toChat(m.chatJid).emit('message:new', m);
  const onMessageStatus = (p: MessageStatusPayload) => toChat(p.chatJid).emit('message:status', p);
  const onMessageUpdated = (m: Message) => toChat(m.chatJid).emit('message:updated', m);
  const onMessageReactions = (p: MessageReactionsPayload) =>
    toChat(p.chatJid).emit('message:reactions', p);
  const onVoice = (s: VoiceStatus) => io.to('admins').emit('voice:status', s);
  const onChatUpdated = (c: Chat) => toChat(c.jid).emit('chat:updated', c);
  const onChatEvent = (e: ChatEvent) => toChat(e.chatJid).emit('chat:event', e);
  const onNote = (n: Note) => toChat(n.chatJid).emit('note:new', n);
  const onGroupChanged = (p: { chatJid: string }) =>
    toChat(p.chatJid).emit('group:changed', { chatJid: p.chatJid });
  const onWaStatus = (s: WaStatus) => {
    io.to('admins').emit('wa:status', s);
    io.to([inboxRoom(PRIMARY_INBOX_ID), inboxStatusRoom(PRIMARY_INBOX_ID)])
      .except('admins')
      .emit('wa:status', { ...s, qr: null });
  };
  // the QR only for admins; the people of that inbox see its state
  const onInboxStatus = (p: InboxStatusPayload) => {
    io.to('admins').emit('inbox:status', p);
    io.to([inboxRoom(p.inboxId), inboxStatusRoom(p.inboxId)])
      .except('admins')
      .emit('inbox:status', { ...p, status: { ...p.status, qr: null } });
  };
  const onInboxesChanged = () => {
    for (const s of io.of('/').sockets.values()) syncInboxRooms(s);
    io.to('all').emit('inboxes:changed');
  };
  // An agent's chosen chats changed: rebuild that user's rooms and tell their clients to reload
  // (the chat list, and an open chat that is no longer theirs).
  const onMemberChatsChanged = (userId: number) => {
    for (const s of io.of('/').sockets.values()) if (s.data.userId === userId) syncInboxRooms(s);
    io.to(`user:${userId}`).emit('chats:access');
  };
  const onTunnel = (s: TunnelStatus) => io.to('admins').emit('tunnel:status', s);
  const onDisabled = (userId: number) => {
    for (const s of io.of('/').sockets.values()) if (s.data.userId === userId) kick(s);
  };
  // All sessions revoked: kick every socket whose session no longer resolves.
  const onRevoked = (userId: number) => {
    const auth = ctx.services.auth;
    for (const s of io.of('/').sockets.values()) {
      if (s.data.userId !== userId) continue;
      const u = auth ? auth.resolveSession(s.data.token) : null;
      if (!u || u.disabled || u.mustChangePassword) kick(s);
    }
  };

  // Role changed: move live sockets in/out of 'admins' (QR + tunnel status are admin-only).
  const onRoleChanged = (userId: number, role: User['role']) => {
    for (const s of io.of('/').sockets.values()) {
      if (s.data.userId !== userId) continue;
      s.data.role = role;
      if (role === 'admin') void s.join('admins');
      else void s.leave('admins');
      syncInboxRooms(s);
    }
  };

  // Access gate closed: tell every client the code, then drop it (sessions are already deleted).
  const onAccessClosed = ({ code }: { code: string }) => {
    for (const s of io.of('/').sockets.values()) {
      s.emit('access:closed', { code });
      s.disconnect(true);
    }
  };

  const { bus } = ctx;
  bus.on('access:closed', onAccessClosed);
  bus.on('message:new', onMessageNew);
  bus.on('message:status', onMessageStatus);
  bus.on('message:updated', onMessageUpdated);
  bus.on('message:reactions', onMessageReactions);
  bus.on('voice:status', onVoice);
  bus.on('chat:updated', onChatUpdated);
  bus.on('chat:event', onChatEvent);
  bus.on('note:new', onNote);
  bus.on('group:changed', onGroupChanged);
  bus.on('wa:status', onWaStatus);
  bus.on('inbox:status', onInboxStatus);
  bus.on('inboxes:changed', onInboxesChanged);
  bus.on('member-chats:changed', onMemberChatsChanged);
  bus.on('tunnel:status', onTunnel);
  bus.on('user:disabled', onDisabled);
  bus.on('user:sessions-revoked', onRevoked);
  bus.on('user:role-changed', onRoleChanged);

  let closed = false;
  const service: RealtimeService = {
    io,
    isOnline: (userId) => (online.get(userId) ?? 0) > 0,
    close() {
      if (closed) return;
      closed = true;
      bus.off('access:closed', onAccessClosed);
      bus.off('message:new', onMessageNew);
      bus.off('message:status', onMessageStatus);
      bus.off('message:updated', onMessageUpdated);
      bus.off('message:reactions', onMessageReactions);
      bus.off('voice:status', onVoice);
      bus.off('chat:updated', onChatUpdated);
      bus.off('chat:event', onChatEvent);
      bus.off('note:new', onNote);
      bus.off('group:changed', onGroupChanged);
      bus.off('wa:status', onWaStatus);
      bus.off('inbox:status', onInboxStatus);
      bus.off('inboxes:changed', onInboxesChanged);
      bus.off('member-chats:changed', onMemberChatsChanged);
      bus.off('tunnel:status', onTunnel);
      bus.off('user:disabled', onDisabled);
      bus.off('user:sessions-revoked', onRevoked);
      bus.off('user:role-changed', onRoleChanged);
      io.disconnectSockets(true);
      // Close engine.io clients without closing the HTTP server (Fastify owns that).
      io.engine?.close();
      online.clear();
      lastTyping.clear();
      if (ctx.services.realtime === service) delete ctx.services.realtime;
    },
  };
  ctx.services.realtime = service;
  return service;
}
