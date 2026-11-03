import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEEDBACK_LOG_LINES, FEEDBACK_LOG_MAX_BYTES } from '@ezychat/shared';
import { cleanScreen, osDetails } from '../src/feedback/diagnostics.js';
import { feedbackFileName, feedbackFileType } from '../src/feedback/files.js';
import {
  recentFeedbackLog,
  redactFeedbackLogLine,
  scrubFeedbackText,
} from '../src/feedback/log.js';
import {
  FEEDBACK_RESPONSE_MAX_BYTES,
  forwardFeedback,
  portalUrlFromOrigin,
} from '../src/feedback/portal.js';
import type { HttpError } from '../src/http/errors.js';

describe('feedback files', () => {
  it('reads each allowed type from its bytes', () => {
    expect(
      feedbackFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'a'),
    ).toBe('image/png');
    expect(feedbackFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'a.png')).toBe('image/jpeg');
    expect(feedbackFileType(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 '), 'a')).toBe('image/webp');
    expect(feedbackFileType(Buffer.from('%PDF-1.4'), 'a')).toBe('application/pdf');
    expect(feedbackFileType(Buffer.from('\x00\x00\x00\x18ftypmp42'), 'a')).toBe('video/mp4');
    expect(feedbackFileType(Buffer.from('\x00\x00\x00\x14ftypqt  '), 'a.mp4')).toBeNull();
    expect(feedbackFileType(Buffer.from('hello\tworld\r\n'), 'notes.TXT')).toBe('text/plain');
    expect(feedbackFileType(Buffer.from('hello'), 'notes.html')).toBeNull();
    expect(feedbackFileType(Buffer.from([0xc3, 0x28]), 'bad.log')).toBeNull();
    expect(feedbackFileType(Buffer.alloc(0), 'empty.txt')).toBeNull();
  });

  it('names a file safely with the extension of its real type', () => {
    expect(feedbackFileName('C:\\Users\\ali\\shot.jpeg', 'image/jpeg')).toBe('shot.jpg');
    expect(feedbackFileName('../../etc/passwd', 'text/plain')).toBe('passwd.txt');
    expect(feedbackFileName('server.log', 'text/plain')).toBe('server.log');
    expect(feedbackFileName('a"<b>|c\u0001.png', 'image/png')).toBe('abc.png');
    expect(feedbackFileName('', 'application/pdf')).toBe('attachment.pdf');
    expect(feedbackFileName(`${'x'.repeat(200)}.pdf`, 'application/pdf')).toHaveLength(94);
  });
});

describe('feedback diagnostics', () => {
  it('names the computer and its version', () => {
    expect(osDetails('win32', '10.0.26100')).toEqual({ os: 'Windows 11', osVersion: '10.0.26100' });
    expect(osDetails('win32', '10.0.19045')).toEqual({ os: 'Windows 10', osVersion: '10.0.19045' });
    expect(osDetails('darwin', '24.3.0')).toEqual({ os: 'macOS', osVersion: '15.3' });
    expect(osDetails('darwin', '25.0.0')).toEqual({ os: 'macOS', osVersion: '26.0' });
    expect(osDetails('darwin', '19.6.0')).toEqual({ os: 'macOS', osVersion: '10.15' });
    expect(osDetails('linux', '6.8.0')).toEqual({ os: 'Linux', osVersion: '6.8.0' });
    expect(osDetails('freebsd', '14.0')).toEqual({ os: 'freebsd', osVersion: '14.0' });
  });

  it('keeps only the shape of the screen path', () => {
    expect(cleanScreen('/chats/60123456789@s.whatsapp.net?q=ali#x')).toBe('/chats/:id');
    expect(cleanScreen('/chats/abc%40lid/info')).toBe('/chats/:id/info');
    expect(cleanScreen('/admin/members/ai/2')).toBe('/admin/members/ai/2');
    expect(cleanScreen('admin/reports')).toBe('/admin/reports');
    expect(cleanScreen(`/x/${'a'.repeat(50)}`)).toBe('/x/:id');
  });
});

