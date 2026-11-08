// Proposed (custom-agents): mock-only store for the AI agents, their own Business context items (with the
// Internal flag) and the inbox each agent serves. Kept in this browser (localStorage) like
// `mock/inboxes.ts`; the production feature keeps all of it on the server (`ai_agents`, `ai_documents`
// with `agent_id` and `internal`), checks every item id against its agent in SQL and builds the prompt there.
import { useSyncExternalStore } from 'react';
import {
  DEFAULT_AI_HANDOFF_RULES,
  DEFAULT_AI_INSTRUCTIONS,
  codePointLength,
} from '@ezychat/shared';

export type AgentPreset = 'sales' | 'faq' | 'custom';
export const AGENT_PRESETS: readonly AgentPreset[] = ['sales', 'faq', 'custom'];

/** Production limits (design): role text 8,000 characters, hand-over rules 4,000, 20 items per agent. */
export const AGENT_INSTRUCTIONS_CHARACTERS = 8000;
export const AGENT_HANDOFF_CHARACTERS = 4000;
export const AGENT_ITEMS = 20;
/** Production `AI_INTERNAL_CHARACTERS`: an agent's Internal items, in characters in total. */
export const AGENT_INTERNAL_CHARACTERS = 10_000;

/** A neutral question-answering role in the same style as the Sales text; it never sells. */
const FAQ_INSTRUCTIONS = [
  'ROLE',
  "You are this business's WhatsApp help desk. You answer customers' questions clearly and correctly. You do not sell: never recommend products, upsell or ask the customer to order.",
  '',
  'SCOPE',
  'You help with:',
  '- Questions about the services, opening hours, location, prices and fees written in the business context',
  '- Procedures and policies: how to book, what to bring, how long it takes, who to contact',
  '- The right next step: where to find a form, how to make an appointment, or reaching our team',
  'You do not help with topics unrelated to the business (general chat, news, coding, homework, opinions, politics, religion). Reply politely in one line and steer back, for example: "Sorry, I can only help with questions about our services. What would you like to know?"',
  '',
  'KNOWLEDGE',
  '- Answer only from the business context. Keep names, times, fees and steps exactly as written.',
  '- Never guess. If a detail is missing, say so and let our team confirm.',
  '- Never give personal medical, legal or financial advice, and never promise exceptions.',
  '',
  'LANGUAGE',
  "- Reply in the customer's language. If they mix languages, reply in the main language of their message.",
  '- If you cannot reply in their language, use the default language named in the business context, otherwise English.',
  '',
  'STYLE',
  '- Calm, polite and helpful; no slang and no sales language. At most one emoji, and only where it fits.',
  '- One to three short sentences. Use a short numbered list only for steps.',
  '- Answer first: no long greetings and no repeating the question back.',
  '- Ask at most one clarifying question when needed.',
  '- WhatsApp formatting only: *bold* for key details and plain line breaks. No headings, tables or links you were not given.',
].join('\n');

const FAQ_HANDOFF_RULES = [
  '- The customer is upset or makes a complaint',
  '- The customer wants to book, change or cancel an appointment or an order',
  '- The customer asks about their own account, case, payment or personal records',
  '- The customer asks for an exception to a rule or policy',
].join('\n');

/** English starting texts (production: `AI_AGENT_PRESETS` in `@ezychat/shared` + `ai.defaults.<preset>.*`). */
export const PRESET_TEXTS: Record<AgentPreset, { instructions: string; handoffRules: string }> = {
  sales: { instructions: DEFAULT_AI_INSTRUCTIONS, handoffRules: DEFAULT_AI_HANDOFF_RULES },
  faq: { instructions: FAQ_INSTRUCTIONS, handoffRules: FAQ_HANDOFF_RULES },
  custom: { instructions: '', handoffRules: '' },
};

export interface MockAgentItem {
  id: string;
  kind: 'text' | 'file';
  name: string;
  /** Text items: the text; files: the extracted text shown in the preview. */
  text: string;
  size: number;
  /** Rule B: used by the agent to decide, never told to customers. */
  internal: boolean;
  createdAt: number;
}

export interface MockAgent {
  id: string;
  name: string;
  preset: AgentPreset;
  instructions: string;
  handoffRules: string;
  enabled: boolean;
  /** The inbox this agent answers (one agent per inbox); null = not answering any inbox. */
  inboxId: string | null;
  items: MockAgentItem[];
  createdAt: number;
}

interface State {
  agents: MockAgent[];
}

// Bump the key whenever the seed changes, so open browsers load the new demo data.
const KEY = 'mock.customAgents.v2';
const DAY = 24 * 60 * 60 * 1000;
const seedTime = Date.UTC(2026, 9, 14, 9, 0);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const item = (
  id: string,
  kind: MockAgentItem['kind'],
  name: string,
  text: string,
  internal: boolean,
  daysAfter: number,
): MockAgentItem => ({
  id,
  kind,
  name,
  text,
  size: kind === 'file' ? 48_213 : bytes(text),
  internal,
  createdAt: seedTime + daysAfter * DAY,
});

