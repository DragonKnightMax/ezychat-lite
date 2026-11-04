import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEMPLATE_SIGNING_CONTEXT,
  AgentTemplateCategory,
  cleanAgentTemplateValue,
  AgentTemplateEntry,
  AgentTemplateListFile,
  SUPPORTED_TEMPLATE_SCHEMA_VERSIONS,
  agentTemplateFits,
  type AgentCatalogTemplate,
  type AgentTemplateCatalog,
  type AgentTemplateListState,
  type AgentTemplateListStatus,
} from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { DownloadTooLarge, downloadCapped } from '../connectors/list/download.js';
import { writeAtomic } from '../connectors/list/store.js';
import { publicKeys, signatureValid } from '../connectors/list/verify.js';
import { TEMPLATE_LIST_BASE_URL, TEMPLATE_LIST_PUBLIC_KEYS } from './keys.js';
import type { TemplateListService } from './types.js';

export const LIST_FILE = 'templates-v1.json';
export const SIG_FILE = 'templates-v1.json.sig';
export const DOWNLOAD_TIMEOUT_MS = 10_000;
export const LIST_MAX_BYTES = 512 * 1024;
export const SIG_MAX_BYTES = 1024;
/** At most one download per this time; a refresh in between answers with the current catalog. */
export const REFRESH_MIN_INTERVAL_MS = 30_000;

/** Dev and test only (`--mode dev --fake-wa`): the list's base URL and one extra public key. */
export const LIST_URL_ENV = 'EZYCHAT_TEMPLATE_LIST_URL';
export const TEST_KEY_ENV = 'EZYCHAT_TEMPLATE_LIST_TEST_KEY';

/** Why a downloaded list was not used (logged; the last good copy stays). */
export type RejectReason = 'too_large' | 'signature' | 'format' | 'sequence';

class ListRejected extends Error {
  constructor(readonly reason: RejectReason) {
    super(`template list rejected: ${reason}`);
    this.name = 'ListRejected';
  }
}

export interface TemplateListOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Base64 raw Ed25519 public keys (default: the production keys). */
  keys?: readonly string[];
  /** Where templates-v1.json and its .sig are; null never downloads (default: see listSource). */
  baseUrl?: string | null;
  /** Environment for the dev switches (default process.env). */
  env?: NodeJS.ProcessEnv;
}

interface ListCopy {
  /** null while nothing was saved (the app's own templates only). */
  sequence: number | null;
  generatedAt: string | null;
  categories: AgentTemplateCategory[];
  entries: AgentTemplateEntry[];
}

const EMPTY: ListCopy = { sequence: null, generatedAt: null, categories: [], entries: [] };

/**
 * Where the list comes from. A real install always uses dl.ezychat.ai and the keys built into the
 * app. Only a dev server with fake WhatsApp (`--mode dev --fake-wa`) reads EZYCHAT_TEMPLATE_LIST_URL
 * (http allowed) and EZYCHAT_TEMPLATE_LIST_TEST_KEY; without the URL it never downloads. Fake
 * WhatsApp in any other mode never downloads either.
 */
export function templateListSource(
  ctx: AppContext,
  options: Pick<TemplateListOptions, 'keys' | 'baseUrl' | 'env'> = {},
): { baseUrl: string | null; keys: string[] } {
  const keys = [...(options.keys ?? TEMPLATE_LIST_PUBLIC_KEYS)];
  if (options.baseUrl !== undefined) return { baseUrl: options.baseUrl, keys };
  if (ctx.config.fakeWa && ctx.config.mode === 'dev') {
    const env = options.env ?? process.env;
    const testKey = env[TEST_KEY_ENV]?.trim();
    if (testKey) keys.push(testKey);
    return { baseUrl: env[LIST_URL_ENV]?.trim() || null, keys };
  }
  return { baseUrl: ctx.config.fakeWa ? null : TEMPLATE_LIST_BASE_URL, keys };
}

/** The bytes the publisher signed: the domain prefix, then the exact list file. */
export const signedBytes = (list: Buffer) =>
  Buffer.concat([Buffer.from(TEMPLATE_SIGNING_CONTEXT, 'utf8'), list]);

/**
 * Reads the entries one by one (one bad, repeated or newer entry never blocks the others). Texts are
 * cleaned by the contract (control and bidi characters removed) before anything keeps them.
 */
export function parseTemplateEntries(raw: readonly unknown[]): {
  entries: AgentTemplateEntry[];
  hidden: number;
  skipped: number;
} {
  const result = { entries: [] as AgentTemplateEntry[], hidden: 0, skipped: 0 };
  const seen = new Set<string>();
  for (const item of raw) {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const version = record.schemaVersion;
    if (typeof version === 'number' && !SUPPORTED_TEMPLATE_SCHEMA_VERSIONS.includes(version)) {
      result.hidden++;
      continue;
    }
    const parsed = AgentTemplateEntry.safeParse(cleanAgentTemplateValue(item));
    if (!parsed.success || seen.has(parsed.data.id)) {
      result.skipped++;
      continue;
    }
    seen.add(parsed.data.id);
    result.entries.push(parsed.data);
  }
  return result;
}

function parseCategories(raw: readonly unknown[]): AgentTemplateCategory[] {
  const categories: AgentTemplateCategory[] = [];
  for (const item of raw) {
    const parsed = AgentTemplateCategory.safeParse(cleanAgentTemplateValue(item));
    if (parsed.success && !categories.some((c) => c.id === parsed.data.id))
      categories.push(parsed.data);
  }
  return categories;
}

/**
 * The AI agent template list (design docs/features/template-store/design.md): downloads the signed
 * list at start and on refresh, checks the Ed25519 signature (over the domain prefix + bytes), the
 * format, the sequence and every entry, and keeps the last good copy in `<data>/templates/`.
 */
