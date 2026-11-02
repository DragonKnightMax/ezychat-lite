// Screenshots of the proposed message edit and delete (message-edit-delete) in the running seeded
// mock (run.ts --fake-wa), desktop 1280 px and mobile 360 px touch, light and dark: Jason Lim's
// chat with an edited reply, the customer's edit, the customer's and a teammate's deletes; the
// "Edited" history, "Show original", the ⋮ menu (touch: the press-and-hold bar), the edit dialog
// and its result, the delete choices, the closed windows (3 days later), WhatsApp offline and the
// agent's view. Reports page errors and horizontal overflow. It changes the mock's data and resets
// it at the start of every round. Ends with edit-delete-results.json.
// Usage: node docs/features/message-edit-delete/mock/edit-delete-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7487';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium
  .launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
  .catch(() => chromium.launch({ channel: 'chrome' }));
const problems = [];
const passed = [];
const AHMAD = '60125550142@s.whatsapp.net';
const JASON = '60129001234@s.whatsapp.net';
const chatPath = `/chats/${encodeURIComponent(AHMAD)}`;

async function session(user, scheme, size, touch) {
  const ctx = await browser.newContext({
    viewport: size,
    baseURL: BASE,
    colorScheme: scheme,
    hasTouch: touch,
    isMobile: touch,
  });
  const login = await ctx.request.post('/api/auth/login', {
    data: { username: user, password: 'demo-pass-123' },
    headers: { origin: BASE },
  });
  if (!login.ok()) throw new Error(`login ${user} failed ${login.status()}`);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${user} ${scheme} pageerror: ${e.message}`));
  return { ctx, page };
}
const post = (ctx, path, data) => ctx.request.post(path, { data, headers: { origin: BASE } });
const byBody = async (ctx, body) => {
  const { messages } = await (
    await ctx.request.get(`/api/chats/${encodeURIComponent(AHMAD)}/messages`)
  ).json();
  const m = messages.find((x) => x.body === body);
  if (!m) throw new Error(`no message "${body}"`);
  return m.id;
};

for (const scheme of ['light', 'dark'])
  for (const [vp, size] of [
    ['desktop', { width: 1280, height: 860 }],
    ['mobile', { width: 360, height: 780 }],
  ]) {
    const touch = vp === 'mobile';
    const { ctx, page } = await session('aisyah', scheme, size, touch);
    const shot = async (n, step) => {
      await page.waitForTimeout(600);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
        problems.push(`${scheme} ${vp} ${step}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${n}-${step}-${vp}-${scheme}.png`) });
      passed.push(`${n}-${step}-${vp}-${scheme}`);
    };
    await post(ctx, '/api/mock/wa-offline', { offline: false });
    await post(ctx, '/api/mock/message-changes/reset', {});
    const recent = await byBody(ctx, 'Your order is being prepared now!');
    const price = await byBody(ctx, 'Yes, we open 10am to 6pm on Hari Raya.');
    const wrong = await byBody(ctx, 'Sorry, wrong chat 🙈');
    const bubble = (id) => page.locator(`[data-message-id="${id}"]`);
    const openActions = async (id) => {
      const b = bubble(id);
      await b.scrollIntoViewIfNeeded();
      if (touch) {
        const box = await b.boundingBox();
        const at = { clientX: box.x + 20, clientY: box.y + 10, pointerType: 'touch', pointerId: 7 };
        await b.dispatchEvent('pointerdown', at);
        await page.waitForTimeout(650);
        await b.dispatchEvent('pointerup', at);
      } else {
        await b.hover();
        await b.locator('xpath=..').getByTestId('message-more').click();
      }
    };
    const choose = async (name) => {
      if (touch)
        await page
          .getByTestId('reaction-picker')
          .getByRole('button', { name, exact: true })
          .click();
      else await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
    };

    await page.goto(chatPath);
    await bubble(recent).scrollIntoViewIfNeeded();
    await shot('01', 'chat');
    await bubble(price).scrollIntoViewIfNeeded();
    await bubble(price).getByTestId('edited-label').click();
    await shot('02', 'edit-history');
    await page.keyboard.press('Escape');
    await bubble(wrong).getByTestId('show-original').click();
    await shot('03', 'show-original');

    await openActions(recent);
    await shot('04', 'actions');
    await choose('Edit');
    await page
      .getByTestId('edit-text')
      .fill('Your order is being prepared now! Ready in 10 minutes.');
    await shot('05', 'edit-dialog');
    await page.getByTestId('edit-save').click();
    await page.waitForTimeout(3500);
    await shot('06', 'edited');

    await openActions(recent);
    await choose('Delete');
    await shot('07', 'delete-dialog');
    await page.getByTestId('delete-for-everyone').click();
    await page.waitForTimeout(3500);
    await shot('08', 'deleted-for-everyone');

    // 3 days later: Edit is disabled with its reason; only Delete for me is left.
    await post(ctx, '/api/mock/message-changes/clock', { offsetMinutes: 4320 });
    await page.reload();
    await openActions(price);
    await shot('09', 'windows-closed');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await openActions(price);
    await choose('Delete');
    await shot('10', 'delete-for-me-only');
    await page.getByTestId('delete-for-me').click();
    await page.waitForTimeout(3500);
    if (await bubble(price).count()) problems.push(`${scheme} ${vp}: hidden message still shown`);
    await shot('11', 'hidden-for-team');

    await post(ctx, '/api/mock/message-changes/clock', { offsetMinutes: 0 });
    await post(ctx, '/api/mock/wa-offline', { offline: true });
    await page.reload();
    const fresh = await byBody(ctx, 'Pickup is at our Georgetown shop, see you then 👍');
    if (!touch) {
      await openActions(fresh);
      await shot('12', 'offline');
      await page.keyboard.press('Escape');
    }
    await post(ctx, '/api/mock/wa-offline', { offline: false });
    // A WhatsApp Business API inbox (Online orders): no edit or delete at all.
    await page.goto(`/chats/${encodeURIComponent(JASON)}`);
    await page.waitForTimeout(800);
    if (await page.getByTestId('message-more').count())
      problems.push(`${scheme} ${vp}: actions shown on a Business API chat`);
    await shot('14', 'business-api-none');
    await ctx.close();

    // The agent: no "Show original", no actions on Aisyah's or the phone's messages.
    const agent = await session('daniel', scheme, size, touch);
    await post(agent.ctx, '/api/mock/message-changes/reset', {});
    await agent.page.goto(chatPath);
    await agent.page.locator(`[data-message-id="${wrong}"]`).scrollIntoViewIfNeeded();
    await agent.page.waitForTimeout(800);
    if (await agent.page.getByTestId('show-original').count())
      problems.push(`${scheme} ${vp}: agent sees Show original`);
    await agent.page.screenshot({ path: join(OUT, `13-agent-view-${vp}-${scheme}.png`) });
    await agent.ctx.close();
  }

await browser.close();
writeFileSync(
  join(OUT, 'edit-delete-results.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), passed, failed: problems }, null, 2) + '\n',
);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`screenshots in ${OUT}`);
