// Send feedback screenshots (docs/screenshots/feedback): the account menu entry, the empty form, a filled
// problem with a file, app details and the redacted log shown, and the sent state; desktop 1280×800 and
// mobile 360×780 at 2×, light and dark. Also fails on page errors and horizontal overflow.
//
// Run on a fresh Dev Build with the feedback portal pointed at the fake portal this script starts:
//   EZYCHAT_FEEDBACK_URL=http://127.0.0.1:7477/v1/feedback \
//     npx tsx --conditions=ezychat-source packages/server/src/cli.ts --data <tmp> --mode dev --fake-wa \
//     --port 7466 --web-dist apps/web/dist
//   node e2e/feedback-screens.mjs http://127.0.0.1:7466 docs/screenshots/feedback
// Nothing reaches the real licence portal: the fake portal answers every report with FB-0042.
/* global document -- used inside page.evaluate (runs in the browser) */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:7466';
// Screenshots go only inside this repository (never an arbitrary path from the command line).
const REPO = resolve(import.meta.dirname, '..');
const OUT = resolve(REPO, process.argv[3] ?? 'docs/screenshots/feedback');
const inside = relative(REPO, OUT);
if (!inside || inside.startsWith('..') || resolve(inside) === inside)
  throw new Error(`Output folder must be inside the repository: ${OUT}`);
const PORTAL_PORT = 7477;
mkdirSync(OUT, { recursive: true });

const portal = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ reference: 'FB-0042' }));
  });
});
await new Promise((done) => portal.listen(PORTAL_PORT, '127.0.0.1', done));

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082',
  'hex',
);
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const problems = [];
const sizes = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 },
  mobile: {
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

const setup = await (await browser.newContext({ baseURL: BASE })).request;
await setup.post('/api/setup/admin', {
  data: { username: 'aisyah', displayName: 'Aisyah', password: 'demo-pass-12345' },
  headers: { origin: BASE },
});

for (const scheme of ['light', 'dark'])
  for (const [size, options] of Object.entries(sizes)) {
    const suffix = `${size}${scheme === 'dark' ? '-dark' : ''}`;
    const ctx = await browser.newContext({ ...options, baseURL: BASE, colorScheme: scheme });
    const login = await ctx.request.post('/api/auth/login', {
      data: { username: 'aisyah', password: 'demo-pass-12345' },
      headers: { origin: BASE },
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => problems.push(`${suffix}: ${e.message}`));
    const shot = async (name) => {
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`) });
    };
    await page.goto('/');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Send feedback' }).waitFor();
    await shot('menu');
    await page.getByRole('menuitem', { name: 'Send feedback' }).click();
    const d = page.getByRole('dialog');
    await d.waitFor();
    await shot('empty');
    await d.getByLabel('Short title', { exact: true }).fill('Photos from customers do not open');
    await d
      .getByLabel('Details', { exact: true })
      .fill(
        'When a customer sends a photo, the chat shows a grey box. It started after the update. Expected: the photo opens like before.',
      );
    await d.getByText('Every time', { exact: true }).click();
    await d.getByText('Stops my work', { exact: true }).click();
    await d
      .locator('input[type=file]')
      .setInputFiles({ name: 'grey-box.png', mimeType: 'image/png', buffer: PNG });
    await d.getByLabel('Email', { exact: true }).fill('aisyah@kopiapong.my');
    await shot('filled');
    await d.getByRole('button', { name: 'See what is sent' }).click();
    await d.getByText('Attach recent activity log').click();
    await d.getByText('Attach recent activity log').scrollIntoViewIfNeeded();
    await shot('details');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('FB-0042').waitFor();
    await shot('sent');
    await ctx.close();
  }

await browser.close();
portal.close();
console.log(problems.length ? problems.join('\n') : 'feedback screens: no page errors or overflow');
process.exit(problems.length ? 1 : 0);
