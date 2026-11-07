// Screenshots of the proposed Forward message (forward-message) in the running seeded mock (run.ts --fake-wa),
// desktop 1280 px and mobile 360 px (touch), light (dark for the dialog), en + ms + zh-CN: the message menu
// with Forward (desktop ⋮ menu, touch press-and-hold bar), every dialog state (list, search, picked across
// inboxes, 5 of 5, 24-hour window closed, Safety locked, WhatsApp offline, forwarded many times = one chat),
// the sent toast, the "Forwarded" label on the copy and on inbound forwarded messages, a limited agent's
// list (chosen chats only), Activity and Lite (one inbox, no inbox chips).
// Reports page errors and horizontal overflow; ends with screenshots/forward-results.json.
// Usage: node docs/features/forward-message/mock/forward-shots.mjs [baseUrl]   (PW_CHROMIUM=<chromium>)
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
const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};

async function session(user, { size, scheme = 'light', locale = 'en', edition = 'enterprise' }) {
  const ctx = await browser.newContext({
    ...sizes[size],
    baseURL: BASE,
    colorScheme: scheme,
    timezoneId: 'Asia/Kuala_Lumpur',
  });
  await ctx.addInitScript(
    ([loc, ed]) => {
      localStorage.setItem('wati.locale', loc);
      localStorage.setItem('mock.customAgents.edition.v1', ed);
    },
    [locale, edition],
  );
  const login = await ctx.request.post('/api/auth/login', {
    data: { username: user, password: 'demo-pass-123' },
    headers: { origin: BASE },
  });
  if (!login.ok()) throw new Error(`login ${user} failed ${login.status()}`);
  const page = await ctx.newPage();
  page.setDefaultTimeout(12_000);
  const suffix = `${size}-${scheme}${locale === 'en' ? '' : `-${locale}`}`;
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
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${suffix} ${name}: ${e.message.split('\n')[0]}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  };
  const api = (method, path, data) =>
    ctx.request.fetch(`/api${path}`, { method, data, headers: { origin: BASE } });
  return { ctx, page, shot, step, api, size };
}

const dialog = (page) => page.getByTestId('forward-dialog');
const chatUrl = (jid) => `/chats/${encodeURIComponent(jid)}`;
const PRIYA = '60128814455@s.whatsapp.net';
const FARAH = '60123110021@s.whatsapp.net';
const NURUL = '60126677889@s.whatsapp.net';
const JASON = '60129001234@s.whatsapp.net';

/** The bubble whose text contains `text`. */
const bubble = (page, text) => page.locator('[data-message-id]').filter({ hasText: text }).last();

/** Opens the message menu: ⋮ on desktop, the press-and-hold bar on touch. */
async function openMenu(s, text) {
  const { page, size } = s;
  const b = bubble(page, text);
  await b.waitFor();
  const row = b.locator('xpath=..');
  if (size === 'desktop') {
    await b.hover();
    await row.getByTestId('message-more').click();
    await page.getByTestId('message-forward').waitFor();
  } else {
    // Touch: the bar opens by press-and-hold; its button is a real control for keyboards too.
    await row.getByTestId('reaction-picker-button').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('touch-forward').waitFor();
  }
}
async function openForward(s, jid, text) {
  await s.page.goto(chatUrl(jid));
  await openMenu(s, text);
  await s.page.getByTestId(s.size === 'desktop' ? 'message-forward' : 'touch-forward').click();
  await dialog(s.page).waitFor();
  await s.page.getByTestId('forward-row').first().waitFor();
}
const pick = async (page, name) => {
  await dialog(page).getByTestId('forward-row').filter({ hasText: name }).first().click();
};
const mock = async (page, label) => {
  await page.getByTestId('forward-mock-controls').getByRole('button', { name: label }).click();
  await page.waitForTimeout(300);
};

