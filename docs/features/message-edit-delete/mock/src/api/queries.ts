import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  type Locale,
  type SendMediaFields,
  type ApiToken,
  type CreateApiTokenBodyInput,
  type McpSettingsPatch,
  ApiTokenListResponse,
  CreateApiTokenResponse,
  McpSettingsResponse,
  type PatchMeBody,
  MeResponse,
  OpenChatCountResponse,
  ResolveAllChatsResponse,
  SetupStatusResponse,
  CloudflareSetupStatus,
  TunnelStatusSchema,
  type AuditEntry,
  type ChangePasswordBody,
  type Chat,
  type ChatDetailResponse,
  type ChatListResponse,
  type ChatPatchBody,
  type ChatStatus,
  type CreateUserBody,
  type CustomerProfileBody,
  type CustomerProfileResponse,
  type GroupInfoResponse,
  type GroupMemberAboutResponse,
  type StartMemberChatResponse,
  type CustomerTagsResponse,
  type CloudflareCreateBody,
  type LoginBody,
  type Message,
  type MessageListResponse,
  type Note,
  type PatchUserBody,
  type QuickReply,
  type QuickReplyBody,
  type ResetPasswordResponse,
  type SetupAdminBody,
  type Settings,
  type SettingsPatchBody,
  type TunnelStartBody,
  type TunnelStatus,
  type User,
  type WaStatus,
} from '@ezychat/shared';
import { ApiError, api } from './client';
import { unsubscribePush } from '../pwa/push';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export interface ChatFilters {
  status?: ChatStatus;
  assigned: 'me' | 'none' | 'any';
  q?: string;
  /** customer tag filter */
  tag?: string;
}

export const qk = {
  me: ['me'] as const,
  setupStatus: ['setup-status'] as const,
  chats: (f: ChatFilters) => ['chats', f] as const,
  chatsAll: ['chats'] as const,
  openChatCount: ['open-chat-count'] as const,
  chat: (jid: string) => ['chat', jid] as const,
  messages: (jid: string) => ['messages', jid] as const,
  notes: (jid: string) => ['notes', jid] as const,
  customerProfile: (jid: string) => ['customer-profile', jid] as const,
  groupMembers: (jid: string) => ['group-members', jid] as const,
  memberAbout: (groupJid: string, member: string) => ['member-about', groupJid, member] as const,
  customerTags: (q: string) => ['customer-tags', q] as const,
  quickReplies: ['quick-replies'] as const,
  users: ['users'] as const,
  directory: ['users', 'directory'] as const,
  wa: ['wa'] as const,
  tunnel: ['tunnel'] as const,
  cloudflareSetup: ['cloudflare-setup'] as const,
  settings: ['settings'] as const,
  audit: ['audit'] as const,
  mcpSettings: ['integrations', 'mcp'] as const,
  apiTokens: ['integrations', 'tokens'] as const,
};

export type ChatsData = InfiniteData<ChatListResponse, string | null>;
/** pages[0] holds the NEWEST messages; each page's `messages` are in ascending time order. */
export type MessagesData = InfiniteData<MessageListResponse, string | null>;

const enc = encodeURIComponent;

