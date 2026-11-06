// Screen review of New chat (docs/features/new-chat/design.md, confirmed mock docs/features/new-chat/mock) in a
// running Dev Build started fresh with
//   npx tsx packages/server/src/cli.ts --data <temp> --port 7492 --fake-wa --mode dev --max-inboxes 3 --web-dist apps/web/dist
// Desktop 1280 px and mobile 360 px (touch), light and dark: the header button, the dialog (empty, invalid,
// number typed with the ban warning, existing chat, daily limit reached), the chat it opens, the Business API
// template step with the preview and the chat after it, Settings → General → New chats (off, on with the limit,
// 0 = no limit, invalid), the audit rows and a team member's view. Reports page errors and horizontal overflow.
// Usage: node e2e/new-chat-screens.mjs <port> <outDir>   (PW_CHROMIUM=<chromium> if Playwright's own is missing)
/* global document -- used inside page.evaluate (runs in the browser) */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { cookieSession } from './devbuild-client.mjs';

const PORT = Number(process.argv[2] ?? 7492);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535)
  throw new Error('The port must be an integer between 1024 and 65535.');
const inside = (base, path) => {
  const rel = relative(base, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const repo = resolve(import.meta.dirname, '..');
const OUT = resolve(repo, process.argv[3] ?? 'new-chat-screens');
if (!inside(repo, OUT) && !inside(resolve(tmpdir()), OUT))
  throw new Error('The output folder must be inside the repository or the temp folder.');
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });

// Seed: an admin, a team member of inbox 1, a few chats, a Business API inbox.
const api = cookieSession(BASE);
const admin = { username: 'aisyah', displayName: 'Aisyah', password: 'demo-pass-123' };
if ((await api('GET', '/setup/status')).json.needsSetup) await api('POST', '/setup/admin', admin);
await api('POST', '/auth/login', { username: admin.username, password: admin.password });
for (const [jid, name, text] of [
  ['60125550142@s.whatsapp.net', 'Siti Rahman', 'Ada hantar ke Bayan Lepas tak?'],
  ['60127020388@s.whatsapp.net', 'Lim Mei Ying', 'Booked! A table for 6 at 8pm please.'],
  ['60123110021@s.whatsapp.net', 'Farah Aziz', 'Yes, we can do the catering on Saturday.'],
])
  await api('POST', '/dev/fake-incoming', { chatJid: jid, senderName: name, text });
let inboxes = (await api('GET', '/inboxes')).json.inboxes;
if (!inboxes.some((i) => i.type === 'fake-api'))
  await api('POST', '/dev/fake-api-inbox', { name: 'Online orders' });
inboxes = (await api('GET', '/inboxes')).json.inboxes;
await api('PATCH', '/inboxes/1', { name: 'Kopi Apong' });
let users = (await api('GET', '/users')).json.users;
if (!users.some((u) => u.username === 'daniel')) {
  await api('POST', '/users', {
    username: 'daniel',
    displayName: 'Daniel',
    role: 'agent',
    password: 'daniel-pass-123',
  });
  users = (await api('GET', '/users')).json.users;
}
// A second admin for the dark runs: each person may start 5 new chats an hour.
if (!users.some((u) => u.username === 'nadia'))
  await api('POST', '/users', {
    username: 'nadia',
    displayName: 'Nadia',
    role: 'admin',
    password: 'nadia-pass-123',
  });
const asNadia = cookieSession(BASE);
await asNadia('POST', '/auth/login', { username: 'nadia', password: 'nadia-pass-123' });
await asNadia('POST', '/auth/change-password', {
  currentPassword: 'nadia-pass-123',
  newPassword: 'nadia-pass-456', // NOSONAR: throwaway password of a temp Dev Build user
});
const daniel = users.find((u) => u.username === 'daniel');
await api('PUT', `/users/${daniel.id}/inboxes`, { inboxIds: inboxes.map((i) => i.id) });
const asDaniel = cookieSession(BASE);
await asDaniel('POST', '/auth/login', { username: 'daniel', password: 'daniel-pass-123' });
await asDaniel('POST', '/auth/change-password', {
  currentPassword: 'daniel-pass-123',
  newPassword: 'daniel-pass-456', // NOSONAR: throwaway password of a temp Dev Build user
});

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const problems = [];
const passed = [];
const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};
let run = 0;

