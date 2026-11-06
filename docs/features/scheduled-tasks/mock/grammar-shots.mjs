// Screenshots of the proposed Fix English (grammar-fix) in the running seeded mock (run.ts --fake-wa),
// at desktop 1280 px and mobile 360 px (touch), light and dark: spelling underlined at once (red, from
// the dictionary in the browser) before the grammar check, then grammar (blue) with "Fix 5", the card
// over one word (hover on desktop, tap on the phone), one word accepted, Fix all with "5 fixed · Undo",
// Undo, "No mistakes", a Malay message (not checked), a long multi-line draft with team words left
// alone, an unknown word with "Add to team words", the AI grammar check down (spelling still checked),
// and Settings → AI → Fix English (new and updated install, team words). Reports page errors and
// horizontal overflow; ends with grammar-results.json.
// Usage: node docs/features/grammar-fix/mock/grammar-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7489';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.PW_CHROMIUM
    ? { executablePath: process.env.PW_CHROMIUM }
    : { channel: process.env.PW_CHANNEL ?? 'chrome' },
);
const problems = [];
const passed = [];
const send = (ctx, path, data, method = 'post') =>
  ctx.request[method](path, { data, headers: { origin: BASE } });

const FARAH = '60123110021@s.whatsapp.net';
const DRAFT = 'Hi Farah, your order have been ship. pls check you email for a update.';
const FIXED = 'Hi Farah, your order has been shipped. Please check your email for an update.';
const LONG =
  'Hi Farah, thank you for your patient. i will sent the invoice for RM480 tommorow morning lah, ' +
  'and the delivery to Bayan Lepas is confirm for Saturday 10am. ' +
  'If you need a extra tray of nasi lemak, pls tell us before Thursday ya.';
const MALAY = 'Boleh, saya check dulu ya. Nanti saya update you.';
const UNKNOWN = 'Hi Farah, the cendol is RM4 today. ';

