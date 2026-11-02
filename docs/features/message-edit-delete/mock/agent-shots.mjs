// Screenshots of the proposed custom-agents UI in the running seeded mock (run.ts --fake-wa), at desktop
// 1280 px and mobile 360 px: Members with one row per AI agent, the Sales agent page, the new-agent preset
// picker, an Internal item dialog, the Business context list with the Internal badge, Try it deciding with an
// Internal item and with a hand-over rule, the Advanced texts, the Members at-limit hint, Admin → Inboxes with the AI agent line and select, and the Lite view (one inbox, one agent).
// Reports page errors and horizontal overflow. Each viewport uses a fresh browser context, so the mock-only
// localStorage state starts from the seed; the run adds one inbox ("Delivery") on the server-free mock state.
// Usage: node docs/features/upgrade-enterprise/mock/agent-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7487';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium
  .launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
  .catch(() => chromium.launch({ channel: 'chrome' }));
const problems = [];

async function session(vp, size) {
  const ctx = await browser.newContext({ viewport: size, baseURL: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${vp} pageerror: ${e.message}`));
  const login = await ctx.request.post('/api/auth/login', {
    data: { username: 'aisyah', password: 'demo-pass-123' },
    headers: { origin: BASE },
  });
  if (!login.ok()) throw new Error(`login failed ${login.status()}`);
  /** Page shot (full page for the long agent page) or, with `target`, a shot of one element. */
  const shot = async (n, step, { full = false, target } = {}) => {
    await page.waitForTimeout(700);
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (wide) problems.push(`${vp} ${step}: horizontal overflow`);
    const path = join(OUT, `${n}-${step}-${vp}.png`);
    if (target) await target.screenshot({ path });
    else await page.screenshot({ path, fullPage: full });
  };
  return { ctx, page, shot };
}

for (const [vp, size] of [
  ['desktop', { width: 1280, height: 860 }],
  ['mobile', { width: 360, height: 780 }],
]) {
  const { ctx, page, shot } = await session(vp, size);

  // 01 Members: one row per AI agent (name, preset badge, inbox chip).
  await page.goto('/admin/members?edition=enterprise');
  await page.locator('a:visible', { hasText: 'Sofia' }).first().waitFor();
  // Both inboxes have an agent: no Add AI agent, and the hint says why.
  await page.getByTestId('agent-limit-hint').waitFor();
  await shot('01', 'members-agents');

  // Enterprise: /admin/members/ai goes to Members (spec); Lite goes to its agent (08 / 09).
  await page.goto('/admin/members/ai');
  await page.waitForURL(/\/admin\/members$/);

  // 02 The Sales agent page (Aina on Kopi Apong).
  await page.goto('/admin/members/ai/a1');
  await page.getByTestId('agent-page').waitFor();
  await shot('02', 'agent-page-sales', { full: true });

  // 11 Advanced (collapsed, as on the AI Sales Agent page): role and hand-over rules.
  const advanced = page.getByTestId('agent-advanced');
  await advanced.locator('summary').click();
  await advanced.getByText('Using the Sales starting text', { exact: false }).waitFor();
  await shot('11', 'agent-advanced', { target: advanced });

  // 05 Business context with the Internal badge (and the All / Customer-facing / Internal filter).
  const context = page.getByTestId('agent-context');
  await context.scrollIntoViewIfNeeded();
  await shot('05', 'context-internal-badge', { target: context });

  // 04 The Internal item dialog (an existing Internal text item).
  await context.locator('button:visible', { hasText: 'Pricing floor (internal)' }).first().click();
  await page.getByTestId('internal-switch').waitFor();
  await shot('04', 'internal-item-dialog');
  await page.keyboard.press('Escape');
  await page.getByTestId('internal-switch').waitFor({ state: 'detached' });

  // 10 Try it: the agent uses the Internal item to decide and hands over without quoting it.
  const tryIt = page.getByTestId('agent-try');
  await tryIt.scrollIntoViewIfNeeded();
  await tryIt.getByRole('textbox').fill('Can you give a discount for a 40 pax catering order?');
  await tryIt.getByRole('button', { name: 'Ask' }).click();
  await tryIt.getByText('Nothing internal was told to the customer', { exact: false }).waitFor();
  await shot('10', 'try-it-internal', { target: tryIt });

  // 12 Try it uses the hand-over rules of this page (also unsaved): a refund matches a Sales rule.
  await tryIt.getByRole('textbox').fill('Can I get a refund?');
  await tryIt.getByRole('button', { name: 'Ask' }).click();
  await tryIt.getByText('Hand-over rule:', { exact: false }).waitFor();
  await shot('12', 'try-it-rule', { target: tryIt });

  // 06 Admin → Inboxes: the AI agent line on each card.
  await page.goto('/admin/inboxes');
  await page.getByTestId('inbox-agent').first().waitFor();
  await shot('06', 'inboxes-agent-line');

  // 07 Edit inbox: the AI agent select.
  await page.getByTestId('inbox-card').first().getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('inbox-agent-field').waitFor();
  await shot('07', 'inbox-dialog-agent');
  await page.keyboard.press('Escape');
  await page.getByTestId('inbox-agent-field').waitFor({ state: 'detached' });

  // 03 New agent: add a third inbox first (one agent per inbox), then Add AI agent → preset picker.
  await page.getByRole('button', { name: 'Add inbox' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Inbox name').fill('Delivery');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.goto('/admin/members');
  await page.getByRole('link', { name: 'Add AI agent' }).first().click();
  const picker = page.getByTestId('preset-picker');
  await picker.waitFor();
  await picker.getByText('FAQ', { exact: true }).click();
  await shot('03', 'new-agent-preset-picker');

  // 08 / 09 Lite view: one inbox, one agent, no inbox UI, no Add, no Delete.
  await page.goto('/admin/members?edition=lite');
  await page.locator('a:visible', { hasText: 'Aina' }).first().waitFor();
  await shot('08', 'lite-members');
  await page.goto('/admin/members/ai');
  await page.getByTestId('agent-page').waitFor();
  if (await page.getByTestId('agent-delete').count()) problems.push(`${vp} lite: Delete is shown`);
  if (await page.getByTestId('agent-inbox').count())
    problems.push(`${vp} lite: the inbox select is shown`);
  await shot('09', 'lite-agent-page', { full: true });

  await ctx.close();
}

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Saved the custom-agents screenshots in ${OUT}`);
