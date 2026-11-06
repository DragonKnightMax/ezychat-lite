import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpenCheck,
  Calculator,
  CalendarDays,
  ContactRound,
  CreditCard,
  Plug,
  Receipt,
  ShoppingBag,
  ShoppingCart,
  Store,
  Table2,
  Users,
  Wallet,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/api/client';
import type { MockEdition } from './edition';

/**
 * Proposed (connector-list): the connector list (format 1) and partner (MCP) connections, as the
 * mock's stand-in routes `/api/mock/connector-list*` serve them (../../connector-list.ts). In the app
 * the server downloads and checks the signed list; the page only reads what the server kept.
 */
export type Lang = 'en' | 'ms' | 'zh-CN';
export type Texts = { en: string } & Partial<Record<Exclude<Lang, 'en'>, string>>;

export interface Guards {
  confirmFirst?: boolean;
  valueFrom?: Record<string, string>;
  fromCustomer?: string[];
  within?: Record<string, string>;
  limits?: { perChat?: number; perDay?: number };
}

export interface ListTool {
  name: string;
  title: Texts;
  description: Texts;
  access: 'read' | 'write';
  guards?: Guards;
}

export interface ListSetting {
  id: string;
  type: 'text' | 'select' | 'toggle' | 'days' | 'timeRange' | 'calendarPicker';
  label: Texts;
  hint?: Texts;
  options?: Array<{ value: string; label: Texts }>;
  default?: unknown;
  from?: string;
}

export interface ListEntry {
  id: string;
  schemaVersion: number;
  minAppVersion: string;
  kind: 'mcp' | 'builtin' | 'coming_soon';
  editions: MockEdition[];
  builtinId?: string;
  name: string;
  summary: Texts;
  description: Texts;
  category: string;
  icon: string;
  publisher?: string;
  homepage?: string;
  privacy?: Texts;
  mcp?: { url: string };
  auth?:
    | { type: 'oauth'; clientId?: string; scopes: string[] }
    | { type: 'api_key'; label: Texts; help: string }
    | { type: 'none' };
  tools?: ListTool[];
  skill?: Texts;
  settings?: ListSetting[];
}

export type ActivityReason =
  | 'confirm_first'
  | 'value_from'
  | 'from_customer'
  | 'within'
  | 'limit'
  | 'unreachable'
  | 'partner_error';

export interface PartnerActivity {
  at: number;
  kind: 'checked' | 'done' | 'refused' | 'failed';
  agent: string;
  customer: string;
  tool: string;
  reason?: ActivityReason;
}

export interface AgentChoice {
  settings: Record<string, unknown>;
  tools: Record<string, boolean>;
}

export interface PartnerConnection {
  state: 'waiting' | 'connected' | 'failed';
  error?: 'cancelled' | 'unreachable';
  account?: string;
  keyEnd?: string;
  connectedAt?: number;
  entry: ListEntry;
  agents: Record<string, AgentChoice>;
  activity: PartnerActivity[];
  signInUrl: string | null;
  choices: Record<string, Array<{ value: string; label: string }>>;
}

export type ListState = 'loaded' | 'offline' | 'rejected';

export interface ConnectorListView {
  appVersion: string;
  schemaVersions: number[];
  list: { format: 1; generatedAt: string; sequence: number; entries: ListEntry[] };
  status: { state: ListState; lastGoodAt: number };
  mock: { showGoogleMcp: boolean; delisted: string[]; partnerReachable: boolean };
  connections: Record<string, PartnerConnection>;
}

export const connectorListKey = ['mock', 'connectorList'] as const;

export function useConnectorList() {
  return useQuery({
    queryKey: connectorListKey,
    queryFn: () => api<ConnectorListView>('/mock/connector-list'),
    // While a partner sign-in is open in another tab, look for its result.
    refetchInterval: (query) =>
      Object.values(query.state.data?.connections ?? {}).some((c) => c.state === 'waiting')
        ? 1500
        : false,
  });
}

