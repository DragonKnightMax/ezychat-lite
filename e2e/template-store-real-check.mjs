// Dev Build check of the template store against the REAL published list (docs/features/template-store/design.md):
// starts the server from source (`cli.ts --mode dev --fake-wa`, fresh temp data, no model). With fake
// WhatsApp the server downloads nothing unless EZYCHAT_TEMPLATE_LIST_URL is set, so it is set to the
// production URL (TEMPLATE_LIST_BASE_URL, https://dl.ezychat.ai/templates/) and no test key: the list is
// verified with the built-in production keys only. Checks: the list loads and is saved; the gallery source line shows
// it; entries with the same version as the built-in templates change nothing visible; Apply → Create
// builds the agent; refresh is limited (one download per 30 s, 10 calls a minute per admin); with
// dl.ezychat.ai unreachable (a preload makes the server's fetch fail for that host only) a restart keeps
// the saved copy. The published entries need app 0.1.75 (the release that ships the template store):
// run 1 is this build's own version (list verified, every entry hidden, gallery unchanged); runs 2 and 3
// report 0.1.75 (WATI_VERSION) so the entries apply. Needs `npm run build -w @ezychat/web` first.
//   node e2e/template-store-real-check.mjs [port] [outDir]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checker } from './devbuild-client.mjs';
import { launchBrowser, screensArgs, shot, signInDemoAdmin } from './screens-common.mjs';

const { base, out } = screensArgs('.template-store-real-screens');
const port = Number(new URL(base).port);
const { check, finish } = checker();
const work = mkdtempSync(join(tmpdir(), 'tpl-store-real-'));
const dataDir = join(work, 'data');
const PRODUCTION_URL = 'https://dl.ezychat.ai/templates/'; // = TEMPLATE_LIST_BASE_URL (checked below)
const LIST_HOST = new URL(PRODUCTION_URL).hostname;
const keysSource = readFileSync(resolve('packages/server/src/templates/keys.ts'), 'utf8');
check(
  keysSource.includes(`TEMPLATE_LIST_BASE_URL = '${PRODUCTION_URL}'`),
  "the URL used is the app's built-in production URL",
);

// Preload for the offline run: the server's fetch fails for the list host only (as with no network).
const offlinePreload = join(work, 'offline.mjs');
writeFileSync(
  offlinePreload,
  `const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === ${JSON.stringify(LIST_HOST)})
    return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  return real(input, init);
};
`,
);

const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
let server = null;
function start({ offline = false, version } = {}) {
  // tsx runs the server in a child process: the source condition goes through NODE_OPTIONS.
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=ezychat-source`,
  };
  env.EZYCHAT_TEMPLATE_LIST_URL = PRODUCTION_URL;
  delete env.EZYCHAT_TEMPLATE_LIST_TEST_KEY;
  if (version) env.WATI_VERSION = version;
  else delete env.WATI_VERSION;
  if (offline)
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(offlinePreload).href}`;
  server = spawn(
    process.execPath,
    [
      '--conditions=ezychat-source',
      tsxCli,
      'packages/server/src/cli.ts',
      '--data',
      dataDir,
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--mode',
      'dev',
      '--fake-wa',
      '--web-dist',
      resolve('apps/web/dist'),
    ],
    { env, stdio: 'ignore' },
  );
}
async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server) return;
  if (server.exitCode !== null || server.signalCode !== null) return void (server = null);
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
  server = null;
}

