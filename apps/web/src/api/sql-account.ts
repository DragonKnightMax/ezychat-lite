import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  SqlAccountStatus,
  SqlActivity,
  SqlAgentSettings,
  SqlConnectResult,
  SqlCustomerRow,
  SqlDebtor,
  type SqlConnectBody,
  type SqlLinkBody,
} from '@ezychat/shared';
import { api } from './client';

/**
 * Admin → Connectors → SQL Account (admins only; design docs/features/sql-accounting/design.md).
 * The keys never reach the browser: the server answers with the address and the key end only.
 */
export const sqlAccountKey = ['connectors', 'sql-account'] as const;
export const sqlAgentKey = (agentId: number) => [...sqlAccountKey, 'agent', agentId] as const;
export const sqlCustomersKey = [...sqlAccountKey, 'customers'] as const;
export const sqlActivityKey = [...sqlAccountKey, 'activity'] as const;
export const sqlDebtorsKey = (q: string) => [...sqlAccountKey, 'debtors', q] as const;

export function useSqlAccount(enabled = true) {
  return useQuery({
    queryKey: sqlAccountKey,
    queryFn: ({ signal }) => api('/connectors/sql-account', { signal, schema: SqlAccountStatus }),
    enabled,
  });
}

/** Checks the keys with SQL Account; they are saved only when SQL Account answered. */
export function useSqlConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SqlConnectBody) =>
      api('/connectors/sql-account/connect', { method: 'POST', body, schema: SqlConnectResult }),
    onSuccess: (result) => qc.setQueryData(sqlAccountKey, result.status),
  });
}

/** Sends one check to SQL Account and answers the connection's state now. */
export function useSqlTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api('/connectors/sql-account/test', { method: 'POST', schema: SqlAccountStatus }),
    onSuccess: (status) => qc.setQueryData(sqlAccountKey, status),
  });
}

/** Deletes the keys from this computer (nothing changes in SQL Account). */
export function useSqlDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api('/connectors/sql-account/disconnect', { method: 'POST', schema: SqlAccountStatus }),
    onSuccess: (status) => {
      qc.setQueryData(sqlAccountKey, status);
      void qc.invalidateQueries({ queryKey: sqlCustomersKey });
    },
  });
}

/** "Match by phone number" (install-wide). */
export function useSqlMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (matchByPhone: boolean) =>
      api('/connectors/sql-account/match', {
        method: 'PUT',
        body: { matchByPhone },
        schema: SqlAccountStatus,
      }),
    onSuccess: (status) => {
      qc.setQueryData(sqlAccountKey, status);
      void qc.invalidateQueries({ queryKey: sqlCustomersKey });
    },
  });
}

/** One AI agent's access per SQL Account object (the defaults until an admin saves them). */
export function useSqlAgentSettings(agentId: number | null, enabled = true) {
  return useQuery({
    queryKey: sqlAgentKey(agentId ?? 0),
    queryFn: ({ signal }) =>
      api(`/connectors/sql-account/agents/${agentId}`, { signal, schema: SqlAgentSettings }),
    enabled: enabled && agentId !== null,
  });
}

export function useSaveSqlAgentSettings(agentId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SqlAgentSettings) =>
      api(`/connectors/sql-account/agents/${agentId}`, {
        method: 'PUT',
        body,
        schema: SqlAgentSettings,
      }),
    onSuccess: (saved) => qc.setQueryData(sqlAgentKey(agentId), saved),
  });
}

/** Customers tab: direct chats and the SQL Account customer each is matched to. */
export function useSqlCustomers(enabled = true) {
  return useQuery({
    queryKey: sqlCustomersKey,
    queryFn: ({ signal }) =>
      api('/connectors/sql-account/customers', { signal, schema: z.array(SqlCustomerRow) }),
    enabled,
  });
}

/** SQL Account customers for the Link dialog (503 `sql_unavailable` while not connected). */
export function useSqlDebtors(q: string, enabled = true) {
  return useQuery({
    queryKey: sqlDebtorsKey(q),
    queryFn: ({ signal }) =>
      api(`/connectors/sql-account/debtors?q=${encodeURIComponent(q)}`, {
        signal,
        schema: z.array(SqlDebtor),
      }),
    // Keep the last answer on screen while the next search runs.
    placeholderData: (previous) => previous,
    enabled,
  });
}

/** Links a chat to a customer code (checked with SQL Account; 400 `unknown_code`), or unlinks it. */
export function useSqlLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SqlLinkBody) =>
      api('/connectors/sql-account/links', { method: 'PUT', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: sqlCustomersKey }),
  });
}

export function useSqlActivity(enabled = true) {
  return useQuery({
    queryKey: sqlActivityKey,
    queryFn: ({ signal }) =>
      api('/connectors/sql-account/activity', { signal, schema: z.array(SqlActivity) }),
    enabled,
  });
}
