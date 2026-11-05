// Screenshots of the proposed phrase list (ai-phrase-dictionary) in the running seeded mock
// (run.ts --fake-wa), at desktop 1280 px and mobile 360 px (touch), light and dark: Settings → AI
// with the model choice and the Phrase list card (ready, building, empty, error, switched off), the
// phrase list dialog (all, Malay, add, edit), and instant grey text from a phrase in the composer
// (English, half-typed word, Malay, Chinese) next to the model completion when no phrase matches.
// Reports page errors, horizontal overflow and how fast phrase grey text shows.
// Usage: node docs/features/ai-phrase-dictionary/mock/phrase-shots.mjs [baseUrl]
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
const timings = [];
const NURUL = '60126677889@s.whatsapp.net';
const SITI = '60131234567@s.whatsapp.net';
const TAN = '60127020388@s.whatsapp.net';
const post = (ctx, path, data, method = 'post') =>
  ctx.request[method](path, { data, headers: { origin: BASE } });

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
    await post(
      ctx,
      '/api/mock/reply-suggestions',
      { install: 'new', mode: 'normal', enabled: true },
      'put',
    );
    await post(ctx, '/api/mock/phrases/state', { state: 'ready' }, 'put');
    await post(ctx, '/api/mock/suggest-model', { model: 'fast' }, 'put');
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name, opts = {}) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`), ...opts });
    };
    const card = page.getByTestId('phrase-dictionary-settings');
    const openSettings = async () => {
      await page.goto('/admin/settings/ai');
      await card.waitFor();
      await page.getByTestId('reply-suggestions-settings').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    };

    // Settings → AI: the model choice and the phrase list card.
    await openSettings();
    await shot('01-settings-model');
    await card.scrollIntoViewIfNeeded();
    await shot('02-phrase-card');
    await page.getByTestId('suggest-model').scrollIntoViewIfNeeded();
    await page.getByTestId('suggest-model').click();
    await page.getByRole('listbox').waitFor();
    await page.waitForTimeout(400);
    await shot('03-model-choices');
    await page.keyboard.press('Escape');

    // The list.
    await card.getByRole('button', { name: 'View phrases' }).click();
    const list = page.getByTestId('phrase-list');
    await list.waitFor();
    // Wait for the dialog's open animation to end.
    await page.waitForTimeout(500);
    await shot('04-phrase-list');
    await list.locator('label', { hasText: 'Bahasa Melayu' }).click();
    await shot('05-phrase-list-malay');
    await list.locator('label', { hasText: /^All$/ }).click();
    await list.getByRole('button', { name: 'Add phrase' }).click();
    await list
      .getByRole('textbox', { name: 'Add phrase' })
      .fill('We are closed on the first Monday of each month.');
    if (await list.getByRole('button', { name: 'Save phrase' }).isDisabled())
      problems.push(`${suffix} Save phrase is disabled after typing a phrase`);
    // The button fades from grey to teal (transition-colors).
    await page.waitForTimeout(400);
    await shot('06-phrase-add');
    await list.getByRole('button', { name: 'Cancel' }).click();
    await list.getByRole('button', { name: 'Edit phrase' }).first().click();
    await page.waitForTimeout(400);
    await shot('07-phrase-edit');
    await page.keyboard.press('Escape');

    // Card states.
    for (const [name, state] of [
      ['08-building', 'building'],
      ['09-empty', 'empty'],
      ['10-error', 'error'],
    ]) {
      await post(ctx, '/api/mock/phrases/state', { state }, 'put');
      await openSettings();
      await card.scrollIntoViewIfNeeded();
      await shot(name);
    }
    await post(ctx, '/api/mock/phrases/state', { state: 'ready' }, 'put');
    await post(ctx, '/api/mock/reply-suggestions', { enabled: false }, 'put');
    await openSettings();
    await card.scrollIntoViewIfNeeded();
    await shot('11-switched-off');
    await post(ctx, '/api/mock/reply-suggestions', { enabled: true }, 'put');

    // Composer: instant grey text from a phrase, then the model when no phrase matches.
    const box = () => page.getByRole('textbox', { name: 'Message' });
    const ghost = page.getByTestId('completion-ghost');
    const typeAndWatch = async (jid, typed, name, waitMs = 1_500) => {
      await page.goto(`/chats/${encodeURIComponent(jid)}`);
      await page.getByTestId('suggest-reply').waitFor();
      await box().click();
      await box().fill('');
      await page.keyboard.type(typed, { delay: 140 });
      const typedAt = Date.now();
      let shownAfter = null;
      while (Date.now() - typedAt < waitMs) {
        if ((await ghost.getAttribute('class')) !== 'hidden') {
          shownAfter = Date.now() - typedAt;
          break;
        }
        await page.waitForTimeout(20);
      }
      timings.push(
        `${suffix} ${name}: ${shownAfter === null ? 'no grey text' : `${shownAfter} ms after the last key`}`,
      );
      await shot(name);
    };
    await typeAndWatch(NURUL, 'Thank you for ', '12-phrase-english');
    await typeAndWatch(NURUL, 'Our open', '13-phrase-half-word');
    await typeAndWatch(SITI, 'Terima kasih ', '14-phrase-malay');
    await typeAndWatch(TAN, '谢谢您', '15-phrase-chinese');
    await typeAndWatch(NURUL, 'Hi Nurul! Two Nasi ', '16-model-when-no-phrase', 3_000);

    await ctx.close();
  }

await browser.close();
console.log(problems.length ? `Problems:\n${problems.join('\n')}` : 'No problems found.');
console.log(timings.join('\n'));
console.log(`Saved the ai-phrase-dictionary screenshots in ${OUT}`);
