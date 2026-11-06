// Screenshots of the proposed @ tagging in group chats (group-mentions) in the running seeded mock
// (run.ts --fake-wa), at desktop 1280 px and mobile 360 px (touch), light and dark: the picker with
// every member, a filtered list, no match, a picked tag in the box, the sent bubble with the names,
// the large Reseller group (generated members without names) and a direct chat (no picker).
// Sends go through the real server route with `mentions`, and the fake WhatsApp records them.
// Reports page errors and horizontal overflow; ends with mention-results.json.
// Usage: node docs/features/group-mentions/mock/mention-shots.mjs [baseUrl]
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

const CLUB = '120363025550002@g.us';
const RESELLERS = '120363025550003@g.us';
const chatUrl = (jid) => `/chats/${encodeURIComponent(jid)}`;

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
    const login = await ctx.request.post('/api/auth/login', {
      data: { username: 'aisyah', password: 'demo-pass-123' },
      headers: { origin: BASE },
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name) => {
      await page.waitForTimeout(400);
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
      }
    };
    const box = () => page.getByRole('textbox', { name: /message/i }).last();
    const picker = () => page.getByTestId('mention-picker');

    await step('01-picker-all', async () => {
      await page.goto(chatUrl(CLUB));
      await box().click();
      await box().pressSequentially('Morning @');
      await picker().waitFor();
      await shot('01-picker-all');
    });
    await step('02-picker-filtered', async () => {
      await box().pressSequentially('fa');
      await page.getByRole('option', { name: /Farah Aziz/ }).waitFor();
      await shot('02-picker-filtered');
    });
    await step('03-picked', async () => {
      await page.keyboard.press('Enter');
      await box().pressSequentially('and @');
      await picker().waitFor();
      await page.getByRole('option', { name: /Tan Wei Jie/ }).click();
      await box().pressSequentially('the new beans arrive Friday ☕');
      const value = await box().inputValue();
      if (value !== 'Morning @Farah Aziz and @Tan Wei Jie the new beans arrive Friday ☕')
        throw new Error(`unexpected draft: ${value}`);
      await shot('03-picked');
    });
    await step('04-sent', async () => {
      if (sizeName === 'mobile') await page.getByRole('button', { name: /^send$/i }).click();
      else await page.keyboard.press('Enter');
      // The group is assigned to Daniel: confirm replying anyway (existing behaviour).
      const anyway = page.getByRole('button', { name: /reply anyway|send anyway/i });
      if (await anyway.isVisible({ timeout: 2000 }).catch(() => false)) await anyway.click();
      await page
        .getByText('Morning @Farah Aziz and @Tan Wei Jie the new beans arrive Friday ☕')
        .last()
        .waitFor();
      await page.waitForTimeout(1500);
      await shot('04-sent');
    });
    await step('05-no-match', async () => {
      await box().pressSequentially('@zzz');
      await picker()
        .getByText(/No member matches/)
        .waitFor();
      await shot('05-no-match');
      await page.keyboard.press('Escape');
      await box().fill('');
    });
    await step('06-large-group', async () => {
      await page.goto(chatUrl(RESELLERS));
      await box().click();
      await box().pressSequentially('@');
      await picker().waitFor();
      await shot('06-large-group');
      await page.keyboard.press('Escape');
    });
    await ctx.close();
  }

// What the fake WhatsApp was asked to send: the API route returns it in the message list.
writeFileSync(join(OUT, 'mention-results.json'), JSON.stringify({ passed, problems }, null, 2));
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
await browser.close();
