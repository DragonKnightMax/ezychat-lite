import { describe, expect, it, vi } from 'vitest';
import { GoogleError } from '../google-calendar/google.js';
import { DriveClient, DRIVE_ENDPOINTS, queryLiteral } from './drive.js';

const APP = { clientId: 'id', clientSecret: 'secret' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('DriveClient', () => {
  it('maps Google answers to errors and never follows a foreign upload address', async () => {
    const answers: Response[] = [];
    const fetchImpl = vi.fn(async () => answers.shift()!);
    const client = new DriveClient(APP, DRIVE_ENDPOINTS, fetchImpl as unknown as typeof fetch);
    const upload = () =>
      client.upload('t', {
        name: 'a',
        mimeType: 'image/png',
        parentId: 'p',
        bytes: Buffer.from('x'),
        appKey: 'k',
      });
    answers.push(json(401, {}));
    await expect(upload()).rejects.toMatchObject({ kind: 'expired' });
    answers.push(json(429, {}));
    await expect(upload()).rejects.toMatchObject({ kind: 'unavailable', status: 429 });
    answers.push(json(404, {}));
    await expect(upload()).rejects.toMatchObject({ kind: 'rejected', status: 404 });
    answers.push(
      new Response(null, { status: 200, headers: { location: 'https://evil.example/x' } }),
    );
    await expect(upload()).rejects.toMatchObject({ kind: 'unavailable' });
    answers.push(new Response(null, { status: 200 }));
    await expect(upload()).rejects.toBeInstanceOf(GoogleError);
    answers.push(
      new Response(null, {
        status: 200,
        headers: { location: `${DRIVE_ENDPOINTS.upload}/files?upload_id=1` },
      }),
      new Response('not json', { status: 200 }),
    );
    await expect(upload()).rejects.toMatchObject({ kind: 'unavailable' });
    fetchImpl.mockRejectedValueOnce(new TypeError('offline'));
    await expect(upload()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('reads at most the allowed bytes', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(10), { status: 200 }));
    const client = new DriveClient(APP, DRIVE_ENDPOINTS, fetchImpl as unknown as typeof fetch);
    expect(await client.download('t', 'f', 5)).toBe('tooLarge');
    expect(await client.export('t', 'f', 'text/plain', 20)).toHaveLength(10);
    expect(String((fetchImpl.mock.calls as unknown as Array<[string]>)[1]![0])).toContain(
      '/export?mimeType=text%2Fplain',
    );
  });

  it('answers rejected for an item without an id, and escapes query strings', async () => {
    const client = new DriveClient(APP, DRIVE_ENDPOINTS, (async () =>
      json(200, { name: 'x' })) as unknown as typeof fetch);
    await expect(client.file('t', 'f')).rejects.toMatchObject({ kind: 'rejected' });
    const noId = new DriveClient(APP, DRIVE_ENDPOINTS, (async () =>
      json(200, {})) as unknown as typeof fetch);
    await expect(noId.createFolder('t', 'n', 'p')).rejects.toMatchObject({ kind: 'rejected' });
    expect(queryLiteral("Jay's \\ folder")).toBe("'Jay\\'s \\\\ folder'");
  });
});
