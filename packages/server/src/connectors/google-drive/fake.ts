/**
 * In-process stand-in for Google (sign-in and Drive v3), used ONLY when the server runs with
 * `--fake-wa` (tests, e2e, Dev Builds) and no Google app is configured. Nothing here touches the
 * network: `fetch` answers the same requests DriveClient sends to the fake base URLs. Like
 * `drive.file`, an item answers 404 unless the (fake) picker granted it or the app created it.
 */
import { randomBytes } from 'node:crypto';
import { FakeGoogleAuth, fakeJson as json } from '../google-fake-auth.js';
import { DRIVE_SCOPES, FOLDER_MIME, type DriveEndpoints } from './drive.js';

const BASE = 'https://fake-google-drive.invalid';
export const FAKE_DRIVE_ENDPOINTS: DriveEndpoints = {
  auth: `${BASE}/o/oauth2/v2/auth`,
  token: `${BASE}/token`,
  api: `${BASE}/drive/v3`,
  upload: `${BASE}/upload/drive/v3`,
  revoke: `${BASE}/revoke`,
};
export const FAKE_DRIVE_APP = { clientId: 'fake-client', clientSecret: 'fake-secret' };
export const FAKE_DRIVE_ACCOUNT = 'demo.drive@example.com';
export const FAKE_DRIVE_FOLDER_ID = 'demo-folder-000000000001';
export const FAKE_DRIVE_DOC_ID = 'demo-doc-prices-0000000001';

export interface FakeDriveItem {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  appProperties: Record<string, string>;
  trashed: boolean;
}

function demoItems(): FakeDriveItem[] {
  const item = (
    id: string,
    name: string,
    mimeType: string,
    parents: string[],
    content = '',
  ): FakeDriveItem => ({
    id,
    name,
    mimeType,
    parents,
    content: Buffer.from(content, 'utf8'),
    appProperties: {},
    trashed: false,
  });
  return [
    item(FAKE_DRIVE_FOLDER_ID, 'EzyChat demo folder', FOLDER_MIME, ['root']),
    item('demo-folder-000000000002', 'Shared documents', FOLDER_MIME, ['root']),
    item(
      FAKE_DRIVE_DOC_ID,
      'Price list',
      'application/vnd.google-apps.document',
      [FAKE_DRIVE_FOLDER_ID],
      'Nasi lemak set RM 12.90\nTeh tarik RM 3.50\nCatering for 20 people RM 450, order 3 days ahead.',
    ),
    item(
      'demo-sheet-stock-000000001',
      'Stock this week',
      'application/vnd.google-apps.spreadsheet',
      [FAKE_DRIVE_FOLDER_ID],
      'Item,In stock\nDurian cake,No (back on Friday)\nKaya toast,Yes',
    ),
    item(
      'demo-text-faq-000000000001',
      'Delivery FAQ.txt',
      'text/plain',
      [FAKE_DRIVE_FOLDER_ID],
      'We deliver in Penang island from 10am to 8pm. Delivery is free above RM 50.',
    ),
    item(
      'demo-image-flyer-000000001',
      'Old flyer.jpg',
      'image/jpeg',
      [FAKE_DRIVE_FOLDER_ID],
      'not really a jpeg',
    ),
  ];
}

interface UploadSession {
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
}

export class FakeGoogleDrive extends FakeGoogleAuth {
  readonly items = new Map<string, FakeDriveItem>(demoItems().map((i) => [i.id, i]));
  /** Picked in the (fake) file picker. */
  readonly granted = new Set<string>();
  /** Created by the app (always reachable with drive.file). */
  readonly created = new Set<string>();
  /** HTTP statuses the next uploads answer instead of storing (e.g. 503). */
  readonly uploadStatuses: number[] = [];
  private readonly sessions = new Map<string, UploadSession>();

  constructor() {
    super(FAKE_DRIVE_ACCOUNT, DRIVE_SCOPES.join(' '));
  }

  /** The fake picker's choice (tests and the dev picker page). */
  grant(id: string): boolean {
    if (!this.items.has(id)) return false;
    this.granted.add(id);
    return true;
  }

  /** Folders the picker shows. */
  folders(): FakeDriveItem[] {
    return [...this.items.values()].filter((i) => i.mimeType === FOLDER_MIME && !i.trashed);
  }

  /** Files of a folder the picker shows (everything in it, like Google's picker). */
  filesIn(folderId: string): FakeDriveItem[] {
    return [...this.items.values()].filter(
      (i) => i.mimeType !== FOLDER_MIME && !i.trashed && i.parents.includes(folderId),
    );
  }

  private reachable(id: string): FakeDriveItem | undefined {
    const item = this.items.get(id);
    return item && (this.granted.has(id) || this.created.has(id)) ? item : undefined;
  }

