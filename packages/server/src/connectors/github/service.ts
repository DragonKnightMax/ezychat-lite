/**
 * GitHub connector (core code, offered in Lite only for now; design docs/features/github/design.md,
 * rules docs/connector-design.md). One GitHub sign-in per install (the App through the device flow,
 * or a fine-grained token). Per AI agent: the repositories it may look in (from what GitHub allows,
 * at most 20) and the Issues and Pull requests switches. Read only, never code. The connector only
 * grants access; the agent's instructions say when to look something up.
 *
 * Logs carry events, tools, ok, ms and counts only: never query words, titles, bodies, repository
 * names, logins or tokens.
 */
import {
  GITHUB_APP_CLIENT_ID,
  GITHUB_APP_INSTALL_URL,
  GITHUB_TOKEN_WARN_DAYS,
  GITHUB_TOKENS_URL,
  GitHubAgentSettings,
  type GitHubActivity,
  type GitHubAgentView,
  type GitHubDeviceProgress,
  type GitHubDeviceStart,
  type GitHubRepo,
  type GitHubRepoList,
  type GitHubState,
  type GitHubStatus,
} from '@ezychat/shared';
import { agentById } from '../../ai/agents.js';
import type { AppContext } from '../../context.js';
import { audit } from '../../db/audit.js';
import { HttpError, errors } from '../../http/errors.js';
import { getChats } from '../../wa-bridge/index.js';
import { TokenRefused, createGitHubAuth, type Actor } from './auth.js';
import { GitHubClient, GitHubError } from './client.js';
import { FakeGitHub } from './fake.js';
import { REPO_CACHE_MS, readAccessibleRepos, type AccessibleRepos } from './repos.js';
import {
  addActivity,
  listActivity,
  readSettings,
  writeSettings,
  type ActivityInput,
} from './repo.js';

declare module '../../context.js' {
  interface Services {
    github?: GitHubService;
  }
}

/** A look-up's answer is kept this long (the same question in one conversation asks once). */
export const RESULT_CACHE_MS = 2 * 60_000;
const MAX_CACHED_RESULTS = 100;
const DAY_MS = 24 * 60 * 60_000;

/** What one agent may look in now (connected, ≥1 chosen repo still shared, a switch on). */
export interface UsableGitHub {
  settings: GitHubAgentSettings;
  /** The chosen repos GitHub still shares (as far as the cached list knows). */
  repos: GitHubRepo[];
}

export interface GitHubServiceOptions {
  /** Overrides the client (tests); default the guarded one, or the fake's with --fake-wa. */
  client?: GitHubClient;
  fake?: FakeGitHub | null;
  now?: () => number;
}

const unavailable = () => new HttpError(503, 'github_unavailable', 'GitHub could not be reached');
const notConnected = () => new HttpError(409, 'not_connected', 'Connect GitHub first');

function defaultFake(ctx: AppContext): FakeGitHub | null {
  // The fake replaces GitHub only with --fake-wa (never in service mode); EZYCHAT_GITHUB_REAL=1
  // lets a --fake-wa Dev Build talk to real GitHub.
  const useFake =
    ctx.config.fakeWa && ctx.config.mode !== 'service' && process.env.EZYCHAT_GITHUB_REAL !== '1';
  return useFake ? new FakeGitHub() : null;
}