const SEED: State = {
  agents: [
    {
      id: 'a1',
      name: 'Aina',
      preset: 'sales',
      ...PRESET_TEXTS.sales,
      // Off like the server's AI member (seed.ts), whose name and on/off this agent shows (useAgents.ts).
      enabled: false,
      inboxId: 'main',
      createdAt: seedTime,
      items: [
        // The item the app already has (seed.ts), now owned by agent 1.
        item(
          'i1',
          'text',
          'Menu and opening hours',
          'Kopi Apong opens daily 8am–10pm. Kopi O RM3.50, Teh Tarik RM4, Nasi Lemak Ayam RM12. Delivery within 5 km of Georgetown, free above RM40.',
          false,
          0,
        ),
        item(
          'i2',
          'text',
          'Pricing floor (internal)',
          'Lowest price for a 40-pax catering order: RM 1,800. Never offer more than 10% discount.',
          true,
          1,
        ),
      ],
    },
    {
      id: 'a2',
      name: 'Sofia',
      preset: 'faq',
      ...PRESET_TEXTS.faq,
      enabled: true,
      inboxId: 'catering',
      createdAt: seedTime + 2 * DAY,
      items: [
        item(
          'i3',
          'file',
          'Catering FAQ.pdf',
          'How early must I book? Catering orders need 3 days notice.\nWhat is the minimum order? 20 pax.\nDo you deliver? Delivery within Penang island, RM30 per trip.\nHow do I pay? A 30% deposit confirms the booking; the rest on the day.',
          false,
          2,
        ),
        item(
          'i4',
          'text',
          'Halal and allergens',
          'All our food is halal certified by JAKIM. Dishes may contain nuts, dairy, egg and gluten. Ask our team for the allergen list of a menu.',
          false,
          3,
        ),
      ],
    },
  ],
};

let state: State = load();
const listeners = new Set<() => void>();

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    // Private window or blocked storage: start from the seed.
  }
  return structuredClone(SEED);
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

export function useMockAgents(): State {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * Enterprise: every agent. Lite: exactly one, always bound to inbox 1 (spec): the agent of inbox 1, or
 * else the first agent shown on inbox 1 (an Enterprise view may have deleted or moved it; Lite has no
 * Inbox select to fix that, and its next save stores the binding).
 */
export function visibleAgents(
  agents: MockAgent[],
  lite: boolean,
  firstInboxId: string | null,
): MockAgent[] {
  if (!lite) return agents;
  const own = agents.find((a) => firstInboxId && a.inboxId === firstInboxId);
  if (own) return [own];
  const first = agents[0];
  return first ? [{ ...first, inboxId: firstInboxId }] : [];
}

/** maxAgents = maxInboxes (Lite 1). */
export function maxAgents(lite: boolean, inboxCount: number): number {
  return lite ? 1 : Math.max(1, inboxCount);
}

export function agentOfInbox(s: State, inboxId: string): MockAgent | undefined {
  return s.agents.find((a) => a.inboxId === inboxId);
}

const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface AgentDraft {
  name: string;
  instructions: string;
  handoffRules: string;
  inboxId: string | null;
}

/** Creates a new agent (off until an admin turns it on); binding an inbox unbinds that inbox's agent. */
export function createAgent(preset: AgentPreset, draft: AgentDraft): MockAgent {
  const created: MockAgent = {
    id: newId('agent'),
    preset,
    ...draft,
    enabled: false,
    items: [],
    createdAt: Date.now(),
  };
  save({ agents: [...unbound(state.agents, draft.inboxId), created] });
  return created;
}

/** Re-binding an inbox releases the agent that served it before (production: in the same step). */
function unbound(agents: MockAgent[], inboxId: string | null, keep?: string): MockAgent[] {
  return inboxId
    ? agents.map((a) => (a.inboxId === inboxId && a.id !== keep ? { ...a, inboxId: null } : a))
    : agents;
}

export function updateAgent(id: string, patch: Partial<Omit<MockAgent, 'id' | 'items'>>) {
  const agents =
    patch.inboxId !== undefined ? unbound(state.agents, patch.inboxId, id) : state.agents;
  save({ agents: agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
}

export function deleteAgent(id: string) {
  save({ agents: state.agents.filter((a) => a.id !== id) });
}

/** From Admin → Inboxes: this inbox is answered by `agentId` (or by no agent). */
export function setInboxAgent(inboxId: string, agentId: string | null) {
  const agents = state.agents.map((a) =>
    a.id === agentId ? { ...a, inboxId } : a.inboxId === inboxId ? { ...a, inboxId: null } : a,
  );
  save({ agents });
}

export function addItem(agentId: string, body: Omit<MockAgentItem, 'id' | 'createdAt'>) {
  save({
    agents: state.agents.map((a) =>
      a.id === agentId
        ? { ...a, items: [...a.items, { ...body, id: newId('item'), createdAt: Date.now() }] }
        : a,
    ),
  });
}

export function updateItem(
  agentId: string,
  itemId: string,
  patch: Partial<Pick<MockAgentItem, 'name' | 'text' | 'internal' | 'size'>>,
) {
  save({
    agents: state.agents.map((a) =>
      a.id === agentId
        ? { ...a, items: a.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) }
        : a,
    ),
  });
}

/**
 * Round 2: would this change push the agent's Internal items over 10,000 characters? Same rule for the
 * item dialogs and the row's "Mark as Internal" (production: 400 `internal_too_large`).
 */
export function internalTooLarge(
  items: MockAgentItem[],
  change: { id: string | null; internal: boolean; text: string },
): boolean {
  if (!change.internal) return false;
  const others = items
    .filter((i) => i.internal && i.id !== change.id)
    .reduce((total, i) => total + codePointLength(i.text), 0);
  return others + codePointLength(change.text) > AGENT_INTERNAL_CHARACTERS;
}

export function removeItems(agentId: string, itemIds: string[]) {
  save({
    agents: state.agents.map((a) =>
      a.id === agentId ? { ...a, items: a.items.filter((i) => !itemIds.includes(i.id)) } : a,
    ),
  });
}

/** Back to the seeded demo (walkthrough reset). */
export function resetMockAgents() {
  save(structuredClone(SEED));
}
