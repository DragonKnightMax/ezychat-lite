// Screenshots of the GitHub connector in the real app, against e2e/agents-devbuild.ts (mock model, fake
// WhatsApp, FakeGitHub: never calls GitHub or a model). Desktop 1280 px and mobile 360 px, light and
// dark: gallery card, Overview not signed in, device code, not installed, connected, Settings (no repos,
// picker, repos chosen and saved), Activity, agent page row, sign-in expired, GitHub down, token form
// with the classic-token error. Reports page errors and horizontal overflow.
// Needs the built web app (npm run build -w apps/web): the dev build serves apps/web/dist.
// Usage: node e2e/github-screens.mjs <port> <outDir>
/* global document -- used inside page.evaluate (runs in the browser) */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, join } from 'node:path';

const PORT = Number(process.argv[2] ?? 7491);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535)
  throw new Error('The port must be an integer between 1024 and 65535.');
const BASE = `http://127.0.0.1:${PORT}`;
const inside = (base, path) => {
  const rel = relative(base, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const repo = resolve(import.meta.dirname, '..');
const OUT = resolve(repo, process.argv[3] ?? 'github-screens');
if (!inside(repo, OUT) && !inside(resolve(tmpdir()), OUT))
  throw new Error('The output folder must be inside the repository or the temp folder.');
mkdirSync(OUT, { recursive: true });

const health = await fetch(BASE + '/api/health');
if (health.headers.get('x-agents-devbuild') !== 'mock-ai')
  throw new Error('Run this only against e2e/agents-devbuild.ts (mock model)');

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
      locale: 'en-US',
      timezoneId: 'Asia/Kuala_Lumpur',
    });
    const req = (method, path, data) =>
      ctx.request.fetch(path, { method, data, headers: { origin: BASE } });
    await req('POST', '/api/auth/login', { username: 'checker', password: 'check-pass-123' });
    // Every context starts signed out, installed, GitHub answering.
    await req('POST', '/api/connectors/github/disconnect');
    await req('POST', '/api/dev/fake-github', { mode: 'ok', installed: true });
    const agent = (await (await req('GET', '/api/ai')).json()).agents[0];

    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name, opts = {}) => {
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`), ...opts });
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
    const gh = async (tab = 'overview') => {
      await page.goto(`/admin/connectors/github?tab=${tab}`);
      await page.getByTestId('connector-page-github').waitFor();
    };

    await step('gallery', async () => {
      await page.goto('/admin/connectors');
      await page.getByTestId('connectors-gallery').waitFor();
      await page.getByTestId('connector-card-github').scrollIntoViewIfNeeded();
      await shot('01-gallery');
    });
    await step('not-installed', async () => {
      await req('POST', '/api/dev/fake-github', { installed: false });
      await gh();
      await account().waitFor();
      await shot('02-overview-not-connected', { fullPage: true });
      await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
      await dialog().getByTestId('github-device-code').waitFor();
      await shot('03-device-code');
      await req('POST', '/api/dev/fake-github/device', { action: 'approve' });
      await account().getByRole('button', { name: 'Check again' }).waitFor({ timeout: 15_000 });
      await account().scrollIntoViewIfNeeded();
      await shot('04-not-installed');
    });
    await step('connected', async () => {
      await req('POST', '/api/dev/fake-github', { installed: true });
      await account().getByRole('button', { name: 'Check again' }).click();
      await account().getByRole('button', { name: 'Disconnect' }).waitFor();
      // Settings are kept across sign-ins: start each run with no repositories (needs a sign-in).
      await req('PUT', `/api/connectors/github/agents/${agent.id}`, {
        repos: [],
        issues: true,
        pulls: true,
      });
      await shot('05-connected', { fullPage: true });
    });
    await step('settings', async () => {
      await gh('settings');
      await page.getByTestId('github-settings').waitFor();
      await shot('06-settings-no-repos', { fullPage: true });
      await page.getByRole('button', { name: 'Choose repositories' }).click();
      await dialog().getByTestId('github-picker').waitFor();
      for (const name of ['helpdesk', 'website'])
        await dialog().getByText(name, { exact: true }).click();
      await shot('07-repo-picker');
      await dialog()
        .getByRole('button', { name: /^Add 2/ })
        .click();
      await page.getByTestId('github-repo-list').waitFor();
      await shot('08-repos-chosen', { fullPage: true });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForTimeout(600);
    });
    await step('activity', async () => {
      await gh('activity');
      await shot('09-activity');
    });
    await step('agent', async () => {
      await page.goto(`/admin/members/ai/${agent.id}`);
      const card = page.getByTestId('agent-connectors');
      await card.waitFor();
      await card.scrollIntoViewIfNeeded();
      await shot('10-agent-connectors');
    });
    await step('unavailable', async () => {
      await req('POST', '/api/dev/fake-github', { mode: 'unavailable' });
      await req('POST', '/api/connectors/github/check');
      await gh();
      await account().scrollIntoViewIfNeeded();
      await shot('11-unavailable');
      await req('POST', '/api/dev/fake-github', { mode: 'ok' });
    });
    await step('token', async () => {
      await req('POST', '/api/connectors/github/disconnect');
      await gh();
      await page.getByRole('button', { name: 'Use a token instead' }).click();
      await dialog().getByTestId('github-token').waitFor();
      await dialog()
        .getByLabel('Fine-grained token')
        .fill('ghp_classic0000000000000000000000000000');
      await dialog().getByRole('button', { name: 'Check and save' }).click();
      await dialog().getByRole('alert').waitFor();
      await shot('12-token-classic');
      await page.keyboard.press('Escape');
    });
    await ctx.close();
  }

await browser.close();
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ passed, problems }, null, 2));
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
if (problems.length) process.exitCode = 1;
