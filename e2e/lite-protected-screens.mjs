#!/usr/bin/env node
// Screens of "EzyChat Lite runs as a background service" (phase 'protected', Allow and continue) with a fake
// desktop bridge (`window.watiLiteImport` from addInitScript; the real one exists only in the desktop window).
// Setup wizard step 0 while locked (before any account), then Admin → Inboxes → Add a number from EzyChat
// Lite in the states idle, waiting, declined and failed. 1280 and 360 px, light and dark.
//
//   npx tsx --conditions=ezychat-source packages/server/src/cli.ts --data <temp> --port 7620 \
//     --mode dev --fake-wa --web-dist apps/web/dist
//   node e2e/lite-protected-screens.mjs 7620 <outDir>
import { SIZES, launchBrowser, screensArgs, shot, signInDemoAdmin } from './screens-common.mjs';

const { base, out } = screensArgs('docs/screenshots/lite-import');
const problems = [];

/** Installs the fake bridge: every call answers with the state given (Allow moves on to `waiting`). */
function bridgeScript(unlock) {
  return `(() => {
    const state = {
      phase: 'protected', mode: null, lite: null, liteService: true, unlock: ${JSON.stringify(unlock)},
      enterprise: null, issues: [], steps: [], result: null, failure: null,
    };
    const answer = async () => state;
    window.watiLiteImport = {
      getState: answer, scan: answer, start: answer, reset: answer,
      unlock: async () => ({ ...state, unlock: 'waiting' }),
      saveSupportFile: async () => true,
      onChanged: () => () => {},
    };
  })();`;
}

async function eachSize(browser, cookie, run) {
  for (const scheme of ['light', 'dark'])
    for (const [size, options] of Object.entries(SIZES)) {
      const tag = `${size}${scheme === 'dark' ? '-dark' : ''}`;
      for (const unlock of ['idle', 'waiting', 'declined', 'failed']) {
        const ctx = await browser.newContext({ ...options, baseURL: base, colorScheme: scheme });
        if (cookie) {
          const [name, value] = cookie.split('=');
          await ctx.addCookies([{ name, value, url: base }]);
        }
        await ctx.addInitScript(bridgeScript(unlock));
        const page = await ctx.newPage();
        page.on('pageerror', (e) => problems.push(`${tag} ${unlock}: ${e.message}`));
        await run(page, tag, unlock);
        await ctx.close();
      }
    }
}

const browser = await launchBrowser();
try {
  // 1. New install: setup step 0 while Lite is locked (only the idle state; the wizard shares the Allow card).
  await eachSize(browser, '', async (page, tag, unlock) => {
    if (unlock !== 'idle') return;
    await page.goto('/setup');
    await page.getByTestId('lite-setup-bring').waitFor();
    await shot(page, out, problems, tag, 'setup-locked-choose');
    await page.getByRole('button', { name: 'Bring from EzyChat Lite' }).click();
    await page.getByTestId('lite-protected').waitFor();
    await shot(page, out, problems, tag, 'setup-locked-allow');
  });

  // 2. Admin → Inboxes → Add a number from EzyChat Lite, in every Allow state.
  const cookie = await signInDemoAdmin(base);
  await eachSize(browser, cookie, async (page, tag, unlock) => {
    await page.goto('/admin/inboxes/lite');
    await page.locator(`[data-testid="lite-protected"][data-unlock="${unlock}"]`).waitFor();
    await shot(page, out, problems, tag, `admin-locked-${unlock}`);
  });
} finally {
  await browser.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`OK: screens in ${out}`);
