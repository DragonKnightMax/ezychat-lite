// Screenshots of the proposed AI agents in WhatsApp groups (ai-groups) in the running seeded mock
// (run.ts --fake-wa), at desktop 1280 px and mobile 360 px (touch), light and dark: the agent page
// Groups card (on with groups and the agent-off hint, off, on with no group switched on, an inbox
// without groups, the dashed Mock only panel), the group chats (Kopi Lovers Club: mention, AI answer,
// follow-up answered, unrelated message not answered, hand-over line; the Reseller group with its long
// name: the auto-reply loop and the loop guard's paused line; Family Day 2026: off, no badge), the
// header badge, Group info (admin switch, agent view read-only, disabled while Answer in groups is
// off), the chat's Mock only panel with a simulated mention and the hand-over notification preview,
// and Try it with Group question (answer and hand-over). Reports page errors and horizontal overflow;
// ends with groups-results.json.
// Usage: node docs/features/message-edit-delete/mock/groups-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7487';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
// This PC has no Playwright Chromium: use PW_CHROMIUM when set, else the installed Chrome.
const browser = await chromium.launch(
  process.env.PW_CHROMIUM
    ? { executablePath: process.env.PW_CHROMIUM }
    : { channel: process.env.PW_CHANNEL ?? 'chrome' },
);
const problems = [];
const passed = [];
const send = (ctx, path, data, method = 'post') =>
  ctx.request[method](path, { data, headers: { origin: BASE } });

const CLUB = '120363025550002@g.us';
const RESELLERS = '120363025550003@g.us';
const FAMILY = '120363025550004@g.us';
const chatUrl = (jid) => `/chats/${encodeURIComponent(jid)}?edition=enterprise`;

