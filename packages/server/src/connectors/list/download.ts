/** A download that was too large (declared or streamed); the caller maps it to its own reason. */
export class DownloadTooLarge extends Error {
  constructor() {
    super('download too large');
    this.name = 'DownloadTooLarge';
  }
}

/** The server answered with a status other than 2xx. */
export class DownloadUnavailable extends Error {
  constructor(readonly status: number) {
    super(`list server answered ${status}`);
    this.name = 'DownloadUnavailable';
  }
}

export interface CappedDownloadOptions {
  fetch: typeof fetch;
  /** Aborts with the caller (shutdown) and after the timeout. */
  signal: AbortSignal;
  /** Most bytes accepted; a larger declared or streamed body throws DownloadTooLarge. */
  max: number;
  /** `error` refuses any redirect (the template list); default follows (the connector list). */
  redirect?: 'follow' | 'error';
}

/**
 * Downloads `url` into memory, never more than `max` bytes: checks the declared length first, then
 * counts the streamed bytes and cancels the body as soon as it passes the cap. Used by the signed
 * connector and template lists (fixed https hosts, never an address from a user).
 */
export async function downloadCapped(url: URL, options: CappedDownloadOptions): Promise<Buffer> {
  const response = await options.fetch(url, {
    signal: options.signal,
    headers: { 'cache-control': 'no-cache' },
    ...(options.redirect ? { redirect: options.redirect } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new DownloadUnavailable(response.status);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > options.max) {
    await response.body?.cancel().catch(() => {});
    throw new DownloadTooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > options.max) {
      await reader.cancel().catch(() => {});
      throw new DownloadTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
