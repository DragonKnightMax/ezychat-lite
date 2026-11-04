import {
  ConnectorListFile,
  connectorFit,
  type ConnectorEntry,
  type ConnectorGallery,
  type ConnectorIcon,
  type ConnectorListState,
  type ConnectorListStatus,
  type GalleryConnector,
} from '@ezychat/shared';
import type { AppContext } from '../../context.js';
import { BUILTIN_CONNECTOR_LIST } from './builtin-list.js';
import { CONNECTOR_LIST_BASE_URL, CONNECTOR_LIST_PUBLIC_KEYS } from './keys.js';
import { DownloadTooLarge, DownloadUnavailable, downloadCapped } from './download.js';
import { LIST_FILE, ListStore, SIG_FILE } from './store.js';
import type { ConnectorListService } from './types.js';
import {
  iconContentOk,
  iconContentType,
  parseEntries,
  publicKeys,
  referencedIcons,
  sha256,
  signatureValid,
} from './verify.js';

export const DOWNLOAD_TIMEOUT_MS = 10_000;
export const LIST_MAX_BYTES = 2 * 1024 * 1024;
export const SIG_MAX_BYTES = 1024;
export const ICON_MAX_BYTES = 256 * 1024;
/** At most one download per this time; a refresh in between answers with the current gallery. */
export const REFRESH_MIN_INTERVAL_MS = 30_000;
const ICON_CONCURRENCY = 4;
const ICON_FILE = /^[a-z0-9][a-z0-9-]{1,48}\.(svg|png)$/;

/** Dev and test only (`--mode dev --fake-wa`): the list's base URL and one extra public key. */
export const LIST_URL_ENV = 'EZYCHAT_CONNECTOR_LIST_URL';
export const TEST_KEY_ENV = 'EZYCHAT_CONNECTOR_LIST_TEST_KEY';

/** Why a downloaded list was not used (logged; the last good copy stays). */
export type RejectReason = 'too_large' | 'signature' | 'format' | 'sequence' | 'icon';

class ListRejected extends Error {
  constructor(readonly reason: RejectReason) {
    super(`connector list rejected: ${reason}`);
    this.name = 'ListRejected';
  }
}

class ListUnavailable extends Error {
  constructor(readonly status: number) {
    super(`connector list server answered ${status}`);
    this.name = 'ListUnavailable';
  }
}

export interface ConnectorListOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Base64 raw Ed25519 public keys (default: the production keys). */
  keys?: readonly string[];
  /** Where list-v1.json, its .sig and icons/ are; null never downloads (default: see listSource). */
  baseUrl?: string | null;
  /** The list used while none was saved (default: the one shipped in the app). */
  builtin?: { entries: readonly unknown[] };
  /** Environment for the dev switches (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface ConnectorIconFile {
  bytes: Buffer;
  contentType: 'image/svg+xml' | 'image/png';
}

/** The service plus the icon look-up of `GET /api/connectors/icons/:file`. */
export interface ConnectorListServiceImpl extends ConnectorListService {
  icon(file: string): ConnectorIconFile | null;
}

interface ListCopy {
  /** null for the built-in list. */
  sequence: number | null;
  generatedAt: string | null;
  entries: ConnectorEntry[];
  hidden: number;
  icons: Map<string, ConnectorIcon>;
}

/**
 * Where the list comes from. A real install always uses dl.ezychat.ai and the keys built into the
 * app. Only a dev server with fake WhatsApp (`--mode dev --fake-wa`, never a real install) reads
 * EZYCHAT_CONNECTOR_LIST_URL (a local list server, http allowed) and
 * EZYCHAT_CONNECTOR_LIST_TEST_KEY (one extra key); without the URL it never downloads. Fake WhatsApp
 * in any other mode never downloads either.
 */
export function listSource(
  ctx: AppContext,
  options: Pick<ConnectorListOptions, 'keys' | 'baseUrl' | 'env'> = {},
): { baseUrl: string | null; keys: string[] } {
  const keys = [...(options.keys ?? CONNECTOR_LIST_PUBLIC_KEYS)];
  if (options.baseUrl !== undefined) return { baseUrl: options.baseUrl, keys };
  if (ctx.config.fakeWa && ctx.config.mode === 'dev') {
    const env = options.env ?? process.env;
    const testKey = env[TEST_KEY_ENV]?.trim();
    if (testKey) keys.push(testKey);
    return { baseUrl: env[LIST_URL_ENV]?.trim() || null, keys };
  }
  return { baseUrl: ctx.config.fakeWa ? null : CONNECTOR_LIST_BASE_URL, keys };
}

