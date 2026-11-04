// Dev Build check and screen review of the template store (docs/features/template-store/design.md).
// Builds a signed template list with a throw-away key (the publisher script + the app's 18 templates +
// one new "Event venue" template), serves it on 127.0.0.1, starts e2e/agents-devbuild.ts (mock model,
// fake WhatsApp, temp data, only loopback fetches) pointed at it, then checks through the real app:
// the list is downloaded and verified, the gallery shows it, Apply + Create builds the agent from it,
// a list with a bad signature is refused (the last good copy stays), and an offline list server keeps
// it too. Screenshots of every state at desktop 1280 / phone 360, light and dark. Never calls a model.
//   npx tsx --conditions=ezychat-source e2e/template-store-check.mjs [port] [outDir]
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeExport } from '../scripts/export-templates.mjs';
import { build } from '../docs/features/template-store/publisher/build-templates.mjs';
import { checker } from './devbuild-client.mjs';
import { SIZES, launchBrowser, screensArgs, shot, signInDemoAdmin } from './screens-common.mjs';

const { base, out } = screensArgs('.template-store-screens');
const port = Number(new URL(base).port);
const LIST_PORT = port + 110;
const { check, finish } = checker();
const work = mkdtempSync(join(tmpdir(), 'tpl-store-check-'));

// ── The signed list ──────────────────────────────────────────────────────────────────────────
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
const templatesDir = join(work, 'templates');
writeExport(templatesDir);
const venueDir = join(templatesDir, 'venue');
mkdirSync(join(venueDir, 'en'), { recursive: true });
writeFileSync(
  join(venueDir, 'template.json'),
  JSON.stringify({
    id: 'venue',
    version: 1,
    schemaVersion: 1,
    minAppVersion: '0.1.0',
    editions: ['lite', 'enterprise'],
    category: 'events',
    icon: 'party-popper',
    preset: 'sales',
    recommendedConnectors: ['google-sheets'],
    texts: {
      en: {
        agentName: 'Venue assistant',
        name: 'Event venue',
        description:
          'Answers about halls, dates, packages and deposits. Hands bookings to your team.',
        keywords: 'hall dewan wedding',
        contextName: 'Venue details',
      },
    },
  }),
);
writeFileSync(join(venueDir, 'en/focus.md'), 'BUSINESS\nYou answer for an event venue.\n');
writeFileSync(join(venueDir, 'en/handoff-rules.md'), '- The customer wants to book a date\n');
writeFileSync(join(venueDir, 'en/context.md'), 'Halls and capacity:\nPackages and prices:\n');
const cats = JSON.parse(readFileSync(join(templatesDir, 'categories.json'), 'utf8'));
cats.push({ id: 'events', name: { en: 'Events', ms: 'Acara', 'zh-CN': '活动' } });
writeFileSync(join(templatesDir, 'categories.json'), JSON.stringify(cats));
const dist = join(work, 'dist');
const result = await build({
  templates: templatesDir,
  schema: join(work, 'unused.json'),
  out: dist,
  sequence: 1,
  generatedAt: '2026-11-04T10:00:00.000Z',
  signingKey: pem,
  validate: () => [], // the server checks every entry itself
});
check(result.entries === 19 && result.signed, 'the publisher built and signed 19 templates');

let mode = 'good'; // good | badsig | down
const listServer = createServer((req, res) => {
  if (mode === 'down') return req.socket.destroy();
  const file = req.url?.endsWith('.sig') ? 'templates-v1.json.sig' : 'templates-v1.json';
  let body = readFileSync(join(dist, file));
  if (mode === 'badsig' && file.endsWith('.sig'))
    body = Buffer.from(Buffer.alloc(64, 7).toString('base64'));
  res.writeHead(200).end(body);
});
await new Promise((r) => listServer.listen(LIST_PORT, '127.0.0.1', r));

