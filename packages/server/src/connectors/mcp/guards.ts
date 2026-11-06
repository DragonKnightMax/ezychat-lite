/**
 * Declared guards (design: connector-list, Guards): the checks the core runs before it calls a
 * partner's tool. A list entry can only add checks; the core rules (write tools start off, Try it
 * never runs them, nothing is undone) live in tools.ts. These are the general form of the checks
 * the Google Calendar connector has in code (offered times, customer replied, booking details,
 * booking hours). Every guard fails closed: an argument it cannot read is refused.
 */
import type { ConnectorSetting, ConnectorTool } from '@ezychat/shared';
import type { DB } from '../../db/index.js';
import {
  consentUsed,
  countCalls,
  customerMessageSince,
  hasValue,
  lastAiReplyAt,
  type ActivityReason,
} from './repo.js';

export type GuardResult =
  | {
      ok: true;
      /** confirmFirst: the customer message that confirmed this write (used once). */
      consentMessageId: string | null;
    }
  | { ok: false; reason: ActivityReason; arg?: string };

export interface GuardInput {
  db: DB;
  connectorId: string;
  tool: ConnectorTool;
  args: Record<string, unknown>;
  chatJid: string;
  /** The AI agent's user (its replies in the chat). */
  aiUserId: number;
  /** The agent's settings with the entry's defaults filled in. */
  settings: Record<string, unknown>;
  settingDefs: readonly ConnectorSetting[];
  timeZone: string;
  now: number;
  /** The customer's own messages in this chat (text and transcripts). */
  customerTexts: () => readonly string[];
  /** The saved contact's name, email and phone numbers. */
  savedContact: () => readonly string[];
}

/**
 * The value at `a.b.c` of the arguments, or undefined. The contract's paths name object keys only
 * (no array indexes): a path through an array, or a missing key, does not resolve.
 */
export function argAt(args: unknown, path: string): unknown {
  let value: unknown = args;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** A string or number argument as text; anything else (missing, empty, objects) is null. */
function asText(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

const digits = (text: string) => text.replace(/\D/g, '');
const PHONE = /^\+?[\d\s().-]+$/;
/** fromCustomer: shortest text and phone number accepted (shorter ones match too easily). */
export const MIN_TEXT_CHARS = 3;
export const MIN_PHONE_DIGITS = 6;

/** Lower-case word tokens: letters, digits and the characters inside emails and names. */
function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}@._+'-]+/gu) ?? [])
    .map((token) => token.replace(/^[._+'-]+|[._+'-]+$/g, ''))
    .filter(Boolean);
}

/** The numbers in a text: each run of digits with phone separators, and each word's digits. */
function numbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.match(/\+?\d[\d\s().-]*\d/g) ?? []) out.add(digits(run));
  for (const word of text.split(/\s+/)) if (/\d/.test(word)) out.add(digits(word));
  return out;
}

/**
 * True when the customer gave `value`: the saved contact's (the whole value), or written by the
 * customer as whole words (a phone number as a whole number). Short values never match.
 */
export function customerGave(
  value: string,
  texts: () => readonly string[],
  saved: () => readonly string[],
): boolean {
  const trimmed = value.trim();
  if (PHONE.test(trimmed) && /\d/.test(trimmed)) {
    const wanted = digits(trimmed);
    if (wanted.length < MIN_PHONE_DIGITS) return false;
    return (
      saved().some((known) => digits(known) === wanted) ||
      texts().some((text) => numbers(text).has(wanted))
    );
  }
  if (trimmed.length < MIN_TEXT_CHARS) return false;
  if (saved().some((known) => known.trim().toLowerCase() === trimmed.toLowerCase())) return true;
  const needle = tokens(trimmed);
  if (!needle.length) return false;
  return texts().some((text) => {
    const hay = tokens(text);
    for (let i = 0; i + needle.length <= hay.length; i++)
      if (needle.every((token, j) => hay[i + j] === token)) return true;
    return false;
  });
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday (0 = Sunday) and "HH:MM" of an instant in `timeZone`. */
export function localTime(at: number, timeZone: string): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: WEEKDAYS[part('weekday')] ?? -1, time: `${part('hour')}:${part('minute')}` };
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True when the ISO time `value` fits the setting (a timeRange or days value). */
export function fitsSetting(
  value: unknown,
  def: ConnectorSetting | undefined,
  setting: unknown,
  timeZone: string,
): boolean {
  if (typeof value !== 'string' || !ISO_TIME.test(value) || !def) return false;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return false;
  const local = localTime(at, timeZone);
  if (def.type === 'days')
    return Array.isArray(setting) && setting.some((day) => day === local.day);
  if (def.type === 'timeRange') {
    if (!Array.isArray(setting) || setting.length !== 2) return false;
    const [from, to] = setting as unknown[];
    if (typeof from !== 'string' || typeof to !== 'string' || !HHMM.test(from) || !HHMM.test(to))
      return false;
    return local.time >= from && local.time < to;
  }
  return false;
}