  private meta(item: FakeDriveItem) {
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      parents: item.parents,
      trashed: item.trashed,
      ...(item.mimeType.startsWith('application/vnd.google-apps')
        ? {}
        : { size: String(item.content.length) }),
    };
  }

  private add(input: Omit<FakeDriveItem, 'id' | 'trashed'>): FakeDriveItem {
    const id = `fake-${randomBytes(10).toString('hex')}`;
    const item = { ...input, id, trashed: false };
    this.items.set(id, item);
    this.created.add(id);
    return item;
  }

  /** `'X' in parents`, `name = 'Y'`, `appProperties has { key='k' and value='v' }`, mimeType. */
  private matches(item: FakeDriveItem, q: string): boolean {
    const unq = (text: string) => text.replaceAll("\\'", "'").replaceAll('\\\\', '\\');
    const field = (pattern: RegExp) => {
      const found = pattern.exec(q);
      return found ? unq(found[1]!) : null;
    };
    const parent = field(/'((?:[^'\\]|\\.)*)' in parents/);
    if (parent !== null && !item.parents.includes(parent)) return false;
    const name = field(/name = '((?:[^'\\]|\\.)*)'/);
    if (name !== null && item.name !== name) return false;
    const mime = field(/mimeType = '((?:[^'\\]|\\.)*)'/);
    if (mime !== null && item.mimeType !== mime) return false;
    const prop = /key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)'/.exec(q);
    if (prop && item.appProperties[unq(prop[1]!)] !== unq(prop[2]!)) return false;
    return !item.trashed;
  }

  private static bodyText(init: RequestInit | undefined): string {
    return typeof init?.body === 'string' ? init.body : '';
  }

  private static bodyBytes(init: RequestInit | undefined): Buffer {
    const body = init?.body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    return Buffer.from(typeof body === 'string' ? body : '');
  }

  /** The PUT of a resumable upload (no token: the upload id is the key, as Google's). */
  private finishUpload(url: URL, method: string, init: RequestInit | undefined): Response {
    const uploadId = url.searchParams.get('upload_id')!;
    const session = this.sessions.get(uploadId);
    if (!session || method !== 'PUT') return json(404, { error: { code: 404 } });
    this.sessions.delete(uploadId);
    this.calls.push('upload');
    const status = this.uploadStatuses.shift();
    if (status) return json(status, { error: { code: status } });
    const item = this.add({ ...session, content: FakeGoogleDrive.bodyBytes(init) });
    return json(200, { id: item.id });
  }

  private startUpload(init: RequestInit | undefined): Response {
    const body = JSON.parse(FakeGoogleDrive.bodyText(init)) as Partial<UploadSession>;
    const parent = body.parents?.[0];
    if (!parent || !this.reachable(parent)) return json(404, { error: { code: 404 } });
    const uploadId = randomBytes(8).toString('hex');
    this.sessions.set(uploadId, {
      name: String(body.name),
      mimeType: String(body.mimeType),
      parents: [parent],
      appProperties: body.appProperties ?? {},
    });
    return new Response(null, {
      status: 200,
      headers: {
        location: `${BASE}/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}`,
      },
    });
  }

  private listFiles(url: URL): Response {
    this.calls.push('list');
    const q = url.searchParams.get('q') ?? '';
    const files = [...this.items.values()]
      .filter((i) => this.reachable(i.id) && this.matches(i, q))
      .map((i) => this.meta(i));
    return json(200, { files });
  }

  private createFolder(init: RequestInit | undefined): Response {
    const body = JSON.parse(FakeGoogleDrive.bodyText(init)) as {
      name?: string;
      parents?: string[];
    };
    const parent = body.parents?.[0];
    if (!parent || !this.reachable(parent)) return json(404, { error: { code: 404 } });
    this.calls.push('createFolder');
    const item = this.add({
      name: String(body.name),
      mimeType: FOLDER_MIME,
      parents: [parent],
      content: Buffer.alloc(0),
      appProperties: {},
    });
    return json(200, { id: item.id });
  }

  private exportFile(id: string): Response {
    const item = this.reachable(id);
    if (!item?.mimeType.startsWith('application/vnd.google-apps'))
      return json(404, { error: { code: 404 } });
    this.calls.push('export');
    return new Response(new Uint8Array(item.content), { status: 200 });
  }

  private getFile(id: string, url: URL): Response {
    const item = this.reachable(id);
    if (!item) return json(404, { error: { code: 404 } });
    if (url.searchParams.get('alt') === 'media') {
      this.calls.push('download');
      return new Response(new Uint8Array(item.content), { status: 200 });
    }
    this.calls.push('file');
    return json(200, this.meta(item));
  }

  private answer(url: URL, method: string, init: RequestInit | undefined): Response {
    if (url.pathname === '/upload/drive/v3/files' && url.searchParams.has('upload_id'))
      return this.finishUpload(url, method, init);
    const denied = this.authorize(url.pathname, init);
    if (denied) return denied;
    const route = `${method} ${url.pathname}`;
    if (route === 'POST /upload/drive/v3/files') return this.startUpload(init);
    if (route === 'GET /drive/v3/files') return this.listFiles(url);
    if (route === 'POST /drive/v3/files') return this.createFolder(init);
    const exported = /^GET \/drive\/v3\/files\/([^/]+)\/export$/.exec(route);
    if (exported) return this.exportFile(decodeURIComponent(exported[1]!));
    const one = /^GET \/drive\/v3\/files\/([^/]+)$/.exec(route);
    if (one) return this.getFile(decodeURIComponent(one[1]!), url);
    return json(404, { error: { code: 404 } });
  }

  readonly fetch: typeof fetch = (input, init) => {
    const raw = typeof input === 'string' || input instanceof URL ? input : input.url;
    const url = new URL(raw);
    if (url.origin !== BASE)
      return Promise.reject(new TypeError('fake Google Drive: unknown host'));
    return Promise.resolve(this.answer(url, (init?.method ?? 'GET').toUpperCase(), init));
  };
}