/**
 * The connector list (design docs/features/connector-list/design.md): downloads the signed list at
 * start and on refresh, checks the Ed25519 signature, the sequence, every entry and every icon, and
 * keeps the last good copy in `<data>/connectors/`. Everything else reads the local copy.
 */
export function createConnectorListService(
  ctx: AppContext,
  options: ConnectorListOptions = {},
): ConnectorListServiceImpl {
  const log = ctx.log.child({ mod: 'connector-list' });
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const source = listSource(ctx, options);
  const keys = publicKeys(source.keys);
  const store = new ListStore(ctx.config.dataDir);
  const app = () => ({ version: ctx.config.version, edition: ctx.edition });
  const stop = new AbortController();

  const builtinParsed = parseEntries((options.builtin ?? BUILTIN_CONNECTOR_LIST).entries);
  const builtin: ListCopy = {
    sequence: null,
    generatedAt: null,
    entries: builtinParsed.entries,
    hidden: builtinParsed.hidden,
    icons: new Map(),
  };

  let copy = builtin;
  let state: ConnectorListState = 'builtin';
  let checkedAt: number | null = null;
  /** Icons of the copy in use whose saved file matched its hash. */
  let verifiedIcons = new Set<string>();
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const localIconOk = (icon: ConnectorIcon) => {
    const bytes = store.icon(icon.file);
    return (
      !!bytes &&
      bytes.length === icon.size &&
      sha256(bytes) === icon.sha256 &&
      iconContentOk(icon.file, bytes)
    );
  };

  /** Checks a list and its signature; throws ListRejected. */
  function check(list: Buffer, sig: Buffer, saved: ListCopy | null) {
    if (!signatureValid(list, sig, keys)) throw new ListRejected('signature');
    let json: unknown;
    try {
      json = JSON.parse(list.toString('utf8'));
    } catch {
      throw new ListRejected('format');
    }
    const file = ConnectorListFile.safeParse(json);
    if (!file.success) throw new ListRejected('format');
    if (saved?.sequence != null && file.data.sequence < saved.sequence)
      throw new ListRejected('sequence');
    const parsed = parseEntries(file.data.entries);
    const icons = referencedIcons(parsed.entries);
    if (!icons) throw new ListRejected('icon');
    const next: ListCopy = {
      sequence: file.data.sequence,
      generatedAt: file.data.generatedAt,
      entries: parsed.entries,
      hidden: parsed.hidden,
      icons,
    };
    return { next, skipped: parsed.skipped };
  }

  function loadSaved() {
    const saved = store.read();
    if (!saved) return;
    try {
      const { next } = check(saved.list, saved.sig, null);
      copy = next;
      verifiedIcons = new Set([...next.icons.values()].filter(localIconOk).map((i) => i.file));
      state = 'loaded';
      log.info(
        { sequence: next.sequence, entries: next.entries.length, hidden: next.hidden },
        'connector list copy loaded',
      );
    } catch (err) {
      log.warn(
        { reason: err instanceof ListRejected ? err.reason : 'unreadable' },
        'saved connector list failed its checks; using the built-in list',
      );
    }
  }

  async function download(url: URL, max: number): Promise<Buffer> {
    try {
      return await downloadCapped(url, {
        fetch: fetchFn,
        max,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
      });
    } catch (err) {
      if (err instanceof DownloadTooLarge) throw new ListRejected('too_large');
      if (err instanceof DownloadUnavailable) throw new ListUnavailable(err.status);
      throw err;
    }
  }

  /** Downloads the icons that are new or changed; any bad icon rejects the whole list. */
  async function fetchIcons(icons: Map<string, ConnectorIcon>, base: URL) {
    const fresh = new Map<string, Buffer>();
    const todo = [...icons.values()].filter((icon) => !localIconOk(icon));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const icon = todo[next++]!;
        let bytes: Buffer;
        try {
          bytes = await download(new URL(`icons/${icon.file}`, base), ICON_MAX_BYTES);
        } catch (err) {
          throw err instanceof ListRejected ? new ListRejected('icon') : err;
        }
        if (
          bytes.length !== icon.size ||
          sha256(bytes) !== icon.sha256 ||
          !iconContentOk(icon.file, bytes)
        )
          throw new ListRejected('icon');
        fresh.set(icon.file, bytes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(ICON_CONCURRENCY, todo.length) }, worker));
    return fresh;
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
      const { next, skipped } = check(list, sig, copy);
      if (closed) return;
      if (skipped.length)
        log.warn(
          { count: skipped.length, ids: skipped.filter(Boolean).slice(0, 20) },
          'connector list entries skipped',
        );
      const unchanged =
        next.sequence === copy.sequence &&
        [...next.icons.keys()].every((f) => verifiedIcons.has(f));
      if (unchanged) {
        state = 'loaded';
        log.info({ sequence: next.sequence, ms: ms() }, 'connector list unchanged');
        return;
      }
      const fresh = await fetchIcons(next.icons, base);
      if (closed) return;
      store.save(list, sig, fresh, new Set(next.icons.keys()));
      copy = next;
      verifiedIcons = new Set(next.icons.keys());
      state = 'loaded';
      log.info(
        {
          sequence: next.sequence,
          entries: next.entries.length,
          hidden: next.hidden,
          skipped: skipped.length,
          icons: fresh.size,
          ms: ms(),
        },
        'connector list loaded',
      );
    } catch (err) {
      if (closed) return;
      if (err instanceof ListRejected) {
        state = 'rejected';
        log.warn({ reason: err.reason, ms: ms() }, 'connector list rejected');
        return;
      }
      // Offline: the copy in use stays (the built-in list keeps the state `builtin`).
      state = copy.sequence === null ? 'builtin' : 'offline';
      const e = err as { name?: string; code?: string; status?: number };
      log.info(
        { causeName: e.name, code: e.code, status: e.status, ms: ms() },
        'connector list download failed',
      );
    }
  }

  const status = (): ConnectorListStatus => ({
    state,
    generatedAt: copy.generatedAt,
    sequence: copy.sequence,
    checkedAt,
    appVersion: ctx.config.version,
    hidden: copy.hidden,
  });

  const gallery = (): ConnectorGallery => {
    const port = ctx.services.connectorConnections;
    const shown = new Set<string>();
    const connectors: GalleryConnector[] = [];
    const add = (entry: ConnectorEntry, delisted: boolean) => {
      const fit = connectorFit(entry, app());
      if (fit === 'hidden' || shown.has(entry.id)) return;
      shown.add(entry.id);
      connectors.push({ entry, fit, delisted, connection: port?.view(entry.id) ?? null });
    };
    for (const entry of copy.entries) add(entry, false);
    // Connected but no longer in the list: keeps working with the copy saved at connect time.
    for (const saved of port?.saved() ?? []) if (!shown.has(saved.id)) add(saved.entry, true);
    return { status: status(), connectors };
  };

  loadSaved();

  return {
    status,
    gallery,
    entry(id) {
      return copy.entries.find((e) => e.id === id && connectorFit(e, app()) === 'ok') ?? null;
    },
    async refresh() {
      const due = checkedAt === null || now() - checkedAt >= REFRESH_MIN_INTERVAL_MS;
      if (!inFlight && !closed && source.baseUrl && due) {
        inFlight = run(source.baseUrl).finally(() => {
          inFlight = null;
        });
      }
      if (inFlight) await inFlight;
      return gallery();
    },
    icon(file) {
      if (!ICON_FILE.test(file) || !verifiedIcons.has(file)) return null;
      const icon = copy.icons.get(file);
      const bytes = store.icon(file);
      if (!icon || !bytes || bytes.length !== icon.size || sha256(bytes) !== icon.sha256)
        return null;
      return { bytes, contentType: iconContentType(file) };
    },
    shutdown() {
      closed = true;
      stop.abort();
    },
  };
}

export function initConnectorList(ctx: AppContext) {
  const service = createConnectorListService(ctx);
  ctx.services.connectorList = service;
  // Once at start, in the background: never delays the server start.
  service.refresh().catch(() => {});
}

export function getConnectorList(ctx: AppContext): ConnectorListService {
  const service = ctx.services.connectorList;
  if (!service) throw new Error('Connector list service not initialised');
  return service;
}
