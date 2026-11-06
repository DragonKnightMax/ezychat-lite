// Screenshots of the proposed Scheduled tasks card (scheduled-tasks) in the running seeded mock
// (run.ts --fake-wa), desktop 1280 px and mobile 360 px (touch), light and dark: the agent page card
// (a few tasks, empty, a long list), the add/edit dialog (chat picker, chosen days, validation,
// preview sent / skipped), Run now, the run history, the chat with a "Scheduled" message, the paused
// states (agent off, AI not connected, WhatsApp off), and the card in Malay and Chinese.
// Task state lives in the browser (localStorage), so every context starts from the seed.
// Reports page errors and horizontal overflow; ends with screenshots/results.json.
// Usage: node docs/features/scheduled-tasks/mock/scheduled-shots.mjs [baseUrl]
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
const only = process.env.SHOTS_ONLY; // e.g. "desktop-light"

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    if (only && only !== suffix) continue;
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
    const page = await ctx.newPage();
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
    const openCard = async () => {
      await page.goto('/admin/members/ai/a1');
      await card().waitFor();
      await card().scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    };
    const toCardTop = async () => {
      await card().evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(200);
    };
    const mock = (key) => card().getByTestId(`scheduled-mock-${key}`);
    const reset = async () => {
      await card().getByTestId('scheduled-mock-reset').click();
    };

    const turn = async (label) => {
      await page.evaluate(() => window.scrollTo(0, 0));
      const button = page.getByRole('button', { name: label, exact: true }).first();
      if (await button.isVisible()) {
        await button.click();
        await page.waitForTimeout(800);
      }
    };
    await step('card', async () => {
      await openCard();
      await turn('Turn on');
      await openCard();
      await reset();
      await toCardTop();
      await shot('01-card-tasks');
    });
    await step('add-dialog', async () => {
      await card().getByTestId('scheduled-add').click();
      await dialog().waitFor();
      await dialog().getByTestId('scheduled-save').click();
      await shot('02-add-validation');
      await dialog().getByTestId('scheduled-name').fill('Daily specials');
      await dialog().getByTestId('scheduled-chat').click();
      await page.getByPlaceholder('Search chats and groups').fill('staff');
      await shot('03-chat-picker');
      await page.getByRole('option', { name: /Kopi Apong Staff/ }).click();
      await dialog().getByText('Chosen days').click();
      await dialog().getByTestId('scheduled-days').getByText('Fri').click();
      await dialog()
        .getByTestId('scheduled-instruction')
        .fill("Tell the team today's bookings from Google Calendar. Skip if there are none.");
      await dialog().getByTestId('scheduled-preview-button').click();
      await dialog().getByTestId('scheduled-preview').scrollIntoViewIfNeeded();
      await shot('04-add-preview-sent');
    });
    await step('preview-skipped', async () => {
      await page.keyboard.press('Escape');
      await mock('nothingToday').click();
      await card().getByTestId('scheduled-name-link').first().click();
      await dialog().waitFor();
      await dialog().getByTestId('scheduled-preview-button').click();
      await dialog().getByTestId('scheduled-preview').scrollIntoViewIfNeeded();
      await shot('05-edit-preview-skipped');
      await page.keyboard.press('Escape');
      await mock('nothingToday').click();
    });
    await step('history', async () => {
      await card().getByTestId('scheduled-menu').first().click();
      await page.getByTestId('scheduled-history').click();
      await dialog().getByTestId('scheduled-history-list').waitFor();
      await shot('06-history');
      await page.keyboard.press('Escape');
    });
    await step('run-now', async () => {
      await card().getByTestId('scheduled-menu').first().click();
      await page.getByTestId('scheduled-run-now').click();
      await dialog().waitFor();
      await shot('07-run-now');
      await dialog().getByTestId('scheduled-run-confirm').click();
      await page.getByText('Sent to Kopi Apong Staff').waitFor();
      await shot('08-run-now-sent');
    });
    await step('chat', async () => {
      await page.goto(`/chats/${encodeURIComponent('120363025550005@g.us')}`);
      await page.getByTestId('scheduled-mark').first().waitFor();
      await page.waitForTimeout(600);
      await shot('09-chat-scheduled');
    });
    await step('paused', async () => {
      await openCard();
      await mock('waConnected').click();
      await toCardTop();
      await shot('10-paused-whatsapp');
      await mock('waConnected').click();
      await mock('aiConnected').click();
      await toCardTop();
      await shot('11-paused-ai');
      await mock('aiConnected').click();
    });
    await step('agent-off', async () => {
      await turn('Turn off');
      await toCardTop();
      await shot('12-paused-agent-off');
      await turn('Turn on');
    });
    await step('empty', async () => {
      // The second agent (Enterprise view) has no tasks yet.
      await page.goto('/admin/members/ai/a2?edition=enterprise');
      await card().waitFor();
      await toCardTop();
      await shot('13-empty');
      await page.goto('/admin/members/ai/a1?edition=lite');
      await card().waitFor();
    });
    await step('long-list', async () => {
      await openCard();
      await card().getByTestId('scheduled-mock-fill').click();
      await toCardTop();
      await shot('14-long-list');
      await card().getByTestId('scheduled-show-all').click();
      await shot('15-long-list-all', true);
      await reset();
    });
    if (sizeName === 'desktop' && scheme === 'light')
      for (const lang of ['ms', 'zh-CN'])
        await step(`lang-${lang}`, async () => {
          await ctx.request.patch('/api/me', { data: { locale: lang }, headers: { origin: BASE } });
          await openCard();
          await toCardTop();
          await shot(`16-card-${lang}`);
          await card().getByTestId('scheduled-name-link').first().click();
          await dialog().waitFor();
          await shot(`17-edit-${lang}`);
          await page.keyboard.press('Escape');
          await ctx.request.patch('/api/me', { data: { locale: 'en' }, headers: { origin: BASE } });
        });
    await ctx.close();
  }

await browser.close();
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ passed, problems }, null, 2));
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
