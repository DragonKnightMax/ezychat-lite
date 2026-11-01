// Lite → Enterprise in one step (design: anchorsprint/ezychat-enterprise
// docs/superpowers/specs/2026-10-31-lite-to-enterprise-upgrade-design.md).
// The import itself runs in the desktop main process and the server CLI; the web screens talk to the
// desktop through `window.watiLiteImport` (only the desktop window on the host PC has it) and read the
// after-import notice through `/api/lite-import/notice` (admins).
import { z } from 'zod';

/** copy: this install has no chats yet (file copy, Lite stays inbox 1). merge: Lite's number becomes a new inbox. */
export const LiteImportMode = z.enum(['copy', 'merge']);
export type LiteImportMode = z.infer<typeof LiteImportMode>;

/** How Lite reached the internet (design §5.9). */
export const LiteRemote = z.enum(['managed', 'dashboard', 'quick', 'lan']);
export type LiteRemote = z.infer<typeof LiteRemote>;

/** A check that blocks the import, each with one clear action in the UI. */
export const LiteCheckIssue = z.enum([
  'lite_running',
  'lite_newer',
  'disk',
  'same_number',
  'no_slot',
  'lite_service',
]);
export type LiteCheckIssue = z.infer<typeof LiteCheckIssue>;

export const LiteRole = z.enum(['admin', 'agent']);
export type LiteRole = z.infer<typeof LiteRole>;

export const LiteUser = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  role: LiteRole,
});
export type LiteUser = z.infer<typeof LiteUser>;

/**
 * Read-only summary of a Lite data folder (`server --lite-summary <dir>` prints it as JSON).
 * Never contains chat text, customer names or numbers other than Lite's own linked number.
 */
export const LiteSummary = z.object({
  dataDir: z.string(),
  /** `PRAGMA user_version` of Lite's app.db. */
  schemaVersion: z.number().int(),
  /** Lite's linked number as E.164-ish digits with '+', or null when not linked. */
  number: z.string().nullable(),
  /** Lite's linked own JID (alias-resolved), for the same-number check. */
  ownJid: z.string().nullable(),
  chats: z.number().int(),
  customers: z.number().int(),
  messages: z.number().int(),
  mediaBytes: z.number(),
  /** Bytes the copy needs (app.db + media + wa-auth + connectors + models). */
  totalBytes: z.number(),
  users: z.array(LiteUser),
  aiAgents: z.array(z.object({ id: z.number().int(), name: z.string(), enabled: z.boolean() })),
  quickReplyShortcuts: z.array(z.string()),
  /** Names only, never secrets. */
  tokens: z.array(z.object({ name: z.string(), kind: z.enum(['token', 'oauth']) })),
  remote: LiteRemote,
  /** Own domain hostname, last quick-tunnel URL, or null. */
  address: z.string().nullable(),
  port: z.number().int().nullable(),
});
export type LiteSummary = z.infer<typeof LiteSummary>;

export const LiteTeamAction = z.enum(['match', 'add', 'skip']);
export type LiteTeamAction = z.infer<typeof LiteTeamAction>;

export const LiteTeamChoice = z.object({
  liteUserId: z.number().int(),
  action: LiteTeamAction,
  /** Enterprise user id for `match`. */
  matchUserId: z.number().int().nullable(),
  /** Role for `add`. */
  role: LiteRole,
});
export type LiteTeamChoice = z.infer<typeof LiteTeamChoice>;

/** The plan the merge runs with (`server --import-lite <dir> --import-plan <file>`). */
export const LiteImportPlan = z.object({
  team: z.array(LiteTeamChoice).default([]),
});
export type LiteImportPlan = z.infer<typeof LiteImportPlan>;

export const LiteImportStepId = z.enum(['stop', 'copy', 'migrate', 'merge', 'verify', 'handover', 'start']);
export type LiteImportStepId = z.infer<typeof LiteImportStepId>;

/** One JSON line the import CLI prints on stdout while it runs. */
export const LiteImportProgress = z.object({
  step: LiteImportStepId,
  state: z.enum(['running', 'done', 'failed']),
  done: z.number().optional(),
  total: z.number().optional(),
});
export type LiteImportProgress = z.infer<typeof LiteImportProgress>;

export const LiteImportResult = z.object({
  mode: LiteImportMode,
  inboxId: z.number().int(),
  inboxName: z.string(),
  chats: z.number().int(),
  usersAdded: z.number().int(),
  usersMatched: z.number().int(),
  agentImported: z.boolean(),
  /** The agent came in off and unbound because no AI agent slot was free. */
  agentOff: z.boolean(),
  renamedShortcuts: z.array(z.string()),
});
export type LiteImportResult = z.infer<typeof LiteImportResult>;