const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const mobile = sizeName === 'mobile';
    const ctx = await browser.newContext({
      ...size,
      baseURL: BASE,
      colorScheme: scheme,
      timezoneId: 'Asia/Kuala_Lumpur',
    });
    const login = await send(ctx, '/api/auth/login', {
      username: 'aisyah',
      password: 'demo-pass-123',
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    const scenario = (body) => send(ctx, '/api/mock/groups/scenario', body, 'put');
    const setAgent = (agentId, enabled) =>
      send(ctx, `/api/mock/groups/agents/${agentId}`, { enabled }, 'put');
    const setGroup = (jid, enabled) =>
      send(ctx, `/api/mock/groups/chats/${encodeURIComponent(jid)}`, { enabled }, 'put');
    // Every context starts from the seeded switches (the messages of earlier contexts stay).
    await scenario({ reset: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name, opts = {}, target = page) => {
      await target.waitForTimeout(400);
      const overflow = await target.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await target.screenshot({ path: join(OUT, `${name}-${suffix}.png`), ...opts });
      passed.push(`${name}-${suffix}`);
    };
    const element = async (name, locator) => {
      await page.waitForTimeout(300);
      await locator.scrollIntoViewIfNeeded();
      await locator.screenshot({ path: join(OUT, `${name}-${suffix}.png`) });
      passed.push(`${name}-${suffix}`);
    };
    const step = async (name, run) => {
      try {
        await run();
      } catch (error) {
        problems.push(`${suffix} ${name}: ${error.message.split('\n')[0]}`);
      }
    };
    const agentPage = async (id = 'a1') => {
      await page.goto(`/admin/members/ai/${id}?edition=enterprise`);
      await page.getByTestId('agent-groups').waitFor();
      await page.waitForTimeout(300);
    };
    const chat = async (jid) => {
      await page.goto(chatUrl(jid));
      await page
        .getByRole('button', { name: /Open group info/ })
        .first()
        .waitFor();
      await page.waitForTimeout(500);
    };
    const groupInfo = async () => {
      await page
        .getByRole('button', { name: /Open group info/ })
        .first()
        .click();
      await page.getByTestId('group-ai-row').waitFor();
    };

    // 1. Agent page → Groups: on with groups (Aina is off: the hint), off, none on, no groups.
    await step('agent-card', async () => {
      await agentPage();
      await element('01-groups-card', page.getByTestId('agent-groups'));
      await setAgent('a1', false);
      await agentPage();
      await page.getByTestId('groups-off').waitFor();
      await element('02-groups-card-off', page.getByTestId('agent-groups'));
      await setAgent('a1', true);
      for (const jid of [CLUB, RESELLERS, FAMILY]) await setGroup(jid, false);
      await agentPage();
      await page.getByTestId('groups-none-on').waitFor();
      await element('03-groups-card-none-on', page.getByTestId('agent-groups'));
      await scenario({ reset: true });
      await agentPage('a2');
      await page.getByTestId('groups-none').waitFor();
      await element('04-groups-card-no-groups', page.getByTestId('agent-groups'));
      await agentPage();
      await shot('05-agent-page', { fullPage: true });
    });

    // 2. Group conversations: header badge, mention, answers, follow-up, silence, hand-over, paused.
    await step('conversations', async () => {
      await chat(CLUB);
      await page.getByTestId('group-ai-badge').waitFor();
      await shot('06-club-chat');
      // Arjun quotes the AI's first answer (no @mention) and gets an answer (owner, 2026-10-28).
      await page.getByText('same time on Sunday?').last().scrollIntoViewIfNeeded();
      await shot('06b-quote-answered');
      await chat(RESELLERS);
      await shot('07-resellers-loop-guard');
      await chat(FAMILY);
      await shot('08-family-day-off');
    });

    // 3. Group info: admin switch, agent view (read only), Answer in groups off (disabled + hint).
    await step('group-info', async () => {
      await chat(CLUB);
      await groupInfo();
      await shot('09-group-info-admin');
      await scenario({ viewAs: 'agent' });
      await chat(CLUB);
      await groupInfo();
      await page.getByTestId('group-ai-state').waitFor();
      await shot('10-group-info-agent-view');
      await scenario({ viewAs: 'admin' });
      await setAgent('a1', false);
      await chat(CLUB);
      await groupInfo();
      await shot('11-group-info-agent-switch-off');
      await setAgent('a1', true);
    });

    // 4. The chat's Mock only panel: a simulated mention answered, then a hand-over notification.
    await step('simulate', async () => {
      await chat(CLUB);
      await page.getByTestId('mock-groups').locator('summary').click();
      await page.getByTestId('simulate-question').click();
      await page.getByText('The AI answered in the group.').waitFor();
      await shot('12-simulated-mention');
      await page.getByTestId('simulate-handover').click();
      await page.getByTestId('group-notification').waitFor();
      await element('13-handover-notification', page.getByTestId('mock-groups'));
      await scenario({ loopGuard: true });
      await page.getByTestId('simulate-question').click();
      await page.getByText('The loop guard holds').waitFor();
      await shot('14-loop-guard-reached');
      await scenario({ loopGuard: false });
    });

    // 5. Try it → Group question: a grounded answer naming the member, then a hand-over.
    await step('try-it', async () => {
      await agentPage();
      const tryIt = page.getByTestId('agent-try');
      await tryIt.getByTestId('try-group').click();
      await tryIt.getByRole('textbox').fill('What time does the kitchen close?');
      await tryIt.getByRole('button', { name: 'Ask' }).click();
      await tryIt.getByTestId('try-group-quote').waitFor();
      await element('15-try-group-answer', tryIt);
      await tryIt.getByRole('textbox').fill('Can I bring my cat to the shop?');
      await tryIt.getByRole('button', { name: 'Ask' }).click();
      await tryIt.getByText('A team member will reply soon.').waitFor();
      await element('16-try-group-handover', tryIt);
    });

    // 6. The agent page in Malay and Chinese (the Groups card's texts).
    if (!mobile || scheme === 'light')
      await step('languages', async () => {
        for (const lang of ['ms', 'zh-CN']) {
          // The account language (PATCH /api/me) wins over the browser copy; set both.
          await send(ctx, '/api/me', { locale: lang }, 'patch');
          await page.evaluate((l) => localStorage.setItem('wati.locale', l), lang);
          await agentPage();
          await element(`17-groups-card-${lang}`, page.getByTestId('agent-groups'));
        }
        await send(ctx, '/api/me', { locale: 'en' }, 'patch');
        await page.evaluate(() => localStorage.setItem('wati.locale', 'en'));
      });
    await scenario({ reset: true });
    await ctx.close();
  }
await browser.close();
writeFileSync(
  join(OUT, 'groups-results.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), passed, failed: problems }, null, 2) + '\n',
);
console.log(
  `${passed.length} shots. ` +
    (problems.length ? problems.join('\n') : 'No page errors or horizontal overflow.'),
);