let cookie = '';
const api = async (method, path) => {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      cookie,
      origin: base,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    body: method === 'POST' ? '{}' : undefined,
  });
  return { status: res.status, body: await res.json() };
};
async function waitState(wanted) {
  let last;
  for (let i = 0; i < 30; i++) {
    last = (await api('GET', '/ai/templates')).body;
    if (last.status.state === wanted) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

const browser = await launchBrowser();
const problems = [];
async function openGallery(path) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    baseURL: base,
    locale: 'en-US',
  });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(path);
  await page
    .getByTestId('business-templates')
    .getByRole('button', { name: 'Browse templates' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId('template-source').waitFor();
  return { ctx, page, dialog };
}

try {
  // ── Run 1: this build's own version ─────────────────────────────────────────────────────
  start();
  await waitHealthy();
  cookie = await signInDemoAdmin(base);
  const own = await waitState('loaded');
  check(
    own.status.state === 'loaded' && own.status.sequence === 1,
    `downloaded the real list from ${LIST_HOST} and verified it with the built-in keys`,
    JSON.stringify(own.status),
  );
  check(
    existsSync(join(dataDir, 'templates', 'templates-v1.json')) &&
      existsSync(join(dataDir, 'templates', 'templates-v1.json.sig')),
    'the list and its signature were saved in the data folder',
  );
  check(
    own.templates.length === 0 && own.categories.length === 6,
    'on this build (0.1.74) every entry is hidden: they need app 0.1.75',
    `${own.templates.length} templates / ${own.categories.length} categories`,
  );
  const builtinCount = 18;
  {
    const { ctx, page, dialog } = await openGallery('/admin/members/ai/new?preset=sales');
    const source = await dialog.getByTestId('template-source').textContent();
    check(
      source === 'Template library updated 4 Nov 2026.',
      '0.1.74: the gallery source line shows the real list',
      source,
    );
    check(
      (await dialog.getByRole('radio').count()) === builtinCount,
      '0.1.74: the gallery shows the 18 built-in templates',
    );
    await shot(page, out, problems, 'desktop', '01-gallery-real-list-0.1.74');
    await ctx.close();
  }
  await stopServer();

  // ── Run 2: as 0.1.75 ─────────────────────────────────────────────────────────────────────
  start({ version: '0.1.75' });
  await waitHealthy();
  cookie = await signInDemoAdmin(base);
  const loaded = await waitState('loaded');
  check(
    loaded.status.sequence === 1 &&
      loaded.templates.length === 18 &&
      loaded.categories.length === 6,
    '0.1.75: all 18 entries and 6 categories fit',
    `${loaded.templates.length} / ${loaded.categories.length}`,
  );
  check(
    loaded.templates.every((t) => t.entry.version === 1),
    'every published entry has version 1 (equal to the built-in templates)',
  );
  {
    const { ctx, page, dialog } = await openGallery('/admin/members/ai/new?preset=sales');
    const source = await dialog.getByTestId('template-source').textContent();
    check(
      source === 'Template library updated 4 Nov 2026.',
      '0.1.75: the gallery source line shows the real list',
      source,
    );
    check(
      (await dialog.getByRole('radio').count()) === builtinCount,
      'equal versions keep the built-in templates (same 18 cards, nothing added)',
    );
    const listNames = loaded.templates.map((t) => t.entry.texts.en.name).sort();
    const cards = await Promise.all(
      listNames.map(async (n) => dialog.getByRole('radio', { name: n, exact: true }).count()),
    );
    check(
      listNames.length === 18 && cards.every((c) => c === 1),
      'every list template shows once under its built-in name',
      listNames.filter((_, i) => cards[i] !== 1).join(', '),
    );
    await shot(page, out, problems, 'desktop', '02-gallery-real-list-0.1.75');

    // Apply → Create.
    const pick = loaded.templates.find((t) => t.entry.id === 'bakery');
    await dialog.getByRole('radio', { name: pick.entry.texts.en.name, exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply template' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Create agent' }).click();
    await page.waitForURL(/\/admin\/members\/ai\/\d+$/);
    const id = Number(new URL(page.url()).pathname.split('/').pop());
    const agent = (await api('GET', `/ai/agents/${id}`)).body;
    check(
      agent.settings.displayName === pick.entry.texts.en.agentName &&
        agent.documents.some((d) => d.name === pick.entry.texts.en.contextName),
      'Apply → Create agent builds the agent from the template',
      `${agent.settings.displayName} / ${agent.documents.map((d) => d.name).join(', ')}`,
    );
    await shot(page, out, problems, 'desktop', '03-agent-created');
    await ctx.close();
  }

  // Rate limits: no second download inside 30 s; the 11th call in a minute answers 429.
  const before = (await api('GET', '/ai/templates')).body.status.checkedAt;
  const answers = [];
  for (let i = 0; i < 11; i++) answers.push(await api('POST', '/ai/templates/refresh'));
  const after = (await api('GET', '/ai/templates')).body.status.checkedAt;
  check(after === before, 'refreshes inside 30 s download nothing', `${before} → ${after}`);
  check(
    answers.slice(0, 9).every((a) => a.status === 200) && answers.at(-1).status === 429,
    'refresh is rate limited (429 within a minute)',
    answers.map((a) => a.status).join(','),
  );

  // ── Offline: restart with the list host unreachable ─────────────────────────────────────
  await stopServer();
  start({ offline: true, version: '0.1.75' });
  await waitHealthy();
  cookie = await signInDemoAdmin(base);
  const offline = await waitState('offline');
  check(
    offline.status.state === 'offline' &&
      offline.status.sequence === 1 &&
      offline.templates.length === 18,
    'offline: the saved copy stays in use after a restart',
    JSON.stringify(offline.status),
  );
  {
    const { ctx, page, dialog } = await openGallery('/admin/members/ai/1');
    const text = await dialog.getByTestId('template-source').textContent();
    check(
      text.startsWith("Couldn't check for new templates"),
      'offline: the gallery says it uses the saved list',
      text,
    );
    check(
      (await dialog.getByRole('radio').count()) === builtinCount,
      'offline: the gallery still shows all 18 templates',
    );
    await shot(page, out, problems, 'desktop', '04-gallery-offline');
    await ctx.close();
  }
  check(problems.length === 0, 'no page errors or horizontal overflow', problems.join('; '));
} finally {
  await browser.close();
  await stopServer();
  rmSync(work, { recursive: true, force: true });
}
finish();
