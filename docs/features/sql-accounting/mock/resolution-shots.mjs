// Screenshots of the proposed Closing chats card (ai-handoff-rules) in the running seeded mock
// (run.ts --fake-wa), at desktop 1280 px and mobile 360 px (touch), light and dark: the sales agent's
// card off (its default: no check-in line, the team closes chats) and on (clear-yes rule), each with
// the dashed Mock only preview of the same two customer messages, plus the whole agent page around it.
// Reports page errors and horizontal overflow; ends with resolution-results.json.
// Usage: node docs/features/ai-handoff-rules/mock/resolution-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7489';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
// This PC has no Playwright Chromium: use PW_CHROMIUM when set, else the installed Chrome.
const browser = await chromium.launch(
  process.env.PW_CHROMIUM
    ? { executablePath: process.env.PW_CHROMIUM }
    : { channel: process.env.PW_CHANNEL ?? 'chrome' },
);
const problems = [];
const passed = [];
const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const ctx = await browser.newContext({ ...size, baseURL: BASE, colorScheme: scheme });
    const login = await ctx.request.post('/api/auth/login', {
      data: { username: 'aisyah', password: 'demo-pass-123' },
      headers: { origin: BASE },
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    await page.goto('/admin/members/ai/a1');
    const card = page.getByTestId('agent-resolution');
    await card.waitFor();
    const sw = page.getByTestId('resolution-check');
    for (const state of ['off', 'on']) {
      if ((await sw.getAttribute('aria-checked')) !== String(state === 'on')) await sw.click();
      await page.waitForTimeout(300);
      const hint = await card.textContent();
      const want = state === 'on' ? 'Does that answer your question?' : 'How many do you need?';
      if (!hint.includes(want)) problems.push(`${suffix} ${state}: preview misses "${want}"`);
      if (state === 'off' && hint.includes('Does that answer'))
        problems.push(`${suffix} off: a check-in line is shown`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${state}: horizontal overflow`);
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: join(OUT, `closing-chats-${state}-${suffix}.png`) });
      passed.push(`closing-chats-${state}-${suffix}`);
    }
    // The switch survives a reload (kept per agent).
    await page.reload();
    await card.waitFor();
    if ((await sw.getAttribute('aria-checked')) !== 'true')
      problems.push(`${suffix}: switch lost after reload`);
    await sw.click();
    await page.screenshot({ path: join(OUT, `agent-page-${suffix}.png`), fullPage: true });
    passed.push(`agent-page-${suffix}`);
    await ctx.close();
  }
await browser.close();
writeFileSync(join(OUT, 'resolution-results.json'), JSON.stringify({ passed, problems }, null, 2));
console.log(`${passed.length} shots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