type Action =
  | { kind: 'check' }
  | {
      kind: 'scenario';
      body: Partial<{
        listState: ListState;
        showGoogleMcp: boolean;
        lejarListed: boolean;
        partnerReachable: boolean;
      }>;
    }
  | { kind: 'connect' | 'cancel' | 'disconnect'; id: string }
  | { kind: 'agent'; id: string; agentId: string; choice: AgentChoice };

export function useConnectorListAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: Action): Promise<ConnectorListView & { result?: string }> => {
      const base = '/mock/connector-list';
      if (action.kind === 'check') return api(`${base}/check`, { method: 'POST' });
      if (action.kind === 'scenario')
        return api(`${base}/scenario`, { method: 'PUT', body: action.body });
      if (action.kind === 'agent')
        return api(
          `${base}/connectors/${encodeURIComponent(action.id)}/agents/${encodeURIComponent(action.agentId)}`,
          { method: 'PUT', body: action.choice },
        );
      return api(`${base}/connectors/${encodeURIComponent(action.id)}/${action.kind}`, {
        method: 'POST',
      });
    },
    onSuccess: (data) => client.setQueryData(connectorListKey, data),
  });
}

export type KeyResult = 'ok' | 'refused' | 'unreachable';

export function useApiKeyAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; key: string; save: boolean }) =>
      api<{ result: KeyResult; view: ConnectorListView }>(
        `/mock/connector-list/connectors/${encodeURIComponent(input.id)}/api-key`,
        { method: 'POST', body: { key: input.key, save: input.save } },
      ),
    onSuccess: (data) => client.setQueryData(connectorListKey, data.view),
  });
}

/** The entry's text in the UI language; English when the entry has none. */
export function pick(texts: Texts | undefined, language: string): string {
  if (!texts) return '';
  const lang = (language.startsWith('zh') ? 'zh-CN' : language.slice(0, 2)) as Lang;
  return texts[lang] ?? texts.en;
}

const ICONS: Record<string, LucideIcon> = {
  calendar: CalendarDays,
  book: BookOpenCheck,
  contact: ContactRound,
  warehouse: Warehouse,
  card: CreditCard,
  table: Table2,
  bag: ShoppingBag,
  calculator: Calculator,
  receipt: Receipt,
  wallet: Wallet,
  users: Users,
  cart: ShoppingCart,
  store: Store,
};

/** In the app the icon comes with the list (icons/<id>.svg); the mock uses a stand-in. */
export function entryIcon(entry: Pick<ListEntry, 'icon'>): LucideIcon {
  return ICONS[entry.icon] ?? Plug;
}

const versionParts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
export function versionAtLeast(have: string, need: string): boolean {
  const a = versionParts(have);
  const b = versionParts(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** What this app does with an entry: unknown schema versions are never shown. */
export type EntryFit = 'hidden' | 'needsUpdate' | 'enterprise' | 'ok';
export function entryFit(
  entry: ListEntry,
  view: Pick<ConnectorListView, 'appVersion' | 'schemaVersions'>,
  edition: MockEdition,
): EntryFit {
  if (!view.schemaVersions.includes(entry.schemaVersion)) return 'hidden';
  if (!versionAtLeast(view.appVersion, entry.minAppVersion)) return 'needsUpdate';
  if (!entry.editions.includes(edition)) return 'enterprise';
  return 'ok';
}

/** The values a tool switch and the settings form start with. */
export function defaultChoice(entry: ListEntry): AgentChoice {
  return {
    settings: Object.fromEntries((entry.settings ?? []).map((s) => [s.id, s.default ?? ''])),
    // Look-ups start on; tools that change data start off (core rule).
    tools: Object.fromEntries((entry.tools ?? []).map((t) => [t.name, t.access === 'read'])),
  };
}

export function choiceFor(connection: PartnerConnection | undefined, agentId: string): AgentChoice {
  const base = defaultChoice(connection!.entry);
  const saved = connection?.agents[agentId];
  return saved
    ? {
        settings: { ...base.settings, ...saved.settings },
        tools: { ...base.tools, ...saved.tools },
      }
    : base;
}
