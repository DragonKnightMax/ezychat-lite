// Proposed (multi-inbox): mock-only store for inboxes, the inbox of each chat and each member's inbox
// access. Kept in this browser (localStorage) so the walkthrough survives a reload; the production
// feature keeps all of this on the server and filters chats there (an agent never receives a chat of an
// inbox they cannot open).
import { useMemo, useSyncExternalStore } from 'react';
import { useMockEdition } from './edition';

export type InboxStatus =
  | 'connected'
  | 'waiting_scan'
  | 'phone_offline'
  // Proposed (business-api): a Business API number whose access token Meta rejects.
  | 'token_invalid';

/**
 * Proposed (business-api): the Meta side of a Business API inbox. The admin pastes the IDs, the token and
 * the App secret; the server checks them with the Graph API and reads the rest. The token and the App
 * secret are stored encrypted on the server and never sent back (only the last four characters).
 */
export interface MockApiConnection {
  phoneNumberId: string;
  wabaId: string;
  /** Meta's verified business name for the number. */
  verifiedName: string;
  /** Meta's quality rating of the number. */
  quality: 'high' | 'medium' | 'low';
  /** Business-initiated conversations a day Meta allows (messaging limit tier). */
  limit: '250' | '1K' | '10K' | '100K' | 'unlimited';
  tokenEnd: string;
  /** Mock only: the webhook fails although the tunnel runs (Meta reports delivery errors). */
  webhookFailing?: boolean;
}

/** Proposed (business-api): an approved message template, synced from the WhatsApp Business Account. */
export interface MockTemplate {
  name: string;
  language: string;
  category: 'utility' | 'marketing' | 'authentication';
  /** Body with {{1}}, {{2}} … variables, as Meta stores it. */
  body: string;
  /** Example value for each variable (Meta keeps one per variable). */
  examples: string[];
  /** A media header or buttons: listed, not sendable from EzyChat in v1 (owner 2026-10-25). */
  header?: 'image' | 'document' | 'video';
}

export interface MockInbox {
  id: string;
  name: string;
  /** Display number, e.g. +60 12-345 6789 (known after the QR scan). */
  number: string;
  /**
   * A WhatsApp app on a phone (QR scan, as the app works today) or, proposed (business-api), a number on
   * the WhatsApp Business API (Meta Cloud API; Enterprise only).
   */
  type: 'linked_phone' | 'business_api';
  /** Proposed (business-api): set only for a Business API inbox. */
  api?: MockApiConnection;
  status: InboxStatus;
  /** Short colour token for the inbox chip (design-system tone, never a hex value). */
  tone: 'primary' | 'info' | 'warning' | 'success';
}

/** 'all' = every inbox (admins always); otherwise the ids an agent may open. */
export type InboxAccess = 'all' | string[];

interface State {
  inboxes: MockInbox[];
  /** chat JID → inbox id. */
  chatInbox: Record<string, string>;
  /** user id → access. Admins are not listed: they always see all inboxes. */
  access: Record<number, InboxAccess>;
  /** The chat list's inbox filter: 'all' or one inbox id (kept per browser, like the other filters). */
  inboxFilter: string;
  /**
   * Proposed (business-api): chat JID → time (ms) of the customer's last message. The 24-hour customer
   * service window of a Business API chat runs from it. The server keeps this per chat in production.
   */
  lastInbound: Record<string, number>;
  /** Proposed (business-api): approved templates of the WhatsApp Business Account. */
  templates: MockTemplate[];
}

// Bump the key whenever the seed changes, so open browsers load the new demo data.
const KEY = 'mock.businessApi.inboxes.v2';

const HOUR = 3_600_000;
export const WINDOW_MS = 24 * HOUR;

const seed = (): State => ({
  inboxes: [
    {
      id: 'main',
      name: 'Kopi Apong',
      number: '+60 12-345 6789',
      // The number the app links today keeps working as the first inbox.
      type: 'linked_phone',
      status: 'connected',
      tone: 'primary',
    },
    {
      id: 'catering',
      name: 'Catering',
      number: '+60 13-777 0000',
      type: 'linked_phone',
      status: 'connected',
      tone: 'warning',
    },
    {
      // Proposed (business-api): a third number on the WhatsApp Business API.
      id: 'support',
      name: 'Online orders',
      number: '+60 3-2785 5000',
      type: 'business_api',
      status: 'connected',
      tone: 'info',
      api: {
        phoneNumberId: '106540352242922',
        wabaId: '102290129340398',
        verifiedName: 'Kopi Apong Sdn Bhd',
        quality: 'high',
        limit: '1K',
        tokenEnd: 'a9F2',
      },
    },
  ],
  chatInbox: {
    '60123110021@s.whatsapp.net': 'catering',
    '60126677889@s.whatsapp.net': 'catering',
    '60125550142@s.whatsapp.net': 'main',
    '60127020388@s.whatsapp.net': 'main',
    '60128814455@s.whatsapp.net': 'support',
    '60129001234@s.whatsapp.net': 'support',
  },
  // Seeded users: 1 Aisyah (admin), 2 Daniel, 3 Mei Ling.
  access: { 2: ['main', 'support'], 3: ['catering'] },
  inboxFilter: 'all',
  // Priya wrote 18 hours ago (6 hours left); Jason 30 hours ago (window closed).
  lastInbound: {
    '60128814455@s.whatsapp.net': Date.now() - 18 * HOUR,
    '60129001234@s.whatsapp.net': Date.now() - 30 * HOUR,
  },
  templates: [
    {
      name: 'order_update',
      language: 'en',
      category: 'utility',
      body: 'Hi {{1}}, your order {{2}} is {{3}}. Reply to this message if you need help.',
      examples: ['Jason', '#1042', 'on its way'],
    },
    {
      name: 'follow_up',
      language: 'en',
      category: 'marketing',
      body: 'Hi {{1}}, thanks for visiting Kopi Apong! Show this message for 10% off your next order this week.',
      examples: ['Jason'],
    },
    {
      name: 'peringatan_tempahan',
      language: 'ms',
      category: 'utility',
      body: 'Hai {{1}}, tempahan anda untuk {{2}} pada {{3}} telah disahkan. Balas mesej ini jika ada pertanyaan.',
      examples: ['Jason', '2 orang', '7 malam'],
    },
    {
      name: 'weekend_menu',
      language: 'en',
      category: 'marketing',
      body: 'Hi {{1}}, our weekend menu is out! Durian cendol is back.',
      examples: ['Jason'],
      header: 'image',
    },
  ],
});

