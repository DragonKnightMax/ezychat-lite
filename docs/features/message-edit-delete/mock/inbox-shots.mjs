// Screenshots of the proposed multi-inbox UI in the running seeded mock (run.ts --fake-wa), at desktop
// 1280 px and mobile 360 px: the admin's unified list with the inbox filter, a conversation with its inbox,
// the Inboxes page, Add inbox with the QR code, Members with inbox access, an agent's list (one inbox) and
// an agent who opens a chat of another inbox. Reports page errors and
// horizontal overflow. Run it once on a freshly started mock (it saves an inbox).
// Usage: node docs/features/upgrade-enterprise/mock/inbox-shots.mjs [baseUrl]
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
const jid = (n) => encodeURIComponent(`6012${n}@s.whatsapp.net`);

async function session(vp, size, username) {
  const ctx = await browser.newContext({ viewport: size, baseURL: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${vp} ${username} pageerror: ${e.message}`));
  const login = await ctx.request.post('/api/auth/login', {
    data: { username, password: 'demo-pass-123' },
    headers: { origin: BASE },
  });
  if (!login.ok()) throw new Error(`login ${username} failed ${login.status()}`);
  const shot = async (n, step) => {
    await page.waitForTimeout(700);
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (wide) problems.push(`${vp} ${step}: horizontal overflow`);
    await page.screenshot({ path: join(OUT, `${n}-${step}-${vp}.png`) });
  };
  return { ctx, page, shot };
}

for (const [vp, size] of [
  ['desktop', { width: 1280, height: 860 }],
  ['mobile', { width: 360, height: 780 }],
]) {
  // Admin: every inbox, one list.
  const admin = await session(vp, size, 'aisyah');
  await admin.page.goto('/');
  await admin.page.getByTestId('inbox-filter').waitFor();
  await admin.shot('01', 'admin-unified-list', vp);

  await admin.page.goto(`/chats/${jid('6677889')}`);
  await admin.page.locator('[data-testid="inbox-chip"]:visible').first().waitFor();
  await admin.shot('02', 'conversation-inbox', vp);

  await admin.page.goto('/admin/inboxes');
  await admin.page.getByTestId('inbox-card').first().waitFor();
  await admin.shot('03', 'inboxes-page', vp);

  await admin.page.getByRole('button', { name: 'Add inbox' }).first().click();
  const dialog = admin.page.getByRole('dialog');
  await dialog.getByLabel('Inbox name').fill('Delivery');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await admin.page.getByTestId('inbox-qr').waitFor();
  await admin.page.getByTestId('inbox-qr').scrollIntoViewIfNeeded();
  await admin.shot('04', 'add-inbox-qr', vp);
  await admin.page.keyboard.press('Escape');

  await admin.page.goto('/admin/members');
  await admin.page.locator('[data-testid="inbox-access"]:visible').first().waitFor();
  await admin.shot('05', 'members-access', vp);
  await admin.page.getByRole('button', { name: 'Inboxes for Daniel' }).click();
  await admin.page.getByRole('dialog').getByRole('checkbox').first().waitFor();
  await admin.shot('06', 'members-access-dialog', vp);
  await admin.page.keyboard.press('Escape');
  await admin.ctx.close();

  // Agent Mei Ling: only the Catering inbox.
  const agent = await session(vp, size, 'meiling');
  await agent.page.goto('/');
  await agent.page.getByText('Farah', { exact: false }).first().waitFor();
  await agent.shot('07', 'agent-one-inbox', vp);
  await agent.page.goto(`/chats/${jid('8814455')}`);
  await agent.page.getByText('You cannot open this chat').waitFor();
  await agent.shot('08', 'agent-no-access', vp);
  await agent.ctx.close();
}
await browser.close();
console.log(problems.length ? problems.join('\n') : 'no page errors, no horizontal overflow');
process.exit(problems.length ? 1 : 0);
