import {
  Calculator,
  CalendarDays,
  ContactRound,
  CreditCard,
  HardDrive,
  Plug,
  Puzzle,
  ShoppingBag,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import type { ConnectorEntry, GoogleCalendarState } from '@ezychat/shared';

/**
 * Admin → Connectors: what the app itself provides next to the connector list (design
 * docs/features/connector-list/design.md). The list (server, `GET /api/connectors/list`) gives
 * every partner and coming-soon connector; the app keeps only its own features here: the built-in
 * Google Calendar, Google Sheets and Google Drive (their pages and tabs live in the app) and the custom MCP connector (Enterprise,
 * linked by its web extension through `connectorLinks`). Texts are catalog keys under
 * `connectors.items.<id>` and `connectors.tools.<tool>` (admin namespace).
 */
export const CONNECTOR_CATEGORIES = [
  'booking',
  'accounting',
  'crm',
  'data',
  'payments',
  'commerce',
  'custom',
  'other',
] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

/** The gallery filter of each list category (the list's names differ from the app's keys). */
export const LIST_CATEGORY: Record<ConnectorEntry['category'], ConnectorCategory> = {
  calendar: 'booking',
  accounting: 'accounting',
  crm: 'crm',
  spreadsheets: 'data',
  payments: 'payments',
  online_shop: 'commerce',
  custom: 'custom',
  other: 'other',
};

/** The icon of a list entry without its own icon file. */
export const CATEGORY_ICON: Record<ConnectorCategory, LucideIcon> = {
  booking: CalendarDays,
  accounting: Calculator,
  crm: ContactRound,
  data: Table2,
  payments: CreditCard,
  commerce: ShoppingBag,
  custom: Plug,
  other: Puzzle,
};

/** What the AI may do with the built-in Google Calendar, Google Sheets and Google Drive. */
export type ConnectorTool =
  'checkFree' | 'book' | 'readRows' | 'addLead' | 'save' | 'find' | 'read';

export const CONNECTOR_IDS = [
  'google-calendar',
  'google-sheets',
  'google-drive',
  'custom-mcp',
] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export interface CatalogConnector {
  id: ConnectorId;
  icon: LucideIcon;
  category: ConnectorCategory;
  /** `core`: every edition. `enterprise`: greyed out unless an extension links it. */
  edition: 'core' | 'enterprise';
  /** Look-ups (read) and actions that change data. */
  tools: readonly { key: ConnectorTool; access: 'read' | 'write' }[];
}

export const CONNECTORS: readonly CatalogConnector[] = [
  {
    id: 'google-calendar',
    icon: CalendarDays,
    category: 'booking',
    edition: 'core',
    tools: [
      { key: 'checkFree', access: 'read' },
      { key: 'book', access: 'write' },
    ],
  },
  {
    id: 'google-sheets',
    icon: Table2,
    category: 'data',
    edition: 'core',
    tools: [
      { key: 'readRows', access: 'read' },
      { key: 'addLead', access: 'write' },
    ],
  },
  {
    id: 'google-drive',
    icon: HardDrive,
    category: 'data',
    edition: 'core',
    tools: [
      { key: 'save', access: 'write' },
      { key: 'find', access: 'read' },
      { key: 'read', access: 'read' },
    ],
  },
  { id: 'custom-mcp', icon: Plug, category: 'custom', edition: 'enterprise', tools: [] },
];

export function findConnector(id: string | undefined): CatalogConnector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

/**
 * What a gallery card shows. `linked`: an extension provides the connector's page (no badge here;
 * that page shows its own state). `needsUpdate`: the list entry asks for a newer EzyChat;
 * `delisted`: connected, but no longer in the connector list (it keeps working).
 */
export type ConnectorStatus =
  | 'connected'
  | 'attention'
  | 'notConnected'
  | 'comingSoon'
  | 'enterprise'
  | 'linked'
  | 'needsUpdate'
  | 'delisted';

/** `google`: the sign-in state of this connector (Google Calendar's, Sheets' or Drive's). */
export function connectorStatus(
  c: CatalogConnector,
  google: GoogleCalendarState | undefined,
  extensionLink: string | undefined,
): ConnectorStatus {
  if (extensionLink) return 'linked';
  if (c.edition === 'enterprise') return 'enterprise';
  if (c.id === 'google-calendar' || c.id === 'google-sheets' || c.id === 'google-drive') {
    if (google === 'connected') return 'connected';
    if (google === 'expired' || google === 'unavailable') return 'attention';
  }
  return 'notConnected';
}
