// Screenshots of the proposed Business API inbox type in the running seeded mock (run.ts --fake-wa), at
// desktop 1280 px and mobile 360 px, light and dark (Enterprise view): Admin → Inboxes (Business API card,
// Phone access off and on, token rejected), Add an inbox (type choice, the Meta form with its guide, a
// rejected token, the connected number), Edit (Meta connection, Replace token), Phone access note, the chat
// list's closed-window icon, a conversation inside the window, one after it (Send a template), the template
// dialog (values and preview, no templates), a sent template; plus the Lite view (no Business API).
// With a --fresh mock on MOCK_UI_PORT, pass `--setup` to capture the setup wizard's WhatsApp step instead.
// Reports page errors and horizontal overflow; the mock blocks every outside request.
// Usage: node docs/features/business-api/mock/business-api-shots.mjs [baseUrl] [--setup]
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const SETUP = args.includes('--setup');
const BASE = args.find((a) => a.startsWith('http')) ?? 'http://localhost:7487';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium
  .launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
  .catch(() => chromium.launch({ channel: 'chrome' }));
const problems = [];
const taken = [];
const sizes = { desktop: { width: 1280, height: 860 }, mobile: { width: 360, height: 780 } };
const PRIYA = '/chats/60128814455%40s.whatsapp.net';
const JASON = '/chats/60129001234%40s.whatsapp.net';

