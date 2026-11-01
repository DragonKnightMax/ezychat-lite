// Shape checks for the Lite import contract (packages/shared/src/lite-import.ts). Pure, no electron.
//
// The main process is compiled by tsc and runs as plain JS: it may import only *types* from
// @ezychat/shared (which ships TypeScript source and zod; see i18n.ts). These hand-written checks mirror
// the zod schemas `LiteImportPlan`, `LiteSummary`, `LiteImportProgress` and `LiteImportOutcome`;
// parse.test.ts runs both on the same inputs so they cannot drift apart.
import type {
  LiteImportOutcome,
  LiteImportPlan,
  LiteImportProgress,
  LiteImportResult,
  LiteImportStepId,
  LiteSummary,
  LiteTeamChoice,
} from '@ezychat/shared';

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : null;
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const nullable =
  <T>(check: (v: unknown) => v is T) =>
  (v: unknown): v is T | null =>
    v === null || check(v);
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (values as readonly string[]).includes(v);
const listOf = <T>(value: unknown, item: (v: unknown) => T | null): T[] | null => {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const v of value) {
    const parsed = item(v);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
};

export const STEP_IDS: readonly LiteImportStepId[] = [
  'stop',
  'copy',
  'migrate',
  'merge',
  'verify',
  'handover',
  'start',
];
const isRole = oneOf(['admin', 'agent'] as const);
const isStep = oneOf(STEP_IDS);

function teamChoice(value: unknown): LiteTeamChoice | null {
  const v = obj(value);
  if (!v) return null;
  if (!isInt(v.liteUserId) || !oneOf(['match', 'add', 'skip'] as const)(v.action)) return null;
  if (!nullable(isInt)(v.matchUserId) || !isRole(v.role)) return null;
  return { liteUserId: v.liteUserId, action: v.action, matchUserId: v.matchUserId, role: v.role };
}

/** The renderer's `start(plan)` argument (zod `LiteImportPlan`): a clean copy, or null when invalid. */
export function parseLiteImportPlan(value: unknown): LiteImportPlan | null {
  const v = obj(value);
  if (!v) return null;
  if (v.team === undefined) return { team: [] };
  const team = listOf(v.team, teamChoice);
  return team ? { team } : null;
}

/** One line of `--lite-summary` (zod `LiteSummary`), or null. */
export function parseLiteSummary(value: unknown): LiteSummary | null {
  const v = obj(value);
  if (!v) return null;
  if (!isStr(v.dataDir) || !isInt(v.schemaVersion)) return null;
  if (!nullable(isStr)(v.number) || !nullable(isStr)(v.ownJid)) return null;
  if (!isInt(v.chats) || !isInt(v.customers) || !isInt(v.messages)) return null;
  if (!isNum(v.mediaBytes) || !isNum(v.totalBytes)) return null;
  const users = listOf(v.users, (u) => {
    const x = obj(u);
    return x && isInt(x.id) && isStr(x.username) && isStr(x.displayName) && isRole(x.role)
      ? { id: x.id, username: x.username, displayName: x.displayName, role: x.role }
      : null;
  });
  const aiAgents = listOf(v.aiAgents, (a) => {
    const x = obj(a);
    return x && isInt(x.id) && isStr(x.name) && isBool(x.enabled)
      ? { id: x.id, name: x.name, enabled: x.enabled }
      : null;
  });
  const quickReplyShortcuts = listOf(v.quickReplyShortcuts, (s) => (isStr(s) ? s : null));
  const tokens = listOf(v.tokens, (tk) => {
    const x = obj(tk);
    return x && isStr(x.name) && oneOf(['token', 'oauth'] as const)(x.kind)
      ? { name: x.name, kind: x.kind }
      : null;
  });
  if (!users || !aiAgents || !quickReplyShortcuts || !tokens) return null;
  if (!oneOf(['managed', 'dashboard', 'quick', 'lan'] as const)(v.remote)) return null;
  if (!nullable(isStr)(v.address) || !nullable(isInt)(v.port)) return null;
  return {
    dataDir: v.dataDir,
    schemaVersion: v.schemaVersion,
    number: v.number,
    ownJid: v.ownJid,
    chats: v.chats,
    customers: v.customers,
    messages: v.messages,
    mediaBytes: v.mediaBytes,
    totalBytes: v.totalBytes,
    users,
    aiAgents,
    quickReplyShortcuts,
    tokens,
    remote: v.remote,
    address: v.address,
    port: v.port,
  };
}

/** One progress line of `--import-lite` (zod `LiteImportProgress`), or null. */
export function parseLiteImportProgress(value: unknown): LiteImportProgress | null {
  const v = obj(value);
  if (!v || !isStep(v.step) || !oneOf(['running', 'done', 'failed'] as const)(v.state)) return null;
  if (v.done !== undefined && !isNum(v.done)) return null;
  if (v.total !== undefined && !isNum(v.total)) return null;
  return {
    step: v.step,
    state: v.state,
    ...(v.done !== undefined ? { done: v.done } : {}),
    ...(v.total !== undefined ? { total: v.total } : {}),
  };
}

function result(value: unknown): LiteImportResult | null {
  const v = obj(value);
  if (!v || !oneOf(['copy', 'merge'] as const)(v.mode)) return null;
  if (!isInt(v.inboxId) || !isStr(v.inboxName) || !isInt(v.chats)) return null;
  if (!isInt(v.usersAdded) || !isInt(v.usersMatched)) return null;
  if (!isBool(v.agentImported) || !isBool(v.agentOff)) return null;
  const renamedShortcuts = listOf(v.renamedShortcuts, (s) => (isStr(s) ? s : null));
  if (!renamedShortcuts) return null;
  return {
    mode: v.mode,
    inboxId: v.inboxId,
    inboxName: v.inboxName,
    chats: v.chats,
    usersAdded: v.usersAdded,
    usersMatched: v.usersMatched,
    agentImported: v.agentImported,
    agentOff: v.agentOff,
    renamedShortcuts,
  };
}

/** The final line of `--import-lite` (zod `LiteImportOutcome`), or null. */
export function parseLiteImportOutcome(value: unknown): LiteImportOutcome | null {
  const v = obj(value);
  if (!v) return null;
  if ('result' in v) {
    const r = result(v.result);
    if (r) return { result: r };
  }
  const e = obj(v.error);
  if (e && isStr(e.code) && (e.message === undefined || isStr(e.message)))
    return { error: { code: e.code, ...(e.message !== undefined ? { message: e.message } : {}) } };
  return null;
}

/** Parses one stdout line as JSON; null for log lines and anything else. */
export function jsonLine(line: string): unknown {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
