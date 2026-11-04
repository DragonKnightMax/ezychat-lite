// Screen review and Dev Build check of the Claims agent template (docs/features/claims-template/design.md)
// against e2e/agents-devbuild.ts (mock model, fake WhatsApp, temp data). Start the runner with
// `--max-agents 2`, then: node e2e/claims-template-screens.mjs <port> <outDir>
// PASS/FAIL per check (a new agent from the template is Custom, group-only and has its Claim rules; an
// existing agent is never switched), plus overflow and page errors; never calls a model.
import { checker, cookieSession } from './devbuild-client.mjs';
import {
  DEMO_ADMIN,
  SIZES,
  launchBrowser,
  screensArgs,
  shot,
  signInDemoAdmin,
} from './screens-common.mjs';

const { base, out } = screensArgs('.claims-template-screens');
const { check, finish } = checker();
const cookie = await signInDemoAdmin(base);
// API calls go through the checked session (plain paths on this Dev Build only).
const session = cookieSession(base);
await session('POST', '/auth/login', {
  username: DEMO_ADMIN.username,
  password: DEMO_ADMIN.password,
});
/** One API call as the signed-in admin; the JSON answer. */
async function call(method, path, body) {
  const res = await session(method, path, body);
  if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status}`);
  return res.json;
}

// Agent 1 (Aina) answers direct chats with the untouched Sales starting text.
await call('PUT', '/ai', {
  displayName: 'Aina',
  enabled: false,
  instructions: '',
  handoffRules: '',
});
const aina = (await call('GET', '/ai')).agents[0];

const LOCALES = { en: 'en-US', ms: 'ms-MY', 'zh-CN': 'zh-CN' };
const NAMES = { en: 'Claims agent', ms: 'Ejen tuntutan', 'zh-CN': '理赔代理' };
const APPLY = { en: 'Apply template', ms: 'Gunakan templat', 'zh-CN': '应用模板' };
const BROWSE = { en: 'Browse templates', ms: 'Lihat templat', 'zh-CN': '浏览模板' };
const CREATE = { en: 'Create agent', ms: 'Cipta ejen', 'zh-CN': '创建代理' };

async function applyClaims(p, lang) {
  await p.getByTestId('business-templates').getByRole('button', { name: BROWSE[lang] }).click();
  const gallery = p.getByRole('dialog');
  await gallery.getByRole('radio', { name: NAMES[lang] }).click();
  await gallery.getByRole('button', { name: APPLY[lang] }).click();
  await gallery.waitFor({ state: 'hidden' });
}

/** Creates an agent from the template once and checks what Save did; deleted again (2-agent limit). */
async function createAndCheck(p, lang, tag, problems) {
  await p.getByRole('button', { name: CREATE[lang] }).click();
  await p.waitForURL(/\/admin\/members\/ai\/\d+$/);
  const id = Number(new URL(p.url()).pathname.split('/').pop());
  await p.getByTestId('agent-direct').waitFor();
  await shot(p, out, problems, tag, '03-created-top');
  await p.getByTestId('agent-direct').scrollIntoViewIfNeeded();
  await shot(p, out, problems, tag, '04-created-switches');
  const agent = await call('GET', `/ai/agents/${id}`);
  const groups = await call('GET', `/ai/agents/${id}/groups`);
  check(agent.agent.preset === 'custom', 'the new agent is Custom', agent.agent.preset);
  check(
    agent.settings.instructions.startsWith('CLAIMS\n') &&
      !agent.settings.instructions.includes('Sales'),
    'its instructions are the claims text only',
  );
  check(
    agent.documents.some((d) => d.name === 'Claim rules'),
    'its Claim rules Business context item was added',
  );
  check(
    groups.enabled === true && groups.answerDirect === false,
    'it answers in groups only',
    JSON.stringify({ enabled: groups.enabled, answerDirect: groups.answerDirect }),
  );
  const first = await call('GET', `/ai/agents/${aina.id}/groups`);
  check(first.answerDirect === true, 'the other agent still answers direct chats');
  await call('DELETE', `/ai/agents/${id}`);
}

const browser = await launchBrowser();
const problems = [];
let created = false;
for (const lang of ['en', 'ms', 'zh-CN'])
  for (const scheme of lang === 'en' ? ['light', 'dark'] : ['light'])
    for (const [size, options] of Object.entries(SIZES)) {
      const tag = `${lang}-${size}-${scheme}`;
      const c = await browser.newContext({
        ...options,
        baseURL: base,
        colorScheme: scheme,
        locale: LOCALES[lang],
        serviceWorkers: 'block',
      });
      const [name, value] = cookie.split('=');
      await c.addCookies([{ name, value, url: base }]);
      const p = await c.newPage();
      p.on('pageerror', (e) => problems.push(`${tag}: page error ${e.message}`));

      await p.goto('/admin/members/ai/new?preset=custom');
      await p.getByTestId('business-templates').waitFor();
      if (lang === 'en') {
        // The gallery: Team and operations with the Claims agent.
        await p.getByRole('button', { name: BROWSE.en }).click();
        await p.getByRole('dialog').getByRole('button', { name: 'Team and operations' }).click();
        await p.getByRole('dialog').getByRole('radio', { name: NAMES.en }).click();
        await shot(p, out, problems, tag, '01-gallery');
        await p.keyboard.press('Escape');
        await p.getByRole('dialog').waitFor({ state: 'hidden' });
      }
      // A new agent after Apply: filled texts and the group note.
      await applyClaims(p, lang);
      await p.getByTestId('group-setup').waitFor();
      await shot(p, out, problems, tag, '02-new-applied');
      if (!created && size === 'desktop') {
        created = true;
        await createAndCheck(p, lang, tag, problems);
      }
      // The existing agent (Lite's only agent): a note, never a switch.
      await p.goto(`/admin/members/ai/${aina.id}`);
      await p.getByTestId('business-templates').waitFor();
      await applyClaims(p, lang);
      await p.getByTestId('group-setup').scrollIntoViewIfNeeded();
      await shot(p, out, problems, tag, '05-existing-applied');
      await c.close();
    }
await browser.close();
const after = await call('GET', `/ai/agents/${aina.id}/groups`);
check(
  after.answerDirect === true && after.enabled === false,
  'applying the template to an existing agent changed no switch',
);
check(problems.length === 0, 'no overflow or page errors', problems.join(' | '));
finish();
