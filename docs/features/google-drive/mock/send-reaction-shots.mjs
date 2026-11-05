// Screenshots of the proposed reaction sending in the running seeded mock (run.ts --fake-wa), at
// desktop 1280 px and mobile 360 px, light and dark: the 🙂 button on hover, the emoji bar, the
// sent 👍 and its list entry ("You", Remove), all emojis behind "+", a teammate's view (the bar says
// the choice replaces Aisyah's, the list names her), the disabled bar while WhatsApp is offline, and
// on touch the bar opened by press-and-hold with Reply. Reports page errors and horizontal overflow.
// Usage: node docs/features/upgrade-enterprise/mock/send-reaction-shots.mjs [baseUrl]
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
const chatPath = `/chats/${encodeURIComponent(FARAH)}`;

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

for (const scheme of ['light', 'dark'])
  for (const [vp, size] of [
    ['desktop', { width: 1280, height: 860 }],
    ['mobile', { width: 360, height: 780 }],
  ]) {
    const touch = vp === 'mobile';
    const { ctx, page } = await session('aisyah', scheme, size, touch);
    const shot = async (n, step) => {
      await page.waitForTimeout(500);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
        problems.push(`${scheme} ${vp} ${step}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${n}-${step}-${vp}-${scheme}.png`) });
    };
    const { messages } = await (
      await ctx.request.get(`/api/chats/${encodeURIComponent(FARAH)}/messages`)
    ).json();
    const target = messages.filter((m) => !m.fromMe && m.type === 'text').at(-1);
    await post(ctx, '/api/mock/wa-offline', { offline: false });
    await post(ctx, '/api/mock/react', { messageId: target.id, emoji: '' });
    await page.goto(chatPath);
    const bubble = page.locator(`[data-message-id="${target.id}"]`);
    const row = bubble.locator('xpath=..');
    await bubble.scrollIntoViewIfNeeded();
    const openBar = async () => {
      if (touch) {
        const box = await bubble.boundingBox();
        const at = { clientX: box.x + 20, clientY: box.y + 10, pointerType: 'touch', pointerId: 7 };
        await bubble.dispatchEvent('pointerdown', at);
        await page.waitForTimeout(650);
        await bubble.dispatchEvent('pointerup', at);
      } else {
        await bubble.hover();
        await row.getByTestId('reaction-picker-button').click();
      }
      await page.getByTestId('reaction-picker').waitFor();
    };

    if (!touch) {
      await bubble.hover();
      await shot('01', 'hover-button');
    }
    await openBar();
    await shot('02', touch ? 'hold-bar-with-reply' : 'bar');
    await page.getByTestId('reaction-picker').getByRole('button', { name: /👍/ }).click();
    await row.getByTestId('reaction-badges').waitFor();
    await row.getByTestId('reaction-badges').click();
    await page.getByTestId('reaction-list').waitFor();
    await shot('03', 'sent-list-you');
    await page.keyboard.press('Escape');
    await openBar();
    await shot('04', 'bar-current');
    await page
      .getByTestId('reaction-picker')
      .getByRole('button', { name: /more|lagi|更多/i })
      .first()
      .click();
    await shot('05', 'more-emojis');
    await page.keyboard.press('Escape');

    // A teammate (Mei Ling, assigned to the chat) sees Aisyah's reaction named, and that a choice replaces it.
    const daniel = await session('meiling', scheme, size, touch);
    await daniel.page.goto(chatPath);
    const dBubble = daniel.page.locator(`[data-message-id="${target.id}"]`);
    const dRow = dBubble.locator('xpath=..');
    await dBubble.scrollIntoViewIfNeeded();
    await dRow.getByTestId('reaction-badges').waitFor();
    await daniel.page.waitForTimeout(4500); // the mock refreshes the names every 4 s
    await dRow.getByTestId('reaction-badges').click();
    await daniel.page.getByTestId('reaction-list').waitFor();
    await daniel.page.waitForTimeout(400);
    await daniel.page.screenshot({ path: join(OUT, `06-teammate-list-${vp}-${scheme}.png`) });
    await daniel.page.keyboard.press('Escape');
    if (!touch) {
      await dBubble.hover();
      await dRow.getByTestId('reaction-picker-button').click();
      await daniel.page.getByTestId('reaction-picker').waitFor();
      await daniel.page.waitForTimeout(400);
      await daniel.page.screenshot({ path: join(OUT, `07-teammate-bar-${vp}-${scheme}.png`) });
    }
    await daniel.ctx.close();

    await post(ctx, '/api/mock/wa-offline', { offline: true });
    await page.waitForTimeout(800);
    await openBar();
    await shot('08', 'offline');
    await page.keyboard.press('Escape');
    await post(ctx, '/api/mock/wa-offline', { offline: false });
    await post(ctx, '/api/mock/react', { messageId: target.id, emoji: '' });
    await ctx.close();
  }
await browser.close();
console.log(problems.length ? problems.join('\n') : 'No page errors or horizontal overflow.');
console.log(`Saved the send-reactions screenshots in ${OUT}`);