async function session(edition, scheme, size, user = 'aisyah') {
  const ctx = await browser.newContext({ viewport: size, baseURL: BASE, colorScheme: scheme });
  await ctx.addInitScript((e) => localStorage.setItem('mock.customAgents.edition.v1', e), edition);
  await ctx.route(/^https:\/\/(?!localhost)/, (r) => r.fulfill({ status: 204, body: '' }));
  if (user) {
    const login = await ctx.request.post('/api/auth/login', {
      data: { username: user, password: 'demo-pass-123' },
      headers: { origin: BASE },
    });
    if (!login.ok()) throw new Error(`login ${user} failed ${login.status()}`);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${edition} ${scheme} pageerror: ${e.message}`));
  return { ctx, page };
}

async function shot(page, name) {
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  if (overflow) problems.push(`${name}: horizontal scroll`);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  taken.push(name);
}

/** Screenshot of an open dialog's scroll area, whole (long forms scroll inside the dialog). */
async function dialogShot(page, name) {
  await page.waitForTimeout(250);
  const dialog = page.getByRole('dialog');
  await dialog.screenshot({ path: join(OUT, `${name}.png`) });
  taken.push(name);
  const overflow = await dialog.evaluate((d) => d.scrollWidth > d.clientWidth + 1);
  if (overflow) problems.push(`${name}: dialog horizontal scroll`);
}

async function tunnel(on) {
  const ctx = await browser.newContext({ baseURL: BASE });
  await ctx.request.post('/api/auth/login', {
    data: { username: 'aisyah', password: 'demo-pass-123' },
    headers: { origin: BASE },
  });
  const r = await ctx.request.post(on ? '/api/tunnel/start' : '/api/tunnel/stop', {
    data: on ? { mode: 'quick' } : {},
    headers: { origin: BASE },
  });
  if (!r.ok()) problems.push(`tunnel ${on}: ${r.status()}`);
  await ctx.close();
}

async function fillApiForm(page, token) {
  const form = page.getByTestId('api-form');
  await form.getByLabel('Phone number ID').fill('109876543210987');
  await form.getByLabel('WhatsApp Business Account ID').fill('104455667788990');
  await form.getByLabel('Access token').fill(token);
  await form.getByLabel('App secret').fill('0123456789abcdef0123456789abcdef');
}

if (SETUP) {
  // One fresh server allows one first setup, so one page takes both widths.
  const { ctx, page } = await session('enterprise', 'light', sizes.desktop, null);
  const both = async (name) => {
    await shot(page, `${name}-desktop`);
    await page.setViewportSize(sizes.mobile);
    await shot(page, `${name}-mobile`);
    await page.setViewportSize(sizes.desktop);
  };
  await page.goto('/setup');
  await page.getByLabel('Business name').fill('Kopi Apong');
  await page.getByLabel('Your name').fill('Aisyah');
  await page.getByLabel('Password', { exact: true }).fill('demo-pass-123');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('wa-step-choice').waitFor();
  await both('setup-wa-choice');
  await page.getByText('Business API', { exact: true }).click();
  await page.getByTestId('api-form').waitFor();
  await both('setup-api-form');
  await fillApiForm(page, 'EAAGm0PX4ZCpsBAKZz9f');
  await page.getByRole('button', { name: 'Check and connect' }).click();
  await page.getByText('Business API number connected').waitFor();
  await both('setup-api-connected');
  await ctx.close();
} else {
  // 1. Phone access off.
  await tunnel(false);
  for (const scheme of ['light', 'dark']) {
    for (const [sizeName, size] of Object.entries(sizes)) {
      const suffix = `${sizeName}${scheme === 'dark' ? '-dark' : ''}`;
      const { ctx, page } = await session('enterprise', scheme, size);
      await page.goto('/admin/inboxes');
      await page.getByTestId('inbox-card').nth(2).waitFor();
      if (sizeName === 'mobile')
        await page.getByTestId('inbox-card').nth(2).scrollIntoViewIfNeeded();
      else await page.getByTestId('inbox-card').nth(1).scrollIntoViewIfNeeded();
      await shot(page, `inboxes-tunnel-off-${suffix}`);

      if (scheme === 'light') {
        await page.getByRole('button', { name: 'Add inbox' }).click();
        await shot(page, `add-type-phone-${suffix}`);
        await page.getByRole('button', { name: /WhatsApp Business API/ }).click();
        await page.getByLabel('Inbox name').fill('Delivery');
        await page.getByRole('button', { name: 'Where do I find these?' }).click();
        await dialogShot(page, `add-api-form-${suffix}`);
        await page.getByRole('button', { name: 'Check and connect' }).click();
        await dialogShot(page, `add-api-required-${suffix}`);
        await fillApiForm(page, 'EAAG-expired-token');
        await page.getByRole('button', { name: 'Check and connect' }).click();
        await page.getByText('Meta did not accept these details').waitFor();
        await dialogShot(page, `add-api-rejected-${suffix}`);
        await page.getByTestId('api-form').getByLabel('Access token').fill('EAAGm0PX4ZCpsBAKZz9f');
        await page.getByRole('button', { name: 'Check and connect' }).click();
        await page.getByTestId('api-connection').waitFor();
        await dialogShot(page, `add-api-connected-${suffix}`);
        await page.getByRole('button', { name: 'Done' }).click();
      }
      await ctx.close();
    }
  }

  // 2. Phone access on (Quick Tunnel).
  await tunnel(true);
  for (const scheme of ['light', 'dark']) {
    for (const [sizeName, size] of Object.entries(sizes)) {
      const suffix = `${sizeName}${scheme === 'dark' ? '-dark' : ''}`;
      const { ctx, page } = await session('enterprise', scheme, size);
      await page.goto('/admin/inboxes');
      const card = page.getByTestId('inbox-card').nth(2);
      await card.getByTestId('webhook-ok').waitFor();
      await card.scrollIntoViewIfNeeded();
      await shot(page, `inboxes-api-card-${suffix}`);

      await card.getByRole('button', { name: 'Edit' }).click();
      await page.getByTestId('api-connection').scrollIntoViewIfNeeded();
      await dialogShot(page, `edit-api-${suffix}`);
      if (scheme === 'light') {
        await page.getByRole('button', { name: 'Replace token' }).click();
        await page.getByTestId('api-form').scrollIntoViewIfNeeded();
        await dialogShot(page, `edit-replace-token-${suffix}`);
        await page.getByRole('button', { name: 'Simulate: token rejected' }).click();
        await page.keyboard.press('Escape');
        await card.scrollIntoViewIfNeeded();
        await shot(page, `inboxes-token-rejected-${suffix}`);

        // Owner 2026-10-25: move a linked-phone inbox to the Business API and back.
        await page.goto('/admin/inboxes');
        await page.getByTestId('inbox-card').nth(0).getByRole('button', { name: 'Edit' }).click();
        await page.getByRole('button', { name: 'Move to the Business API' }).click();
        await page.getByTestId('switch-to-api').scrollIntoViewIfNeeded();
        await dialogShot(page, `switch-to-api-${suffix}`);
        await fillApiForm(page, 'EAAGm0PX4ZCpsBAKZz9f');
        await page.getByRole('button', { name: 'Check and move' }).click();
        await page.getByTestId('api-connection').waitFor();
        await page.getByTestId('api-connection').scrollIntoViewIfNeeded();
        await dialogShot(page, `switched-to-api-${suffix}`);
        await page.getByRole('button', { name: 'Switch back to the WhatsApp app (QR)' }).click();
        await page.getByText('Switch to the WhatsApp app?').scrollIntoViewIfNeeded();
        await dialogShot(page, `switch-to-phone-${suffix}`);
        await page.getByRole('button', { name: 'Switch and show the QR code' }).click();
        await page.getByTestId('inbox-qr').scrollIntoViewIfNeeded();
        await dialogShot(page, `switched-to-phone-${suffix}`);
        await page.keyboard.press('Escape');

        await page.goto('/admin/tunnel');
        await page.getByText('Business API messages arrive through Phone access').waitFor();
        await shot(page, `phone-access-note-${suffix}`);
      }

      // Conversations: inside the window (Priya) and after it (Jason).
      await page.goto(PRIYA);
      await page.getByTestId('reply-window').waitFor();
      await shot(page, `chat-window-open-${suffix}`);
      await page.goto(JASON);
      await page.getByTestId('window-closed').waitFor();
      await shot(page, `chat-window-closed-${suffix}`);
      await page.getByRole('button', { name: 'Send a template' }).click();
      await page.getByRole('button', { name: /order_update/ }).click();
      await page.getByLabel('Variable 2').fill('#1042');
      await page.getByRole('button', { name: 'Send template' }).click();
      await page.getByText('Fill this in.').waitFor();
      await page.getByLabel('Variable 3').fill('on its way');
      if (scheme === 'light') {
        await page.getByRole('button', { name: /weekend_menu/ }).scrollIntoViewIfNeeded();
        await dialogShot(page, `template-unsupported-${suffix}`);
      }
      await page.getByTestId('template-preview').scrollIntoViewIfNeeded();
      await dialogShot(page, `template-dialog-${suffix}`);
      // Sent once: messages live on the one mock server, the window per browser.
      if (scheme === 'light' && sizeName === 'desktop') {
        await page.getByRole('button', { name: 'Send template' }).click();
        await page.getByTestId('via-template').first().waitFor();
        await shot(page, `template-sent-${suffix}`);
        await page.getByRole('button', { name: "Simulate the customer's reply" }).click();
        await page.getByTestId('reply-window').waitFor();
        await shot(page, `chat-window-reopened-${suffix}`);
      }
      if (sizeName === 'desktop' && scheme === 'light') {
        await page.evaluate(() => {
          const key = 'mock.businessApi.inboxes.v2';
          const s = JSON.parse(localStorage.getItem(key));
          s.lastInbound['60129001234@s.whatsapp.net'] = 0;
          localStorage.setItem(key, JSON.stringify(s));
        });
        await page.goto('/');
        await page.getByTestId('window-closed-icon').first().waitFor();
        await shot(page, 'chat-list-closed-icon-desktop');
        // No approved templates.
        await page.evaluate(() => {
          const key = 'mock.businessApi.inboxes.v2';
          const s = JSON.parse(localStorage.getItem(key));
          s.templates = [];
          s.lastInbound['60129001234@s.whatsapp.net'] = 0;
          localStorage.setItem(key, JSON.stringify(s));
        });
        await page.goto(JASON);
        await page.getByRole('button', { name: 'Send a template' }).click();
        await dialogShot(page, 'template-empty-desktop');
      }
      await ctx.close();
    }
  }

  // 3. Lite view: no Business API anywhere; a linked-phone chat has no window.
  for (const [sizeName, size] of Object.entries(sizes)) {
    const { ctx, page } = await session('lite', 'light', size);
    await page.goto(JASON);
    await page.waitForTimeout(800);
    if (await page.getByTestId('window-closed').count()) problems.push('lite: window panel shown');
    await shot(page, `lite-chat-${sizeName}`);
    await ctx.close();
  }
  await tunnel(false);
}

await browser.close();
// results.json: what the e2e-shots pane (and anyone) reads; a --setup run adds to the seeded run's.
const resultsFile = join(OUT, 'results.json');
const earlier =
  SETUP && existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : null;
writeFileSync(
  resultsFile,
  JSON.stringify(
    {
      ranAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      feature: 'business-api',
      passed: [...new Set([...(earlier?.passed ?? []), ...taken])].sort(),
      failed: [...(earlier?.failed ?? []), ...problems],
    },
    null,
    2,
  ) + '\n',
);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Screenshots in ${OUT}`);
