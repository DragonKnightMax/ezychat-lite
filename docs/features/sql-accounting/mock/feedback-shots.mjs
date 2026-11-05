// Screenshots of the proposed Send feedback dialog (in-app-feedback) in the running seeded mock
// (run.ts --fake-wa), desktop 1280 px and mobile 360 px (touch), light and dark: the account menu entry,
// the empty form, the marked mistakes, a filled problem with files, app details and the log, an idea,
// the sent state (with what the portal recorded), the portal unreachable and too-many-reports errors,
// and the Enterprise form (company from the licence, no GitHub link).
// Sends go through the mock `POST /api/feedback`; nothing leaves the computer.
// Reports page errors and horizontal overflow; ends with feedback-results.json.
// Usage: node docs/features/in-app-feedback/mock/feedback-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7489';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const problems = [];
const passed = [];
const sizes = {
  desktop: { viewport: { width: 1280, height: 900 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};
const files = [
  { name: 'photo-not-opening.png', mimeType: 'image/png', buffer: Buffer.alloc(180_000, 1) },
  { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(420_000, 2) },
];

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const ctx = await browser.newContext({
      ...size,
      baseURL: BASE,
      colorScheme: scheme,
      timezoneId: 'Asia/Kuala_Lumpur',
    });
    const login = await ctx.request.post('/api/auth/login', {
      data: { username: 'aisyah', password: 'demo-pass-123' },
      headers: { origin: BASE },
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    await ctx.request.delete('/api/mock/feedback', { headers: { origin: BASE } });
    const scenario = async (s) => {
      const r = await ctx.request.put('/api/mock/feedback/scenario', {
        data: { scenario: s },
        headers: { origin: BASE },
      });
      if (!r.ok()) problems.push(`${suffix} scenario ${s}: ${r.status()} ${await r.text()}`);
    };
    await scenario('ok');
    const page = await ctx.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const dialog = () => page.getByRole('dialog');
    const shot = async (name, { bottom = false } = {}) => {
      await page.waitForTimeout(400);
      if (bottom)
        await dialog().evaluate((d) => {
          for (const el of [d, ...d.querySelectorAll('*')])
            if (
              el.scrollHeight > el.clientHeight + 4 &&
              getComputedStyle(el).overflowY !== 'visible'
            )
              el.scrollTop = el.scrollHeight;
        });
      await page.waitForTimeout(200);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`) });
      passed.push(`${name}-${suffix}`);
    };
    const step = async (name, run) => {
      try {
        await run();
      } catch (e) {
        problems.push(`${suffix} ${name}: ${e.message.split('\n')[0]}`);
        await page.screenshot({ path: join(OUT, `FAIL-${name}-${suffix}.png`) }).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
      }
    };
    const openFromMenu = async () => {
      await page.getByRole('button', { name: 'Account menu' }).click();
      await page.getByTestId('menu-feedback').click();
      await dialog().waitFor();
    };

    await page.goto('/?edition=lite');
    await page.getByRole('button', { name: 'Account menu' }).waitFor();

    await step('01-menu', async () => {
      await page.getByRole('button', { name: 'Account menu' }).click();
      await page.getByTestId('menu-feedback').waitFor();
      await shot('01-menu');
      await page.keyboard.press('Escape');
    });
    await step('02-empty', async () => {
      await openFromMenu();
      await shot('02-empty');
    });
    await step('03-errors', async () => {
      await page.getByTestId('feedback-send').click();
      await shot('03-errors', { bottom: true });
    });
    await step('04-problem-filled', async () => {
      const d = dialog();
      await d.getByLabel('Short title', { exact: true }).fill('Photos from customers do not open');
      await d
        .getByLabel('Details', { exact: true })
        .fill(
          'When a customer sends a photo, the chat shows a grey box. Clicking it says "Download failed". It started yesterday after the update. Expected: the photo opens like before.',
        );
      await d.getByText('Every time', { exact: true }).click();
      await d.getByText('Stops my work', { exact: true }).click();
      await d.locator('input[type=file]').setInputFiles(files);
      await d.getByLabel('Email', { exact: true }).fill('aisyah@kopiapong.my');
      await d.getByRole('button', { name: 'See what is sent' }).click();
      await d.getByTestId('feedback-include-log').click();
      await d.getByRole('button', { name: 'See the log' }).click();
      await shot('04-problem-filled');
      await shot('05-problem-details', { bottom: true });
    });
    await step('06-unreachable', async () => {
      await scenario('offline');
      await page.getByTestId('feedback-send').click();
      await page.getByText('Not sent').waitFor();
      await shot('06-unreachable', { bottom: true });
    });
    await step('07-rate-limited', async () => {
      await scenario('rate_limited');
      await page.getByTestId('feedback-send').click();
      await page.getByText('30 minutes').waitFor();
      await shot('07-rate-limited', { bottom: true });
    });
    await step('08-sent', async () => {
      await scenario('ok');
      await page.getByTestId('feedback-send').click();
      await page.getByTestId('feedback-sent').waitFor();
      await page.getByTestId('feedback-mock-received').waitFor();
      await shot('08-sent');
    });
    await step('09-idea', async () => {
      await page.getByRole('button', { name: 'Send another' }).click();
      const d = dialog();
      await d.getByText('Idea', { exact: true }).click();
      await d.getByLabel('Short title', { exact: true }).fill('Let us schedule a message');
      await shot('09-idea');
      await page.keyboard.press('Escape');
    });
    await step('10-enterprise', async () => {
      await page.goto('/?edition=enterprise');
      await page.getByRole('button', { name: 'Account menu' }).waitFor();
      await openFromMenu();
      await page.waitForTimeout(500);
      await shot('10-enterprise', { bottom: true });
      await page.keyboard.press('Escape');
      await page.goto('/?edition=lite');
    });
    if (sizeName === 'desktop')
      await step('11-admin-help', async () => {
        await page.goto('/admin/reports');
        await page.getByRole('button', { name: 'Help & feedback' }).click();
        await page.getByTestId('sidebar-feedback').waitFor();
        await shot('11-admin-help');
        await page.getByTestId('sidebar-feedback').click();
        await dialog().waitFor();
        await shot('12-admin-area');
      });
    await ctx.close();
  }

await browser.close();
writeFileSync(
  join(OUT, 'feedback-results.json'),
  JSON.stringify({ passed: passed.length, problems }, null, 2) + '\n',
);
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
process.exit(problems.length ? 1 : 0);
