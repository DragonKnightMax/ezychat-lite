// Screenshots of the proposed emoji reactions in the running seeded mock (run.ts --fake-wa), at
// desktop 1280 px and mobile 360 px, light and dark: a customer's 👍 under an outbound reply, the
// list of who reacted, the phone's own reaction on an inbound message, a busy group message (grouped
// emojis with a count) and its list with a long name, a change and a removal made with the mock-only
// "Simulate reactions" panel. Reports page errors and horizontal overflow.
// Usage: node docs/features/upgrade-enterprise/mock/reaction-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7489';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium
  .launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
  .catch(() => chromium.launch({ channel: 'chrome' }));
const problems = [];
const FARAH = '60123110021@s.whatsapp.net';
const JASON = '60129001234@s.whatsapp.net';
const GROUP = '120363025550001@g.us';
const chat = (jid) => `/chats/${encodeURIComponent(jid)}`;

for (const scheme of ['light', 'dark'])
  for (const [vp, size] of [
    ['desktop', { width: 1280, height: 860 }],
    ['mobile', { width: 360, height: 780 }],
  ]) {
    const ctx = await browser.newContext({ viewport: size, baseURL: BASE, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${scheme} ${vp} pageerror: ${e.message}`));
    const login = await ctx.request.post('/api/auth/login', {
      data: { username: 'aisyah', password: 'demo-pass-123' },
      headers: { origin: BASE },
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);

    const shot = async (n, step) => {
      await page.waitForTimeout(500);
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      if (wide) problems.push(`${scheme} ${vp} ${step}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${n}-${step}-${vp}-${scheme}.png`) });
    };
    const badgeOf = (text) =>
      page.locator('[data-message-id]').filter({ hasText: text }).getByTestId('reaction-badges');

    // 01/02 Direct chat: Farah's 👍 under the assistant's reply, then the list.
    await page.goto(chat(FARAH));
    const replyBadge = badgeOf('Yes, we can cater for 30');
    await replyBadge.waitFor();
    await shot('01', 'dm-outbound-badge');
    await replyBadge.click();
    await page.getByTestId('reaction-list').waitFor();
    await shot('02', 'dm-reaction-list');
    await page.keyboard.press('Escape');

    // 03 The phone's 🙏 on an inbound question.
    await page.goto(chat(JASON));
    await badgeOf('How much is a large Kopi Peng?').waitFor();
    await shot('03', 'dm-phone-reaction');

    // 04/05 Group: grouped emojis with a count, then the list with a long name.
    await page.goto(chat(GROUP));
    const groupBadge = badgeOf('durian cendol');
    await groupBadge.waitFor();
    await shot('04', 'group-badge');
    await groupBadge.click();
    await page.getByTestId('reaction-list').waitFor();
    await shot('05', 'group-reaction-list');
    await page.keyboard.press('Escape');

    // 06/07 Simulate: Farah changes her reaction, then removes it (the badge goes away).
    await page.goto(chat(FARAH));
    await page.getByTestId('mock-reactions').locator('summary').click();
    await page.getByText('Last reply').click();
    await page.getByRole('button', { name: 'Customer changes to ❤️' }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-testid="reaction-badges"]')].some((b) =>
        b.textContent?.includes('❤️'),
      ),
    );
    await shot('06', 'dm-changed');
    await page.getByRole('button', { name: 'Customer removes it' }).click();
    await replyBadge.waitFor({ state: 'detached' });
    await shot('07', 'dm-removed');
    // Put Farah's 👍 back for the next viewport.
    await page.getByRole('button', { name: 'Customer reacts 👍' }).click();
    await replyBadge.waitFor();

    await ctx.close();
  }

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Saved the emoji-reactions screenshots in ${OUT}`);
