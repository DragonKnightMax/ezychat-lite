import { z } from 'zod';

/**
 * GitHub connector (core code, offered in Lite only for now; design docs/features/github/design.md,
 * rules docs/connector-design.md). One GitHub sign-in per install, two ways: Anchor Sprint's GitHub
 * App through GitHub's device flow (Client ID only, no secret), or a fine-grained personal access
 * token. Per AI agent: the repositories it may look in and two look-up switches. Read only: issues
 * and pull requests, never code. The connector only grants access; the agent's instructions decide
 * when to look something up.
 */

/** Anchor Sprint's GitHub App "EzyChat by Anchor Sprint" (registered 2026-11-10). Public values. */
export const GITHUB_APP_CLIENT_ID = 'Iv23lifY4jMBIsreENXj';
export const GITHUB_APP_SLUG = 'ezychat-by-anchor-sprint';
export const GITHUB_APP_INSTALL_URL = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;
export const GITHUB_DEVICE_URL = 'https://github.com/login/device';
export const GITHUB_NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
export const GITHUB_TOKENS_URL = 'https://github.com/settings/personal-access-tokens';
export const GITHUB_APP_AUTHORIZATIONS_URL = 'https://github.com/settings/apps/authorizations';

/** Repositories one agent may look in. */
export const GITHUB_MAX_REPOS = 20;
/** Search results one look-up returns. */
export const GITHUB_SEARCH_RESULTS = 10;
/** Latest comments one read returns. */
export const GITHUB_COMMENTS = 5;
/** Characters kept of an issue or pull request body. */
export const GITHUB_BODY_CHARACTERS = 4_000;
/** Characters kept of one comment. */
export const GITHUB_COMMENT_CHARACTERS = 1_500;
/** Characters of one tool result. */
export const GITHUB_RESULT_CHARACTERS = 12_000;
/** GitHub calls one AI turn may make. */
export const GITHUB_CALLS_PER_TURN = 6;
/** A token sign-in warns this many days before the token expires. */
export const GITHUB_TOKEN_WARN_DAYS = 7;

export const GitHubMethod = z.enum(['app', 'token']);
export type GitHubMethod = z.infer<typeof GitHubMethod>;

/**
 * `not_connected`; `no_installation` (App: signed in, installed nowhere); `connected`; `expiring`
 * (token: within GITHUB_TOKEN_WARN_DAYS of its expiry); `expired` (App: sign in again; token:
 * expired or revoked); `unavailable` (GitHub did not answer).
 */
export const GitHubState = z.enum([
  'not_connected',
  'no_installation',
  'connected',
  'expiring',
  'expired',
  'unavailable',
]);
export type GitHubState = z.infer<typeof GitHubState>;

/** `GET /api/connectors/github` (admins). Tokens never reach the browser. */
export const GitHubStatus = z.object({
  state: GitHubState,
  method: GitHubMethod.nullable(),
  /** The GitHub login that signed in. */
  login: z.string().nullable(),
  connectedAt: z.number().int().nullable(),
  /** Token sign-in: when GitHub says the token expires (ms), else null. */
  tokenExpiresAt: z.number().int().nullable(),
  /** When it stopped working (expired/unavailable), else null. */
  problemSince: z.number().int().nullable(),
  /** Where the admin changes which repositories EzyChat may reach, on GitHub. */
  manageUrl: z.string().url().nullable(),
});
export type GitHubStatus = z.infer<typeof GitHubStatus>;

/** `owner/name`, as GitHub allows them. */
export const GITHUB_FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export const GitHubRepo = z.object({
  /** GitHub's repository id (stable across renames). */
  id: z.number().int().positive(),
  fullName: z.string().regex(GITHUB_FULL_NAME),
  private: z.boolean(),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

/** `GET /api/connectors/github/repos[?refresh=1]` (admins): what GitHub lets EzyChat reach. */
export const GitHubRepoList = z.object({
  repos: z.array(GitHubRepo),
  /** When the list was read from GitHub (ms). */
  checkedAt: z.number().int(),
});
export type GitHubRepoList = z.infer<typeof GitHubRepoList>;

/** Per AI agent: `GET`/`PUT /api/connectors/github/agents/:agentId` (admins). */
export const GitHubAgentSettings = z
  .object({
    repos: z.array(GitHubRepo).max(GITHUB_MAX_REPOS).default([]),
    /** Search, list and read issues (a look-up). */
    issues: z.boolean().default(true),
    /** Search and read pull requests, never their code (a look-up). */
    pulls: z.boolean().default(true),
  })
  .refine((s) => new Set(s.repos.map((r) => r.id)).size === s.repos.length, {
    path: ['repos'],
    message: 'a repository is listed twice',
  });
export type GitHubAgentSettings = z.infer<typeof GitHubAgentSettings>;

export const DEFAULT_GITHUB_SETTINGS: GitHubAgentSettings = {
  repos: [],
  issues: true,
  pulls: true,
};

/** `GET /api/connectors/github/agents/:agentId` also says which chosen repos GitHub no longer shares. */
export const GitHubAgentView = z.object({
  settings: GitHubAgentSettings,
  /** Ids of chosen repos GitHub no longer lets EzyChat reach (skipped by the tools). */
  unavailableRepoIds: z.array(z.number().int()),
});
export type GitHubAgentView = z.infer<typeof GitHubAgentView>;

/** `POST /api/connectors/github/device` (admins): start the App sign-in. */
export const GitHubDeviceStart = z.object({
  /** Opaque id for polling; the device code itself never leaves the server. */
  requestId: z.string(),
  userCode: z.string(),
  verificationUri: z.string().url(),
  expiresAt: z.number().int(),
});
export type GitHubDeviceStart = z.infer<typeof GitHubDeviceStart>;

/** `GET /api/connectors/github/device/:requestId`: the page polls until it is not `pending`. */
export const GitHubDeviceProgress = z.object({
  status: z.enum(['pending', 'done', 'denied', 'expired', 'failed']),
  /** done: the new status (connected or no_installation). */
  github: GitHubStatus.nullable(),
});
export type GitHubDeviceProgress = z.infer<typeof GitHubDeviceProgress>;

/** `POST /api/connectors/github/token` (admins): sign in with a fine-grained token. */
export const GitHubTokenBody = z.object({ token: z.string().trim().min(1).max(400) });
export type GitHubTokenBody = z.infer<typeof GitHubTokenBody>;

/** Why a pasted token was refused (400 `{error}`). */
export const GitHubTokenError = z.enum(['classic', 'invalid', 'no_repos']);
export type GitHubTokenError = z.infer<typeof GitHubTokenError>;

/** One line of the connector's Activity tab: who and when, never repo names, titles or text. */
export const GitHubActivityKind = z.enum(['searched', 'read', 'refused', 'failed']);
export type GitHubActivityKind = z.infer<typeof GitHubActivityKind>;
export const GitHubActivity = z.object({
  id: z.number().int(),
  at: z.number().int(),
  kind: GitHubActivityKind,
  agentId: z.number().int().nullable(),
  agentName: z.string(),
  chatJid: z.string().nullable(),
  /** The customer's saved or WhatsApp name (shown to admins only). */
  customer: z.string(),
  /** The chat's name when it is a group. */
  group: z.string().nullable().default(null),
});
export type GitHubActivity = z.infer<typeof GitHubActivity>;

/** `GET /api/connectors/github/activity` (admins): newest first, at most 50. */
export const GitHubActivityList = z.object({ activity: z.array(GitHubActivity) });
export type GitHubActivityList = z.infer<typeof GitHubActivityList>;

/** GitHub's page of a repository. */
export function githubRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}
