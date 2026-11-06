// Screenshots of the proposed concept tips in the running mock, desktop 1280 px and mobile 360 px (touch),
// light and dark. Seeded run (run.ts --fake-wa): each admin screen with its "?" open. Fresh run
// (run.ts --fresh --fake-wa on a new server; it fills the account step itself): the setup wizard's WhatsApp and AI assistant steps.
// Reports page errors, horizontal overflow and a tip card that leaves the screen; ends with tips-results.json.
// Usage: node docs/features/ai-handoff-rules/mock/tips-shots.mjs [baseUrl] [seeded|fresh]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7489';
const RUN = process.argv[3] ?? 'seeded';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
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

/** Admin screens: [name, path, tip topic, optional step before opening the tip]. */
const SEEDED = [
  ['settings-voice', '/admin/settings/ai', 'voice', 'details'],
  ['settings-ai-connection', '/admin/settings/ai', 'aiConnection'],
  ['settings-ai-key', '/admin/settings/ai', 'apiKey', 'Replace key'],
  ['settings-ai-model', '/admin/settings/ai', 'aiModel', 'Advanced: choose a model'],
  ['settings-lan', '/admin/settings/general', 'lan'],
  ['settings-mcp', '/admin/settings/integrations', 'mcp'],
  ['settings-token', '/admin/settings/integrations', 'accessToken'],
  ['agent-context', '/admin/members/ai/a1', 'businessContext'],
  ['agent-role', '/admin/members/ai/a1', 'instructions', 'details'],
  ['agent-handover', '/admin/members/ai/a1', 'handoff', 'details'],
  ['agent-try', '/admin/members/ai/a1', 'tryIt'],
  ['tunnel', '/admin/tunnel', 'tunnel'],
  ['connectors', '/admin/connectors', 'connectors'],
];

async function overflow(page, label) {
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  if (wide) problems.push(`${label}: horizontal overflow`);
}

async function openTip(page, topic, label, file) {
  const trigger = page.locator(`[data-tip="${topic}"]:visible`).first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const card = page.locator('[data-slot="popover-content"]');
  await card.waitFor();
  await page.waitForTimeout(250);
  const box = await card.boundingBox();
  const vw = page.viewportSize().width;
  if (!box || box.x < 0 || box.x + box.width > vw + 1)
    problems.push(`${label}: tip card off screen`);
  await page.screenshot({ path: join(OUT, `${file}.png`) });
  const more = card.getByRole('button', { name: /Show steps/ });
  if (await more.count()) {
    await more.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `${file}-steps.png`) });
  }
  passed.push(label);
  await page.keyboard.press('Escape');
  await card.waitFor({ state: 'detached' });
}

for (const scheme of RUN === 'seeded' ? ['light', 'dark'] : [])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const ctx = await browser.newContext({ ...size, baseURL: BASE, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    if (RUN === 'seeded') {
      const login = await ctx.request.post('/api/auth/login', {
        data: { username: 'aisyah', password: 'demo-pass-123' },
        headers: { origin: BASE },
      });
      if (!login.ok()) throw new Error(`login failed ${login.status()}`);
      for (const [name, path, topic, step] of SEEDED) {
        const label = `${name} ${suffix}`;
        try {
          await page.goto(path);
          await page.locator('[data-tip]').first().waitFor();
          if (step && step !== 'details') await page.getByRole('button', { name: step }).click();
          if (step === 'details')
            await page.evaluate((t) => {
              let el = document.querySelector(`[data-tip="${t}"]`);
              while ((el = el?.parentElement)) if (el.tagName === 'DETAILS') el.open = true;
            }, topic);
          await overflow(page, label);
          await openTip(page, topic, label, `${name}-${suffix}`);
        } catch (e) {
          problems.push(`${label}: ${e.message.split('\n')[0]}`);
        }
      }
    }
    await ctx.close();
  }

if (RUN === 'fresh') {
  // One first-time setup per fresh server: walk the wizard once, then capture each step in every
  // size and theme by changing the viewport and colour scheme of the same page.
  const ctx = await browser.newContext({ ...sizes.desktop, baseURL: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`fresh pageerror: ${e.message}`));
  await page.goto('/');
  await page.getByLabel('Business name').fill('Kopi Apong');
  await page.getByLabel('Your name').fill('Aisyah');
  await page.getByLabel('Password', { exact: true }).fill('demo-pass-123');
  await page.locator('button[type="submit"]').click();
  const variants = async (name, topic, before) => {
    for (const scheme of ['light', 'dark'])
      for (const [sizeName, size] of Object.entries(sizes)) {
        const label = `${name} ${sizeName}-${scheme}`;
        try {
          await page.emulateMedia({ colorScheme: scheme });
          await page.setViewportSize(size.viewport);
          if (before) await before();
          await page.locator(`[data-tip="${topic}"]`).first().waitFor({ timeout: 8000 });
          await overflow(page, label);
          await openTip(page, topic, label, `${name}-${sizeName}-${scheme}`);
        } catch (e) {
          problems.push(`${label}: ${e.message.split('\n')[0]}`);
        }
      }
  };
  await variants('setup-whatsapp', 'whatsappLink');
  await page.getByRole('button', { name: /skip/i }).first().click();
  await variants('setup-ai', 'aiConnection');
  await variants('setup-ai-business', 'businessContext');
  await page.getByRole('button', { name: /OpenAI API key instead/i }).click();
  await variants('setup-ai-key', 'apiKey');
  await page.getByRole('button', { name: /ChatGPT instead/i }).click();
  await page.getByRole('button', { name: /Claude API key instead/i }).click();
  await variants('setup-ai-claude-key', 'claudeKey');
  await ctx.close();
}

await browser.close();
writeFileSync(
  join(OUT, `tips-results-${RUN}.json`),
  `${JSON.stringify({ passed: passed.length, problems }, null, 2)}\n`,
);
console.log(`passed ${passed.length}, problems ${problems.length}`);
for (const p of problems) console.log(`  ${p}`);
