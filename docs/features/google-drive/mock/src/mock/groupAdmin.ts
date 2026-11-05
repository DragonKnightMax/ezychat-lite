import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { qk } from '@/api/queries';

/**
 * Proposed (group-management), mock only: what an admin may change in a WhatsApp group from Group
 * info, as the stand-in routes `/api/mock/group-admin*` serve it (../../group-admin.ts). Production:
 * `GET /api/chats/:jid/group` carries the same fields from `WaCapabilities.groupAdmin`.
 */
export interface GroupAdminCaps {
  editInfo: boolean;
  addMembers: boolean;
  inviteOnly: boolean;
  removeMembers: boolean;
  admins: boolean;
  inviteLink: boolean;
  settings: Array<'announce' | 'locked' | 'memberAdd' | 'approval'>;
  joinRequests: boolean;
  maxMembers: number | null;
  nameMax: number;
}

export interface GroupSettings {
  announce: boolean;
  locked: boolean;
  memberAdd: 'admins' | 'all';
  approval: boolean;
}

export interface GroupAdminView {
  connection: 'linked_phone' | 'business_api';
  offline: boolean;
  caps: GroupAdminCaps;
  myRole: 'superadmin' | 'admin' | 'member';
  members: number;
  settings: GroupSettings;
  inviteLink: string | null;
  requests: Array<{ id: string; phone: string; name: string; at: number }>;
  log: Array<{ at: number; by: string; action: string; target: string | null }>;
}

const key = (jid: string) => ['mock-group-admin', jid] as const;
const enc = encodeURIComponent;

export function useGroupAdmin(jid: string, enabled = true) {
  return useQuery({
    queryKey: key(jid),
    queryFn: () => api<GroupAdminView>(`/mock/group-admin/${enc(jid)}`),
    enabled,
  });
}

/** Every change refreshes the admin view and the member list read from WhatsApp. */
function useChange<V, R = unknown>(jid: string, run: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key(jid) });
      void qc.invalidateQueries({ queryKey: qk.groupMembers(jid) });
    },
  });
}

export const useEditGroup = (jid: string) =>
  useChange(jid, (body: { name?: string; description?: string }) =>
    api(`/mock/group-admin/${enc(jid)}`, { method: 'PATCH', body }),
  );

export const useAddMember = (jid: string) =>
  useChange(jid, (phone: string) =>
    api<{ result: 'added' | 'invite_needed'; phone: string }>(
      `/mock/group-admin/${enc(jid)}/members`,
      { body: { phone } },
    ),
  );

export const useSendInvite = (jid: string) =>
  useChange(jid, (phone: string) =>
    api(`/mock/group-admin/${enc(jid)}/members/${enc(phone)}/invite`, { method: 'POST' }),
  );

export const useRemoveMember = (jid: string) =>
  useChange(jid, (member: string) =>
    api(`/mock/group-admin/${enc(jid)}/members/${enc(member)}`, { method: 'DELETE' }),
  );

export const useSetMemberAdmin = (jid: string) =>
  useChange(jid, (v: { member: string; admin: boolean }) =>
    api(`/mock/group-admin/${enc(jid)}/members/${enc(v.member)}/role`, {
      method: 'PUT',
      body: { admin: v.admin },
    }),
  );

export const useResetInvite = (jid: string) =>
  useChange(jid, () => api(`/mock/group-admin/${enc(jid)}/invite-link/reset`, { method: 'POST' }));

export const useGroupSettings = (jid: string) =>
  useChange(jid, (body: Partial<GroupSettings>) =>
    api(`/mock/group-admin/${enc(jid)}/settings`, { method: 'PUT', body }),
  );

export const useJoinRequest = (jid: string) =>
  useChange(jid, (v: { id: string; approve: boolean }) =>
    api(`/mock/group-admin/${enc(jid)}/requests/${enc(v.id)}`, { body: { approve: v.approve } }),
  );

export function useMockSwitch(jid: string) {
  return useChange(jid, (body: { connection?: GroupAdminView['connection']; offline?: boolean }) =>
    api('/mock/group-admin/mock', { method: 'PUT', body }),
  );
}
