// Screenshots of the proposed connector list (connector-list) in the running seeded mock
// (run.ts --fake-wa), at desktop 1280 px and mobile 360 px (touch), light and dark: the gallery from
// the list (loaded, checked, offline, bad signature, Google Calendar (MCP) shown, Lite with an
// Enterprise-only entry, a connector removed from the list), a partner (MCP) page (Overview with
// details, Settings with the entry's form, tool switches and rules, Activity, no longer listed), the
// API key flow (dialog, key refused, partner unreachable, connected, settings), the OAuth flow (the
// stand-in partner sign-in tab, waiting, cancelled, connected, settings, partner unreachable), an
// entry that needs a newer EzyChat, an Enterprise-only entry in Lite, a coming-soon entry, and the
// baseline additions (Google Calendar Bookings tab and Open Google Calendar, Admin → Reports, the
// agent page Connectors card). Reports page errors and horizontal overflow; ends with results.json.
// Usage: node docs/features/message-edit-delete/mock/connector-list-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7487';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
// This PC has no Playwright Chromium: use PW_CHROMIUM when set, else the installed Chrome.
const browser = await chromium.launch(
  process.env.PW_CHROMIUM
    ? { executablePath: process.env.PW_CHROMIUM }
    : { channel: process.env.PW_CHANNEL ?? 'chrome' },
);
const problems = [];
const passed = [];
const send = (ctx, path, data, method = 'post') =>
  ctx.request[method](path, { data, headers: { origin: BASE } });

