/**
 * The WhatsApp Web version to announce. WhatsApp refuses clients whose version is too old, so Baileys
 * suggests looking up the newest one from its GitHub copy on every connect. That lookup has no
 * timeout, and awaiting it before the socket held every connect (and every new QR) at "connecting"
 * while GitHub was slow or blocked. A connect never waits for it now: it uses the last version
 * looked up (or Baileys' bundled one) at once, and the lookup refreshes in the background, bounded
 * by `timeoutMs` and cached, so a connect WhatsApp refused for an old version retries with the new one.
 */
export type WaVersion = [number, number, number];

export interface WaVersionSourceOptions {
  fetchLatest: () => Promise<{ version: WaVersion }>;
  timeoutMs?: number;
  /** How long a fetched version is reused before the next lookup. */
  ttlMs?: number;
  /** How long to skip the lookup after a failure or timeout. */
  failureTtlMs?: number;
  now?: () => number;
}

export const WA_VERSION_TIMEOUT_MS = 10_000;
const WA_VERSION_TTL_MS = 6 * 60 * 60_000;
const WA_VERSION_FAILURE_TTL_MS = 10 * 60_000;

export interface WaVersionRefresh {
  version: WaVersion | undefined;
  /** Set when this refresh tried the lookup and it failed or timed out. */
  error?: unknown;
}

export interface WaVersionSource {
  /** The version to connect with now: the last one looked up, else undefined (Baileys' bundled one). */
  current(): WaVersion | undefined;
  /** Looks the version up unless a recent result is cached; never rejects, one lookup at a time. */
  refresh(): Promise<WaVersionRefresh>;
}

export function createWaVersionSource(opts: WaVersionSourceOptions): WaVersionSource {
  const timeoutMs = opts.timeoutMs ?? WA_VERSION_TIMEOUT_MS;
  const ttlMs = opts.ttlMs ?? WA_VERSION_TTL_MS;
  const failureTtlMs = opts.failureTtlMs ?? WA_VERSION_FAILURE_TTL_MS;
  const now = opts.now ?? Date.now;
  let version: WaVersion | undefined;
  let nextLookupAt = 0;
  let inflight: Promise<WaVersionRefresh> | null = null;

  const lookup = async (): Promise<WaVersionRefresh> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`WA version lookup timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
        timer.unref?.();
      });
      ({ version } = await Promise.race([opts.fetchLatest(), timeout]));
      nextLookupAt = now() + ttlMs;
      return { version };
    } catch (error) {
      nextLookupAt = now() + failureTtlMs;
      return { version, error };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    current: () => version,
    refresh() {
      if (inflight) return inflight;
      if (now() < nextLookupAt) return Promise.resolve({ version });
      inflight = lookup().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