/**
 * Runs the tool's declared guards in a live chat, cheapest first: limits, confirmFirst,
 * valueFrom, fromCustomer, within. The first that fails decides the refusal. Synchronous: the
 * caller reserves the call (tools.ts) before anything awaits, so parallel calls cannot both pass.
 */
export function checkGuards(input: GuardInput): GuardResult {
  const guards = input.tool.guards;
  if (!guards) return { ok: true, consentMessageId: null };
  const { db, connectorId, chatJid, now } = input;
  const name = input.tool.name;

  const limits = guards.limits;
  if (
    limits?.perChat !== undefined &&
    countCalls(db, connectorId, name, chatJid, now) >= limits.perChat
  )
    return { ok: false, reason: 'limit' };
  if (limits?.perDay !== undefined && countCalls(db, connectorId, name, null, now) >= limits.perDay)
    return { ok: false, reason: 'limit' };

  let consentMessageId: string | null = null;
  if (guards.confirmFirst) {
    // The customer must have written after the AI's last reply (the proposal) that came before
    // this turn; with no reply yet there was nothing to confirm. One confirmation, one change: a
    // regenerated reply or a second call never reuses it.
    const proposal = lastAiReplyAt(db, chatJid, input.aiUserId);
    consentMessageId = proposal === null ? null : customerMessageSince(db, chatJid, proposal);
    if (consentMessageId === null || consentUsed(db, connectorId, name, chatJid, consentMessageId))
      return { ok: false, reason: 'confirm_first' };
  }

  for (const [path, from] of Object.entries(guards.valueFrom ?? {})) {
    const text = asText(argAt(input.args, path));
    if (text === null || !hasValue(db, connectorId, chatJid, from, text, now))
      return { ok: false, reason: 'value_from', arg: path };
  }

  for (const path of guards.fromCustomer ?? []) {
    const text = asText(argAt(input.args, path));
    if (text === null || !customerGave(text, input.customerTexts, input.savedContact))
      return { ok: false, reason: 'from_customer', arg: path };
  }

  for (const [path, settingId] of Object.entries(guards.within ?? {})) {
    const def = input.settingDefs.find((s) => s.id === settingId);
    if (!fitsSetting(argAt(input.args, path), def, input.settings[settingId], input.timeZone))
      return { ok: false, reason: 'within', arg: path };
  }
  return { ok: true, consentMessageId };
}

/** What the tool tells the model when a guard refused the call (fixed text, no values). */
export function refusalText(
  result: Extract<GuardResult, { ok: false }>,
  tool: ConnectorTool,
  toolName: (partnerTool: string) => string,
): string {
  const arg = result.arg ?? '';
  switch (result.reason) {
    case 'limit':
      return 'Not done: the limit for this action was reached. Do not try again; hand the chat to the team if the customer needs more.';
    case 'confirm_first':
      return 'Not done: the customer has not confirmed. Tell the customer exactly what you will do and wait for them to confirm in their own words, then call this tool again. One confirmation allows this action once.';
    case 'value_from': {
      const from = tool.guards?.valueFrom?.[arg] ?? '';
      return `Not done: "${arg}" must be a value that ${toolName(from)} returned in this chat in the last 24 hours. Call ${toolName(from)} first and pass one of its values unchanged.`;
    }
    case 'from_customer':
      return `Not done: pass the "${arg}" the customer wrote in this chat, exactly as they wrote it. Ask the customer for it; never invent it.`;
    case 'within':
      return `Not done: "${arg}" is outside what this business allows. Offer the customer another time within the allowed hours and days.`;
    default:
      return 'Not done. Hand the chat to the team.';
  }
}

