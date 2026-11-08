import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Proposed (limited chat access), mock only: "Chats this member can see" (All chats / Only chosen
 * chats) as the stand-in routes `/api/mock/member-chats*` serve it (../../member-chats.ts).
 * Production: `User.chatScope` + `GET/PUT /api/users/:id/chats` (design.md → API).
 */
export interface ChosenChat {
  jid: string;
  name: string;
  type: 'dm' | 'group';
}

export interface MemberChats {
  userId: number;
  scope: 'all' | 'chosen';
  chats: ChosenChat[];
}

interface State {
  me: MemberChats;
  members?: MemberChats[];
}

const KEY = ['mock-member-chats'] as const;

export function useMemberChatsState() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [...KEY, user?.id ?? 0],
    queryFn: () => api<State>('/mock/member-chats'),
    enabled: !!user,
    // A change takes effect live (production: socket rooms rebuilt + `chat:access`).
    refetchInterval: 4000,
  });
}

/** The signed-in user's own scope; `limited` false while loading or for "All chats". */
export function useMyChats(): { limited: boolean; jids: ReadonlySet<string>; loaded: boolean } {
  const q = useMemberChatsState();
  const me = q.data?.me;
  return {
    limited: me?.scope === 'chosen',
    jids: new Set(me?.chats.map((c) => c.jid) ?? []),
    loaded: !!q.data,
  };
}

/** Admins: one member's choice (default "All chats"). */
export function useMemberChats(userId: number): MemberChats {
  const rows = useMemberChatsState().data?.members ?? [];
  return rows.find((m) => m.userId === userId) ?? { userId, scope: 'all', chats: [] };
}

export function useSaveMemberChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { userId: number; scope: 'all' | 'chosen'; chats: string[] }) =>
      api(`/mock/member-chats/${v.userId}`, {
        method: 'PUT',
        body: { scope: v.scope, chats: v.chats },
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
