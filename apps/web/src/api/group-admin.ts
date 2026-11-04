import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AddGroupMemberResponse,
  GroupAdminResponse,
  GroupInviteLinkResponse,
  type EditGroupBody,
  type GroupSettings,
} from '@ezychat/shared';
import { api } from './client';
import { qk } from './queries';

/**
 * Group management (design docs/features/group-management/design.md): what an EzyChat admin may
 * change in a WhatsApp group from Group info. The answer carries the connection's `caps`; the UI
 * shows only those actions, never by inbox type. Changes are never queued (offline → 503).
 */
export const groupAdminKey = (jid: string) => ['group-admin', jid] as const;

const enc = encodeURIComponent;

export function useGroupAdmin(jid: string, enabled = true) {
  return useQuery({
    queryKey: groupAdminKey(jid),
    queryFn: ({ signal }) =>
      api(`/chats/${enc(jid)}/group`, { signal, schema: GroupAdminResponse }),
    enabled: !!jid && enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** Every change refreshes the admin view and the member list read from WhatsApp. */
function useGroupChange<V, R>(
  jid: string,
  run: (v: V) => Promise<R>,
  onSuccess?: (r: R, v: V) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (r, v) => onSuccess?.(r, v),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: groupAdminKey(jid) });
      void qc.invalidateQueries({ queryKey: qk.groupMembers(jid) });
    },
  });
}

export const useEditGroup = (jid: string) =>
  useGroupChange(jid, (body: EditGroupBody) =>
    api(`/chats/${enc(jid)}/group`, { method: 'PATCH', body }),
  );

/** Exactly one number (digits with country code). `invite_needed`: offer Send invite. */
export const useAddGroupMember = (jid: string) =>
  useGroupChange(jid, (phone: string) =>
    api(`/chats/${enc(jid)}/group/members`, {
      method: 'POST',
      body: { phone },
      schema: AddGroupMemberResponse,
    }),
  );

export const useSendGroupInvite = (jid: string) =>
  useGroupChange(jid, (member: string) =>
    api(`/chats/${enc(jid)}/group/members/${enc(member)}/invite`, { method: 'POST' }),
  );

export const useRemoveGroupMember = (jid: string) =>
  useGroupChange(jid, (member: string) =>
    api(`/chats/${enc(jid)}/group/members/${enc(member)}`, { method: 'DELETE' }),
  );

export const useSetGroupMemberAdmin = (jid: string) =>
  useGroupChange(jid, (v: { member: string; admin: boolean }) =>
    api(`/chats/${enc(jid)}/group/members/${enc(v.member)}/role`, {
      method: 'PUT',
      body: { admin: v.admin },
    }),
  );

export function useResetGroupInvite(jid: string) {
  const qc = useQueryClient();
  return useGroupChange(
    jid,
    () =>
      api(`/chats/${enc(jid)}/group/invite-link/reset`, {
        method: 'POST',
        schema: GroupInviteLinkResponse,
      }),
    // The dialog shows the new link at once.
    ({ inviteLink }) =>
      qc.setQueryData<GroupAdminResponse>(groupAdminKey(jid), (old) =>
        old ? { ...old, inviteLink } : old,
      ),
  );
}

export function useGroupSettings(jid: string) {
  const qc = useQueryClient();
  return useGroupChange(
    jid,
    (body: Partial<GroupSettings>) =>
      api(`/chats/${enc(jid)}/group/settings`, { method: 'PUT', body }),
    // Show the new value at once; the refetch after it confirms what WhatsApp reports.
    (_r, body) =>
      qc.setQueryData<GroupAdminResponse>(groupAdminKey(jid), (old) =>
        old ? { ...old, settings: { ...old.settings, ...body } } : old,
      ),
  );
}

export const useGroupJoinRequest = (jid: string) =>
  useGroupChange(jid, (v: { member: string; approve: boolean }) =>
    api(`/chats/${enc(jid)}/group/requests/${enc(v.member)}`, {
      method: 'POST',
      body: { approve: v.approve },
    }),
  );