async function session(username, password, size, scheme) {
  const ctx = await browser.newContext({ ...sizes[size], baseURL: BASE, colorScheme: scheme });
  const login = await ctx.request.post('/api/auth/login', {
    data: { username, password },
    headers: { origin: BASE },
  });
  if (!login.ok()) throw new Error(`login ${username} ${login.status()}`);
  const page = await ctx.newPage();
  const suffix = scheme === 'dark' ? `${size}-dark` : size;
  page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
  const shot = async (name, full = false) => {
    await page.waitForTimeout(450);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
    await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`), fullPage: full });
    passed.push(`${name}-${suffix}`);
  };
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${suffix} ${name}: ${e.message.split('\n')[0]}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  };
  return { ctx, page, shot, step };
}

const dialog = (page) => page.getByTestId('new-chat-dialog');
const openDialog = async (page) => {
  await page.goto('/');
  await page.getByTestId('new-chat-button').click();
  await dialog(page).waitFor();
};

for (const scheme of ['light', 'dark'])
  for (const size of Object.keys(sizes)) {
    run += 1;
    const number = (n) => `012-77${run}${n} 4321`;
    await api('PUT', '/new-chat/settings', { staffEnabled: false, dailyLimit: 20 });
    const [who, pass] = run <= 2 ? ['aisyah', 'demo-pass-123'] : ['nadia', 'nadia-pass-456'];
    const { ctx, page, shot, step } = await session(who, pass, size, scheme);
    await step('header', async () => {
      await page.goto('/');
      await page.getByTestId('new-chat-button').waitFor();
      await shot('01-header');
    });
    await step('dialog', async () => {
      await openDialog(page);
      await shot('02-dialog-empty');
      await page.getByLabel('Phone number').fill('12345');
      await page.getByRole('button', { name: 'Start chat' }).click();
      await shot('03-invalid');
      await page.getByLabel('Phone number').fill(number(1));
      await page.getByLabel('Name (optional)').fill('Farah Ismail');
      await shot('04-typed-warning');
      await page.getByRole('button', { name: 'Start chat' }).click();
      await page
        .getByRole('textbox', { name: /message/i })
        .first()
        .waitFor();
      await shot('05-chat-opened');
    });
    await step('existing', async () => {
      await openDialog(page);
      await page.getByLabel('Phone number').fill('012-555 0142');
      await page.getByRole('button', { name: 'Start chat' }).click();
      await page.getByRole('button', { name: 'Open chat' }).waitFor();
      await shot('06-existing');
    });
    await step('limit', async () => {
      await api('PUT', '/new-chat/settings', { dailyLimit: 1 });
      await openDialog(page);
      await page.getByText('Daily limit reached').waitFor();
      await shot('07-daily-limit');
      await api('PUT', '/new-chat/settings', { dailyLimit: 20 });
    });
    await step('template', async () => {
      await openDialog(page);
      await page.getByLabel('Send from').click();
      await page.getByRole('option', { name: /Online orders/ }).click();
      await page.getByLabel('Phone number').fill(number(2));
      await page.getByLabel('Name (optional)').fill('Ravi Kumar');
      await shot('08-api-number');
      await page.getByRole('button', { name: 'Choose a template' }).click();
      await page.getByTestId('new-chat-templates').waitFor();
      await page.getByRole('button', { name: /order_update/ }).click();
      await page.getByLabel('Variable 2').fill('#1042');
      await page.getByTestId('template-preview').scrollIntoViewIfNeeded();
      await shot('09-api-template-preview');
      await page.getByRole('button', { name: 'Send template' }).click();
      await page.getByTestId('window-closed').waitFor();
      await shot('10-api-chat-after-template');
    });
    await step('settings', async () => {
      await page.goto('/admin/settings/general');
      const card = page.getByTestId('new-chat-settings');
      await card.waitFor();
      await card.scrollIntoViewIfNeeded();
      await shot('11-settings-off');
      await card.getByRole('switch').click();
      await card.getByLabel('New chats per day, per WhatsApp number').fill('0');
      await card.scrollIntoViewIfNeeded();
      await shot('12-settings-on-no-limit');
      await card.getByLabel('New chats per day, per WhatsApp number').fill('');
      await shot('13-settings-limit-invalid');
      await card.getByLabel('New chats per day, per WhatsApp number').fill('10');
      await card.getByRole('button', { name: 'Save settings' }).click();
      await page.waitForTimeout(500);
    });
    await step('audit', async () => {
      await page.goto('/admin/audit');
      await page
        .getByText('Chat started with a new number')
        .filter({ visible: true })
        .first()
        .waitFor();
      await shot('14-audit');
    });
    await ctx.close();

    const d = await session('daniel', 'daniel-pass-456', size, scheme);
    await d.step('staff', async () => {
      await d.page.goto('/');
      await d.page.getByTestId('new-chat-button').waitFor();
      await d.shot('15-staff-on');
    });
    await d.ctx.close();
    await api('PUT', '/new-chat/settings', { staffEnabled: false });
    const d2 = await session('daniel', 'daniel-pass-456', size, scheme);
    await d2.step('staff-off', async () => {
      await d2.page.goto('/');
      await d2.page.getByRole('heading', { name: 'Inbox' }).waitFor();
      await d2.page.waitForTimeout(800);
      if (await d2.page.getByTestId('new-chat-button').count())
        throw new Error('New chat shown to a team member with the switch off');
      await d2.shot('16-staff-off');
    });
    await d2.ctx.close();
  }

await browser.close();
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ passed, problems }, null, 2) + '\n');
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