// ── arguments ───────────────────────────────────────────────────────────────────────────────

const MAX_DEPTH = 8;

/**
 * Bounds of a free-form map (a schema object without fixed fields: `additionalProperties`, or
 * cut at the schema's depth limit) and of everything inside one. A value past a bound refuses the
 * call: the model's data is never cut and sent half.
 */
export const MAP_LIMITS = {
  /** Keys per map. */
  keys: 100,
  /** Characters of each key. */
  keyChars: 200,
  /** Characters of each string inside a map. */
  stringChars: 10_000,
  /** Items of each array inside a map. */
  arrayItems: 100,
} as const;

function typeOk(type: unknown, value: unknown): boolean {
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  if (!types.length) return true;
  return types.some((t) => {
    if (t === 'string') return typeof value === 'string';
    if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (t === 'integer') return Number.isInteger(value);
    if (t === 'boolean') return typeof value === 'boolean';
    if (t === 'null') return value === null;
    if (t === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
    if (t === 'array') return Array.isArray(value);
    return false;
  });
}

class InvalidArgs extends Error {}

const isNode = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The model's arguments checked against the partner's bounded input schema (mcp.ts
 * boundedInputSchema): keys the schema does not name are dropped at every level with fixed fields,
 * so an extra or aliased key never reaches the partner past the guards; a free-form map keeps its
 * keys within MAP_LIMITS. A wrong type, a value outside an enum, a missing required field or a map
 * past its bounds refuses the call (null).
 */
export function cleanArgs(
  schema: Record<string, unknown>,
  args: unknown,
): Record<string, unknown> | null {
  const walk = (
    node: Record<string, unknown>,
    value: unknown,
    depth: number,
    inMap: boolean,
  ): unknown => {
    if (depth > MAX_DEPTH || !typeOk(node.type, value)) throw new InvalidArgs();
    if (Array.isArray(node.enum) && !node.enum.some((option) => option === value))
      throw new InvalidArgs();
    if (inMap && typeof value === 'string' && value.length > MAP_LIMITS.stringChars)
      throw new InvalidArgs();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const props = node.properties as Record<string, Record<string, unknown>> | undefined;
      if (!props) return cleanMap(node, record, depth);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(props))
        if (Object.hasOwn(record, key) && record[key] !== undefined)
          out[key] = walk(child, record[key], depth + 1, inMap);
      for (const key of Array.isArray(node.required) ? (node.required as string[]) : [])
        if (!Object.hasOwn(out, key)) throw new InvalidArgs();
      return out;
    }
    if (Array.isArray(value)) {
      if (inMap && value.length > MAP_LIMITS.arrayItems) throw new InvalidArgs();
      const items = isNode(node.items) ? node.items : inMap ? {} : null;
      if (items) return value.map((item) => walk(items, item, depth + 1, inMap));
    }
    return value;
  };
  // A map keeps its keys (bounded); each value is checked against the value schema, or only
  // bounded when any value is allowed.
  const cleanMap = (
    node: Record<string, unknown>,
    record: Record<string, unknown>,
    depth: number,
  ) => {
    const entries = Object.entries(record).filter(([, v]) => v !== undefined);
    if (entries.length > MAP_LIMITS.keys) throw new InvalidArgs();
    const valueNode = isNode(node.additionalProperties) ? node.additionalProperties : {};
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (!key || key.length > MAP_LIMITS.keyChars) throw new InvalidArgs();
      // An own property even for "__proto__": the key is data, never the object's prototype.
      Object.defineProperty(out, key, {
        value: walk(valueNode, item, depth + 1, true),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  try {
    return walk(schema, args, 0, false) as Record<string, unknown>;
  } catch {
    return null;
  }
}