const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const ctx = await browser.newContext({
      ...size,
      baseURL: BASE,
      colorScheme: scheme,
      timezoneId: 'Asia/Kuala_Lumpur',
    });
    const login = await send(ctx, '/api/auth/login', {
      username: 'aisyah',
      password: 'demo-pass-123',
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    const scenario = (body) => send(ctx, '/api/mock/connector-list/scenario', body, 'put');
    // Every context starts from the seeded state: list loaded, Lejar connected, Kedai not.
    await scenario({ reset: true });
    await send(ctx, '/api/mock/google-calendar/connect', { account: 'kopiapong.penang@gmail.com' });
    await send(ctx, '/api/mock/google-calendar/state', { state: 'connected' }, 'put');
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name, opts = {}, target = page) => {
      await target.waitForTimeout(400);
      const overflow = await target.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await target.screenshot({ path: join(OUT, `${name}-${suffix}.png`), ...opts });
      passed.push(`${name}-${suffix}`);
    };
    const step = async (name, run) => {
      try {
        await run();
      } catch (error) {
        problems.push(`${suffix} ${name}: ${error.message.split('\n')[0]}`);
      }
    };
    const open = async (path, testId) => {
      await page.goto(path);
      await page.getByTestId(testId).first().waitFor();
      await page.waitForTimeout(300);
    };
    const gallery = () => open('/admin/connectors?edition=enterprise', 'connectors-gallery');
    const partner = (id, tab = 'overview') =>
      open(`/admin/connectors/${id}?tab=${tab}`, `connector-page-${id}`);

    // 1. Gallery from the list: loaded, Check for new connectors, offline, bad signature.
    await step('gallery', async () => {
      await gallery();
      await shot('01-gallery', { fullPage: true });
      await page.getByTestId('check-connector-list').click();
      await page.getByText('You have the newest connector list.').waitFor();
      await shot('02-gallery-checked');
      await scenario({ listState: 'offline' });
      await gallery();
      await shot('03-gallery-offline');
      await scenario({ listState: 'rejected' });
      await gallery();
      await shot('04-gallery-rejected');
      await scenario({ listState: 'loaded', showGoogleMcp: true });
      await gallery();
      await page.getByRole('button', { name: 'Calendar & booking' }).click();
      await shot('05-gallery-google-mcp');
      await page.goto('/admin/connectors?edition=lite');
      await page.getByTestId('connector-card-gudang-stock').waitFor();
      await shot('06-gallery-lite', { fullPage: true });
      await page.goto('/admin/connectors?edition=enterprise');
      await scenario({ lejarListed: false });
      await gallery();
      await shot('07-gallery-delisted');
      await page.getByTestId('mock-list-controls').scrollIntoViewIfNeeded();
      await shot('07b-gallery-mock-controls');
      await scenario({ lejarListed: true });
    });

    // 2. Partner (MCP) page, connected: Overview, details, Settings, Activity; then no longer listed.
    await step('lejar', async () => {
      await partner('lejar-accounting');
      await shot('08-lejar-overview', { fullPage: true });
      await page.getByRole('button', { name: 'Show details for your developer' }).click();
      await shot('09-lejar-details', { fullPage: true });
      await partner('lejar-accounting', 'settings');
      await page.getByTestId('guard-rules').waitFor();
      await shot('10-lejar-settings', { fullPage: true });
      await partner('lejar-accounting', 'activity');
      await page.getByTestId('partner-activity').waitFor();
      await shot('11-lejar-activity', { fullPage: true });
      await scenario({ lejarListed: false });
      await partner('lejar-accounting');
      await page.getByTestId('delisted-note').waitFor();
      await shot('12-lejar-delisted');
      await scenario({ lejarListed: true });
    });

    // 3. API key flow (Kedai CRM): privacy before Connect, dialog, refused, unreachable, connected.
    await step('kedai', async () => {
      await partner('kedai-crm');
      await shot('13-kedai-not-connected', { fullPage: true });
      await page.getByTestId('partner-connect').click();
      await page.getByTestId('api-key-dialog').waitFor();
      await shot('14-kedai-key-dialog');
      await page.getByTestId('api-key-input').fill('kedai-wrong-key');
      await page.getByTestId('key-test').click();
      await page.getByText('refused this key').waitFor();
      await shot('15-kedai-key-refused');
      await scenario({ partnerReachable: false });
      await page.getByTestId('api-key-input').fill('kd_demo12345');
      await page.getByTestId('key-test').click();
      await page.getByText('could not check the key').waitFor();
      await shot('16-kedai-key-unreachable');
      await scenario({ partnerReachable: true });
      await page.getByTestId('key-save').click();
      await page.getByText('Key ending in 2345').waitFor();
      await shot('17-kedai-connected', { fullPage: true });
      await partner('kedai-crm', 'settings');
      await page.getByTestId('entry-settings').waitFor();
      await shot('18-kedai-settings', { fullPage: true });
    });

    // 4. OAuth flow (Google Calendar (MCP)): stand-in sign-in tab, waiting, cancelled, connected.
    await step('oauth', async () => {
      await scenario({ showGoogleMcp: true });
      await partner('google-calendar-mcp');
      await shot('19-gcmcp-not-connected', { fullPage: true });
      let signIn = ctx.waitForEvent('page');
      await page.getByTestId('partner-connect').click();
      let tab = await signIn;
      await tab.waitForLoadState();
      await shot('20-partner-sign-in-tab', {}, tab);
      await page.bringToFront();
      await page.getByTestId('partner-waiting').waitFor();
      await shot('21-gcmcp-waiting');
      await tab.getByRole('link', { name: 'Cancel' }).click();
      await tab.close();
      await page.getByText('Sign-in cancelled').waitFor();
      await shot('22-gcmcp-cancelled');
      signIn = ctx.waitForEvent('page');
      await page.getByTestId('partner-connect').click();
      tab = await signIn;
      await tab.getByRole('link', { name: 'Allow' }).click();
      await tab.getByText('is connected').waitFor();
      await shot('23-partner-sign-in-done', {}, tab);
      await tab.close();
      await page.getByText('kopiapong.penang@gmail.com').first().waitFor();
      await shot('24-gcmcp-connected', { fullPage: true });
      await partner('google-calendar-mcp', 'settings');
      await page.getByTestId('entry-settings').waitFor();
      await shot('25-gcmcp-settings', { fullPage: true });
      await send(ctx, '/api/mock/connector-list/connectors/google-calendar-mcp/disconnect', {});
      await scenario({ partnerReachable: false });
      await partner('google-calendar-mcp');
      await page.getByTestId('partner-connect').click();
      await page.getByText('Could not reach').first().waitFor();
      await shot('26-gcmcp-unreachable');
      await scenario({ partnerReachable: true, showGoogleMcp: false });
    });

    // 5. Other entries: needs a newer EzyChat, Enterprise only in Lite, coming soon.
    await step('entries', async () => {
      await partner('bayar-invoices');
      await page.getByTestId('needs-update').waitFor();
      await shot('27-needs-update', { fullPage: true });
      await page.goto('/admin/connectors/gudang-stock?edition=lite');
      await page.getByTestId('connector-page-gudang-stock').waitFor();
      await shot('28-enterprise-only-lite', { fullPage: true });
      await page.goto('/admin/connectors?edition=enterprise');
      await partner('bukku');
      await shot('29-coming-soon', { fullPage: true });
    });

    // 6. Baseline additions: Google Calendar Bookings and Open Google Calendar, Reports, agent card.
    await step('baseline', async () => {
      await open('/admin/connectors/google-calendar?tab=bookings', 'calendar-bookings');
      await shot('30-gc-bookings', { fullPage: true });
      await open('/admin/connectors/google-calendar', 'google-calendar-settings');
      await page.getByTestId('google-calendar-settings').scrollIntoViewIfNeeded();
      await shot('31-gc-open-calendar');
      await open('/admin/reports', 'reports-page');
      await shot('32-reports', { fullPage: true });
      await open('/admin/members/ai/a1', 'agent-connectors');
      await page
        .getByTestId('agent-connectors')
        .screenshot({ path: join(OUT, `33-agent-connectors-${suffix}.png`) });
      passed.push(`33-agent-connectors-${suffix}`);
    });
    await scenario({ reset: true });
    await ctx.close();
  }
await browser.close();
writeFileSync(
  join(OUT, 'results.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), passed, failed: problems }, null, 2) + '\n',
);
console.log(
  `${passed.length} shots. ` +
    (problems.length ? problems.join('\n') : 'No page errors or horizontal overflow.'),
);
