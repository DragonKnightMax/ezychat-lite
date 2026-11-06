// Screen review shots for scheduled tasks against e2e/agents-devbuild.ts (mock model, fake WhatsApp,
// temp data), after e2e/devbuild-scheduled-check.mjs has run on it (admin "checker", a staff group,
// tasks and one scheduled message). Desktop 1280 and mobile 360 (touch), light and dark: the card
// (long list, a few tasks, paused, empty), the add dialog (validation, chat picker, preview), History,
// Run now and the chat with the Scheduled mark. Reports page errors and horizontal overflow.
// Usage: PW_CHROMIUM=<chromium> node e2e/scheduled-screens.mjs <port> <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
/* global document -- used inside page.evaluate (runs in the browser) */
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [port = '7491', out = 'scheduled-shots'] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });
const STAFF = '120363088800001@g.us';
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const problems = [];
const passed = [];

// Set-up through the API: agent on, three tasks kept (one off), the rest deleted.
const setup = await browser.newContext({ baseURL: base });
const req = setup.request;
const H = { origin: base };
const call = async (method, path, data) => {
  const r = await req.fetch(path, { method, data, headers: H });
  if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${await r.text()}`);
  return r.json().catch(() => null);
};
await call('POST', '/api/auth/login', { username: 'checker', password: 'check-pass-123' });
const agent = (await call('GET', '/api/ai')).agents[0];
const turn = (enabled) =>
  call('PUT', `/api/ai/agents/${agent.id}`, {
    displayName: 'Aina',
    enabled,
    instructions: '',
    handoffRules: '',
  });
await turn(true);
const base2 = `/api/ai/agents/${agent.id}/scheduled-tasks`;
const fill = async () => {
  const { tasks } = await call('GET', base2);
  const names = [
    'Opening checklist',
    'Weekly stock count',
    'Monthly rent reminder to the landlord, transfer by 5 pm',
  ];
  for (let i = tasks.length; i < 10; i++)
    await call('POST', base2, {
      name: names[i % names.length],
      time: '09:00',
      dayRule: i % 2 ? 'weekdays' : 'custom',
      days: i % 2 ? [] : [1, 4],
      chatJid: STAFF,
      instruction: 'Tell the team the plan for today.',
      enabled: i % 3 !== 0,
    });
};
const trim = async (keep) => {
  const { tasks } = await call('GET', base2);
  for (const t of tasks.slice(keep)) await call('DELETE', `${base2}/${t.id}`);
};

const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};
for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const ctx = await browser.newContext({
      ...size,
      baseURL: base,
      colorScheme: scheme,
      timezoneId: 'Asia/Kuala_Lumpur',
      serviceWorkers: 'block',
    });
    await ctx.request.post('/api/auth/login', {
      data: { username: 'checker', password: 'check-pass-123' },
      headers: H,
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name, full = false) => {
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(out, `${name}-${suffix}.png`), fullPage: full });
      passed.push(`${name}-${suffix}`);
    };
    const step = async (name, run) => {
      try {
        await run();
      } catch (e) {
        problems.push(`${suffix} ${name}: ${e.message.split('\n')[0]}`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    };
    const card = () => page.getByTestId('agent-scheduled-tasks');
    const dialog = () => page.getByRole('dialog');
    const open = async () => {
      await page.goto(`/admin/members/ai/${agent.id}`);
      await card().waitFor();
      await card().evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(300);
    };

    await step('long-list', async () => {
      await fill();
      await open();
      await shot('01-long-list');
      await card().getByTestId('scheduled-show-all').click();
      await shot('02-long-list-all', true);
    });
    await step('few', async () => {
      await trim(3);
      await open();
      await shot('03-card-tasks');
    });
    await step('add', async () => {
      await card().getByTestId('scheduled-add').first().click();
      await page.getByTestId('scheduled-dialog').waitFor();
      await page.getByTestId('scheduled-save').click();
      await shot('04-add-validation');
      await page.getByTestId('scheduled-name').fill('Daily specials');
      await page.getByTestId('scheduled-chat').click();
      await page.getByTestId('scheduled-chat-search').fill('Staff');
      await page.getByTestId('scheduled-chat-option').first().waitFor();
      await shot('05-chat-picker');
      await page.getByTestId('scheduled-chat-option').first().click();
      await page.getByTestId('scheduled-instruction').fill("Tell the team today's specials");
      await page.getByTestId('scheduled-preview-button').click();
      await page.getByTestId('scheduled-preview').waitFor();
      await page.getByTestId('scheduled-preview').scrollIntoViewIfNeeded();
      await shot('06-add-preview');
      await page.keyboard.press('Escape');
    });
    await step('history', async () => {
      await open();
      await card().getByTestId('scheduled-menu').first().click();
      await page.getByTestId('scheduled-history').click();
      await dialog().waitFor();
      await shot('07-history');
      await page.keyboard.press('Escape');
    });
    await step('run-now', async () => {
      await card().getByTestId('scheduled-menu').first().click();
      await page.getByTestId('scheduled-run-now').click();
      await page.getByTestId('scheduled-run-dialog').waitFor();
      await shot('08-run-now');
      await page.keyboard.press('Escape');
    });
    await step('chat', async () => {
      await page.goto(`/chats/${encodeURIComponent(STAFF)}`);
      await page.getByTestId('scheduled-mark').first().waitFor();
      await page.waitForTimeout(600);
      await shot('09-chat-scheduled');
    });
    await step('paused', async () => {
      await turn(false);
      await open();
      await shot('10-paused-agent-off');
      await turn(true);
    });
    await step('empty', async () => {
      await trim(0);
      await open();
      await shot('11-empty');
    });
    await ctx.close();
  }
await browser.close();
writeFileSync(join(out, 'results.json'), JSON.stringify({ passed, problems }, null, 2));
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