/** Accepts either a bare array or an object wrapping it (`{ users: [...] }`). */
function unwrapList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const v = (data as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
    const first = Object.values(data).find(Array.isArray);
    if (first) return first as T[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Cache helpers (shared with the realtime socket)
// ---------------------------------------------------------------------------

function sameMessage(a: Message, m: { id: string; clientId: string | null }): boolean {
  if (a.id === m.id) return true;
  if (m.clientId && a.clientId === m.clientId) return true;
  return false;
}

const STATUS_RANK: Record<Message['status'], number> = {
  pending: 0,
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/**
 * The socket's `message:status` (sent → WA id, delivered…) can arrive before the POST response
 * that still carries the pending server row. Never let such a stale copy regress the cached
 * message's status or WA id; an explicit `failed` (or failed → pending retry) always applies.
 */
function mergeMessage(existing: Message, rawIncoming: Message): Message {
  // A copy without `senderProfile` (undefined, not null) says nothing about it: keep the known one.
  const incoming =
    rawIncoming.senderProfile === undefined && existing.senderProfile !== undefined
      ? { ...rawIncoming, senderProfile: existing.senderProfile }
      : rawIncoming;
  if (incoming.status !== 'failed' && STATUS_RANK[existing.status] > STATUS_RANK[incoming.status]) {
    return {
      ...incoming,
      id: existing.id,
      status: existing.status,
      error: existing.error,
      mediaUrl: existing.mediaUrl ?? incoming.mediaUrl,
    };
  }
  return incoming;
}

/**
 * A direct chat's profile name changed: relabel that customer's cached group messages
 * (the server attaches `senderProfile` only when messages are loaded or arrive).
 */
export function patchSenderProfilesInCache(qc: QueryClient, chat: Chat): void {
  // Older servers omit `whatsappName`: then the chat name cannot tell a profile name apart.
  if (chat.type !== 'dm' || chat.whatsappName === undefined) return;
  const name = chat.name.trim();
  const profile =
    name && (chat.whatsappName === null || name !== chat.whatsappName)
      ? { chatJid: chat.jid, name }
      : null;
  qc.setQueriesData<MessagesData>({ queryKey: ['messages'] }, (old) => {
    if (!old?.pages) return old;
    let changed = false;
    const pages = old.pages.map((p) => {
      let pageChanged = false;
      const messages = p.messages.map((m) => {
        if (m.senderProfile?.chatJid !== chat.jid) return m;
        if (profile && m.senderProfile.name === profile.name) return m;
        pageChanged = true;
        return { ...m, senderProfile: profile };
      });
      if (!pageChanged) return p;
      changed = true;
      return { ...p, messages };
    });
    return changed ? { ...old, pages } : old;
  });
}

/** Same URL the server builds for a message's media (`mediaUrlFor` in messages/repo.ts). */
export function mediaUrlFor(id: string): string {
  return `/api/media/${encodeURIComponent(id)}`;
}

/**
 * Apply a patch to a cached message. When the patch renames the message (local-<clientId> →
 * WhatsApp id) the server-side media URL moves with it, so rewrite `mediaUrl` too.
 */
function applyPatch(x: Message, patch: Partial<Message>): Message {
  const next = { ...x, ...patch };
  if (patch.id && patch.id !== x.id && x.mediaUrl && patch.mediaUrl === undefined) {
    next.mediaUrl = mediaUrlFor(patch.id);
  }
  return next;
}

/** Insert or replace a message in the messages cache of its chat. */
export function upsertMessageInCache(qc: QueryClient, m: Message): void {
  qc.setQueryData<MessagesData>(qk.messages(m.chatJid), (old) => {
    if (!old || old.pages.length === 0) return old;
    let found = false;
    const pages = old.pages.map((p) => {
      if (!p.messages.some((x) => sameMessage(x, m))) return p;
      found = true;
      return {
        ...p,
        messages: p.messages.map((x) => (sameMessage(x, m) ? mergeMessage(x, m) : x)),
      };
    });
    if (found) return { ...old, pages };
    const [first, ...rest] = pages;
    if (!first) return old;
    const msgs = [...first.messages, m].sort(
      (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
    );
    return { ...old, pages: [{ ...first, messages: msgs }, ...rest] };
  });
}

/** Patch a message (located by id, or by clientId / `local-<clientId>`) in a chat's messages cache. */
export function patchMessageInCache(
  qc: QueryClient,
  chatJid: string,
  match: { id: string; clientId: string | null },
  patch: Partial<Message>,
): void {
  qc.setQueryData<MessagesData>(qk.messages(chatJid), (old) => {
    if (!old) return old;
    const localId = match.clientId ? `local-${match.clientId}` : null;
    const hit = (x: Message) =>
      x.id === match.id ||
      (match.clientId != null && x.clientId === match.clientId) ||
      (localId != null && x.id === localId);
    return {
      ...old,
      pages: old.pages.map((p) =>
        p.messages.some(hit)
          ? { ...p, messages: p.messages.map((x) => (hit(x) ? applyPatch(x, patch) : x)) }
          : p,
      ),
    };
  });
}

/** Remove a message (by id or `local-<clientId>`) from a chat's messages cache. */
export function removeMessageFromCache(qc: QueryClient, chatJid: string, clientId: string): void {
  const localId = `local-${clientId}`;
  qc.setQueryData<MessagesData>(qk.messages(chatJid), (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            messages: p.messages.filter((x) => x.id !== localId && x.clientId !== clientId),
          })),
        }
      : old,
  );
}

/** Replace a chat in every cached chat list and in its detail entry. */
export function upsertChatInCache(qc: QueryClient, chat: Chat): void {
  qc.setQueryData<ChatDetailResponse>(qk.chat(chat.jid), (old) => (old ? { ...old, chat } : old));
  qc.setQueriesData<ChatsData>({ queryKey: qk.chatsAll }, (old) => {
    if (!old?.pages) return old;
    return {
      ...old,
      pages: old.pages.map((p) => ({
        ...p,
        chats: p.chats.map((c) => (c.jid === chat.jid ? chat : c)),
      })),
    };
  });
}

function currentUser(qc: QueryClient): User | null {
  return qc.getQueryData<User | null>(qk.me) ?? null;
}

export function newClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function optimisticMessage(
  qc: QueryClient,
  jid: string,
  clientId: string,
  fields: Partial<Message>,
): Message {
  return {
    id: `local-${clientId}`,
    chatJid: jid,
    senderJid: null,
    senderName: currentUser(qc)?.displayName ?? null,
    fromMe: true,
    sentByUserId: currentUser(qc)?.id ?? null,
    type: 'text',
    body: null,
    mediaUrl: null,
    mediaMime: null,
    mediaName: null,
    mediaStatus: 'none',
    quotedId: null,
    status: 'pending',
    error: null,
    timestamp: Date.now(),
    clientId,
    reactions: [],
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Auth & setup
// ---------------------------------------------------------------------------

/** Current user, or `null` when not logged in (401 is not an error here). */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async (): Promise<User | null> => {
      try {
        return await api('/me', { schema: MeResponse });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
  });
}

export function useSetupStatus() {
  return useQuery({
    queryKey: qk.setupStatus,
    queryFn: () => api('/setup/status', { schema: SetupStatusResponse }),
    staleTime: 30_000,
    retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
  });
}

/** Create the first admin (server logs them in). */
export function useSetupAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupAdminBody) => api<unknown>('/setup/admin', { method: 'POST', body }),
    onSuccess: async (data) => {
      const parsed = MeResponse.safeParse(data);
      const parsedNested = MeResponse.safeParse((data as { user?: unknown } | null)?.user);
      if (parsed.success) qc.setQueryData(qk.me, parsed.data);
      else if (parsedNested.success) qc.setQueryData(qk.me, parsedNested.data);
      qc.setQueryData(qk.setupStatus, { needsSetup: false });
      await qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: LoginBody): Promise<User | null> => {
      const data = await api<unknown>('/auth/login', { method: 'POST', body });
      const parsed = MeResponse.safeParse(data);
      if (parsed.success) return parsed.data;
      const nested = MeResponse.safeParse((data as { user?: unknown } | null)?.user);
      if (nested.success) return nested.data;
      // Server didn't echo the user — ask for it.
      return api('/me', { schema: MeResponse });
    },
    onSuccess: (user) => {
      qc.setQueryData(qk.me, user);
    },
  });
}

