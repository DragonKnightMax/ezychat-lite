// Screenshots of the proposed group management in Group info (group-management) in the running seeded
// mock (run.ts --fake-wa), at desktop 1280 px and mobile 360 px (touch), light and dark: the admin bar
// with join requests, Edit name, Add member (ban-risk note, privacy → Send invite → sent, not on
// WhatsApp), member actions with the Remove confirm, invite link and its Reset confirm, group settings
// with Recent changes, a group where the number is not an admin, WhatsApp offline, the Business API
// connection (invite only, no admins or settings) and an agent's read-only view. Nothing is saved
// except the invites (counted by the add limit): run it on a freshly started mock.
// Reports page errors and horizontal overflow; ends with screenshots/results.json.
// Usage: node docs/features/group-management/mock/group-admin-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7489';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const problems = [];
const passed = [];

const CLUB = '120363025550002@g.us';
const FAMILY = '120363025550004@g.us';
const chatUrl = (jid) => `/chats/${encodeURIComponent(jid)}`;
const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

async function session(user, size, scheme) {
  const ctx = await browser.newContext({
    ...size,
    baseURL: BASE,
    colorScheme: scheme,
    timezoneId: 'Asia/Kuala_Lumpur',
  });
  const login = await ctx.request.post('/api/auth/login', {
    data: { username: user, password: 'demo-pass-123' },
    headers: { origin: BASE },
  });
  if (!login.ok()) throw new Error(`login failed ${login.status()}`);
  return ctx;
}

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const ctx = await session('aisyah', size, scheme);
    const mockSwitch = (data) =>
      ctx.request.put('/api/mock/group-admin/mock', { data, headers: { origin: BASE } });
    await mockSwitch({ connection: 'linked_phone', offline: false });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name) => {
      await page.waitForTimeout(450);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`) });
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
    const panel = () => page.getByTestId('group-admin');
    const openInfo = async (jid) => {
      await page.goto(chatUrl(jid));
      await page
        .getByRole('button', { name: /open group info/i })
        .first()
        .click();
      await panel().waitFor();
    };
    const dialog = () => page.getByRole('dialog').last();
    const close = async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    };

    await step('01-admin-bar', async () => {
      await openInfo(CLUB);
      await page.getByTestId('join-requests').waitFor();
      await shot('01-admin-bar');
    });
    await step('02-edit', async () => {
      await panel()
        .getByRole('button', { name: /edit info/i })
        .click();
      await dialog()
        .getByLabel(/description/i)
        .fill('Kopi Apong regulars: new beans, events and members-only offers. Be kind, no spam.');
      await shot('02-edit');
      await close();
    });
    await step('03-add', async () => {
      await panel()
        .getByRole('button', { name: /add member/i })
        .click();
      await dialog()
        .getByLabel(/whatsapp number/i)
        .fill('60123456787');
      await shot('03-add');
      await dialog().getByRole('button', { name: /^add$/i }).click();
      await dialog()
        .getByRole('button', { name: /send invite/i })
        .waitFor();
      await shot('04-add-privacy');
      await dialog()
        .getByRole('button', { name: /send invite/i })
        .click();
      await dialog()
        .getByText(/invite sent/i)
        .waitFor();
      await shot('05-invite-sent');
      await close();
    });
    await step('06-not-on-whatsapp', async () => {
      await panel()
        .getByRole('button', { name: /add member/i })
        .click();
      await dialog()
        .getByLabel(/whatsapp number/i)
        .fill('60123456780');
      await dialog().getByRole('button', { name: /^add$/i }).click();
      await dialog()
        .getByText(/not on whatsapp/i)
        .waitFor();
      await shot('06-not-on-whatsapp');
      await close();
    });
    await step('07-member', async () => {
      await page
        .locator('[aria-label="Group info"]')
        .getByRole('button', { name: /Farah Aziz/ })
        .first()
        .click();
      await page.getByTestId('member-admin').waitFor();
      await page.getByTestId('member-admin').scrollIntoViewIfNeeded();
      await shot('07-member');
      await page.getByRole('button', { name: /remove from group/i }).click();
      await page.getByRole('alertdialog').waitFor();
      await shot('08-remove-confirm');
      await close();
      await page.locator('[aria-label="Group info"]').getByRole('button', { name: /^members$/i }).click();
    });
    await step('09-link', async () => {
      await panel()
        .getByRole('button', { name: /invite link/i })
        .click();
      await dialog()
        .getByRole('button', { name: /reset link/i })
        .waitFor();
      await shot('09-link');
      await dialog()
        .getByRole('button', { name: /reset link/i })
        .click();
      await page.getByRole('alertdialog').waitFor();
      await shot('10-reset-confirm');
      await close();
      await close();
    });
    await step('11-settings', async () => {
      await panel()
        .getByRole('button', { name: /settings/i })
        .click();
      await dialog().getByTestId('group-history').waitFor();
      await shot('11-settings');
      await close();
    });
    await step('12-not-admin', async () => {
      await openInfo(FAMILY);
      await panel()
        .getByText(/not an admin of this group/i)
        .waitFor();
      await shot('12-not-admin');
    });
    await step('13-offline', async () => {
      await mockSwitch({ offline: true });
      await openInfo(CLUB);
      await panel()
        .getByText(/whatsapp is offline/i)
        .waitFor();
      await shot('13-offline');
      await mockSwitch({ offline: false });
    });
    await step('14-business-api', async () => {
      await mockSwitch({ connection: 'business_api' });
      await openInfo(CLUB);
      await page.getByTestId('invite-only-note').waitFor();
      await shot('14-business-api');
      await panel()
        .getByRole('button', { name: /settings/i })
        .click();
      await dialog().getByTestId('group-history').waitFor();
      await shot('15-business-api-settings');
      await close();
      await page
        .locator('[aria-label="Group info"]')
        .getByRole('button', { name: /Farah Aziz/ })
        .first()
        .click();
      await page.getByTestId('member-admin').waitFor();
      await shot('16-business-api-member');
    });
    await mockSwitch({ connection: 'linked_phone', offline: false });
    await ctx.close();

    const agent = await session('daniel', size, scheme);
    const p2 = await agent.newPage();
    p2.on('pageerror', (e) => problems.push(`${suffix} agent pageerror: ${e.message}`));
    try {
      await p2.goto(chatUrl(CLUB));
      await p2
        .getByRole('button', { name: /open group info/i })
        .first()
        .click();
      await p2.getByText(/only ezychat admins can change/i).waitFor();
      await p2.waitForTimeout(450);
      await p2.screenshot({ path: join(OUT, `17-agent-${suffix}.png`) });
      passed.push(`17-agent-${suffix}`);
    } catch (e) {
      problems.push(`${suffix} 17-agent: ${e.message.split('\n')[0]}`);
    }
    await agent.close();
  }

await browser.close();
writeFileSync(
  join(OUT, 'results.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), passed, failed: problems }, null, 2) + '\n',
);
console.log(`${passed.length} shots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
process.exitCode = problems.length ? 1 : 0;
