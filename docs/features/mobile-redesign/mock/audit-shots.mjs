// Before-audit of the phone experience (360 px touch) on the running seeded baseline mock
// (forward-message run.ts --fake-wa): list, number select, tag popover, New chat, a chat, the
// customer panel, a group and Admin, plus the list measurements in metrics.json.
// Usage: node docs/features/mobile-redesign/mock/audit-shots.mjs <baseUrl> <outDir> [width]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7489';
const OUT = process.argv[3] ?? 'before';
const W = Number(process.argv[4] ?? 360);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const ctx = await browser.newContext({
  viewport: { width: W, height: 780 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  baseURL: BASE,
  timezoneId: 'Asia/Kuala_Lumpur',
});
await ctx.addInitScript(() => {
  localStorage.setItem('wati.locale', 'en');
  localStorage.setItem('mock.customAgents.edition.v1', 'enterprise');
});
const login = await ctx.request.post('/api/auth/login', {
  data: { username: 'aisyah', password: 'demo-pass-123' },
  headers: { origin: BASE },
});
if (!login.ok()) throw new Error(`login failed ${login.status()}`);
const page = await ctx.newPage();
const metrics = {};
const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
};
await page.goto('/');
await page
  .getByRole('link', { name: /Priya Nair/ })
  .first()
  .waitFor();
metrics.list = await page.evaluate(() => {
  const list = document.querySelector('aside ul');
  const top = list?.getBoundingClientRect().top ?? 0;
  const rows = [...document.querySelectorAll('aside ul > li')].filter(
    (li) => li.getBoundingClientRect().bottom <= window.innerHeight,
  ).length;
  const small = [...document.querySelectorAll('button, a, [role=tab], [role=combobox]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.top < window.innerHeight && (r.height < 44 || r.width < 44);
    })
    .map(
      (el) =>
        `${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
    );
  return { chromeBeforeFirstRow: Math.round(top), rowsVisible: rows, smallTargets: small };
});
await shot('01-list');
await page.getByTestId('inbox-filter').click();
await shot('02-inbox-switch-select');
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Filter by tag' }).click();
await shot('03-tag-filter-popover');
await page.keyboard.press('Escape');
await page.getByTestId('new-chat-button').click();
await shot('04-new-chat-dialog');
await page.keyboard.press('Escape');
await page
  .getByRole('link', { name: /Priya Nair/ })
  .first()
  .click();
await page.getByRole('textbox').last().waitFor();
metrics.conversation = await page.evaluate(() => {
  const h = document.querySelector('main header');
  return { headerHeight: Math.round(h?.getBoundingClientRect().height ?? 0) };
});
await shot('05-conversation');
await page
  .getByRole('button', { name: /Customer details|Customer/ })
  .first()
  .click();
await shot('06-customer-panel');
await page.goto('/');
await page
  .getByRole('link', { name: /Kopi Lovers Club/ })
  .first()
  .click()
  .catch(() => {});
await shot('08-group-conversation');
await page.goto('/admin');
await shot('10-admin');
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics, null, 2));
await browser.close();