// ── The Dev Build ────────────────────────────────────────────────────────────────────────────
// Node runs tsx's CLI directly: no npx and no shell, so nothing is looked up on PATH.
const tsxCli = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const server = spawn(
  process.execPath,
  [
    '--conditions=ezychat-source',
    tsxCli,
    'e2e/agents-devbuild.ts',
    '--fake-wa',
    '--port',
    String(port),
  ],
  {
    env: {
      ...process.env,
      EZYCHAT_TEMPLATE_LIST_URL: `http://127.0.0.1:${LIST_PORT}/templates/`,
      EZYCHAT_TEMPLATE_LIST_TEST_KEY: rawPublic,
    },
    stdio: 'ignore',
  },
);
const stop = () => {
  server.kill();
  listServer.close();
  rmSync(work, { recursive: true, force: true });
};
try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const cookie = await signInDemoAdmin(base);
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
    return res.json();
  };
  const catalog = await api('GET', '/ai/templates');
  check(
    catalog.status.state === 'loaded' && catalog.status.sequence === 1,
    'downloaded and verified the signed list at start',
    JSON.stringify(catalog.status),
  );
  const venue = catalog.templates.find((t) => t.entry.id === 'venue');
  check(
    venue?.connectors?.[0]?.name === 'Google Sheets',
    'the venue template names its recommended connector',
  );

  const browser = await launchBrowser();
  const problems = [];
  const [name, value] = cookie.split('=');
  let agentPath = '/admin/members/ai/new?preset=sales';
  const open = async (size, scheme) => {
    const ctx = await browser.newContext({
      ...SIZES[size],
      baseURL: base,
      colorScheme: scheme,
      locale: 'en-US',
    });
    await ctx.addCookies([{ name, value, url: base }]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await page.goto(agentPath);
    await page.getByTestId('business-templates').waitFor();
    return { ctx, page };
  };
  const gallery = async (page) => {
    await page
      .getByTestId('business-templates')
      .getByRole('button', { name: 'Browse templates' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('template-source').waitFor();
    return dialog;
  };

  for (const size of ['desktop', 'mobile'])
    for (const scheme of ['light', 'dark']) {
      const tag = `${size}${scheme === 'dark' ? '-dark' : ''}`;
      const { ctx, page } = await open(size, scheme);
      const dialog = await gallery(page);
      await shot(page, out, problems, tag, '01-gallery-loaded');
      await dialog.getByRole('button', { name: 'Events' }).click();
      await shot(page, out, problems, tag, '02-gallery-events');
      await ctx.close();
    }

  // Apply + Create from the list template.
  {
    const { ctx, page } = await open('desktop', 'light');
    const dialog = await gallery(page);
    const source = await dialog.getByTestId('template-source').textContent();
    check(
      source === 'Template library updated 4 Nov 2026.',
      'the gallery says when the list was updated',
      source,
    );
    const card = dialog.getByRole('radio', { name: 'Event venue' });
    check((await card.count()) === 1, 'the list template is in the gallery');
    const label = await card.locator('xpath=ancestor::label').textContent();
    check(
      label.includes('Works with Google Sheets'),
      'its card says which connector it works with',
    );
    await card.click();
    await dialog.getByRole('button', { name: 'Apply template' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await shot(page, out, problems, 'desktop', '03-applied');
    await page.getByRole('button', { name: 'Create agent' }).click();
    await page.waitForURL(/\/admin\/members\/ai\/\d+$/);
    const id = Number(new URL(page.url()).pathname.split('/').pop());
    // The agent limit is reached now: later screens open the new agent's page (same template card).
    agentPath = `/admin/members/ai/${id}`;
    const agent = await api('GET', `/ai/agents/${id}`);
    check(agent.agent.preset === 'sales', 'the new agent is a Sales agent');
    check(
      agent.settings.instructions.endsWith('You answer for an event venue.') &&
        agent.settings.instructions.length > 200,
      'its role is the Sales starting text plus the list template',
    );
    check(
      agent.settings.displayName === 'Venue assistant',
      'its name comes from the list template',
    );
    check(
      agent.documents.some((d) => d.name === 'Venue details'),
      'its Business context item was added',
    );
    await ctx.close();
  }

  // A list with a bad signature: refused, the last good copy stays (once the 30 s interval passed).
  mode = 'badsig';
  await new Promise((r) => setTimeout(r, 31_000));
  const rejected = await api('POST', '/ai/templates/refresh');
  check(
    rejected.status.state === 'rejected' && rejected.templates.some((t) => t.entry.id === 'venue'),
    'a list with a bad signature is refused and the last good copy stays',
    rejected.status.state,
  );
  for (const size of ['desktop', 'mobile']) {
    const { ctx, page } = await open(size, 'light');
    const dialog = await gallery(page);
    const text = await dialog.getByTestId('template-source').textContent();
    check(
      text.startsWith("Couldn't check for new templates"),
      `${size}: the gallery says it uses the saved list`,
      text,
    );
    await shot(page, out, problems, size, '04-gallery-offline');
    await ctx.close();
  }

  mode = 'down';
  await new Promise((r) => setTimeout(r, 31_000));
  const offline = await api('POST', '/ai/templates/refresh');
  check(
    offline.status.state === 'offline' && offline.templates.some((t) => t.entry.id === 'venue'),
    'an unreachable list server keeps the saved list (offline)',
    offline.status.state,
  );

  await browser.close();
  check(problems.length === 0, 'no page errors or horizontal overflow', problems.join('; '));
} finally {
  stop();
}
finish();