export function createTemplateListService(
  ctx: AppContext,
  options: TemplateListOptions = {},
): TemplateListService {
  const log = ctx.log.child({ mod: 'template-list' });
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const source = templateListSource(ctx, options);
  const keys = publicKeys(source.keys);
  const dir = join(ctx.config.dataDir, 'templates');
  const app = { version: ctx.config.version, edition: ctx.edition };
  const stop = new AbortController();

  let copy: ListCopy = EMPTY;
  let state: AgentTemplateListState = 'builtin';
  let checkedAt: number | null = null;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  /** Checks a list and its signature; throws ListRejected. */
  function check(list: Buffer, sig: Buffer, saved: ListCopy | null) {
    if (!signatureValid(signedBytes(list), sig, keys)) throw new ListRejected('signature');
    let json: unknown;
    try {
      json = JSON.parse(list.toString('utf8'));
    } catch {
      throw new ListRejected('format');
    }
    const file = AgentTemplateListFile.safeParse(json);
    if (!file.success) throw new ListRejected('format');
    if (saved?.sequence != null && file.data.sequence < saved.sequence)
      throw new ListRejected('sequence');
    const parsed = parseTemplateEntries(file.data.entries);
    const next: ListCopy = {
      sequence: file.data.sequence,
      generatedAt: file.data.generatedAt,
      categories: parseCategories(file.data.categories),
      entries: parsed.entries,
    };
    return { next, hidden: parsed.hidden, skipped: parsed.skipped };
  }

  function loadSaved() {
    try {
      const list = join(dir, LIST_FILE);
      const sig = join(dir, SIG_FILE);
      if (!existsSync(list) || !existsSync(sig)) return;
      const { next } = check(readFileSync(list), readFileSync(sig), null);
      copy = next;
      state = 'loaded';
      log.info(
        { sequence: next.sequence, entries: next.entries.length },
        'template list copy loaded',
      );
    } catch (err) {
      log.warn(
        { reason: err instanceof ListRejected ? err.reason : 'unreadable' },
        'saved template list failed its checks; using the built-in templates',
      );
    }
  }

  async function download(url: URL, max: number): Promise<Buffer> {
    try {
      return await downloadCapped(url, {
        fetch: fetchFn,
        max,
        redirect: 'error',
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
      });
    } catch (err) {
      throw err instanceof DownloadTooLarge ? new ListRejected('too_large') : err;
    }
  }

  async function run(baseUrl: string) {
    const started = now();
    checkedAt = started;
    const ms = () => now() - started;
    try {
      const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
      const [list, sig] = await Promise.all([
        download(new URL(LIST_FILE, base), LIST_MAX_BYTES),
        download(new URL(SIG_FILE, base), SIG_MAX_BYTES),
      ]);
      const { next, hidden, skipped } = check(list, sig, copy);
      if (closed) return;
      if (next.sequence === copy.sequence) {
        state = 'loaded';
        log.info({ sequence: next.sequence, ms: ms() }, 'template list unchanged');
        return;
      }
      mkdirSync(dir, { recursive: true });
      writeAtomic(join(dir, SIG_FILE), sig);
      writeAtomic(join(dir, LIST_FILE), list);
      copy = next;
      state = 'loaded';
      log.info(
        { sequence: next.sequence, entries: next.entries.length, hidden, skipped, ms: ms() },
        'template list loaded',
      );
    } catch (err) {
      if (closed) return;
      if (err instanceof ListRejected) {
        state = 'rejected';
        log.warn({ reason: err.reason, ms: ms() }, 'template list rejected');
        return;
      }
      // Offline: the copy in use stays (nothing saved yet keeps the state `builtin`).
      state = copy.sequence === null ? 'builtin' : 'offline';
      const e = err as { name?: string; code?: string; status?: number };
      log.info(
        { causeName: e.name, code: e.code, status: e.status, ms: ms() },
        'template list download failed',
      );
    }
  }

  const status = (): AgentTemplateListStatus => ({
    state,
    generatedAt: copy.generatedAt,
    sequence: copy.sequence,
    checkedAt,
  });

  const catalog = (): AgentTemplateCatalog => {
    const fitting = copy.entries.filter((entry) => agentTemplateFits(entry, app));
    // Connector names only when some template recommends one (the gallery reads the list copy).
    const names = new Map<string, string>();
    if (fitting.some((entry) => entry.recommendedConnectors?.length))
      for (const c of ctx.services.connectorList?.gallery().connectors ?? [])
        names.set(c.entry.id, c.entry.name);
    const templates: AgentCatalogTemplate[] = fitting.map((entry) => ({
      entry,
      connectors: (entry.recommendedConnectors ?? []).flatMap((id) => {
        const name = names.get(id);
        return name ? [{ id, name }] : [];
      }),
    }));
    return { status: status(), categories: copy.categories, templates };
  };

  loadSaved();

  return {
    status,
    catalog,
    async refresh() {
      const due = checkedAt === null || now() - checkedAt >= REFRESH_MIN_INTERVAL_MS;
      if (!inFlight && !closed && source.baseUrl && due) {
        inFlight = run(source.baseUrl).finally(() => {
          inFlight = null;
        });
      }
      if (inFlight) await inFlight;
      return catalog();
    },
    shutdown() {
      closed = true;
      stop.abort();
    },
  };
}

export function initTemplateList(ctx: AppContext) {
  const service = createTemplateListService(ctx);
  ctx.services.templateList = service;
  // Once at start, in the background: never delays the server start.
  service.refresh().catch(() => {});
}

export function getTemplateList(ctx: AppContext): TemplateListService {
  const service = ctx.services.templateList;
  if (!service) throw new Error('Template list service not initialised');
  return service;
}
