// Screenshots of the proposed New chat (new-chat) in the running seeded mock (run.ts --fake-wa),
// desktop 1280 px and mobile 360 px (touch), light (dark for the main screens), en + ms + zh-CN:
// the header button for an admin and for a team member with the switch off and on, every dialog state
// (empty, invalid, checking, not on WhatsApp, existing chat, daily limit, WhatsApp offline), the
// linked-phone flow with the ban warning and the opened chat, the Business API flow (template picker,
// variables, preview, send error, chat after the template), the Settings switch, Activity and Lite.
// Reports page errors and horizontal overflow; ends with screenshots/new-chat-results.json.
// Usage: node docs/features/new-chat/mock/new-chat-shots.mjs [baseUrl]   (PW_CHROMIUM=<chromium>)
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
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

let run = 0;
async function session(user, { size, scheme = 'light', locale = 'en', edition = 'enterprise' }) {
  const ctx = await browser.newContext({
    ...sizes[size],
    baseURL: BASE,
    colorScheme: scheme,
    timezoneId: 'Asia/Kuala_Lumpur',
  });
  await ctx.addInitScript(
    ([loc, ed]) => {
      localStorage.setItem('wati.locale', loc);
      localStorage.setItem('mock.customAgents.edition.v1', ed);
    },
    [locale, edition],
  );
  const login = await ctx.request.post('/api/auth/login', {
    data: { username: user, password: 'demo-pass-123' },
    headers: { origin: BASE },
  });
  if (!login.ok()) throw new Error(`login ${user} failed ${login.status()}`);
  const page = await ctx.newPage();
  const suffix = `${size}-${scheme}${locale === 'en' ? '' : `-${locale}`}`;
  page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
  const shot = async (name, full = false) => {
    await page.waitForTimeout(400);
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
  const api = (method, path, data) =>
    ctx.request.fetch(`/api${path}`, { method, data, headers: { origin: BASE } });
  return { ctx, page, shot, step, api };
}

const dialog = (page) => page.getByTestId('new-chat-dialog');
const openDialog = async (page) => {
  await page.goto('/');
  await page.getByTestId('new-chat-button').click();
  await dialog(page).waitFor();
};
const scenario = async (page, label) => {
  await page
    .getByTestId('new-chat-mock-controls')
    .getByRole('button', { name: label, exact: true })
    .click();
  await page.waitForTimeout(300);
};

for (const size of Object.keys(sizes)) {
  run += 1;
  const n = (x) => `012-88${run}${x} 4321`;
  // Admin, Enterprise (three inboxes: two linked phones, one Business API).
  const a = await session('aisyah', { size });
  const { page, shot, step, api } = a;
  await api('PUT', '/mock/new-chat', { staffEnabled: false, dailyLimit: 20 });
  await api('PUT', '/mock/new-chat/scenario', { scenario: 'normal' });
  await step('header', async () => {
    await page.goto('/');
    await page.getByTestId('new-chat-button').waitFor();
    await shot('01-header-admin');
  });
  await step('empty', async () => {
    await openDialog(page);
    await shot('02-dialog-empty');
  });
  await step('invalid', async () => {
    await dialog(page).getByTestId('new-chat-phone').fill('12345');
    await page.getByTestId('new-chat-start').click();
    await shot('03-invalid');
  });
  await step('typed', async () => {
    await dialog(page).getByTestId('new-chat-phone').fill(n(1));
    await dialog(page).getByLabel('Name (optional)').fill('Farah Ismail');
    await shot('04-typed-warning');
  });
  await step('checking', async () => {
    await page.getByTestId('new-chat-start').click();
    await page.getByText('Checking WhatsApp…').first().waitFor();
    await page.screenshot({ path: join(OUT, `05-checking-${size}-light.png`) });
    passed.push(`05-checking-${size}-light`);
    await page
      .getByRole('textbox', { name: /Type a message|Message/ })
      .first()
      .waitFor();
    await shot('06-chat-opened');
  });
  await step('not-on-whatsapp', async () => {
    await openDialog(page);
    await dialog(page).getByTestId('new-chat-phone').fill('012-345 6780');
    await page.getByTestId('new-chat-start').click();
    await page.getByText('is not on WhatsApp').waitFor();
    await shot('07-not-on-whatsapp');
  });
  await step('existing', async () => {
    await dialog(page).getByTestId('new-chat-phone').fill('012-555 0142');
    await page.getByTestId('new-chat-start').click();
    await page.getByTestId('new-chat-open-existing').waitFor();
    await shot('08-existing');
  });
  await step('daily-limit', async () => {
    await dialog(page).getByTestId('new-chat-phone').fill(n(2));
    await scenario(page, 'Daily limit');
    await shot('09-daily-limit');
  });
  await step('offline', async () => {
    await scenario(page, 'WhatsApp offline');
    await shot('10-offline');
    await scenario(page, 'Normal');
  });
  await step('api-number', async () => {
    await openDialog(page);
    await dialog(page).getByRole('combobox').click();
    await page.getByRole('option', { name: /Online orders/ }).click();
    await dialog(page).getByTestId('new-chat-phone').fill(n(3));
    await dialog(page).getByLabel('Name (optional)').fill('Ravi Kumar');
    await shot('11-api-number');
  });
  await step('api-templates', async () => {
    await page.getByTestId('new-chat-start').click();
    await page.getByTestId('new-chat-templates').waitFor();
    await shot('12-api-templates');
    await page.getByTestId('new-chat-templates').getByRole('button').first().click();
    await page.getByLabel('Variable 2').fill('#1042');
    await page.getByLabel('Variable 3').fill('ready for pick-up');
    await page.getByTestId('new-chat-preview').scrollIntoViewIfNeeded();
    await shot('13-api-variables-preview');
  });
  await step('api-error', async () => {
    await scenario(page, 'Template fails');
    await page.getByTestId('new-chat-send-template').click();
    await page.getByText('The template was not sent').waitFor();
    await page.getByText('The template was not sent').scrollIntoViewIfNeeded();
    await shot('14-api-send-error');
    await scenario(page, 'Normal');
  });
  await step('api-sent', async () => {
    await page.getByTestId('new-chat-send-template').click();
    await page.getByTestId('window-closed').waitFor();
    await shot('15-api-chat-after-template');
  });
  await step('settings', async () => {
    await page.goto('/admin/settings/general');
    const card = page.getByTestId('new-chat-settings');
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    await shot('16-settings-off');
    await card.getByRole('switch').click();
    await shot('17-settings-on-unsaved');
    // Owner 2026-11-06: the daily limit is an admin setting (default 20, 0 = no limit).
    const limit = card.getByTestId('new-chat-daily-limit');
    await limit.getByRole('spinbutton').fill('');
    await limit.scrollIntoViewIfNeeded();
    await shot('23-settings-limit-invalid');
    await limit.getByRole('spinbutton').fill('0');
    await shot('24-settings-limit-none');
    await limit.getByRole('spinbutton').fill('10');
    await limit.scrollIntoViewIfNeeded();
    await shot('25-settings-limit-10');
    await card.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(500);
  });
  await step('activity', async () => {
    await page.goto('/admin/audit');
    await page
      .getByText('Chat started with a new number')
      .filter({ visible: true })
      .first()
      .waitFor();
    await shot('18-activity');
  });
  await a.ctx.close();

  // A team member: Daniel (Kopi Apong + Online orders). Switch on (saved above), then off.
  const d = await session('daniel', { size });
  await d.step('staff-on', async () => {
    await d.page.goto('/');
    await d.page.getByTestId('new-chat-button').waitFor();
    await d.shot('19-header-staff-on');
    await d.page.getByTestId('new-chat-button').click();
    await dialog(d.page).getByRole('combobox').click();
    await d.shot('20-staff-inbox-choice');
    await d.page.keyboard.press('Escape');
  });
  await d.ctx.close();
  const admin2 = await session('aisyah', { size });
  await admin2.api('PUT', '/mock/new-chat', { staffEnabled: false, dailyLimit: 20 });
  await admin2.ctx.close();
  const d2 = await session('daniel', { size });
  await d2.step('staff-off', async () => {
    await d2.page.goto('/');
    await d2.page.getByRole('heading', { name: 'Inbox' }).waitFor();
    if (await d2.page.getByTestId('new-chat-button').count())
      throw new Error('New chat button shown to a team member with the switch off');
    await d2.shot('21-header-staff-off');
  });
  await d2.ctx.close();

  // Lite: one inbox, no "Send from".
  const l = await session('aisyah', { size, edition: 'lite' });
  await l.step('lite', async () => {
    await openDialog(l.page);
    await l.shot('22-dialog-lite');
  });
  await l.ctx.close();

  // Dark and the other languages: the empty dialog and the template step.
  for (const opts of [
    { scheme: 'dark', locale: 'en' },
    { scheme: 'light', locale: 'ms' },
    { scheme: 'light', locale: 'zh-CN' },
  ]) {
    const s = await session('aisyah', { size, ...opts });
    await s.step(`dialog-${opts.locale}-${opts.scheme}`, async () => {
      await openDialog(s.page);
      await s.page.getByTestId('new-chat-phone').fill('012-777 1234');
      await s.shot('02-dialog-empty');
      await dialog(s.page).getByRole('combobox').click();
      await s.page.getByRole('option').nth(2).click();
      await s.page.getByTestId('new-chat-start').click();
      await s.page.getByTestId('new-chat-templates').getByRole('button').first().click();
      await s.shot('13-api-variables-preview');
    });
    await s.ctx.close();
  }
}

await browser.close();
writeFileSync(
  join(OUT, 'new-chat-results.json'),
  JSON.stringify({ passed, problems }, null, 2) + '\n',
);
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