/** Final JSON line of the import CLI: `{"result": …}` or `{"error": {code}}`. */
export const LiteImportOutcome = z.union([
  z.object({ result: LiteImportResult }),
  z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) }),
]);
export type LiteImportOutcome = z.infer<typeof LiteImportOutcome>;

export const LiteImportPhase = z.enum([
  'idle', // nothing scanned yet
  'none', // no Lite data on this PC
  'found', // summary ready, checks pass
  'blocked', // a check failed (issues)
  'running',
  'done',
  'failed',
]);
export type LiteImportPhase = z.infer<typeof LiteImportPhase>;

export interface LiteImportStep {
  id: LiteImportStepId;
  state: 'waiting' | 'running' | 'done' | 'failed';
  /** 0..1 for the copy step, else null. */
  progress: number | null;
}

/** Desktop main → web state of the import (never contains secrets or chat data). */
export interface LiteImportState {
  phase: LiteImportPhase;
  mode: LiteImportMode | null;
  lite: LiteSummary | null;
  /** Lite ran as an OS service (the stop needs one admin prompt). */
  liteService: boolean;
  enterprise: {
    hasData: boolean;
    inboxes: number;
    maxInboxes: number;
    freeBytes: number;
  } | null;
  issues: LiteCheckIssue[];
  steps: LiteImportStep[];
  result: LiteImportResult | null;
  /** Short error code of a failed import ("Lite is running again, nothing was changed"). */
  failure: string | null;
}

/** Exposed by the desktop inbox window's preload as `window.watiLiteImport`; never in a browser. */
export interface DesktopLiteImportBridge {
  getState(): Promise<LiteImportState>;
  /** Find Lite data on this PC, read its summary and run the checks. */
  scan(): Promise<LiteImportState>;
  /** Stop Lite, then copy or merge. The plan is only used in merge mode. */
  start(plan: LiteImportPlan): Promise<LiteImportState>;
  /** Back to the scan after a failure or a blocked check. */
  reset(): Promise<LiteImportState>;
  /** Writes a support file (logs, no chat data) and reveals it; resolves to whether one was written. */
  saveSupportFile(): Promise<boolean>;
  onChanged(callback: (state: LiteImportState) => void): () => void;
}

/** Lite's "Install EzyChat Enterprise" download (design §5.7), `window.watiUpgrade`. */
export interface DesktopUpgradeState {
  /** Hidden when the product has no installer feed or this is not the host window. */
  available: boolean;
  status: 'idle' | 'checking' | 'downloading' | 'started' | 'error';
  version: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

export interface DesktopUpgradeBridge {
  getState(): Promise<DesktopUpgradeState>;
  /** Download the latest Enterprise installer (feed from product config), verify, start it. No arguments. */
  install(): Promise<DesktopUpgradeState>;
  cancel(): Promise<DesktopUpgradeState>;
  onChanged(callback: (state: DesktopUpgradeState) => void): () => void;
}

/** After-import notice for admins: the team checklist (merge) and the MCP "address changed" flag. */
export const LiteImportChecklistItem = z.enum(['share', 'signin', 'notifications', 'mcp']);
export type LiteImportChecklistItem = z.infer<typeof LiteImportChecklistItem>;

export const LiteImportNotice = z.object({
  checklist: z
    .object({
      inboxId: z.number().int(),
      inboxName: z.string(),
      liteUsers: z.number().int(),
      /** Token and OAuth app names from Lite (never secrets), to know which tools to reconnect. */
      tokens: z.array(z.object({ name: z.string(), kind: z.enum(['token', 'oauth']) })),
      items: z.record(LiteImportChecklistItem, z.boolean()),
    })
    .nullable(),
  mcp: z
    .object({
      reason: z.enum(['quick', 'merge', 'domain', 'lan']),
      /** The address AI assistants must use now, e.g. https://inbox.example.com/mcp; null when unknown. */
      mcpUrl: z.string().nullable(),
    })
    .nullable(),
});
export type LiteImportNotice = z.infer<typeof LiteImportNotice>;

export const LiteImportNoticeUpdate = z.object({
  item: LiteImportChecklistItem.optional(),
  done: z.boolean().optional(),
  dismiss: z.enum(['checklist', 'mcp']).optional(),
});
export type LiteImportNoticeUpdate = z.infer<typeof LiteImportNoticeUpdate>;

/** Contents of `<data>/moved.json`: the core refuses to start on a folder with it (exit 4). */
export const MovedMarker = z.object({
  to: z.literal('enterprise'),
  product: z.string(),
  at: z.string(),
  version: z.string(),
});
export type MovedMarker = z.infer<typeof MovedMarker>;
