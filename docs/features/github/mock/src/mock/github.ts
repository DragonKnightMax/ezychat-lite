import { useSyncExternalStore } from 'react';

/**
 * Proposed (github): stand-in for the built-in GitHub connector. Nothing calls GitHub: the device
 * code, the App install, a pasted token and the AI's look-ups are simulated in this browser (kept in
 * localStorage so a reload keeps them). Production plan: `/api/connectors/github/*`, see ../../design.md.
 */
export type GitHubState =
  'disconnected' | 'noInstall' | 'connected' | 'expiring' | 'expired' | 'unavailable';
export type GitHubMethod = 'app' | 'token';

export interface GitHubRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
}

export interface GitHubAgentSettings {
  repos: GitHubRepo[];
  issues: boolean;
  pulls: boolean;
}

export interface GitHubActivity {
  at: number;
  kind: 'searched' | 'read' | 'refused' | 'failed';
  agent: string;
  customer: string;
}

export interface GitHubMockState {
  state: GitHubState;
  method: GitHubMethod | null;
  login: string | null;
  /** Token sign-in: when GitHub says it expires (ms). */
  tokenExpiresAt: number | null;
  /** Repos removed on GitHub after an agent chose them (mock switch). */
  revoked: number[];
  agents: Record<string, GitHubAgentSettings>;
  activity: GitHubActivity[];
}

export const GITHUB_LOGIN = 'kopiapong-dev';
export const DEVICE_CODE = 'WDJB-MJHT';
/** Stand-in slug of Anchor Sprint's App (owner picks the name, design Q1). */
export const APP_SLUG = 'ezychat-by-anchor-sprint';
export const MAX_REPOS = 20;
const DAY = 86_400_000;

/** The repos GitHub lets EzyChat reach (App install or token), stand-in. */
export const ACCESSIBLE_REPOS: readonly GitHubRepo[] = [
  { id: 101, owner: 'kopiapong', name: 'pos-app', private: true },
  { id: 102, owner: 'kopiapong', name: 'ordering-website', private: true },
  { id: 103, owner: 'kopiapong', name: 'menu-api', private: true },
  { id: 104, owner: 'kopiapong', name: 'docs', private: false },
  { id: 201, owner: 'kopiapong-dev', name: 'delivery-tracker', private: true },
  { id: 202, owner: 'kopiapong-dev', name: 'loyalty-card', private: false },
];

export const DEFAULT_GITHUB_SETTINGS: GitHubAgentSettings = {
  repos: [],
  issues: true,
  pulls: true,
};

const KEY = 'ezychat-mock-github-v1';
const initial = (): GitHubMockState => ({
  state: 'disconnected',
  method: null,
  login: null,
  tokenExpiresAt: null,
  revoked: [],
  agents: {},
  activity: [],
});

function load(): GitHubMockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...initial(), ...(JSON.parse(raw) as GitHubMockState) };
  } catch {
    // Private window or blocked storage: start empty.
  }
  return initial();
}

let current: GitHubMockState = load();
const listeners = new Set<() => void>();

function set(next: GitHubMockState) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Kept in memory only.
  }
  for (const listener of listeners) listener();
}

/** The current state outside React (gallery rows). */
export function readGitHubState(): GitHubState {
  return current.state;
}

export function useGitHub(): GitHubMockState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export function githubSettingsFor(state: GitHubMockState, agentId: string): GitHubAgentSettings {
  return state.agents[agentId] ?? DEFAULT_GITHUB_SETTINGS;
}

export const repoName = (r: GitHubRepo) => `${r.owner}/${r.name}`;

/** Repos still shared on GitHub (the tools skip the rest). */
export function usableRepos(state: GitHubMockState, settings: GitHubAgentSettings): GitHubRepo[] {
  return settings.repos.filter((r) => !state.revoked.includes(r.id));
}

/** Token check on Save (design B.2): classic tokens refused; mock: "bad" = not accepted, "empty" = no repos. */
export function checkToken(value: string): 'ok' | 'classic' | 'invalid' | 'noRepos' {
  const v = value.trim();
  if (/^gh[pousr]_/.test(v)) return 'classic';
  if (!v.startsWith('github_pat_') || /bad/i.test(v)) return 'invalid';
  if (/empty/i.test(v)) return 'noRepos';
  return 'ok';
}

export const githubActions = {
  /** Device flow approved on GitHub; mock: `installed` false shows the install step. */
  signedInWithApp(installed: boolean) {
    set({
      ...current,
      state: installed ? 'connected' : 'noInstall',
      method: 'app',
      login: GITHUB_LOGIN,
      tokenExpiresAt: null,
    });
  },
  installed() {
    set({ ...current, state: 'connected' });
  },
  savedToken() {
    set({
      ...current,
      state: 'connected',
      method: 'token',
      login: GITHUB_LOGIN,
      tokenExpiresAt: Date.now() + 90 * DAY,
    });
  },
  setState(state: 'connected' | 'expiring' | 'expired' | 'unavailable') {
    const tokenExpiresAt =
      current.method !== 'token'
        ? null
        : state === 'expiring'
          ? Date.now() + 5 * DAY
          : state === 'expired'
            ? Date.now() - DAY
            : Date.now() + 90 * DAY;
    set({ ...current, state, tokenExpiresAt });
  },
  toggleRevoked(id: number) {
    const revoked = current.revoked.includes(id)
      ? current.revoked.filter((x) => x !== id)
      : [...current.revoked, id];
    set({ ...current, revoked });
  },
  disconnect() {
    // Settings stay (like Google Drive); the AI stops using GitHub until reconnected.
    set({ ...current, state: 'disconnected', method: null, login: null, tokenExpiresAt: null });
  },
  saveAgent(agentId: string, settings: GitHubAgentSettings) {
    set({ ...current, agents: { ...current.agents, [agentId]: settings } });
  },
  addActivity(row: GitHubActivity) {
    set({ ...current, activity: [row, ...current.activity].slice(0, 50) });
  },
};

/** The gallery card and page header status. */
export function githubStatus(state: GitHubState): 'connected' | 'attention' | 'notConnected' {
  if (state === 'connected' || state === 'expiring') return 'connected';
  if (state === 'disconnected') return 'notConnected';
  return 'attention';
}

/** Where the admin changes which repos EzyChat may reach on GitHub. */
export function manageOnGitHubUrl(method: GitHubMethod | null): string {
  return method === 'token'
    ? 'https://github.com/settings/personal-access-tokens'
    : `https://github.com/apps/${APP_SLUG}/installations/new`;
}
