// Screenshots of the proposed Google Calendar connector (google-calendar) in the running seeded mock
// (run.ts --fake-wa), at desktop 1280 px and mobile 360 px (touch), light and dark: Settings →
// Integrations (connected, not connected, Google sign-in, sign-in expired, Google unavailable), the
// agent page Bookings card (connected, booking off, not connected), Try it (free times, would book,
// booking off) and the chat with the "AI booked" line. Reports page errors and horizontal overflow.
// Usage: node docs/features/grammar-fix/mock/calendar-shots.mjs [baseUrl]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:7489';
const OUT = join(import.meta.dirname, 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium
  .launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
  .catch(() => chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge' }));
const problems = [];
const MEI_YING = '60124448899@s.whatsapp.net';
const post = (ctx, path, data, method = 'post') =>
  ctx.request[method](path, { data, headers: { origin: BASE } });

const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
};
const BOOKING = {
  calendarId: 'bookings',
  checkFree: true,
  book: true,
  title: 'Table booking',
  lengthMin: 90,
  days: [1, 2, 3, 4, 5, 6],
  from: '10:00',
  to: '21:00',
  gapMin: 15,
  noticeHours: 2,
  maxDays: 14,
};

for (const scheme of ['light', 'dark'])
  for (const [sizeName, size] of Object.entries(sizes)) {
    const suffix = `${sizeName}-${scheme}`;
    const ctx = await browser.newContext({
      ...size,
      baseURL: BASE,
      colorScheme: scheme,
      timezoneId: 'Asia/Kuala_Lumpur',
    });
    const login = await post(ctx, '/api/auth/login', {
      username: 'aisyah',
      password: 'demo-pass-123',
    });
    if (!login.ok()) throw new Error(`login failed ${login.status()}`);
    const reset = async (state = 'connected', booking = BOOKING) => {
      await post(ctx, '/api/mock/google-calendar/connect', {
        account: 'kopiapong.penang@gmail.com',
      });
      await post(ctx, '/api/mock/google-calendar/state', { state }, 'put');
      await post(ctx, '/api/mock/google-calendar/agents/a1', booking, 'put');
    };
    await reset();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${suffix} pageerror: ${e.message}`));
    const shot = async (name, opts = {}) => {
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      if (overflow) problems.push(`${suffix} ${name}: horizontal overflow`);
      await page.screenshot({ path: join(OUT, `${name}-${suffix}.png`), ...opts });
    };
    const gallery = async () => {
      await page.goto('/admin/connectors');
      await page.getByTestId('connectors-gallery').waitFor();
    };
    const gcPage = async (tab = 'overview') => {
      await page.goto(`/admin/connectors/google-calendar?tab=${tab}`);
      await page.getByTestId('connector-page-google-calendar').waitFor();
      await page.waitForTimeout(300);
    };

    // Admin → Connectors: the gallery (connected first), a category, no match.
    await gallery();
    await shot('01-gallery', { fullPage: true });
    await page.getByRole('button', { name: 'Calendar & booking' }).click();
    await shot('02-gallery-category');
    await page.getByRole('searchbox', { name: 'Search connectors' }).fill('zzz');
    await shot('03-gallery-no-match');

    // Google Calendar page: Overview, Settings, Activity; states.
    await gcPage();
    await shot('04-gc-overview', { fullPage: true });
    await gcPage('settings');
    await shot('05-gc-settings', { fullPage: true });
    await gcPage('activity');
    await shot('06-gc-activity');
    await post(ctx, '/api/mock/google-calendar/state', { state: 'expired' }, 'put');
    await gcPage();
    await page.getByTestId('google-calendar-settings').scrollIntoViewIfNeeded();
    await shot('07-gc-expired');
    await gallery();
    await shot('08-gallery-attention');
    await post(ctx, '/api/mock/google-calendar/disconnect', {});
    await gcPage();
    await shot('09-gc-not-connected', { fullPage: true });
    await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
    await page.getByTestId('google-consent').waitFor();
    await shot('10-google-sign-in');
    await page.keyboard.press('Escape');
    await gcPage('settings');
    await shot('11-gc-settings-not-connected');

    // Other connectors: coming soon and Enterprise-only (Lite view).
    await page.goto('/admin/connectors/google-sheets');
    await page.getByTestId('connector-page-google-sheets').waitFor();
    await shot('12-sheets-coming-soon', { fullPage: true });
    await page.goto('/admin/connectors/hitpay');
    await page.getByTestId('connector-page-hitpay').waitFor();
    await shot('13-hitpay-enterprise', { fullPage: true });

    // Lite view: Enterprise connectors carry an Enterprise badge and an upgrade note.
    await page.goto('/admin/connectors?edition=lite');
    await page.getByTestId('connectors-gallery').waitFor();
    await shot('12b-gallery-lite', { fullPage: true });
    await page.goto('/admin/connectors/autocount?edition=lite');
    await page.getByTestId('connector-page-autocount').waitFor();
    const vote = await page.getByTestId('vote-connector').getAttribute('href');
    if (!vote?.startsWith('https://wa.me/601159246128?text=') || !vote.includes('AutoCount'))
      problems.push(`${suffix} vote link: ${vote}`);
    await shot('13d-autocount-lite', { fullPage: true });
    await page.goto('/admin/connectors/custom-mcp?edition=lite');
    await page.getByTestId('connector-page-custom-mcp').waitFor();
    await shot('13c-custom-lite', { fullPage: true });
    await page.goto('/admin/connectors?edition=enterprise');
    await page.getByTestId('connectors-gallery').waitFor();

    // Agent page → Connectors summary.
    await reset('connected', { ...BOOKING, book: false });
    await page.goto('/admin/members/ai/a1');
    const card = page.getByTestId('agent-connectors');
    await card.waitFor();
    await card.screenshot({ path: join(OUT, `14-agent-connectors-${suffix}.png`) });

    // Try it: free times, then booking off (team books).
    const tryIt = async (pick) => {
      await page.goto('/admin/members/ai/a1');
      const box = page.getByTestId('agent-try');
      await box.waitFor();
      await box.getByRole('textbox').fill('Hi, can I book a table for 4 people?');
      await box.getByRole('button', { name: 'Ask' }).click();
      await box.getByText('AI checked free times').waitFor();
      if (pick) await box.getByRole('button', { name: 'Customer picks the first time' }).click();
      await box.scrollIntoViewIfNeeded();
      return box;
    };
    await tryIt(false);
    await shot('15-try-free-times');
    await tryIt(true);
    await shot('16-try-booking-off-handoff');
    await reset();
    await tryIt(true);
    await page.getByTestId('try-would-book').waitFor();
    await shot('17-try-would-book');

    // The chat where the AI booked a table.
    await page.goto(`/chats/${encodeURIComponent(MEI_YING)}`);
    await page
      .getByText(/AI booked/)
      .first()
      .waitFor();
    await shot('18-chat-booked');
    await ctx.close();
  }
await browser.close();
console.log(problems.length ? problems.join('\n') : 'No page errors or horizontal overflow.');
