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
  type LucideIcon,
} from 'lucide-react';
import type { GoogleState } from './googleCalendar';

/**
 * Proposed (google-calendar → connector gallery): the ready connectors the app knows about. Owner
 * (2026-10-26): every ready connector is offered in Lite and Enterprise; only the custom MCP connector
 * is Enterprise (added to the list by the Enterprise web extension). Texts are catalog keys under
 * `mockConnectors.items.<id>`.
 */
export type ConnectorCategory =
  'booking' | 'accounting' | 'crm' | 'data' | 'payments' | 'commerce' | 'custom';
export const CONNECTOR_CATEGORIES: readonly ConnectorCategory[] = [
  'booking',
  'accounting',
  'crm',
  'data',
  'payments',
  'commerce',
  'custom',
];

/**
 * Proposed: "Vote for this connector" opens a chat with the EzyChat team on WhatsApp (the number the
 * website uses). In the app it is a `useAppLinks()` link an edition can change or hide (`null`).
 */
export const CONNECTOR_REQUEST_WHATSAPP = '601159246128';
export function voteUrl(message: string): string {
  return `https://wa.me/${CONNECTOR_REQUEST_WHATSAPP}?text=${encodeURIComponent(message)}`;
}

export interface CatalogConnector {
  id: string;
  icon: LucideIcon;
  category: ConnectorCategory;
  /** `core`: Lite and Enterprise. `enterprise`: shown in Lite with an upgrade note. */
  edition: 'core' | 'enterprise';
  /** Ready now, or listed so admins see what is coming. */
  available: boolean;
  /** What the AI may do with it: look-ups (read) and actions that change data. */
  tools: { key: string; access: 'read' | 'write' }[];
}

export const CONNECTORS: readonly CatalogConnector[] = [
  {
    id: 'google-calendar',
    icon: CalendarDays,
    category: 'booking',
    edition: 'core',
    available: true,
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
    available: false,
    tools: [
      { key: 'readRows', access: 'read' },
      { key: 'addLead', access: 'write' },
    ],
  },
  {
    id: 'hitpay',
    icon: CreditCard,
    category: 'payments',
    edition: 'core',
    available: false,
    tools: [
      { key: 'paymentLink', access: 'write' },
      { key: 'paymentStatus', access: 'read' },
    ],
  },
  {
    id: 'shopify',
    icon: ShoppingBag,
    category: 'commerce',
    edition: 'core',
    available: false,
    tools: [
      { key: 'orderStatus', access: 'read' },
      { key: 'productStock', access: 'read' },
    ],
  },
  {
    id: 'autocount',
    icon: Calculator,
    category: 'accounting',
    edition: 'core',
    available: false,
    tools: [
      { key: 'stock', access: 'read' },
      { key: 'quotation', access: 'write' },
    ],
  },
  {
    id: 'sql-account',
    icon: Receipt,
    category: 'accounting',
    edition: 'core',
    available: false,
    tools: [
      { key: 'stock', access: 'read' },
      { key: 'outstanding', access: 'read' },
    ],
  },
  {
    id: 'bukku',
    icon: BookOpenCheck,
    category: 'accounting',
    edition: 'core',
    available: false,
    tools: [
      { key: 'invoice', access: 'read' },
      { key: 'quotation', access: 'write' },
    ],
  },
  {
    id: 'xero',
    icon: Wallet,
    category: 'accounting',
    edition: 'core',
    available: false,
    tools: [
      { key: 'invoice', access: 'read' },
      { key: 'contact', access: 'write' },
    ],
  },
  {
    id: 'zoho-books',
    icon: Receipt,
    category: 'accounting',
    edition: 'core',
    available: false,
    tools: [
      { key: 'invoice', access: 'read' },
      { key: 'quotation', access: 'write' },
    ],
  },
  {
    id: 'zoho-crm',
    icon: ContactRound,
    category: 'crm',
    edition: 'core',
    available: false,
    tools: [
      { key: 'findContact', access: 'read' },
      { key: 'addLead', access: 'write' },
    ],
  },
  {
    id: 'hubspot',
    icon: Users,
    category: 'crm',
    edition: 'core',
    available: false,
    tools: [
      { key: 'findContact', access: 'read' },
      { key: 'addLead', access: 'write' },
    ],
  },
  {
    id: 'woocommerce',
    icon: ShoppingCart,
    category: 'commerce',
    edition: 'core',
    available: false,
    tools: [
      { key: 'orderStatus', access: 'read' },
      { key: 'productStock', access: 'read' },
    ],
  },
  {
    id: 'easystore',
    icon: Store,
    category: 'commerce',
    edition: 'core',
    available: false,
    tools: [
      { key: 'orderStatus', access: 'read' },
      { key: 'productStock', access: 'read' },
    ],
  },
  {
    id: 'storehub',
    icon: Store,
    category: 'commerce',
    edition: 'core',
    available: false,
    tools: [
      { key: 'productStock', access: 'read' },
      { key: 'member', access: 'read' },
    ],
  },
  {
    id: 'billplz',
    icon: CreditCard,
    category: 'payments',
    edition: 'core',
    available: false,
    tools: [
      { key: 'paymentLink', access: 'write' },
      { key: 'paymentStatus', access: 'read' },
    ],
  },
  {
    id: 'custom-mcp',
    // Owner (2026-10-26): listed in Lite greyed out, marked Enterprise only.
    icon: Plug,
    category: 'custom',
    edition: 'enterprise',
    available: true,
    tools: [],
  },
];

/** The state a gallery card shows. */
export type ConnectorStatus =
  'connected' | 'attention' | 'notConnected' | 'comingSoon' | 'enterprise';

export function connectorStatus(
  c: CatalogConnector,
  edition: 'lite' | 'enterprise',
  google: GoogleState | undefined,
): ConnectorStatus {
  if (c.edition === 'enterprise' && edition === 'lite') return 'enterprise';
  if (!c.available) return 'comingSoon';
  if (c.id === 'google-calendar') {
    if (google === 'connected') return 'connected';
    if (google === 'expired' || google === 'unavailable') return 'attention';
  }
  return 'notConnected';
}

/** The connectors an edition lists: every edition lists all; Lite greys out Enterprise ones. */
export function listedConnectors(_edition: 'lite' | 'enterprise'): readonly CatalogConnector[] {
  return CONNECTORS;
}

/** Categories with at least one listed connector. */
export function listedCategories(edition: 'lite' | 'enterprise'): ConnectorCategory[] {
  const listed = listedConnectors(edition);
  return CONNECTOR_CATEGORIES.filter((cat) => listed.some((c) => c.category === cat));
}