/**
 * Best-effort removal of this browser's push subscription (server row + browser subscription).
 * Never throws: logout / session revocation must proceed regardless.
 */
export async function dropPushSubscription(): Promise<void> {
  try {
    await unsubscribePush();
  } catch {
    // ignore — e.g. 401 after a revoked session; the browser subscription is still removed.
  }
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // Drop this device's push subscription while the session is still valid, so a
      // shared / handed-over phone stops receiving customer previews after sign-out.
      await dropPushSubscription();
      try {
        await api('/auth/logout', { method: 'POST' });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
      }
    },
    onSettled: () => {
      qc.clear();
      qc.setQueryData(qk.me, null);
    },
  });
}

/** Saves the signed-in user's language preference (null = follow the browser). */
export function useSetMyLocale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (locale: Locale | null) =>
      api('/me', { method: 'PATCH', body: { locale } satisfies PatchMeBody, schema: MeResponse }),
    onSuccess: (user) => qc.setQueryData(qk.me, user),
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ChangePasswordBody) =>
      api<unknown>('/auth/change-password', { method: 'POST', body }),
    onSuccess: async () => {
      const me = currentUser(qc);
      if (me) qc.setQueryData(qk.me, { ...me, mustChangePassword: false });
      await qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

// ---------------------------------------------------------------------------
// Chats & messages
// ---------------------------------------------------------------------------

export function useChats(filters: ChatFilters) {
  return useInfiniteQuery({
    queryKey: qk.chats(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams();
      if (filters.status) p.set('status', filters.status);
      p.set('assigned', filters.assigned);
      if (filters.q?.trim()) p.set('q', filters.q.trim());
      if (filters.tag) p.set('tag', filters.tag);
      if (pageParam) p.set('cursor', pageParam);
      return api<ChatListResponse>(`/chats?${p.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useChat(jid: string | null | undefined) {
  return useQuery({
    queryKey: qk.chat(jid ?? ''),
    queryFn: ({ signal }) => api<ChatDetailResponse>(`/chats/${enc(jid ?? '')}`, { signal }),
    enabled: !!jid,
  });
}

export function useOpenChatCount() {
  return useQuery({
    queryKey: qk.openChatCount,
    queryFn: ({ signal }) => api('/chats/open-count', { schema: OpenChatCountResponse, signal }),
  });
}

export function useResolveAllChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api('/chats/resolve-all', {
        method: 'POST',
        body: { confirmed: true },
        schema: ResolveAllChatsResponse,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.chatsAll }),
        qc.invalidateQueries({ queryKey: ['chat'] }),
        qc.invalidateQueries({ queryKey: qk.openChatCount }),
        qc.invalidateQueries({ queryKey: qk.audit }),
      ]);
    },
  });
}

/** Infinite message history; `fetchNextPage()` loads OLDER messages (pages[1..] are older). */
export function useMessages(jid: string | null | undefined) {
  return useInfiniteQuery({
    queryKey: qk.messages(jid ?? ''),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (pageParam) p.set('before', pageParam);
      return api<MessageListResponse>(`/chats/${enc(jid ?? '')}/messages?${p.toString()}`, {
        signal,
      });
    },
    getNextPageParam: (last) => last.nextBefore,
    enabled: !!jid,
  });
}

/** Flatten MessagesData into ascending order. */
export function flattenMessages(data: MessagesData | undefined): Message[] {
  if (!data) return [];
  const out: Message[] = [];
  for (let i = data.pages.length - 1; i >= 0; i--) out.push(...(data.pages[i]?.messages ?? []));
  return out;
}

export interface SendTextInput {
  text: string;
  quotedId?: string;
  /** Generate with `newClientId()` (crypto.randomUUID). */
  clientId: string;
}

/** Optimistic text send: inserts a pending bubble immediately, reconciled by clientId. */
export function useSendText(jid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendTextInput) =>
      api<Message>(`/chats/${enc(jid)}/messages`, {
        method: 'POST',
        body: { text: input.text, quotedId: input.quotedId, clientId: input.clientId },
      }),
    onMutate: (input) => {
      const msg = optimisticMessage(qc, jid, input.clientId, {
        body: input.text,
        quotedId: input.quotedId ?? null,
      });
      upsertMessageInCache(qc, msg);
      return { clientId: input.clientId };
    },
    onSuccess: (m) => {
      if (m && typeof m === 'object' && 'id' in m) upsertMessageInCache(qc, m);
      void qc.invalidateQueries({ queryKey: qk.chatsAll });
    },
    onError: (e, input) => {
      patchMessageInCache(
        qc,
        jid,
        { id: `local-${input.clientId}`, clientId: input.clientId },
        {
          status: 'failed',
          error: e instanceof Error ? e.message : 'Send failed',
        },
      );
    },
  });
}

export interface SendMediaInput {
  file: File;
  caption?: string;
  clientId: string;
  /** Reply to this message (WhatsApp shows it as a quote). */
  quotedId?: string;
  /** A recorded Ogg/Opus voice note: sent as a WhatsApp voice note, never with a caption. */
  voiceNote?: boolean;
}

export function useSendMedia(jid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendMediaInput) => {
      const fields: SendMediaFields = {
        clientId: input.clientId,
        ...(input.caption ? { caption: input.caption } : {}),
        ...(input.quotedId ? { quotedId: input.quotedId } : {}),
        ...(input.voiceNote ? { voiceNote: '1' as const } : {}),
      };
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      form.append('file', input.file, input.file.name);
      return api<Message>(`/chats/${enc(jid)}/media`, { method: 'POST', form });
    },
    onMutate: (input) => {
      const mime = input.file.type;
      const type: Message['type'] = mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('video/')
          ? 'video'
          : mime.startsWith('audio/')
            ? 'audio'
            : 'document';
      upsertMessageInCache(
        qc,
        optimisticMessage(qc, jid, input.clientId, {
          type,
          body: input.caption ?? null,
          quotedId: input.quotedId ?? null,
          mediaMime: mime || null,
          mediaName: input.file.name,
          mediaStatus: 'pending',
          ...(input.voiceNote ? { voiceNote: true, mediaName: null } : {}),
        }),
      );
    },
    onSuccess: (m) => {
      if (m && typeof m === 'object' && 'id' in m) upsertMessageInCache(qc, m);
      void qc.invalidateQueries({ queryKey: qk.chatsAll });
    },
    onError: (e, input) => {
      // A voice note that did not upload stays in the composer's Review to send again (same
      // clientId, so a retry never duplicates it): drop its bubble instead of a dead Retry.
      if (input.voiceNote) {
        removeMessageFromCache(qc, jid, input.clientId);
        return;
      }
      patchMessageInCache(
        qc,
        jid,
        { id: `local-${input.clientId}`, clientId: input.clientId },
        {
          status: 'failed',
          error: e instanceof Error ? e.message : 'Upload failed',
        },
      );
    },
  });
}

export function useRetryMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Message>(`/messages/${enc(id)}/retry`, { method: 'POST' }),
    onSuccess: (m) => {
      if (m && typeof m === 'object' && 'id' in m) upsertMessageInCache(qc, m);
    },
  });
}

export function usePatchChat(jid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ChatPatchBody) => api<Chat>(`/chats/${enc(jid)}`, { method: 'PATCH', body }),
    onSuccess: async (chat) => {
      if (chat && typeof chat === 'object' && 'jid' in chat) upsertChatInCache(qc, chat);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.chatsAll }),
        qc.invalidateQueries({ queryKey: qk.chat(jid) }),
      ]);
    },
  });
}

export function useMarkRead(jid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<unknown>(`/chats/${enc(jid)}/read`, { method: 'POST' }),
    onMutate: () => {
      const detail = qc.getQueryData<ChatDetailResponse>(qk.chat(jid));
      if (detail) upsertChatInCache(qc, { ...detail.chat, unreadCount: 0 });
      else
        qc.setQueriesData<ChatsData>({ queryKey: qk.chatsAll }, (old) =>
          old?.pages
            ? {
                ...old,
                pages: old.pages.map((p) => ({
                  ...p,
                  chats: p.chats.map((c) => (c.jid === jid ? { ...c, unreadCount: 0 } : c)),
                })),
              }
            : old,
        );
    },
  });
}

export function useNotes(jid: string | null | undefined) {
  return useQuery({
    queryKey: qk.notes(jid ?? ''),
    queryFn: async ({ signal }) =>
      unwrapList<Note>(await api(`/chats/${enc(jid ?? '')}/notes`, { signal }), 'notes'),
    enabled: !!jid,
  });
}

export function useAddNote(jid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api<Note>(`/chats/${enc(jid)}/notes`, { method: 'POST', body: { body } }),
    onSuccess: (note) => {
      if (!note || typeof note !== 'object') return;
      qc.setQueryData<Note[]>(qk.notes(jid), (old) =>
        old ? (old.some((n) => n.id === note.id) ? old : [...old, note]) : old,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Customer profiles
// ---------------------------------------------------------------------------

/** Members of a group chat (read from WhatsApp by the server, cached there for a few minutes). */
export function useGroupMembers(jid: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.groupMembers(jid ?? ''),
    queryFn: ({ signal }) => api<GroupInfoResponse>(`/chats/${enc(jid ?? '')}/members`, { signal }),
    enabled: !!jid && enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** A member's WhatsApp About text, fetched only when their details are opened. */
export function useMemberAbout(groupJid: string, member: string | null) {
  return useQuery({
    queryKey: qk.memberAbout(groupJid, member ?? ''),
    queryFn: ({ signal }) =>
      api<GroupMemberAboutResponse>(`/chats/${enc(groupJid)}/members/${enc(member ?? '')}/about`, {
        signal,
      }),
    enabled: !!member,
    staleTime: 30 * 60_000,
    retry: false,
  });
}

/** Open (or create) the direct chat with a group member. */
export function useStartMemberChat(groupJid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (member: string) =>
      api<StartMemberChatResponse>(`/chats/${enc(groupJid)}/members/${enc(member)}/chat`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.chatsAll });
      void qc.invalidateQueries({ queryKey: qk.groupMembers(groupJid) });
    },
  });
}

export function useCustomerProfile(jid: string | null | undefined) {
  return useQuery({
    queryKey: qk.customerProfile(jid ?? ''),
    queryFn: ({ signal }) =>
      api<CustomerProfileResponse>(`/chats/${enc(jid ?? '')}/profile`, { signal }),
    enabled: !!jid,
  });
}

export function useSaveCustomerProfile(jid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CustomerProfileBody) =>
      api<CustomerProfileResponse>(`/chats/${enc(jid)}/profile`, { method: 'PUT', body }),
    onSuccess: (saved) => {
      qc.setQueryData(qk.customerProfile(jid), saved);
      void qc.invalidateQueries({ queryKey: ['customer-tags'] });
      // Header name and list row/tags, even when the socket is down.
      void qc.invalidateQueries({ queryKey: qk.chat(jid) });
      void qc.invalidateQueries({ queryKey: qk.chatsAll });
    },
  });
}

export function useCustomerTags(q: string) {
  return useQuery({
    queryKey: qk.customerTags(q),
    queryFn: ({ signal }) =>
      api<CustomerTagsResponse>(`/customer-tags?q=${encodeURIComponent(q)}`, { signal }),
    select: (r) => r.tags,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Quick replies
// ---------------------------------------------------------------------------

export function useQuickReplies() {
  return useQuery({
    queryKey: qk.quickReplies,
    queryFn: async () => unwrapList<QuickReply>(await api('/quick-replies'), 'quickReplies'),
    staleTime: 60_000,
  });
}

/** Create (no id) or update (with id). */
export function useSaveQuickReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: QuickReplyBody & { id?: number }) =>
      id == null
        ? api<QuickReply>('/quick-replies', { method: 'POST', body })
        : api<QuickReply>(`/quick-replies/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.quickReplies }),
  });
}

export function useDeleteQuickReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<unknown>(`/quick-replies/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.quickReplies }),
  });
}

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------

export function useUsers(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.users,
    queryFn: async () => unwrapList<User>(await api('/users'), 'users'),
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
  });
}

/** Public team-member fields every logged-in user may see (`GET /api/users/directory`). */
export type DirectoryUser = Pick<
  User,
  'id' | 'displayName' | 'role' | 'disabled' | 'kind' | 'aiRole'
>;

/**
 * Team directory for every role (agents included). Needs the server route
 * `GET /api/users/directory`; when it is missing (404) or forbidden, resolves to an empty list
 * so the UI falls back to "Agent #<id>" instead of erroring.
 */
export function useUserDirectory(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.directory,
    queryFn: async (): Promise<DirectoryUser[]> => {
      try {
        return unwrapList<DirectoryUser>(await api('/users/directory'), 'users');
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return [];
        throw e;
      }
    },
    enabled: opts.enabled ?? true,
    staleTime: 60_000,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserBody) => api<User>('/users', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users }),
  });
}

export function usePatchUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: PatchUserBody }) =>
      api<User>(`/users/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users }),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (id: number) =>
      api<ResetPasswordResponse>(`/users/${id}/reset-password`, { method: 'POST' }),
  });
}