describe('feedback log', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('scrubs chat ids, emails, addresses, numbers and the user folder from text', () => {
    const home = /C:[\\/]+Users[\\/]+ali/gi;
    expect(
      scrubFeedbackText(
        'at C:\\Users\\ali\\app.js 60123@s.whatsapp.net a.b@x.co 8.8.4.4 fe80::1 2001:db8:0:0:1:0:0:1 +60 12-345 6789, 0123456789 v0.1.73 2026-11-03',
        home,
      ),
    ).toBe('at ~\\app.js [chat] [email] [ip] [ip] [ip] [number], [number] v0.1.73 2026-11-03');
  });

  it('keeps only complete JSON records, without personal fields', () => {
    expect(redactFeedbackLogLine('', null)).toBeNull();
    expect(redactFeedbackLogLine('{"level":30,"msg":"half', null)).toBeNull();
    expect(redactFeedbackLogLine('[1,2]', null)).toBeNull();
    const line = redactFeedbackLogLine(
      '{"level":30,"mod":"ai","caption":"photo of Ali","nested":{"Email":"x@y.z","list":["601234567"]},"msg":"ok"}',
      null,
    );
    expect(JSON.parse(line!)).toEqual({
      level: 30,
      mod: 'ai',
      caption: '[removed]',
      nested: { Email: '[removed]', list: ['[number]'] },
      msg: 'ok',
    });
  });

  function logDir() {
    dir = mkdtempSync(join(tmpdir(), 'feedback-log-'));
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    return logs;
  }

  it('reads the last 200 lines of the newest log file', () => {
    const logs = logDir();
    const lines = Array.from({ length: 300 }, (_, i) => `{"level":30,"n":${i},"msg":"tick"}`);
    writeFileSync(join(logs, 'new.log'), lines.join('\n'));
    writeFileSync(join(logs, 'old.log'), '{"level":30,"msg":"old"}\n');
    writeFileSync(join(logs, 'notes.txt'), 'ignored');
    utimesSync(join(logs, 'old.log'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const out = recentFeedbackLog(dir!);
    expect(out.lines).toBe(FEEDBACK_LOG_LINES);
    expect(out.text.split('\n')[0]).toBe('{"level":30,"n":100,"msg":"tick"}');
    expect(out.text).not.toContain('old');
  });

  it('keeps the log under 64 KB and skips a cut first line', () => {
    const logs = logDir();
    const big = (i: number) => `{"level":30,"n":${i},"msg":"${'y'.repeat(1000)}"}`;
    // 600 KB: reading starts inside a line, which is dropped
    writeFileSync(join(logs, 'a.log'), Array.from({ length: 600 }, (_, i) => big(i)).join('\n'));
    const out = recentFeedbackLog(dir!);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(FEEDBACK_LOG_MAX_BYTES);
    expect(out.lines).toBeGreaterThan(50);
    expect(out.text.endsWith('"n":599,"msg":"' + 'y'.repeat(1000) + '"}')).toBe(true);
  });

  it('answers an empty log without a logs folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'feedback-log-'));
    expect(recentFeedbackLog(dir)).toEqual({ lines: 0, text: '' });
  });
});

describe('feedback portal', () => {
  it('accepts https and loopback http origins only', () => {
    expect(portalUrlFromOrigin('https://license.anchorsprint.app')).toBe(
      'https://license.anchorsprint.app/v1/feedback',
    );
    expect(portalUrlFromOrigin('http://localhost:8787')).toBe('http://localhost:8787/v1/feedback');
    expect(portalUrlFromOrigin('http://192.168.1.5:8787')).toBeNull();
    expect(portalUrlFromOrigin('https://user:pw@license.anchorsprint.app')).toBeNull();
    expect(portalUrlFromOrigin('ftp://x')).toBeNull();
    expect(portalUrlFromOrigin('not a url')).toBeNull();
  });

  const forward = (res: Response | Error) =>
    forwardFeedback({
      url: 'https://portal.test/v1/feedback',
      report: { product: 'EZC-LITE' },
      files: [],
      fetch: (async () => {
        if (res instanceof Error) throw res;
        return res;
      }) as typeof fetch,
    });
  const failure = async (res: Response | Error) => {
    try {
      await forward(res);
    } catch (err) {
      return err as HttpError;
    }
    throw new Error('expected a failure');
  };

  it('returns the reference and maps every other answer', async () => {
    expect(await forward(Response.json({ reference: 'FB-0043' }, { status: 201 }))).toBe('FB-0043');
    expect((await failure(Response.json({ reference: '<script>' }, { status: 201 }))).code).toBe(
      'feedback_unreachable',
    );
    expect((await failure(new Response('not json', { status: 201 }))).status).toBe(502);
    expect((await failure(new Response(null, { status: 204 }))).status).toBe(502);
    const tooBig = new Response(
      `{"reference":"FB-1","pad":"${'x'.repeat(FEEDBACK_RESPONSE_MAX_BYTES)}"}`,
      {
        status: 201,
      },
    );
    expect((await failure(tooBig)).status).toBe(502);
    expect((await failure(new TypeError('fetch failed'))).code).toBe('feedback_unreachable');
    expect((await failure(Response.json({ error: 'invalid' }, { status: 400 }))).message).toContain(
      'report field',
    );
    expect((await failure(Response.json({ error: 'too_large' }, { status: 413 }))).code).toBe(
      'too_large',
    );
    expect((await failure(Response.json({ error: 'file_type' }, { status: 415 }))).code).toBe(
      'file_type',
    );
    expect(
      (await failure(Response.json({ error: 'rate_limited' }, { status: 429 }))).headers,
    ).toEqual({
      'retry-after': '3600',
    });
    expect((await failure(Response.json({ error: 'nope' }, { status: 403 }))).status).toBe(502);
    expect((await failure(new Response('down', { status: 503 }))).status).toBe(502);
  });

  it('sends the report and the files as multipart without following redirects', async () => {
    let seen: RequestInit | undefined;
    await forwardFeedback({
      url: 'https://portal.test/v1/feedback',
      report: { a: 1 },
      files: [{ name: 'a.png', type: 'image/png', bytes: Buffer.from([1, 2]) }],
      fetch: (async (_u: unknown, init?: RequestInit) => {
        seen = init;
        return Response.json({ reference: 'FB-1' }, { status: 201 });
      }) as typeof fetch,
    });
    const form = seen!.body as FormData;
    expect(seen!.redirect).toBe('error');
    expect(form.get('report')).toBe('{"a":1}');
    expect((form.get('file') as File).name).toBe('a.png');
  });
});