for (const size of Object.keys(sizes)) {
  const s = await session('aisyah', { size });
  const { page, shot, step, api } = s;
  await api('PUT', '/mock/forward/scenario', { scenario: 'normal' });

  await step('menu', async () => {
    await page.goto(chatUrl(PRIYA));
    await openMenu(s, 'the lid is broken');
    await shot('01-menu-forward');
    await page.keyboard.press('Escape');
  });
  await step('dialog', async () => {
    await openForward(s, PRIYA, 'the lid is broken');
    await shot('02-dialog-list');
  });
  await step('search', async () => {
    await dialog(page).getByTestId('forward-search').fill('kopi');
    await page.waitForTimeout(500);
    await shot('03-search');
    await dialog(page).getByTestId('forward-search').fill('');
    await page.waitForTimeout(400);
  });
  await step('picked', async () => {
    await pick(page, 'Kopi Apong Staff');
    await pick(page, 'Farah Aziz');
    await shot('04-picked-two-inboxes');
  });
  await step('full', async () => {
    for (const name of ['Ahmad', 'Tan Wei Jie', 'Siti Rahman']) await pick(page, name);
    await page.getByTestId('forward-count').scrollIntoViewIfNeeded();
    await shot('05-five-of-five');
  });
  await step('window-closed', async () => {
    await dialog(page).getByTestId('forward-search').fill('Jason');
    await page.waitForTimeout(500);
    await shot('06-window-closed-row');
    await page.keyboard.press('Escape');
  });
  await step('safety', async () => {
    await openForward(s, PRIYA, 'the lid is broken');
    await mock(page, 'Safety locked (this message)');
    await shot('07-safety-locked');
    await mock(page, 'Normal');
    await page.keyboard.press('Escape');
    // The menu item itself is disabled while Safety locks the file (desktop ⋮ menu).
    if (size === 'desktop') {
      await api('PUT', '/mock/forward/scenario', {
        safetyLock: {
          messageId: await bubble(page, 'the lid is broken').getAttribute('data-message-id'),
          locked: true,
        },
      });
      await page.reload();
      await openMenu(s, 'the lid is broken');
      await page.waitForTimeout(4500);
      await shot('08-menu-locked');
      await page.keyboard.press('Escape');
      await api('PUT', '/mock/forward/scenario', {
        scenario: 'normal',
        safetyLock: {
          messageId: await bubble(page, 'the lid is broken').getAttribute('data-message-id'),
          locked: false,
        },
      });
    }
  });
  await step('offline', async () => {
    await openForward(s, PRIYA, 'the lid is broken');
    await mock(page, 'WhatsApp offline');
    await shot('09-offline');
    await mock(page, 'Normal');
  });
  await step('send', async () => {
    await pick(page, 'Kopi Apong Staff');
    await pick(page, 'Farah Aziz');
    await page.getByTestId('forward-send').click();
    await page.getByText('Forwarded to 2 chats').first().waitFor();
    await shot('10-sent-toast');
  });
  await step('copy-in-chat', async () => {
    await page.goto(chatUrl(FARAH));
    await bubble(page, 'the lid is broken').getByTestId('forwarded-label').waitFor();
    await shot('11-copy-forwarded-label');
  });
  await step('inbound-forwarded', async () => {
    await page.goto(chatUrl(JASON));
    await bubble(page, 'buy 2 Kopi Peng').waitFor();
    await shot('12-inbound-forwarded');
  });
  await step('many-times', async () => {
    await page.goto(chatUrl(NURUL));
    await bubble(page, 'URGENT').waitFor();
    await shot('13-inbound-forwarded-many');
    await openForward(s, NURUL, 'URGENT');
    await pick(page, 'Kopi Apong Staff');
    await shot('14-many-times-one-chat');
    await page.keyboard.press('Escape');
  });
  await step('pdf', async () => {
    await openForward(s, FARAH, 'menu for the 30 pax');
    await pick(page, 'Kopi Apong Staff');
    await page.getByTestId('forward-send').click();
    await page.getByText('Forwarded to Kopi Apong Staff').first().waitFor();
    await shot('15-sent-one-open-chat');
  });
  // The owner's case: a 70 MB video from a chat on one number (Catering) to chats on other numbers.
  await step('video-70', async () => {
    await openForward(s, FARAH, 'Walkthrough of the event hall');
    await shot('19-video-70mb-dialog');
    await pick(page, 'Priya Nair');
    await pick(page, 'Kopi Apong Staff');
    await page.getByTestId('forward-send-as-note').scrollIntoViewIfNeeded();
    await shot('20-video-70mb-cross-inbox-as-file');
    await page.keyboard.press('Escape');
  });
  await step('video-120', async () => {
    await openForward(s, FARAH, 'Walkthrough of the event hall');
    await mock(page, 'Video 120 MB');
    await page.keyboard.press('Escape');
    await openForward(s, FARAH, 'Walkthrough of the event hall');
    await dialog(page).getByTestId('forward-search').fill('Priya');
    await page.waitForTimeout(500);
    await shot('21-video-120mb-too-large-row');
    await mock(page, 'Video 120 MB');
    await page.keyboard.press('Escape');
  });
  await step('sending-large', async () => {
    await openForward(s, FARAH, 'Walkthrough of the event hall');
    await mock(page, 'Slow upload');
    await pick(page, 'Kopi Apong Staff');
    await page.getByTestId('forward-send').click();
    await page.getByText('Forwarded to Kopi Apong Staff').first().waitFor();
    await page.goto(chatUrl('120363025550005@g.us'));
    await page.getByTestId('forward-sending-large').last().waitFor();
    await shot('22-sending-large');
    await api('PUT', '/mock/forward/scenario', { scenario: 'normal' });
  });
  await step('upload-fails', async () => {
    await page.waitForTimeout(8000);
    await openForward(s, FARAH, 'Walkthrough of the event hall');
    await mock(page, 'Upload fails');
    await pick(page, 'Ahmad');
    await page.getByTestId('forward-send').click();
    await page.getByText('Forwarded to Ahmad').first().waitFor();
    await page.goto(chatUrl('60125550142@s.whatsapp.net'));
    await page.getByText('Upload to WhatsApp failed').last().waitFor();
    await shot('23-upload-failed-retry');
    await api('PUT', '/mock/forward/scenario', { scenario: 'normal' });
  });
  if (size === 'desktop')
    await step('activity', async () => {
      await page.goto('/admin/audit');
      await page.getByText('Message forwarded').first().waitFor();
      await shot('16-activity');
    });
  await s.ctx.close();

  // Dark, ms, zh-CN: the dialog with two chats picked.
  for (const opt of [{ scheme: 'dark' }, { locale: 'ms' }, { locale: 'zh-CN' }]) {
    const o = await session('aisyah', { size, ...opt });
    await o.step('locale', async () => {
      await openForward(o, PRIYA, 'the lid is broken');
      await o.page.getByTestId('forward-row').nth(0).click();
      await o.page.getByTestId('forward-row').nth(1).click();
      await o.shot('04-picked-two-inboxes');
      await o.page.keyboard.press('Escape');
      await o.page.goto(chatUrl(NURUL));
      await bubble(o.page, 'URGENT').waitFor();
      await o.shot('13-inbound-forwarded-many');
    });
    await o.ctx.close();
  }

  // A limited agent (Ravi: Priya Nair, Jason Lim, Kopi Lovers Club): only the chosen chats are listed.
  const r = await session('ravi', { size });
  await r.step('limited', async () => {
    await openForward(r, PRIYA, 'the lid is broken');
    await r.shot('17-limited-agent-list');
  });
  await r.ctx.close();

  // Lite: one inbox, no inbox chips and no "own number" note.
  const l = await session('aisyah', { size, edition: 'lite' });
  await l.step('lite', async () => {
    await openForward(l, NURUL, 'URGENT');
    await l.shot('18-lite-dialog');
  });
  await l.ctx.close();
}

await browser.close();
writeFileSync(
  join(OUT, 'forward-results.json'),
  JSON.stringify({ shots: passed.length, problems, passed }, null, 2) + '\n',
);
console.log(`${passed.length} screenshots, ${problems.length} problems`);
for (const p of problems) console.log(' -', p);
