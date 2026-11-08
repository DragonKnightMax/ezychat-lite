// Screenshots of the proposed AI reply suggestions in the running seeded mock (run.ts --fake-wa), at
// desktop 1280 px and mobile 360 px (touch), light and dark: the Suggest reply button, loading, two
// chips, a chip in the composer, the replace confirm, the grey completion (Tab hint / Accept pill),
// no answer, a hand-off rule, Chinese and Malay chips, an error, an expired connection, and the
// Settings → AI card (new and updated install). Reports page errors and horizontal overflow.
// Usage: node docs/features/ai-reply-suggestions/mock/suggest-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7489';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium
  .launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
  .catch(() => chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' }));
const problems = [];
const CHATS = {
  nurul: '60126677889@s.whatsapp.net',
  ahmad: '60125550142@s.whatsapp.net',
  tan: '60127020388@s.whatsapp.net',
  priya: '60128814455@s.whatsapp.net',
  siti: '60131234567@s.whatsapp.net',
};
const chatPath = (jid) => `/chats/${encodeURIComponent(jid)}`;
const post = (ctx, path, data, method = 'post') =>
  ctx.request[method](path, { data, headers: { origin: BASE } });
const setMock = (ctx, body) => post(ctx, '/api/mock/reply-suggestions', body, 'put');

const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const ctx = await browser.newContext({ ...size, baseURL: BASE, colorScheme: scheme });
    const login = await post(ctx, '/api/auth/login', {
      username: 'aisyah',
      password: 'demo-pass-123',
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    await setMock(ctx, { install: 'new', mode: 'normal', enabled: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`) });
    };
    const box = () => page.getByRole('textbox', { name: 'Message' });
    const openChat = async (jid) => {
      await page.goto(chatPath(jid));
      await page.getByTestId('suggest-reply').waitFor();
      await page.waitForTimeout(300);
    };

    await openChat(CHATS.nurul);
    await shot('01-button');

    await setMock(ctx, { mode: 'slow' });
    await page.getByTestId('suggest-reply').click();
    await page.waitForTimeout(400);
    await shot('02-loading');
    await page.getByTestId('suggestion-chip').first().waitFor({ timeout: 8_000 });
    await setMock(ctx, { mode: 'normal' });
    await shot('03-chips');

    await page.getByTestId('suggestion-chip').first().click();
    await shot('04-draft-in-composer');

    await box().fill('Hi Nurul, sure');
    await page.getByTestId('suggest-reply').click();
    await page.getByTestId('suggestion-chip').nth(1).click();
    await page.getByTestId('replace-confirm').waitFor();
    await shot('05-replace-confirm');
    await page.getByRole('button', { name: 'Keep my text' }).click();

    await box().fill('');
    await page
      .getByTestId('reply-suggestions')
      .getByRole('button', { name: 'Close suggestions' })
      .click();
    await box().click();
    await page.keyboard.type('Hi Nurul! Two Nasi ', { delay: 30 });
    await page
      .getByTestId(sizeName === 'mobile' ? 'accept-completion' : 'completion-hint')
      .waitFor({ timeout: 5_000 });
    await shot('06-completion');
    if (sizeName === 'desktop') await page.keyboard.press('Tab');
    else await page.getByTestId('accept-completion').click();
    const value = await box().inputValue();
    if (!value.includes('Lemak Ayam')) problems.push(`${suffix} completion not accepted: ${value}`);
    await shot('07-completion-accepted');

    for (const [name, jid, wait] of [
      ['08-no-answer', CHATS.ahmad, 'suggestion-note'],
      ['09-handoff-rule', CHATS.priya, 'suggestion-note'],
      ['10-chinese', CHATS.tan, 'suggestion-chip'],
      ['11-malay', CHATS.siti, 'suggestion-chip'],
    ]) {
      await openChat(jid);
      await page.getByTestId('suggest-reply').click();
      await page.getByTestId(wait).first().waitFor();
      await shot(name);
    }

    await setMock(ctx, { mode: 'error' });
    await openChat(CHATS.nurul);
    await page.getByTestId('suggest-reply').click();
    await page.getByTestId('reply-suggestions').getByRole('alert').waitFor();
    await shot('12-error');

    await setMock(ctx, { mode: 'expired' });
    await page.reload();
    await page.getByText('AI suggestions are not available now').waitFor();
    await shot('13-expired');
    await setMock(ctx, { mode: 'normal' });

    await page.goto('/admin/settings/ai');
    const card = page.getByTestId('reply-suggestions-settings');
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    await shot('14-settings-new-install');
    await setMock(ctx, { install: 'upgraded' });
    await page.reload();
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    await shot('15-settings-updated-install');

    await setMock(ctx, { install: 'new', mode: 'normal', enabled: true });
    await ctx.close();
  }

await browser.close();
console.log(problems.length ? `Problems:\n${problems.join('\n')}` : 'No problems found.');
console.log(`Saved the ai-reply-suggestions screenshots in ${OUT}`);
