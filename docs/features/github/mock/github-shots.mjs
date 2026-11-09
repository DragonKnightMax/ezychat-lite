// Screenshots of the proposed GitHub connector (github) in the running seeded mock (run.ts --fake-wa),
// desktop 1280 px and mobile 360 px (touch), light and dark: the gallery card, Overview (not connected,
// device code, not installed, connected, token form with an error, token connected and expiring),
// Settings (no repositories, picker, repositories chosen, a repo no longer shared), the agent page
// Connectors row, the Mock only chat simulator (issue, other repo, issue text with orders), Activity,
// and sign-in expired with Settings paused. State lives in the browser (localStorage), so every
// context starts empty. Reports page errors and horizontal overflow; ends with screenshots/results.json.
// Usage: node docs/features/github/mock/github-shots.mjs [baseUrl]
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
    const account = () => page.getByTestId('github-account');

    await step('gallery', async () => {
      await page.goto('/admin/connectors');
      await page.getByTestId('connector-card-github').scrollIntoViewIfNeeded();
      await shot('01-gallery');
    });
    await step('overview', async () => {
      await page.goto('/admin/connectors/github');
      await account().waitFor();
      await shot('02-overview-not-connected', true);
      await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
      await dialog().getByTestId('github-device-code').waitFor();
      await shot('03-device-code');
      await dialog().getByRole('button', { name: 'Let the code expire' }).click();
      await shot('04-device-expired');
      await dialog().getByRole('button', { name: 'Approve, app not installed' }).click();
      await account().getByText('Install EzyChat on GitHub').waitFor();
      await account().scrollIntoViewIfNeeded();
      await shot('05-not-installed');
      await account().getByRole('button', { name: 'Check again' }).click();
      await account().getByText('Change on GitHub').waitFor();
      await shot('06-connected-app');
    });
    await step('settings', async () => {
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByTestId('github-settings').waitFor();
      await shot('07-settings-no-repos', true);
      await page.getByRole('button', { name: 'Choose repositories' }).click();
      await dialog().waitFor();
      for (const name of ['pos-app', 'ordering-website', 'docs'])
        await dialog().getByText(name, { exact: true }).click();
      await shot('08-repo-picker');
      await dialog()
        .getByRole('button', { name: /^Add 3/ })
        .click();
      await page.getByTestId('github-repo-list').scrollIntoViewIfNeeded();
      await shot('09-repos-chosen', true);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForTimeout(300);
    });
    await step('simulator', async () => {
      const sim = page.getByTestId('github-simulator');
      await sim.getByRole('button', { name: 'Asks about a bug' }).click();
      await sim.scrollIntoViewIfNeeded();
      await shot('10-sim-issue');
      await sim.getByRole('button', { name: 'Asks about another repo' }).click();
      await shot('11-sim-other-repo');
      await sim.getByRole('button', { name: 'Issue text gives orders' }).click();
      await shot('12-sim-inject');
    });
    await step('unshared', async () => {
      await page.getByRole('button', { name: 'Choose repositories' }).click();
      await dialog().getByRole('button', { name: 'Unshare docs on GitHub' }).click();
      await page.keyboard.press('Escape');
      await page.getByTestId('github-repo-list').scrollIntoViewIfNeeded();
      await shot('13-repo-unshared');
    });
    await step('activity', async () => {
      await page.getByRole('tab', { name: 'Activity' }).click();
      await shot('14-activity');
    });
    await step('agent', async () => {
      await page.goto('/admin/members/ai/a1');
      const card = page.getByTestId('agent-connectors');
      await card.waitFor();
      await card.scrollIntoViewIfNeeded();
      await shot('15-agent-connectors');
    });
    await step('expired', async () => {
      await page.goto('/admin/connectors/github?tab=overview');
      await page
        .getByTestId('mock-github-controls')
        .getByRole('button', { name: 'Sign-in expired' })
        .click();
      await account().scrollIntoViewIfNeeded();
      await shot('16-expired');
      await page.getByRole('tab', { name: 'Settings' }).click();
      await shot('17-settings-paused');
    });
    await step('token', async () => {
      await page.goto('/admin/connectors/github?tab=overview');
      await account().getByRole('button', { name: 'Disconnect' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
      await page.getByRole('button', { name: 'Use a token instead' }).click();
      await dialog().getByTestId('github-token').waitFor();
      await dialog().getByLabel('Fine-grained token').fill('ghp_abc123');
      await dialog().getByRole('button', { name: 'Check and save' }).click();
      await shot('18-token-classic');
      await dialog().getByLabel('Fine-grained token').fill('github_pat_11ABCDEF');
      await dialog().getByRole('button', { name: 'Check and save' }).click();
      await account().getByText('Signed in with a token').waitFor();
      await page
        .getByTestId('mock-github-controls')
        .getByRole('button', { name: 'Token expires in 5 days' })
        .click();
      await account().scrollIntoViewIfNeeded();
      await shot('19-token-expiring');
    });
    await ctx.close();
  }

await browser.close();
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ passed, problems }, null, 2));
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
