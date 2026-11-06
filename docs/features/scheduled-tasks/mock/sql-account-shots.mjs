// Screenshots of the proposed SQL Account connector (sql-accounting) in the running seeded mock
// (run.ts --fake-wa), at desktop 1280 px and mobile 360 px (touch), light and dark: gallery card,
// Overview with the API service (API Link) requirements, Connect form (empty, wrong key format), every
// "can't connect" state (desktop light), Connected, Settings with the per-object access table (Off /
// Read / Read + create) and the quotation guards, chat → customer matching (Customers tab, Link dialog),
// Activity, and the Mock only "Try a customer question" (own balance, unmatched chat → hand over,
// someone else's order, object Off). Resets the connector at the start of each pass.
// Reports page errors and horizontal overflow; ends with screenshots/results.json.
// Usage: node docs/features/sql-accounting/mock/sql-account-shots.mjs [baseUrl]
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
const KEY = '13fcdacdc0429dc2f8fa47dddf97c393.sql.my/APIUSER';
const PAGE = '/admin/connectors/sql-account';
const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const full = sizeName === 'desktop' && scheme === 'light';
    const ctx = await browser.newContext({
      ...size,
      baseURL: BASE,
      colorScheme: scheme,
      timezoneId: 'Asia/Kuala_Lumpur',
    });
    const headers = { origin: BASE };
    const login = await ctx.request.post('/api/auth/login', {
      data: { username: 'aisyah', password: 'demo-pass-123' },
      headers,
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    const api = (method, path, data) =>
      ctx.request.fetch(`/api/mock/sql-account${path}`, { method, data, headers });
    await api('POST', '/disconnect');
    await api('PUT', '/scenario', { scenario: 'ok' });
    await api('PUT', '/agents/a1', {
      access: {},
      showPrice: true,
      stockDetail: 'inStock',
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name, fullPage = true) => {
      await page.waitForTimeout(450);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`), fullPage });
      passed.push(`${name}-${suffix}`);
    };
    const tab = async (name) => {
      await page.getByRole('tab', { name }).click();
      await page.waitForTimeout(300);
    };

    await page.goto('/admin/connectors');
    await page.getByText('SQL Account').first().waitFor();
    await shot('sql-01-gallery');

    await page.goto(PAGE);
    await page.getByTestId('connector-page-sql-account').waitFor();
    await shot('sql-02-overview');

    await tab('Connection');
    await page.getByTestId('sql-connect-form').waitFor();
    await shot('sql-03-connect-empty');
    await page.getByLabel('Access key').fill('my-key-123');
    await page.getByLabel('Secret key').fill('not-a-real-secret');
    await page.getByRole('button', { name: 'Test and connect' }).click();
    await page.getByText('This is not a SQL Account access key').waitFor();
    await shot('sql-04-key-format');

    const problemStates = full
      ? ['no_dns', 'unreachable', 'private_ip', 'bad_keys', 'old_version']
      : ['unreachable'];
    await page.getByLabel('Access key').fill(KEY);
    for (const s of problemStates) {
      await api('PUT', '/scenario', { scenario: s });
      await page.getByRole('button', { name: 'Test and connect' }).click();
      await page.waitForTimeout(500);
      await shot(`sql-05-fail-${s}`);
    }
    await api('PUT', '/scenario', { scenario: 'ok' });
    await page.getByRole('button', { name: 'Test and connect' }).click();
    await page.getByTestId('sql-connection').waitFor();
    await shot('sql-06-connected');

    await tab('Settings');
    await page.getByTestId('sql-agent-access').waitFor();
    await shot('sql-07-access-defaults');
    await page
      .getByTestId('sql-object-salesquotation')
      .getByText('Read + create', { exact: true })
      .click();
    await page.getByTestId('sql-object-customerpayment').getByText('Read', { exact: true }).click();
    await page.getByText('Before the AI creates a quotation').waitFor();
    await shot('sql-08-access-quotation-on');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(400);

    await tab('Customers');
    await page.getByTestId('sql-customers').waitFor();
    await shot('sql-09-customers');
    if (full || sizeName === 'mobile') {
      const ahmad = page.getByTestId('sql-customers').locator('li', { hasText: 'Ahmad' });
      await ahmad.getByRole('button', { name: 'Link' }).click();
      await page.getByText('Link Ahmad').first().waitFor();
      await shot('sql-10-link-dialog', false);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await tab('Activity');
    await shot('sql-11-activity');

    if (full || sizeName === 'mobile') {
      const box = page.getByTestId('sql-mock-controls');
      const trySet = async (chat, question, name) => {
        await box.getByLabel('Chat').click();
        await page.getByRole('option', { name: new RegExp(`^${chat}`) }).click();
        await box.getByLabel('Customer asks').click();
        await page.getByRole('option', { name: question }).click();
        await box.getByRole('button', { name: 'Run' }).click();
        await page.getByTestId('sql-try-result').waitFor();
        await page.waitForTimeout(300);
        await page.getByTestId('sql-try-result').scrollIntoViewIfNeeded();
        await shot(name, false);
      };
      await trySet('Farah', 'How much do I still owe?', 'sql-12-try-own-balance');
      await trySet('Ahmad', 'How much do I still owe?', 'sql-13-try-no-match-handover');
      if (full) {
        await trySet('Priya', 'Where is order SO-00399', 'sql-14-try-not-own');
        await trySet('Farah', 'Confirm.', 'sql-15-try-quotation-created');
        await trySet('Jason', 'Where is my order SO-00412?', 'sql-16-try-several');
      }
    }
    await ctx.close();
  }

await browser.close();
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ passed, problems }, null, 2));
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
