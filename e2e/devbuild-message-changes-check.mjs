/* global document, innerWidth -- page.evaluate and waitForFunction run in the browser */
// Dev Build check of editing and deleting messages (docs/features/message-edit-delete/design.md) on a
// seeded Dev Build with fake WhatsApp (`node e2e/marketing-screenshots.mjs <port> <dir>` first). For each of
// desktop 1280 px and mobile 360 px touch, light and dark: a fresh chat (Ahmad Zulkifli), a teammate's reply
// edited (Edited, earlier versions), deleted for everyone, the customer's edit and delete through the fake
// phone (Show original as admin), Delete for me, the server refusing a customer message, and Daniel's
// agent view (windows and offline are covered by unit tests). Saves
// shots as docs/screenshots/chat/edit-delete-<step>-<desktop|mobile>[-dark].png and reports page errors and
// horizontal overflow; exits 1 on any problem.
// Usage: node e2e/devbuild-message-changes-check.mjs <port>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number.parseInt(process.argv[2] ?? '7477', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Usage: <port>');
const BASE = `http://127.0.0.1:${PORT}`;
// Fixed folder: the shots belong to docs/screenshots/chat (no path from the command line).
const OUT = join(import.meta.dirname, '..', 'docs', 'screenshots', 'chat');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const problems = [];
const passed = [];

async function session(username, scheme, size, touch) {
  const ctx = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 2,
    baseURL: BASE,
    colorScheme: scheme,
    hasTouch: touch,
    isMobile: touch,
  });
  const login = await ctx.request.post('/api/auth/login', {
    data: { username, password: 'demo-pass-123' },
    headers: { origin: BASE },
  });
  if (!login.ok()) throw new Error(`login ${username}: ${login.status()}`);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${username} ${scheme}: page error ${e.message}`));
  return { ctx, page };
}

const ok = async (pending, label) => {
  const res = await pending;
  if (!res.ok()) throw new Error(`${label}: ${res.status()} ${await res.text()}`);
  return res.json();
};

let round = 0;
for (const scheme of ['light', 'dark'])
  for (const [vp, size] of [
    ['desktop', { width: 1280, height: 800 }],
    ['mobile', { width: 360, height: 780 }],
  ]) {
    round++;
    const touch = vp === 'mobile';
    const { ctx, page } = await session('aisyah', scheme, size, touch);
    const post = (path, data) => ctx.request.post(path, { data, headers: { origin: BASE } });
    const suffix = `${vp}${scheme === 'dark' ? '-dark' : ''}`;
    const shot = async (step) => {
      await page.waitForTimeout(400);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
        problems.push(`${suffix} ${step}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `edit-delete-${step}-${suffix}.png`) });
      passed.push(`${step}-${suffix}`);
    };
    const jid = `601255501${round}${String(Date.now()).slice(-4)}@s.whatsapp.net`;
    const incoming = (text) =>
      ok(
        post('/api/dev/fake-incoming', { chatJid: jid, senderName: 'Ahmad Zulkifli', text }),
        'incoming',
      );
    const q1 = await incoming('Is the shop open on Hari Raya?');
    const q2 = await incoming('Great, 3 Kopi Peng for pickup at 11am please.');
    const q3 = await incoming('Sorry, wrong chat 🙈');
    await ok(
      post(`/api/chats/${encodeURIComponent(jid)}/messages`, {
        text: 'Yes, we open 10am to 6pm on Hari Raya.',
        clientId: `check-${round}-${Date.now()}`,
      }),
      'reply',
    );
    await page.goto(`/chats/${encodeURIComponent(jid)}`);
    const sent = page.locator('[data-message-id]').filter({ hasText: 'on Hari Raya.' });
    await sent.waitFor();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('[data-message-id]')].some((e) =>
          e.getAttribute('data-message-id').startsWith('local-'),
        ),
    );
    // By id from here: the text changes, and goes once the message is deleted.
    const reply = page.locator(`[data-message-id="${await sent.getAttribute('data-message-id')}"]`);
    const open = async (target, action) => {
      const r = target.locator('..');
      if (touch) {
        await r.getByTestId('reaction-picker-button').focus();
        await page.keyboard.press('Enter');
        if (action)
          await page.getByTestId('reaction-picker').getByRole('button', { name: action }).click();
      } else {
        await target.hover();
        await r.getByTestId('message-more').click();
        if (action) await page.getByRole('menuitem', { name: action }).click();
      }
    };

    await shot('01-chat');
    await open(reply, null);
    await shot('02-actions');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await open(reply, 'Edit');
    await page.getByTestId('edit-text').fill('Yes, we open 10am to 4pm on Hari Raya.');
    await shot('03-edit-dialog');
    await page.getByTestId('edit-save').click();
    await reply.filter({ hasText: '4pm' }).waitFor();
    await reply.getByTestId('edited-label').click();
    await page.getByText('Earlier versions').waitFor();
    await shot('04-edited-history');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // The customer edits and deletes through the fake phone; the admin reveals the original.
    await ok(
      post('/api/dev/fake-edit', {
        messageId: q2.id,
        body: 'Great, 4 Kopi Peng for pickup at 11.30am please.',
      }),
      'edit',
    );
    await ok(post('/api/dev/fake-revoke', { messageId: q3.id }), 'revoke');
    const gone = page.locator(`[data-message-id="${q3.id}"]`);
    await gone.getByTestId('deleted-body').waitFor();
    await gone.getByTestId('show-original').click();
    await gone.filter({ hasText: 'wrong chat' }).waitFor();
    await shot('05-customer-changes');

    await open(reply, 'Delete');
    await page.getByTestId('delete-for-everyone').waitFor();
    await shot('06-delete-dialog');
    await page.getByTestId('delete-for-everyone').click();
    await reply.getByTestId('deleted-body').waitFor();
    await shot('07-deleted');

    // Delete for me: the customer's first question disappears for the team.
    const first = page.locator(`[data-message-id="${q1.id}"]`);
    await open(first, 'Delete');
    await page.getByTestId('delete-for-me').click();
    await first.waitFor({ state: 'detached' });
    await shot('08-hidden');

    // A customer's message is never the team's to edit: the server refuses it.
    const late = await ctx.request.patch(`/api/messages/${encodeURIComponent(q2.id)}`, {
      data: { text: 'x' },
      headers: { origin: BASE },
    });
    if (late.status() !== 400)
      problems.push(`${suffix}: editing a customer message answered ${late.status()}`);
    await ctx.close();

    // Daniel (agent): no Show original, no actions on Aisyah's message.
    const agent = await session('daniel', scheme, size, touch);
    await agent.page.goto(`/chats/${encodeURIComponent(jid)}`);
    await agent.page.locator(`[data-message-id="${q3.id}"]`).getByTestId('deleted-body').waitFor();
    if (await agent.page.getByTestId('show-original').count())
      problems.push(`${suffix}: the agent sees Show original`);
    if (await agent.page.getByTestId('message-more').count())
      problems.push(`${suffix}: the agent gets actions on others' messages`);
    await agent.page.waitForTimeout(400);
    await agent.page.screenshot({ path: join(OUT, `edit-delete-09-agent-${suffix}.png`) });
    passed.push(`09-agent-${suffix}`);
    await agent.ctx.close();
  }

await browser.close();
console.log(
  `${passed.length} shots. ${problems.length ? problems.join('\n') : 'No page errors or horizontal overflow.'}`,
);
process.exit(problems.length ? 1 : 0);
