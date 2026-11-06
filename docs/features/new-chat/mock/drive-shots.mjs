// Screenshots of the proposed Google Drive connector (google-drive) in the running seeded mock
// (run.ts --fake-wa), desktop 1280 px and mobile 360 px (touch), light and dark: the gallery card,
// Overview (not connected, consent, connected, expired), Settings (no folder, folder picker, folder
// chosen, Save files on with its rules, file picker, files listed, a file with no text), the agent
// page Connectors row, the Mock only chat simulator (saved, read, locked) and Activity.
// State lives in the browser (localStorage), so every context starts empty.
// Reports page errors and horizontal overflow; ends with screenshots/results.json.
// Usage: node docs/features/google-drive/mock/drive-shots.mjs [baseUrl]
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
    const shot = async (name, full = false) => {
      await page.waitForTimeout(450);
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

    await step('gallery', async () => {
      await page.goto('/admin/connectors');
      await page.getByText('Google Drive').first().scrollIntoViewIfNeeded();
      await shot('01-gallery');
    });
    await step('overview', async () => {
      await page.goto('/admin/connectors/google-drive');
      await page.getByTestId('google-drive-account').waitFor();
      await shot('02-overview-not-connected', true);
      await page.getByRole('button', { name: 'Connect Google Drive' }).click();
      await dialog().waitFor();
      await shot('03-consent');
      await dialog().getByRole('button', { name: 'Allow' }).click();
      await page.getByText('kopiapong.penang@gmail.com').first().waitFor();
      await page.getByTestId('google-drive-account').scrollIntoViewIfNeeded();
      await shot('04-overview-connected');
    });
    await step('settings', async () => {
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByTestId('drive-settings').waitFor();
      await shot('05-settings-no-folder', true);
      await page.getByRole('button', { name: 'Choose a folder' }).click();
      await dialog().waitFor();
      await dialog().getByText('Customer files from WhatsApp').click();
      await shot('06-folder-picker');
      await dialog().getByRole('button', { name: 'Select' }).click();
      await page.getByRole('switch', { name: 'Save files' }).click();
      await page.getByTestId('drive-save').scrollIntoViewIfNeeded();
      await shot('07-save-on');
      await page.getByRole('button', { name: 'Add files' }).click();
      await dialog().waitFor();
      for (const name of [
        'Menu and prices November',
        'Catering packages 2026.pdf',
        'Old flyer scan.pdf',
      ])
        await dialog().getByText(name).click();
      await shot('08-file-picker');
      await dialog().getByRole('button', { name: 'Select' }).click();
      await page.getByTestId('drive-files').scrollIntoViewIfNeeded();
      await shot('09-files');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForTimeout(300);
    });
    await step('simulator', async () => {
      const sim = page.getByTestId('drive-simulator');
      await sim.getByRole('button', { name: 'Customer sends a photo' }).click();
      await sim.scrollIntoViewIfNeeded();
      await shot('10-sim-saved');
      await sim.getByRole('button', { name: 'Customer asks a question' }).click();
      await shot('11-sim-read');
      await sim.getByRole('button', { name: 'File locked by Safety' }).click();
      await shot('12-sim-locked');
    });
    await step('activity', async () => {
      await page.getByRole('tab', { name: 'Activity' }).click();
      await shot('13-activity');
    });
    await step('agent', async () => {
      await page.goto('/admin/members/ai/a1');
      const card = page.getByTestId('agent-connectors');
      await card.waitFor();
      await card.scrollIntoViewIfNeeded();
      await shot('14-agent-connectors');
    });
    await step('expired', async () => {
      await page.goto('/admin/connectors/google-drive?tab=overview');
      await page
        .getByTestId('mock-drive-controls')
        .getByRole('button', { name: 'Sign-in expired' })
        .click();
      await page.getByTestId('google-drive-account').scrollIntoViewIfNeeded();
      await shot('15-expired');
      await page.getByRole('tab', { name: 'Settings' }).click();
      await shot('16-settings-paused');
    });
    await ctx.close();
  }

await browser.close();
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ passed, problems }, null, 2));
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
