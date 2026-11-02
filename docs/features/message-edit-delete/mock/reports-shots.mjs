// Screenshots of the proposed Admin → Reports page in the running seeded mock (run.ts --fake-wa), at
// desktop 1280 px and mobile 360 px (touch), light and dark: 30 / 90 / 7 days, a day under the
// pointer, the busy times readout, Show as table, the admin menu with Reports, 5 days of data, no
// messages yet, loading and error. Reports page errors and horizontal overflow.
// Usage: node docs/features/message-edit-delete/mock/reports-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7487';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium
  .launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
  .catch(() => chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' }));
const problems = [];
const post = (ctx, path, data, method = 'post') =>
  ctx.request[method](path, { data, headers: { origin: BASE } });
const setScenario = (ctx, scenario) => post(ctx, '/api/mock/reports/scenario', { scenario }, 'put');

const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const ctx = await browser.newContext({ ...size, baseURL: BASE, colorScheme: scheme });
    const login = await post(ctx, '/api/auth/login', {
      username: 'aisyah',
      password: 'demo-pass-123',
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    await setScenario(ctx, 'normal');
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name, fullPage = true) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`), fullPage });
    };
    const period = (days) => page.getByText(`${days} days`, { exact: true }).click();
    const ready = () => page.getByTestId('report-totals').waitFor();

    await page.goto('/admin/reports');
    await ready();
    await page.waitForTimeout(300);
    await shot('01-30-days');

    await period(90);
    await page.waitForTimeout(400);
    await shot('02-90-days');

    await period(7);
    await page.waitForTimeout(400);
    await shot('03-7-days');

    await period(30);
    await page.waitForTimeout(300);
    const bars = page.getByTestId('daily-bar');
    await page.getByTestId('card-daily').scrollIntoViewIfNeeded();
    const bar = bars.nth(Math.floor((await bars.count()) * 0.6));
    if (sizeName === 'mobile') await bar.tap();
    else await bar.hover();
    await page
      .getByTestId('card-daily')
      .screenshot({ path: join(OUT, `04-day-readout-${suffix}.png`) });

    const cells = page.getByTestId('hours-heatmap').locator('div.cursor-pointer');
    const cell = cells.nth(4 * 24 + 11); // Friday 11am
    if (sizeName === 'mobile') await cell.tap();
    else await cell.hover();
    await page
      .getByTestId('card-hours')
      .screenshot({ path: join(OUT, `05-hour-readout-${suffix}.png`) });

    await page.getByTestId('card-weekdays').getByRole('button', { name: 'Show as table' }).click();
    await page
      .getByTestId('card-weekdays')
      .screenshot({ path: join(OUT, `06-table-${suffix}.png`) });

    if (sizeName === 'mobile') {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole('button', { name: 'Admin menu' }).click();
      await page.waitForTimeout(400);
      await shot('07-menu', false);
      await page.keyboard.press('Escape');
    }

    await setScenario(ctx, 'short');
    await page.reload();
    await ready();
    await page.waitForTimeout(300);
    await shot('08-five-days');

    await setScenario(ctx, 'empty');
    await page.reload();
    await page.getByTestId('reports-empty').waitFor();
    await shot('09-empty');

    await setScenario(ctx, 'slow');
    await page.reload();
    await page.getByTestId('reports-loading').waitFor();
    await shot('10-loading', false);

    await setScenario(ctx, 'error');
    await page.reload();
    await page.getByRole('button', { name: 'Retry' }).waitFor({ timeout: 8_000 });
    await shot('11-error', false);

    await setScenario(ctx, 'normal');
    await ctx.close();
  }

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Saved report screenshots to ${OUT}`);