export function createGitHubService(ctx: AppContext, options: GitHubServiceOptions = {}) {
  const log = ctx.log.child({ mod: 'github' });
  const now = options.now ?? Date.now;
  const fake = options.fake === undefined ? defaultFake(ctx) : options.fake;
  const client = options.client ?? new GitHubClient(fake?.fetch);

  let cache: { at: number; value: AccessibleRepos } | null = null;
  let loading: Promise<AccessibleRepos> | null = null;
  // Bumped on every sign-in change, so a list read for an old sign-in is never kept.
  let generation = 0;
  const results = new Map<string, { at: number; value: unknown }>();

  const auth = createGitHubAuth(ctx, {
    client,
    clientId: GITHUB_APP_CLIENT_ID,
    now,
    afterSignIn: async () => {
      await adminAccessible(true);
    },
  });
  auth.onChange(() => {
    generation++;
    cache = null;
    loading = null;
    results.clear();
  });

  /** One GET with the stored sign-in (refreshed as needed). */
  const api = async <T>(
    path: string,
    query: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> =>
    (await auth.withToken((token) => client.get<T>(token, path, query, signal))).data;

  /** What GitHub lets EzyChat reach, cached REPO_CACHE_MS (single flight). */
  function accessible(force = false): Promise<AccessibleRepos> {
    const stored = auth.load();
    if (!stored) return Promise.reject(new GitHubError('unauthorized'));
    if (!force && cache && now() - cache.at < REPO_CACHE_MS) return Promise.resolve(cache.value);
    if (!loading) {
      const mine = generation;
      loading = (async () => {
        try {
          const value = await readAccessibleRepos(stored.method, (path, query) => api(path, query));
          if (mine === generation) {
            cache = { at: now(), value };
            auth.setProblem(value.installations === 0 ? 'no_installation' : null);
          }
          log.info(
            {
              event: 'github_repos_read',
              repos: value.repos.length,
              installations: value.installations,
            },
            'GitHub repositories read',
          );
          return value;
        } finally {
          if (mine === generation) loading = null;
        }
      })();
    }
    return loading;
  }

  /** `accessible` for an admin route: GitHub out of reach is recorded and answered 503. */
  async function adminAccessible(force: boolean): Promise<AccessibleRepos> {
    if (!auth.load()) throw notConnected();
    try {
      return await accessible(force);
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'unauthorized') throw notConnected();
      if (error instanceof GitHubError) {
        auth.setProblem('unavailable');
        throw unavailable();
      }
      throw error;
    }
  }

  const service = {
    fake,
    auth,

    status(): GitHubStatus {
      const stored = auth.load();
      if (!stored)
        return {
          state: 'not_connected',
          method: null,
          login: null,
          connectedAt: null,
          tokenExpiresAt: null,
          problemSince: null,
          manageUrl: null,
        };
      const problem = auth.problem();
      const expiry = stored.method === 'token' ? (stored.tokenExpiresAt ?? null) : null;
      let state: GitHubState = 'connected';
      let since: number | null = null;
      if (expiry !== null && expiry <= now()) {
        state = 'expired';
        since = expiry;
      } else if (problem?.state === 'expired' || problem?.state === 'unavailable') {
        state = problem.state;
        since = problem.since;
      } else if (stored.method === 'app' && problem?.state === 'no_installation')
        state = 'no_installation';
      else if (expiry !== null && expiry - now() <= GITHUB_TOKEN_WARN_DAYS * DAY_MS)
        state = 'expiring';
      return {
        state,
        method: stored.method,
        login: stored.login,
        connectedAt: stored.connectedAt,
        tokenExpiresAt: expiry,
        problemSince: since,
        manageUrl: stored.method === 'app' ? GITHUB_APP_INSTALL_URL : GITHUB_TOKENS_URL,
      };
    },

    async startDevice(actor: Actor): Promise<GitHubDeviceStart> {
      try {
        return await auth.startDevice(actor);
      } catch {
        throw unavailable();
      }
    },

    async deviceProgress(requestId: string): Promise<GitHubDeviceProgress | null> {
      const status = await auth.deviceStatus(requestId);
      if (!status) return null;
      return { status, github: status === 'done' ? service.status() : null };
    },

    cancelDevice: auth.cancelDevice,

    /** Signs in with a fine-grained token: classic refused, `/user` 200, at least one repo. */
    async connectToken(token: string, actor: Actor): Promise<GitHubStatus> {
      let checked;
      let found: AccessibleRepos;
      try {
        checked = await auth.checkToken(token);
        found = await readAccessibleRepos(
          'token',
          async (path, query) => (await client.get(token, path, query)).data as never,
        );
      } catch (error) {
        if (error instanceof TokenRefused)
          throw new HttpError(400, error.reason, 'GitHub did not accept this token');
        if (
          error instanceof GitHubError &&
          (error.kind === 'unauthorized' || error.kind === 'not_found')
        )
          throw new HttpError(400, 'invalid', 'GitHub did not accept this token');
        throw unavailable();
      }
      if (!found.repos.length)
        throw new HttpError(400, 'no_repos', "This token can't see any repositories");
      auth.saveToken(checked, actor);
      cache = { at: now(), value: found };
      return service.status();
    },

    /** Reads the installations and repositories again (Check again / Refresh). */
    async check(): Promise<GitHubStatus> {
      if (auth.load())
        try {
          await adminAccessible(true);
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
        }
      return service.status();
    },

    disconnect(actor: Actor): GitHubStatus {
      auth.disconnect(actor);
      return service.status();
    },

    async repoList(refresh: boolean): Promise<GitHubRepoList> {
      const value = await adminAccessible(refresh);
      return { repos: value.repos, checkedAt: cache?.at ?? now() };
    },

    /** The agent's settings and which chosen repos GitHub no longer shares (when it can tell). */
    async agentView(agentId: number): Promise<GitHubAgentView> {
      if (!agentById(ctx.db, agentId)) throw errors.notFound('Agent');
      const settings = readSettings(ctx.db, agentId);
      let shared: Set<number> | null = null;
      if (auth.load() && settings.repos.length)
        try {
          shared = new Set((await accessible()).repos.map((r) => r.id));
        } catch {
          shared = null;
        }
      return {
        settings,
        unavailableRepoIds: shared
          ? settings.repos.filter((r) => !shared.has(r.id)).map((r) => r.id)
          : [],
      };
    },

    /**
     * Saves one agent's settings. Every newly chosen repo must be one GitHub shares now (400
     * `repo_not_accessible`); a repo already chosen that GitHub stopped sharing may stay ("No
     * longer shared", skipped by the tools). Names and visibility come from GitHub.
     */
    async putSettings(
      agentId: number,
      next: GitHubAgentSettings,
      actor: Actor,
    ): Promise<GitHubAgentView> {
      if (!agentById(ctx.db, agentId)) throw errors.notFound('Agent');
      const parsed = GitHubAgentSettings.parse(next);
      const state = service.status().state;
      if (state === 'not_connected' || state === 'expired') throw notConnected();
      const before = readSettings(ctx.db, agentId);
      const { repos: shared } = await adminAccessible(false);
      const byId = new Map(shared.map((r) => [r.id, r]));
      const kept = new Map(before.repos.map((r) => [r.id, r]));
      const repos: GitHubRepo[] = [];
      for (const repo of parsed.repos) {
        const current = byId.get(repo.id) ?? kept.get(repo.id);
        if (!current)
          throw new HttpError(400, 'repo_not_accessible', 'GitHub does not share this repository');
        repos.push(current);
      }
      const saved: GitHubAgentSettings = { repos, issues: parsed.issues, pulls: parsed.pulls };
      const fields: string[] = [];
      if (before.repos.map((r) => r.id).join() !== repos.map((r) => r.id).join())
        fields.push('repos');
      if (before.issues !== saved.issues) fields.push('issues');
      if (before.pulls !== saved.pulls) fields.push('pulls');
      writeSettings(ctx.db, agentId, saved, now());
      if (fields.length)
        audit(ctx.db, {
          userId: actor.userId,
          action: 'github.agent_settings',
          ip: actor.ip,
          meta: { agentId, fields },
        });
      return {
        settings: saved,
        unavailableRepoIds: repos.filter((r) => !byId.has(r.id)).map((r) => r.id),
      };
    },

    /** What the agent may look in now, else null (sync: uses the cached repository list). */
    usable(agentId: number | undefined | null): UsableGitHub | null {
      if (agentId === undefined || agentId === null) return null;
      const state = service.status().state;
      if (state !== 'connected' && state !== 'expiring') return null;
      if (!agentById(ctx.db, agentId)) return null;
      const settings = readSettings(ctx.db, agentId);
      if (!settings.issues && !settings.pulls) return null;
      const shared = cache ? new Set(cache.value.repos.map((r) => r.id)) : null;
      const repos = settings.repos.filter((r) => !shared || shared.has(r.id));
      return repos.length ? { settings, repos } : null;
    },

    /** At call time: the agent's chosen repos GitHub shares now, with their current names. */
    async agentRepos(agentId: number): Promise<GitHubRepo[]> {
      const usable = service.usable(agentId);
      if (!usable) return [];
      const shared = new Map((await accessible()).repos.map((r) => [r.id, r]));
      return usable.repos.flatMap((r) => {
        const current = shared.get(r.id);
        return current ? [current] : [];
      });
    },

    /** One GET for a tool, its answer kept RESULT_CACHE_MS. GitHub errors are thrown. */
    async lookup<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
      const key = `${path}?${new URLSearchParams(query).toString()}`;
      const hit = results.get(key);
      if (hit && now() - hit.at < RESULT_CACHE_MS) return hit.value as T;
      const mine = generation;
      const value = await api<T>(path, query, signal);
      if (mine === generation) {
        if (results.size >= MAX_CACHED_RESULTS) results.delete(results.keys().next().value!);
        results.set(key, { at: now(), value });
      }
      return value;
    },

    activity(): GitHubActivity[] {
      return listActivity(ctx.db);
    },

    addActivity(row: ActivityInput) {
      addActivity(ctx.db, row, now());
    },

    /** The group's name when `chatJid` is a group, else null (Activity shows it). */
    groupName(chatJid: string | null): string | null {
      if (!chatJid) return null;
      const chat = getChats(ctx).get(chatJid);
      return chat?.type === 'group' ? chat.name || null : null;
    },

    shutdown() {
      results.clear();
      auth.shutdown();
    },
  };
  return service;
}

export type GitHubService = ReturnType<typeof createGitHubService>;

/** Lite only for the first release (owner decision Q3): no service, routes or tools elsewhere. */
export function initGitHub(ctx: AppContext) {
  if (ctx.edition === 'lite') ctx.services.github = createGitHubService(ctx);
}

export function getGitHub(ctx: AppContext): GitHubService | null {
  return ctx.services.github ?? null;
}
