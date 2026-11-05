import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import type {
  ChatDetailResponse,
  ClientToServerEvents,
  Note,
  ServerToClientEvents,
} from '@ezychat/shared';
import {
  dropPushSubscription,
  patchMessageInCache,
  qk,
  patchSenderProfilesInCache,
  upsertChatInCache,
  upsertMessageInCache,
  useMe,
  useWaStatus,
} from './queries';
import { voiceStatusKey } from './voice';
import { ProfileImageContext } from '../inbox/ProfileImageContext';
import { registerResumeReconnect } from './resume-reconnect';
import { clearDesktopNotifications, showDesktopNotification } from '../pwa/desktop-notifications';

export interface TypingEntry {
  userId: number;
  displayName: string;
  at: number;
}

export interface RealtimeValue {
  connected: boolean;
  typing: Record<string, TypingEntry[]>;
  emitTyping(jid: string): void;
}

const TYPING_TTL_MS = 5_000;
const TYPING_EMIT_THROTTLE_MS = 2_000;

const RealtimeContext = createContext<RealtimeValue>({
  connected: false,
  typing: {},
  emitTyping: () => {},
});

export function useRealtime(): RealtimeValue {
  return useContext(RealtimeContext);
}

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Opens one Socket.IO connection while a (fully set-up) user is logged in and mirrors
 * server events into the TanStack Query cache.
 */
export const RealtimeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const qc = useQueryClient();
  const me = useMe();
  const userId = me.data && !me.data.mustChangePassword && !me.data.disabled ? me.data.id : null;
  const wa = useWaStatus({ enabled: userId != null });
  const [connected, setConnected] = useState(false);
  const [avatarRevision, setAvatarRevision] = useState(0);
  const [typing, setTyping] = useState<Record<string, TypingEntry[]>>({});
  const socketRef = useRef<AppSocket | null>(null);
  const lastTypingEmit = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (userId == null) return;
    const socket: AppSocket = io({
      path: '/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;
    let chatRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshChats = () => {
      // Bulk operations publish many committed updates. Refresh once after the burst,
      // including when an older request was already in flight when the changes arrived.
      clearTimeout(chatRefreshTimer);
      chatRefreshTimer = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: qk.chatsAll });
        void qc.invalidateQueries({ queryKey: qk.openChatCount });
      }, 50);
    };

    socket.on('connect', () => {
      setConnected(true);
      setAvatarRevision(Date.now());
      // Events can arrive between the initial API load and joining socket rooms, too.
      void qc.invalidateQueries();
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('notification:new', (notification) => void showDesktopNotification(notification));

    socket.on('message:new', (m) => {
      upsertMessageInCache(qc, m);
      refreshChats();
    });
    // A transcript arrived for a voice note: update it in place (no chat list refresh needed).
    socket.on('message:updated', (m) => upsertMessageInCache(qc, m));
    // Proposed (emoji-reactions): someone reacted, changed or removed a reaction.
    socket.on('message:reactions', (p) =>
      patchMessageInCache(
        qc,
        p.chatJid,
        { id: p.messageId, clientId: null },
        { reactions: p.reactions },
      ),
    );
    socket.on('voice:status', (s) => qc.setQueryData(voiceStatusKey, s));
    socket.on('message:status', (p) => {
      const patch: { status: typeof p.status; error: string | null; id?: string } = {
        status: p.status,
        error: p.error,
      };
      if (p.newId) patch.id = p.newId;
      patchMessageInCache(qc, p.chatJid, { id: p.id, clientId: p.clientId }, patch);
    });
    socket.on('chat:updated', (c) => {
      upsertChatInCache(qc, c);
      patchSenderProfilesInCache(qc, c);
      refreshChats();
      void qc.invalidateQueries({ queryKey: qk.customerProfile(c.jid) });
      // A teammate may have created a tag: the Tag filter and tag input must offer it. Only an open
      // tag list refetches; closed ones just turn stale.
      if (c.tags?.length) void qc.invalidateQueries({ queryKey: ['customer-tags'] });
    });
    socket.on('chat:event', (e) => {
      qc.setQueryData<ChatDetailResponse>(qk.chat(e.chatJid), (old) =>
        old && !old.events.some((x) => x.id === e.id)
          ? { ...old, events: [...old.events, e] }
          : old,
      );
    });
    socket.on('note:new', (n) => {
      qc.setQueryData<Note[]>(qk.notes(n.chatJid), (old) =>
        old ? (old.some((x) => x.id === n.id) ? old : [...old, n]) : old,
      );
    });
    socket.on('wa:status', (s) => {
      qc.setQueryData(qk.wa, s);
      if (s.state === 'open') setAvatarRevision(Date.now());
    });
    socket.on('tunnel:status', (s) => {
      qc.setQueryData(qk.tunnel, s);
      // Settings → Integrations shows the tunnel URL in its setup commands.
      void qc.invalidateQueries({ queryKey: qk.mcpSettings });
    });
    socket.on('typing', (p) => {
      setTyping((prev) => {
        const list = (prev[p.chatJid] ?? []).filter((t) => t.userId !== p.userId);
        return {
          ...prev,
          [p.chatJid]: [...list, { userId: p.userId, displayName: p.displayName, at: Date.now() }],
        };
      });
    });
    socket.on('session:revoked', () => {
      socket.disconnect();
      clearDesktopNotifications();
      // Stop push previews reaching this device for a user who is no longer signed in.
      void dropPushSubscription();
      qc.clear();
      qc.setQueryData(qk.me, null); // RequireAuth redirects to /login
    });

    const removeResumeListeners = registerResumeReconnect(socket);
    return () => {
      removeResumeListeners();
      clearTimeout(chatRefreshTimer);
      socket.removeAllListeners();
      socket.disconnect();
      clearDesktopNotifications();
      socketRef.current = null;
      setConnected(false);
    };
  }, [userId, qc]);

  // Expire stale typing entries.
  useEffect(() => {
    const t = setInterval(() => {
      setTyping((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, TypingEntry[]> = {};
        for (const [jid, list] of Object.entries(prev)) {
          const kept = list.filter((e) => now - e.at < TYPING_TTL_MS);
          if (kept.length !== list.length) changed = true;
          if (kept.length) next[jid] = kept;
        }
        return changed ? next : prev;
      });
    }, 1_000);
    return () => clearInterval(t);
  }, []);

  const emitTyping = useCallback((jid: string) => {
    const now = Date.now();
    const last = lastTypingEmit.current.get(jid) ?? 0;
    if (now - last < TYPING_EMIT_THROTTLE_MS) return;
    lastTypingEmit.current.set(jid, now);
    socketRef.current?.emit('typing', { chatJid: jid });
  }, []);

  const value = useMemo<RealtimeValue>(
    () => ({ connected, typing, emitTyping }),
    [connected, typing, emitTyping],
  );
  const imageState = useMemo(
    () => ({ ready: userId != null && wa.data?.state === 'open', revision: avatarRevision }),
    [userId, wa.data?.state, avatarRevision],
  );
  return createElement(
    ProfileImageContext.Provider,
    { value: imageState },
    createElement(RealtimeContext.Provider, { value }, children),
  );
};
