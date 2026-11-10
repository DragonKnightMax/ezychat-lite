import { GitHubRepo, type GitHubMethod } from '@ezychat/shared';

/**
 * The repositories GitHub lets EzyChat reach (design "Sign-in" A.5 / B): for the App, every
 * repository of every installation the signed-in user can see; for a token, `GET /user/repos`
 * (owner, collaborator and organisation member). Paged, at most MAX_PAGES pages of 100 per list.
 * The service caches the answer for REPO_CACHE_MS.
 */
export const REPO_CACHE_MS = 10 * 60_000;
const PER_PAGE = 100;
const MAX_PAGES = 10;

/** One authorised GitHub GET (the service adds the token and refresh). */
export type GitHubGet = <T>(path: string, query: Record<string, string>) => Promise<T>;

export interface AccessibleRepos {
  repos: GitHubRepo[];
  /** App: how many installations the user can see (0: install the App first); token: null. */
  installations: number | null;
}

interface ApiRepo {
  id?: unknown;
  full_name?: unknown;
  private?: unknown;
}

async function pages<T>(
  get: GitHubGet,
  path: string,
  pick: (page: unknown) => T[],
  query: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = pick(
      await get(path, { ...query, per_page: String(PER_PAGE), page: String(page) }),
    );
    out.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return out;
}

const field =
  <T>(name: string) =>
  (page: unknown): T[] => {
    const list = (page as Record<string, unknown> | null)?.[name];
    return Array.isArray(list) ? (list as T[]) : [];
  };

export async function readAccessibleRepos(
  method: GitHubMethod,
  get: GitHubGet,
): Promise<AccessibleRepos> {
  let raw: ApiRepo[];
  let installations: number | null = null;
  if (method === 'app') {
    const found = await pages(get, '/user/installations', field<{ id?: unknown }>('installations'));
    const ids = found.map((i) => i.id).filter((id): id is number => Number.isSafeInteger(id));
    installations = ids.length;
    raw = [];
    for (const id of ids)
      raw.push(
        ...(await pages(
          get,
          `/user/installations/${id}/repositories`,
          field<ApiRepo>('repositories'),
        )),
      );
  } else
    raw = await pages(
      get,
      '/user/repos',
      (page) => (Array.isArray(page) ? (page as ApiRepo[]) : []),
      {
        affiliation: 'owner,collaborator,organization_member',
      },
    );
  const byId = new Map<number, GitHubRepo>();
  for (const item of raw) {
    const parsed = GitHubRepo.safeParse({
      id: item.id,
      fullName: item.full_name,
      private: item.private === true,
    });
    if (parsed.success) byId.set(parsed.data.id, parsed.data);
  }
  const repos = [...byId.values()].sort((a, b) =>
    a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase()),
  );
  return { repos, installations };
}