const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const mobile = sizeName === 'mobile';
    const ctx = await browser.newContext({
      ...size,
      baseURL: BASE,
      colorScheme: scheme,
      timezoneId: 'Asia/Kuala_Lumpur',
    });
    const login = await send(ctx, '/api/auth/login', {
      username: 'aisyah',
      password: 'demo-pass-123',
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    const grammar = (body) => send(ctx, '/api/mock/grammar', body, 'put');
    await grammar({ install: 'new', mode: 'normal' });
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
    const box = () => page.getByRole('textbox', { name: /message/i });
    const type = async (text) => {
      await box().fill('');
      await box().fill(text);
    };
    const marksReady = (n) =>
      page.waitForFunction(
        (count) =>
          document.querySelectorAll('[data-testid=grammar-marks] [data-issue]').length === count,
        n,
        { timeout: 8_000 },
      );
    /** Hover (desktop) or tap (phone) the underlined word. */
    const pointAt = async (word) => {
      const rect = await page.evaluate((w) => {
        const span = [...document.querySelectorAll('[data-issue]')].find(
          (s) => s.textContent === w,
        );
        const r = span?.getBoundingClientRect();
        return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, word);
      if (!rect) throw new Error(`no underline for ${word}`);
      if (mobile) await page.touchscreen.tap(rect.x, rect.y);
      else await page.mouse.move(rect.x, rect.y);
      await page.getByTestId('grammar-card').waitFor({ timeout: 3_000 });
    };

    await page.goto(`/chats/${encodeURIComponent(FARAH)}`);
    await box().waitFor();

    await step('spelling at once', async () => {
      await type(DRAFT);
      // Before the 700 ms pause: only the dictionary's spelling mark, no AI request yet.
      await marksReady(1);
      const grammarMarks = await page.locator('[data-issue].decoration-info').count();
      if (grammarMarks) throw new Error('grammar marks before the pause');
      await shot('00-spelling-at-once');
    });
    await step('underlines', async () => {
      await marksReady(5);
      await page.getByTestId('grammar-fix-all').waitFor();
      await shot('01-underlines');
    });
    await step('card', async () => {
      await pointAt('have');
      await shot('02-card');
    });
    await step('accept one', async () => {
      await page.getByTestId('grammar-accept').click();
      await marksReady(4);
      const value = await box().inputValue();
      if (!value.includes('order has been')) throw new Error(`accept gave: ${value}`);
      await shot('03-one-fixed');
    });
    await step('fix all', async () => {
      await type(DRAFT);
      await marksReady(5);
      await page.getByTestId('grammar-fix-all').click();
      await page.getByTestId('grammar-undo').waitFor();
      const value = await box().inputValue();
      if (value !== FIXED) throw new Error(`fix all gave: ${value}`);
      await shot('04-fixed-undo');
    });
    await step('undo', async () => {
      await page.getByRole('button', { name: /undo/i }).click();
      const value = await box().inputValue();
      if (value !== DRAFT) throw new Error(`undo gave: ${value}`);
      await marksReady(5);
    });
    if (!mobile)
      await step('ctrl+j', async () => {
        await box().focus();
        await page.keyboard.press('Control+j');
        const value = await box().inputValue();
        if (value !== FIXED) throw new Error(`Ctrl+J gave: ${value}`);
      });
    await step('clean', async () => {
      await type(FIXED);
      await page.getByTestId('grammar-clean').waitFor({ timeout: 8_000 });
      await shot('05-no-mistakes');
    });
    await step('ignore', async () => {
      await type(DRAFT);
      await marksReady(5);
      await pointAt('you');
      await page.getByTestId('grammar-ignore').click();
      await marksReady(4);
    });
    await step('malay', async () => {
      await type(MALAY);
      await page.waitForTimeout(1_500);
      const marks = await page.locator('[data-issue]').count();
      const pill = await page.getByTestId('grammar-fix-all').count();
      if (marks || pill) throw new Error('Malay text was checked');
      await shot('06-malay-not-checked');
    });
    await step('long', async () => {
      await type(LONG);
      await marksReady(7);
      // "nasi lemak" and "Bayan Lepas" are team words (from Business context): never marked.
      const marked = await page.locator('[data-issue]').allTextContents();
      if (marked.some((w) => /lemak|lepas|bayan|nasi/i.test(w)))
        throw new Error(`team word marked: ${marked}`);
      await shot('07-long-draft');
    });
    await step('unknown word', async () => {
      await type(UNKNOWN);
      await marksReady(1);
      await pointAt('cendol');
      await page.getByTestId('grammar-add-word').waitFor();
      await shot('11-unknown-word');
      await page.getByTestId('grammar-add-word').click();
      await marksReady(0);
    });
    await step('unavailable', async () => {
      await grammar({ mode: 'expired' });
      await page.reload();
      await box().waitFor();
      await type(DRAFT);
      await page.getByTestId('grammar-unavailable').waitFor({ timeout: 8_000 });
      // Spelling needs no AI: "pls" is still marked and fixable.
      await marksReady(1);
      await page.getByTestId('grammar-fix-all').waitFor();
      await shot('08-grammar-unavailable');
      await grammar({ mode: 'normal' });
    });
    await step('settings', async () => {
      await page.goto('/admin/settings/ai');
      const card = page.getByTestId('grammar-settings');
      await card.waitFor();
      await card.scrollIntoViewIfNeeded();
      await shot('09-settings-new-install');
      await grammar({ install: 'upgraded' });
      await page.reload();
      await page.getByTestId('grammar-settings').scrollIntoViewIfNeeded();
      await shot('10-settings-updated-install');
      await grammar({ install: 'new' });
      await page.reload();
      const words = page.getByTestId('team-words');
      await words.waitFor();
      await words.getByText('cendol', { exact: true }).waitFor({ timeout: 5_000 });
      await words.scrollIntoViewIfNeeded();
      await shot('12-team-words');
    });
    // Leave the list as seeded for the next context.
    await send(ctx, `/api/mock/grammar/words/cendol`, undefined, 'delete');
    await ctx.close();
  }

await browser.close();
const result = { passed: passed.length, problems };
writeFileSync(join(OUT, 'grammar-results.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = problems.length ? 1 : 0;
