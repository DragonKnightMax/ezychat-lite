// Screenshots of the proposed "Upgrade to Enterprise" links in the running seeded mock (run.ts --fake-wa),
// at desktop 1280 px and mobile 360 px, light and dark, in the Lite view: Admin → Members (one AI agent
// note), the AI agent limit page, Admin → WhatsApp, the account menu (admin) and the About dialog; plus the
// Enterprise view of the same screens (no links) and an agent's account menu (no link). Checks that each
// link points at https://ezychat.ai/#enterprise with target _blank (the mock runner blocks outside pages). Reports page errors and horizontal overflow.
// Usage: node docs/features/upgrade-enterprise/mock/upgrade-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7487';
const OUT = join(import.meta.dirname, 'screenshots');
const URL = 'https://ezychat.ai/#enterprise';
mkdirSync(OUT, { recursive: true });
const browser = await chromium
  .launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
  .catch(() => chromium.launch({ channel: 'chrome' }));
const problems = [];

async function session(user, edition, scheme, size) {
  const ctx = await browser.newContext({ viewport: size, baseURL: BASE, colorScheme: scheme });
  await ctx.addInitScript((e) => localStorage.setItem('mock.customAgents.edition.v1', e), edition);
  // Never leave the machine: the upgrade page is only checked by its address.
  await ctx.route('https://ezychat.ai/**', (r) => r.fulfill({ status: 204, body: '' }));
  const login = await ctx.request.post('/api/auth/login', {
    data: { username: user, password: 'demo-pass-123' },
    headers: { origin: BASE },
  });
  if (!login.ok()) throw new Error(`login ${user} failed ${login.status()}`);
  const page = await ctx.newPage();
  page.on('pageerror', (e) =>
    problems.push(`${user} ${edition} ${scheme} pageerror: ${e.message}`),
  );
  return { ctx, page };
}

async function check(page, name, label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  if (overflow) problems.push(`${label} ${name}: horizontal scroll`);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

async function expectLink(locator, label) {
  const href = await locator.getAttribute('href');
  const target = await locator.getAttribute('target');
  if (href !== URL || target !== '_blank') problems.push(`${label}: link ${href} target ${target}`);
}

async function count(page, selector) {
  return page.locator(selector).count();
}

async function openMenu(page) {
  await page.getByRole('button', { name: 'Account menu' }).first().click();
  await page.getByRole('menu').waitFor();
}

const sizes = { desktop: { width: 1280, height: 860 }, mobile: { width: 360, height: 780 } };
for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}${scheme === 'dark' ? '-dark' : ''}`;
    const label = `lite ${suffix}`;
    const { ctx, page } = await session('aisyah', 'lite', scheme, size);

    await page.goto('/admin/members');
    await page.getByTestId('upgrade-note').waitFor();
    await expectLink(page.getByTestId('upgrade-enterprise'), `${label} members`);
    await check(page, `members-${suffix}`, label);

    await page.goto('/admin/members/ai/new?preset=faq');
    await page.getByTestId('upgrade-enterprise').waitFor();
    await check(page, `agent-limit-${suffix}`, label);

    await page.goto('/admin/whatsapp');
    await page.getByTestId('upgrade-note').waitFor();
    await check(page, `whatsapp-${suffix}`, label);

    await page.goto('/');
    await openMenu(page);
    await expectLink(page.getByTestId('menu-upgrade'), `${label} menu`);
    await check(page, `menu-${suffix}`, label);
    await page.keyboard.press('Escape');

    await openMenu(page);
    await page.getByRole('menuitem', { name: /^About/ }).click();
    await page.getByTestId('about-upgrade').waitFor();
    await page.waitForTimeout(600); // the sheet slides in
    await page.getByTestId('about-upgrade').scrollIntoViewIfNeeded();
    await check(page, `about-${suffix}`, label);
    await ctx.close();
  }

// Enterprise view: no link anywhere (desktop light).
{
  const { ctx, page } = await session('aisyah', 'enterprise', 'light', sizes.desktop);
  for (const path of ['/admin/members', '/admin/members/ai/new?preset=faq']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    if (await count(page, '[data-testid="upgrade-enterprise"]'))
      problems.push(`enterprise ${path}: upgrade link shown`);
  }
  await page.goto('/');
  await openMenu(page);
  if (await count(page, '[data-testid="menu-upgrade"]'))
    problems.push('enterprise menu: link shown');
  await check(page, 'enterprise-menu-desktop', 'enterprise');
  await page.getByRole('menuitem', { name: /^About/ }).click();
  await page.getByRole('dialog').waitFor();
  if (await count(page, '[data-testid="about-upgrade"]'))
    problems.push('enterprise about: link shown');
  await check(page, 'enterprise-about-desktop', 'enterprise');
  await ctx.close();
}

// An agent (not admin) in Lite: no menu link; About still shows it.
{
  const { ctx, page } = await session('daniel', 'lite', 'light', sizes.desktop);
  await page.goto('/');
  await openMenu(page);
  if (await count(page, '[data-testid="menu-upgrade"]')) problems.push('agent menu: link shown');
  await check(page, 'agent-menu-desktop', 'agent');
  await ctx.close();
}

await browser.close();
console.log(problems.length ? `Problems:\n${problems.join('\n')}` : 'No problems found.');
console.log(`Saved the upgrade-enterprise screenshots in ${OUT}`);
