// Screenshots of the proposed limited chat access (folder partner-role) in the running seeded mock
// (run.ts --fake-wa), desktop 1280 px and mobile 360 px (touch), light and dark: Members with agents
// limited to chosen chats, Edit member with "Chats this member can see" (All chats, Only chosen chats
// filled, none chosen, a long list), and the limited agent's own screens (only chosen chats, a chosen
// chat with notes, Group info member without Message, a chat that is not theirs, no chats yet).
// The mock state is on the server; the script saves nothing, so it runs on any fresh mock.
// Reports page errors and horizontal overflow; ends with screenshots/results.json.
// Usage: node docs/features/partner-role/mock/member-chats-shots.mjs [baseUrl]
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
const chat = (jid) => `/chats/${encodeURIComponent(jid)}`;
const PRIYA = '60128814455@s.whatsapp.net';
const FARAH = '60123110021@s.whatsapp.net';
const KOPI = '120363025550002@g.us';
const schemes = (process.env.SCHEMES ?? 'light,dark').split(',');

for (const scheme of schemes)
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const open = async (username) => {
      const ctx = await browser.newContext({
        ...size,
        baseURL: BASE,
        colorScheme: scheme,
        timezoneId: 'Asia/Kuala_Lumpur',
      });
      const login = await ctx.request.post('/api/auth/login', {
        data: { username, password: 'demo-pass-123' },
        headers: { origin: BASE },
      });
      if (!login.ok()) throw new Error(`login ${username} failed ${login.status()}`);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`${suffix} ${username} pageerror: ${e.message}`));
      return { ctx, page };
    };
    let page;
    const shot = async (name, full = false) => {
      await page.waitForTimeout(500);
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
    const dialog = () => page.getByRole('dialog');
    const edit = async (name) => {
      await page.goto('/admin/members');
      await page.locator('text=Ravi Kumar >> visible=true').first().waitFor();
      await page.waitForTimeout(600); // the member-chats state loads after the list
      const row = page
        .locator(`:is(tr, li):has-text("${name}") >> visible=true`)
        .filter({ hasNot: page.locator('table') })
        .first();
      await row.getByRole('button', { name: /^Edit/ }).first().click();
      await dialog().getByTestId('member-chats').waitFor();
    };

    // ---- Admin (Aisyah) ----
    const admin = await open('aisyah');
    page = admin.page;
    await step('members', async () => {
      await page.goto('/admin/members');
      await page.locator('[data-testid=chosen-chats-note] >> visible=true').first().waitFor();
      await shot('01-members', true);
    });
    await step('edit all', async () => {
      await edit('Daniel');
      await shot('02-edit-all-chats');
      await page.keyboard.press('Escape');
    });
    await step('edit chosen', async () => {
      await edit('Ravi Kumar');
      await dialog().getByTestId('chosen-chats').waitFor();
      await shot('03-edit-chosen-chats');
      await page.keyboard.press('Escape');
    });
    await step('edit none', async () => {
      await edit('Sofia Tan');
      await dialog().getByText('No chats chosen yet').waitFor();
      await shot('04-edit-none-chosen');
      await page.keyboard.press('Escape');
    });
    await step('edit long', async () => {
      await edit('Ravi Kumar');
      for (let i = 0; i < 9; i++) {
        const add = dialog().getByRole('button', { name: /^Add / }).first();
        if (!(await add.count())) break;
        await add.click();
      }
      await dialog().getByTestId('chosen-chats').waitFor();
      await shot('05-edit-many-chosen');
      await page.keyboard.press('Escape'); // closes without saving
    });
    await admin.ctx.close();

    // ---- Limited agent (Ravi) ----
    const ravi = await open('ravi');
    page = ravi.page;
    await step('limited list', async () => {
      await page.goto('/');
      await page.locator('text=Priya Nair >> visible=true').first().waitFor();
      await shot('06-limited-list');
    });
    await step('limited chat', async () => {
      await page.goto(chat(PRIYA));
      await page.locator('text=My order #1042 >> visible=true').first().waitFor();
      await shot('07-limited-chat');
    });
    await step('limited group', async () => {
      await page.goto(chat(KOPI));
      await page.getByRole('heading', { name: 'Kopi Lovers Club' }).first().waitFor();
      await page.getByRole('button', { name: /Open group info/ }).click();
      await page
        .locator('[aria-label="Group info"]')
        .getByRole('button', { name: /Farah Aziz/ })
        .first()
        .click();
      await page.getByTestId('limited-no-member-chat').waitFor();
      await shot('08-limited-group-member');
    });
    await step('not chosen', async () => {
      await page.goto(chat(FARAH));
      await page.getByRole('heading', { name: "You can't open this chat" }).waitFor();
      await shot('09-limited-not-chosen');
    });
    await ravi.ctx.close();

    // ---- Limited agent with no chats (Sofia) ----
    const sofia = await open('sofia');
    page = sofia.page;
    await step('no chats', async () => {
      await page.goto('/');
      await page.getByText('No chats yet').waitFor();
      await shot('10-limited-no-chats');
    });
    await sofia.ctx.close();
  }

await browser.close();
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ passed, problems }, null, 2));
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
process.exitCode = problems.length ? 1 : 0;