let state: State = load();
const listeners = new Set<() => void>();

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    // Private window or blocked storage: start from the seed.
  }
  return seed();
}

function save(next: State) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: keep the change for this page only.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMockInboxes(): State {
  const current = useSyncExternalStore(subscribe, () => state);
  // Proposed (custom-agents): the mock Lite view has one inbox, so every inbox UI hides itself.
  const lite = useMockEdition() === 'lite';
  return useMemo(
    () =>
      // Proposed (business-api): Lite has no Business API, so its one inbox is always a linked phone.
      lite
        ? {
            ...current,
            inboxes: current.inboxes.filter((i) => i.type === 'linked_phone').slice(0, 1),
            inboxFilter: 'all',
          }
        : current,
    [current, lite],
  );
}

/** The inbox of a chat; chats the seed does not know (new ones) belong to the first inbox. */
export function inboxOfChat(s: State, jid: string): MockInbox | undefined {
  const id = s.chatInbox[jid] ?? s.inboxes[0]?.id;
  return s.inboxes.find((i) => i.id === id);
}

export function accessOf(
  s: State,
  user: { id: number; role: string } | null | undefined,
): InboxAccess {
  if (!user) return [];
  if (user.role === 'admin') return 'all';
  return s.access[user.id] ?? [];
}

export function canOpen(access: InboxAccess, inboxId: string | undefined): boolean {
  return access === 'all' || (!!inboxId && access.includes(inboxId));
}

/** A new inbox waits for its QR scan; WhatsApp tells the number after the scan. */
export function addInbox(name: string, api?: MockApiConnection, number = ''): MockInbox {
  const tones: MockInbox['tone'][] = ['primary', 'warning', 'info', 'success'];
  const created: MockInbox = {
    id: `inbox-${Date.now().toString(36)}`,
    name,
    number,
    type: api ? 'business_api' : 'linked_phone',
    ...(api ? { api } : {}),
    tone: tones[state.inboxes.length % tones.length]!,
    // A Business API number is connected once its details are checked; a phone waits for the scan.
    status: api ? 'connected' : 'waiting_scan',
  };
  save({ ...state, inboxes: [...state.inboxes, created] });
  return created;
}

export function updateInbox(id: string, patch: Partial<MockInbox>) {
  save({ ...state, inboxes: state.inboxes.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
}

export function removeInbox(id: string) {
  save({ ...state, inboxes: state.inboxes.filter((i) => i.id !== id) });
}

export function setAccess(userId: number, access: string[]) {
  save({ ...state, access: { ...state.access, [userId]: access } });
}

/** From the inbox side: exactly these agents may open the inbox (others among `agentIds` lose it). */
export function setInboxMembers(inboxId: string, agentIds: number[], allowed: number[]) {
  const access = { ...state.access };
  for (const id of agentIds) {
    const current = access[id];
    const list = Array.isArray(current) ? current.filter((x) => x !== inboxId) : [];
    access[id] = allowed.includes(id) ? [...list, inboxId] : list;
  }
  save({ ...state, access });
}

/** Back to the seeded demo (walkthrough reset). */
export function resetMockInboxes() {
  save(seed());
}

export function setInboxFilter(inboxFilter: string) {
  save({ ...state, inboxFilter });
}

// Proposed (business-api): the 24-hour customer service window and templates.

/** Milliseconds left in the chat's 24-hour window; 0 when closed; null when the inbox has no window. */
export function windowLeft(s: State, jid: string, now = Date.now()): number | null {
  if (inboxOfChat(s, jid)?.type !== 'business_api') return null;
  const last = s.lastInbound[jid];
  if (last === undefined) return 0;
  return Math.max(0, last + WINDOW_MS - now);
}

/** The customer wrote (mock: simulated reply): the window opens again for 24 hours. */
export function customerWrote(jid: string, at = Date.now()) {
  save({ ...state, lastInbound: { ...state.lastInbound, [jid]: at } });
}

/** Mock only: close a chat's window at once (to try the template flow). */
export function closeWindow(jid: string) {
  save({ ...state, lastInbound: { ...state.lastInbound, [jid]: Date.now() - WINDOW_MS - HOUR } });
}

/** Mock only: an empty template list (the "no approved templates" state) or the seeded one back. */
export function setTemplates(templates: MockTemplate[] | 'seed') {
  save({ ...state, templates: templates === 'seed' ? seed().templates : templates });
}

/** {{1}} {{2}} … → the values (empty ones stay as {{n}} so the preview shows what is missing). */
export function fillTemplate(body: string, values: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (all, n: string) => values[Number(n) - 1]?.trim() || all);
}

export function templateVariables(body: string): number {
  return Math.max(0, ...[...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
}
