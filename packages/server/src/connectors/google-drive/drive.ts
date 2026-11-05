/**
 * The few Google Drive API v3 calls the connector needs, on GoogleClient's sign-in and error
 * mapping. Scope `drive.file`: EzyChat reaches only the folder and files the admin picked in
 * Google's file picker and the files and folders it created itself; every other file answers 404.
 *
 * Uploads use Google's resumable protocol (one metadata request, one PUT of the bytes) for every
 * size, so a large file never sits in a multipart body. Downloads and exports read at most
 * `maxBytes`. Never log tokens, file names, folder names or contents.
 */
import {
  GOOGLE_ENDPOINTS,
  GoogleClient,
  GoogleError,
  type GoogleApp,
  type GoogleEndpoints,
} from '../google-calendar/google.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_SCOPES = ['openid', 'email', DRIVE_SCOPE] as const;
export const DRIVE_REQUIRED_SCOPES = [DRIVE_SCOPE] as const;

export interface DriveEndpoints extends GoogleEndpoints {
  /** The upload base (`…/upload/drive/v3`). */
  upload: string;
}

export const DRIVE_ENDPOINTS: DriveEndpoints = {
  ...GOOGLE_ENDPOINTS,
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
};

/** An upload or download may take longer than an API call. */
export const DRIVE_TRANSFER_TIMEOUT_MS = 120_000;
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  /** Bytes (Google Docs have none). */
  size: number | null;
}

const str = (value: unknown) => (typeof value === 'string' ? value : null);
const FIELDS = 'id,name,mimeType,parents,trashed,size';

function toItem(json: Record<string, unknown>): DriveItem | null {
  const id = str(json.id);
  if (!id) return null;
  const size = Number(str(json.size) ?? json.size);
  return {
    id,
    name: (str(json.name) ?? id).slice(0, 300),
    mimeType: (str(json.mimeType) ?? 'application/octet-stream').slice(0, 200),
    parents: Array.isArray(json.parents)
      ? (json.parents as unknown[]).flatMap((p) => (typeof p === 'string' ? [p] : []))
      : [],
    trashed: json.trashed === true,
    size: Number.isFinite(size) && size >= 0 ? size : null,
  };
}

/** A Drive query string literal (single quotes and backslashes escaped). */
export function queryLiteral(value: string): string {
  const escaped = value.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`);
  return `'${escaped}'`;
}

export class DriveClient extends GoogleClient {
  constructor(
    app: GoogleApp,
    readonly driveEndpoints: DriveEndpoints = DRIVE_ENDPOINTS,
    fetchImpl?: typeof fetch,
  ) {
    super(app, driveEndpoints, fetchImpl);
  }

  /** One file's metadata; a file the app may not open answers `rejected` (404). */
  async file(token: string, id: string, signal?: AbortSignal): Promise<DriveItem> {
    const { json } = await this.api(
      `/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`,
      token,
      { signal },
    );
    const item = toItem(json);
    if (!item) throw new GoogleError('rejected');
    return item;
  }

  /**
   * Files and folders in `parentId` matching the extra query (only what the app may see), at most
   * `limit`.
   */
  async list(token: string, query: string, signal?: AbortSignal, limit = 10): Promise<DriveItem[]> {
    const params = new URLSearchParams({
      q: `${query} and trashed = false`,
      fields: `files(${FIELDS})`,
      pageSize: String(Math.min(100, limit)),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const { json } = await this.api(`/files?${params}`, token, { signal });
    const files = Array.isArray(json.files) ? (json.files as Array<Record<string, unknown>>) : [];
    return files.slice(0, limit).flatMap((f) => toItem(f) ?? []);
  }

  /** Creates a folder in `parentId`; its id. */
  async createFolder(
    token: string,
    name: string,
    parentId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { json } = await this.api('/files?fields=id&supportsAllDrives=true', token, {
      method: 'POST',
      signal,
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    const id = str(json.id);
    if (!id) throw new GoogleError('rejected');
    return id;
  }

  /** A raw request (uploads, downloads) with its own timeout and the same error mapping. */
  private async raw(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    const timeout = AbortSignal.timeout(DRIVE_TRANSFER_TIMEOUT_MS);
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new GoogleError('unavailable');
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    if (status === 429 || status >= 500) throw new GoogleError('unavailable', status);
    if (status === 401) throw new GoogleError('expired', status);
    throw new GoogleError('rejected', status);
  }

  /**
   * Uploads `bytes` as a new file in `parentId` (resumable protocol). `appKey` is stored as the
   * file's private app property `ezychatKey`, so a retry can find a file already uploaded.
   */
  async upload(
    token: string,
    input: { name: string; mimeType: string; parentId: string; bytes: Buffer; appKey: string },
    signal?: AbortSignal,
  ): Promise<string> {
    const start = await this.raw(
      `${this.driveEndpoints.upload}/files?uploadType=resumable&supportsAllDrives=true&fields=id`,
      {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': input.mimeType,
          'x-upload-content-length': String(input.bytes.length),
        },
        body: JSON.stringify({
          name: input.name,
          mimeType: input.mimeType,
          parents: [input.parentId],
          appProperties: { ezychatKey: input.appKey },
        }),
      },
    );
    await start.body?.cancel().catch(() => {});
    const location = start.headers.get('location');
    // The session URL must be Google's own upload host (never follow anything else).
    if (!location || new URL(location).origin !== new URL(this.driveEndpoints.upload).origin)
      throw new GoogleError('unavailable');
    const done = await this.raw(location, {
      method: 'PUT',
      signal,
      headers: { 'content-type': input.mimeType },
      body: new Uint8Array(input.bytes),
    });
    const text = await done.text();
    let id: string | null;
    try {
      id = str((JSON.parse(text) as Record<string, unknown>).id);
    } catch {
      id = null;
    }
    if (!id) throw new GoogleError('unavailable');
    return id;
  }

  /** The file EzyChat uploaded with this app key into `parentId`, if any (a retry's check). */
  async findUploaded(
    token: string,
    parentId: string,
    appKey: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const found = await this.list(
      token,
      `${queryLiteral(parentId)} in parents and appProperties has { key='ezychatKey' and value=${queryLiteral(appKey)} }`,
      signal,
      1,
    );
    return found[0]?.id ?? null;
  }

  /** The folder EzyChat created with this name in `parentId`, if any. */
  async findFolder(
    token: string,
    parentId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const found = await this.list(
      token,
      `${queryLiteral(parentId)} in parents and name = ${queryLiteral(name)} and mimeType = ${queryLiteral(FOLDER_MIME)}`,
      signal,
      1,
    );
    return found[0]?.id ?? null;
  }

  /** Reads the body; more than `maxBytes` is `tooLarge`. */
  private async bounded(response: Response, maxBytes: number): Promise<Buffer | 'tooLarge'> {
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return 'tooLarge';
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  /** The file's bytes, at most `maxBytes`. */
  async download(
    token: string,
    id: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer | 'tooLarge'> {
    const response = await this.raw(
      `${this.driveEndpoints.api}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      { signal, headers: { authorization: `Bearer ${token}` } },
    );
    return this.bounded(response, maxBytes);
  }

  /** A Google Docs file exported as `mimeType` (text), at most `maxBytes`. */
  async export(
    token: string,
    id: string,
    mimeType: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer | 'tooLarge'> {
    const response = await this.raw(
      `${this.driveEndpoints.api}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mimeType)}`,
      { signal, headers: { authorization: `Bearer ${token}` } },
    );
    return this.bounded(response, maxBytes);
  }
}
