import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';

/** Proposed (sql-accounting): mirrors ../../sql-account.ts (the mock's stand-in routes). */
export type SqlScenario =
  'ok' | 'no_dns' | 'unreachable' | 'private_ip' | 'bad_keys' | 'old_version';
export type SqlState = 'disconnected' | 'connected' | SqlScenario;
export type SqlAccess = 'off' | 'read' | 'create';
export type SqlObjectId =
  | 'stockitem'
  | 'customer'
  | 'customerinvoice'
  | 'salesinvoice'
  | 'salesquotation'
  | 'salesorder'
  | 'deliveryorder'
  | 'customerpayment';

export interface SqlObject {
  id: SqlObjectId;
  scope: 'everyone' | 'own';
  create: boolean;
  def: SqlAccess;
}

export interface SqlAgentSettings {
  access: Partial<Record<SqlObjectId, SqlAccess>>;
  showPrice: boolean;
  stockDetail: 'inStock' | 'quantity';
}

export interface SqlAccountView {
  state: SqlState;
  scenario: SqlScenario;
  host: string | null;
  keyEnd: string | null;
  checkedAt: number | null;
  version: string | null;
  matchByPhone: boolean;
  objects: SqlObject[];
  agents: Record<string, SqlAgentSettings>;
  defaults: SqlAgentSettings;
}

export interface SqlCustomerRow {
  jid: string;
  name: string;
  kind: 'linked' | 'phone' | 'several' | 'none';
  code: string | null;
  sqlName: string | null;
}

export interface SqlActivityRow {
  at: number;
  agent: string;
  chatJid: string;
  customer: string;
  tool: 'stock' | 'account' | 'document' | 'payments' | 'quotation';
  result: 'done' | 'refused' | 'failed';
  reason?: string;
  dockey?: number;
}

export type SqlQuestion =
  'stock' | 'balance' | 'document' | 'otherDocument' | 'quotation' | 'confirm';
export interface SqlTryResult {
  outcome: 'answer' | 'handover';
  reason?: string;
  object?: SqlObjectId;
  tools: string[];
  reply?: string;
  note?: string;
  match?: { kind: string; code: string | null; sqlName: string | null };
}

const BASE = '/mock/sql-account';
const KEY = ['mock', 'sql-account'] as const;

export function useSqlAccount() {
  return useQuery({ queryKey: KEY, queryFn: () => api<SqlAccountView>(BASE) });
}
export function useSqlCustomers() {
  return useQuery({
    queryKey: [...KEY, 'customers'],
    queryFn: () => api<SqlCustomerRow[]>(`${BASE}/customers`),
  });
}
export function useSqlDebtors(q: string) {
  return useQuery({
    queryKey: [...KEY, 'debtors', q],
    queryFn: () =>
      api<{ code: string; name: string }[]>(`${BASE}/debtors?q=${encodeURIComponent(q)}`),
  });
}
export function useSqlActivity() {
  return useQuery({
    queryKey: [...KEY, 'activity'],
    queryFn: () => api<SqlActivityRow[]>(`${BASE}/activity`),
  });
}

export type SqlAction =
  | { kind: 'connect'; accessKey: string; secretKey: string }
  | { kind: 'test' }
  | { kind: 'disconnect' }
  | { kind: 'scenario'; scenario: SqlScenario }
  | { kind: 'match'; matchByPhone: boolean }
  | { kind: 'agent'; agentId: string; settings: SqlAgentSettings }
  | { kind: 'link'; jid: string; code: string | null };

export function useSqlAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: SqlAction): Promise<unknown> => {
      switch (a.kind) {
        case 'connect':
          return api(`${BASE}/connect`, {
            method: 'POST',
            body: { accessKey: a.accessKey, secretKey: a.secretKey },
          });
        case 'test':
        case 'disconnect':
          return api(`${BASE}/${a.kind}`, { method: 'POST' });
        case 'scenario':
          return api(`${BASE}/scenario`, { method: 'PUT', body: { scenario: a.scenario } });
        case 'match':
          return api(`${BASE}/match`, {
            method: 'PUT',
            body: { matchByPhone: a.matchByPhone },
          });
        case 'agent':
          return api(`${BASE}/agents/${encodeURIComponent(a.agentId)}`, {
            method: 'PUT',
            body: a.settings,
          });
        case 'link':
          return api(`${BASE}/links`, { method: 'PUT', body: { jid: a.jid, code: a.code } });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSqlTry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      agentId: string;
      agentName: string;
      jid: string;
      question: SqlQuestion;
    }) => api<SqlTryResult>(`${BASE}/try`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'activity'] }),
  });
}