export function useRevokeSessions() {
  return useMutation({
    mutationFn: (id: number) => api<unknown>(`/users/${id}/sessions`, { method: 'DELETE' }),
  });
}

// ---------------------------------------------------------------------------
// WhatsApp, tunnel, settings, audit
// ---------------------------------------------------------------------------

export function useWaStatus(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.wa,
    queryFn: () => api<WaStatus>('/wa/status'),
    enabled: opts.enabled ?? true,
    // Socket pushes updates; poll as a fallback while linking.
    refetchInterval: (q) => {
      const s = q.state.data?.state;
      return s === 'qr' || s === 'connecting' ? 5_000 : 30_000;
    },
  });
}

export type WaAction = 'logout' | 'relink' | 'takeover';

export function useWaAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: WaAction) => api<unknown>(`/wa/${action}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.wa }),
  });
}

/** Link by phone number: returns the 8-character code to enter in WhatsApp → Linked devices. */
export function useRequestPairingCode() {
  return useMutation({
    mutationFn: (phone: string) =>
      api<{ code: string }>('/wa/pairing-code', { method: 'POST', body: { phone } }),
  });
}

export function useTunnel(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.tunnel,
    queryFn: () => api<TunnelStatus>('/tunnel'),
    enabled: opts.enabled ?? true,
    refetchInterval: (q) => (q.state.data?.state === 'starting' ? 3_000 : false),
  });
}

/** Poll only while Cloudflare is signing in or provisioning an inbox address. */
export function useCloudflareSetupStatus() {
  return useQuery({
    queryKey: qk.cloudflareSetup,
    queryFn: ({ signal }) => api('/tunnel/cloudflare', { schema: CloudflareSetupStatus, signal }),
    refetchInterval: (query) => {
      const status = query.state.data;
      return status?.busy || status?.state === 'signing_in' || status?.state === 'awaiting_approval'
        ? 2000
        : false;
    },
  });
}

export type CloudflareAccountAction = 'login' | 'login/cancel' | 'refresh';

/** Account actions all return the same public setup state; credentials stay on the server. */
export function useCloudflareAccountAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: CloudflareAccountAction) =>
      api(`/tunnel/cloudflare/${action}`, { body: {}, schema: CloudflareSetupStatus }),
    onSuccess: (status) => qc.setQueryData(qk.cloudflareSetup, status),
  });
}

export function useCreateCloudflareTunnel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CloudflareCreateBody) =>
      api('/tunnel/cloudflare/create', { body, schema: TunnelStatusSchema }),
    onSuccess: async (status) => {
      qc.setQueryData(qk.tunnel, status);
      await Promise.all(
        [qk.tunnel, qk.settings, qk.cloudflareSetup].map((queryKey) =>
          qc.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
}

export function useStartTunnel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TunnelStartBody) =>
      api<TunnelStatus>('/tunnel/start', { method: 'POST', body }),
    onSuccess: (s) => {
      if (s && typeof s === 'object' && 'state' in s) qc.setQueryData(qk.tunnel, s);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.tunnel }),
  });
}

export function useStopTunnel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<TunnelStatus>('/tunnel/stop', { method: 'POST' }),
    onSuccess: (s) => {
      if (s && typeof s === 'object' && 'state' in s) qc.setQueryData(qk.tunnel, s);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.tunnel }),
  });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: () => api<Settings>('/settings') });
}

export interface PatchSettingsResult {
  settings: Settings;
  restartRequired: boolean;
}

export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: SettingsPatchBody): Promise<PatchSettingsResult> => {
      const data = await api<unknown>('/settings', { method: 'PATCH', body });
      if (data && typeof data === 'object' && 'settings' in data) {
        const d = data as { settings: Settings; restartRequired?: boolean };
        return { settings: d.settings, restartRequired: !!d.restartRequired };
      }
      return { settings: data as Settings, restartRequired: false };
    },
    onSuccess: (r) => qc.setQueryData(qk.settings, r.settings),
  });
}

/** Audit log, newest first; `fetchNextPage()` loads older entries (cursor = last entry id). */
export function useAudit(limit = 50) {
  return useInfiniteQuery({
    queryKey: qk.audit,
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam, signal }) => {
      const p = new URLSearchParams({ limit: String(limit) });
      if (pageParam != null) p.set('before', String(pageParam));
      return {
        entries: unwrapList<AuditEntry>(await api(`/audit?${p.toString()}`, { signal }), 'entries'),
      };
    },
    getNextPageParam: (last) =>
      last.entries.length < limit ? null : (last.entries[last.entries.length - 1]?.id ?? null),
  });
}

// ---------------------------------------------------------------------------
// Integrations: AI assistant (MCP) access and personal access tokens (admin)
// ---------------------------------------------------------------------------

export function useMcpSettings() {
  return useQuery({
    queryKey: qk.mcpSettings,
    queryFn: ({ signal }) => api('/integrations/mcp', { schema: McpSettingsResponse, signal }),
  });
}

export function usePatchMcpSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: McpSettingsPatch) =>
      api('/integrations/mcp', { method: 'PATCH', body, schema: McpSettingsResponse }),
    onSuccess: (next) => qc.setQueryData(qk.mcpSettings, next),
  });
}

export function useApiTokens() {
  return useQuery({
    queryKey: qk.apiTokens,
    queryFn: async ({ signal }): Promise<ApiToken[]> =>
      (await api('/integrations/tokens', { schema: ApiTokenListResponse, signal })).tokens,
  });
}

export interface CreateApiTokenVars {
  body: CreateApiTokenBodyInput;
  /**
   * Receives the one-time secret. It is handed straight to the caller's component state and is
   * never the mutation's result, so it stays out of the react-query caches.
   */
  onSecret: (secret: string) => void;
}

/** Creates a token; the mutation result is the token metadata only (see `onSecret`). */
export function useCreateApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, onSecret }: CreateApiTokenVars): Promise<ApiToken> => {
      const { token, secret } = await api('/integrations/tokens', {
        method: 'POST',
        body,
        schema: CreateApiTokenResponse,
      });
      onSecret(secret);
      return token;
    },
    gcTime: 0,
    onSettled: () => qc.invalidateQueries({ queryKey: qk.apiTokens }),
  });
}

/** Revokes a token; one that is already gone (404) counts as revoked. */
export function useRevokeApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      try {
        await api<unknown>(`/integrations/tokens/${id}`, { method: 'DELETE' });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.apiTokens }),
  });
}
