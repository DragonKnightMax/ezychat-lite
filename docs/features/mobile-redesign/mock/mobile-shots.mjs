// Screenshots of the proposed phone redesign (mobile-redesign) in the running seeded mock
// (run.ts --fake-wa): 360 px and 390 px touch, light and dark, en + ms + zh-CN for the main screens,
// and desktop 1280 px to show the desktop layout is unchanged. Measures the list (space above the
// first row, rows visible, touch targets under 44 px) and reports page errors and horizontal overflow.
// Ends with screenshots/mobile-results.json. Run on a fresh mock (the swipes change chats).
// Usage: node docs/features/mobile-redesign/mock/mobile-shots.mjs [baseUrl]   (PW_CHROMIUM=<chromium>)
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
const metrics = {};
const sizes = {
  desktop: { viewport: { width: 1280, height: 860 } },
  m360: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
  m390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};

async function session(
  user,
  { size, scheme = 'light', locale = 'en', edition = 'enterprise', scale = 2 },
) {
  const ctx = await browser.newContext({
    ...sizes[size],
    deviceScaleFactor: scale,
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
    }
  };
  return { ctx, page, shot, step, suffix };
}

const openList = async (page) => {
  await page.goto('/');
  await page.getByTestId('swipe-row').first().waitFor();
};
const measure = (page) =>
  page.evaluate(() => {
    const list = document.querySelector('aside ul');
    const top = list?.getBoundingClientRect().top ?? 0;
    const rows = [...document.querySelectorAll('aside ul > li')].filter(
      (li) => li.getBoundingClientRect().bottom <= window.innerHeight,
    ).length;
    const small = [...document.querySelectorAll('aside button, aside a, aside [role=tab]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        // Chips draw 36 px and extend their hit area with ::after (44 px).
        const after = getComputedStyle(el, '::after');
        const extra = after.content !== 'none' && after.position === 'absolute' ? 8 : 0;
        return r.width > 0 && r.top < window.innerHeight && r.height + extra < 44;
      })
      .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24));
    return { chromeBeforeFirstRow: Math.round(top), rowsVisible: rows, smallTargets: small };
  });

/** A touch swipe on a list row: pointer events as a finger sends them. */
async function swipe(page, index, dx, { release = true } = {}) {
  await page.evaluate(
    ([i, d, up]) => {
      const row = document.querySelectorAll('[data-testid=swipe-row] > div:nth-child(2)')[i];
      const r = row.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const x0 = r.left + r.width / 2;
      const fire = (type, x) =>
        row.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: 'touch',
            pointerId: 7,
            clientX: x,
            clientY: y,
            isPrimary: true,
          }),
        );
      fire('pointerdown', x0);
      for (let k = 1; k <= 6; k++) fire('pointermove', x0 + (d * k) / 6);
      if (up) fire('pointerup', x0 + d);
    },
    [index, dx, release],
  );
}

// ---------- Phone, 360 px, light, English: the whole journey ----------
{
  const { ctx, page, shot, step } = await session('aisyah', { size: 'm360' });
  await step('list', async () => {
    await openList(page);
    metrics.m360 = await measure(page);
    await shot('01-list');
  });
  await step('switcher', async () => {
    await page.getByTestId('inbox-switcher').click();
    await page.getByTestId('inbox-switcher-sheet').waitFor();
    await shot('02-inbox-switcher');
    await page.getByTestId('switch-catering').click();
    await page.getByTestId('inbox-switcher-sheet').waitFor({ state: 'detached' });
    await shot('03-switched-catering');
    // Owner 2026-11-07: New chat's Send from starts on the number being viewed.
    await page.getByTestId('new-chat-fab').click();
    await page.getByRole('dialog').waitFor();
    await shot('03b-new-chat-sends-from-catering');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByTestId('inbox-switcher').click();
    await page.getByTestId('switch-all').click();
    await page.getByTestId('inbox-switcher-sheet').waitFor({ state: 'detached' });
  });
  await step('unread', async () => {
    await page.getByTestId('chip-unread').click();
    await shot('04-chip-unread');
    await page.getByRole('button', { name: /^All$/ }).click();
  });
  await step('tag filter', async () => {
    await page.getByTestId('chip-tag').click();
    await page.getByTestId('tag-filter-sheet').waitFor();
    await shot('05-tag-filter-sheet');
    await page.getByTestId('tag-filter-sheet').getByRole('button', { name: 'VIP' }).click();
    await page.getByTestId('tag-filter-sheet').waitFor({ state: 'detached' });
    await shot('06-tag-filtered');
    await page.getByRole('button', { name: 'Clear tag filter' }).click();
  });
  await step('search', async () => {
    await page.getByTestId('mobile-search').click();
    await page.getByRole('searchbox').fill('kopi');
    await page.waitForTimeout(500);
    await shot('07-search');
    await page.getByRole('button', { name: 'Close search' }).click();
  });
  await step('fab', async () => {
    await page.getByTestId('new-chat-fab').click();
    await page.getByRole('dialog').waitFor();
    await shot('08-new-chat-sheet');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page
      .locator('aside .overflow-y-auto')
      .last()
      .evaluate((el) => el.scrollBy(0, 200));
    await page.waitForTimeout(350);
    await shot('09-fab-compact-on-scroll');
    await page
      .locator('aside .overflow-y-auto')
      .last()
      .evaluate((el) => el.scrollTo(0, 0));
  });
  await step('swipe', async () => {
    // Row 2 is Nurul Huda (unassigned): swipe right = Assign to me.
    await swipe(page, 1, 100, { release: false });
    await shot('10-swipe-assign');
    await swipe(page, 1, 0); // let go where it started: nothing happens
    await swipe(page, 1, 110);
    await page.getByText(/assigned to you/).waitFor();
    await shot('11-swipe-assigned-toast');
    await swipe(page, 2, -100, { release: false });
    await shot('12-swipe-resolve');
    await swipe(page, 2, 0);
  });
  await step('long press', async () => {
    // Close the Undo toasts of the swipes first, so the sheet is not covered.
    for (const close of await page.locator('[data-sonner-toast] [data-close-button]').all())
      await close.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    await page
      .locator('[data-testid=swipe-row] > div:nth-child(2)')
      .nth(3)
      .dispatchEvent('contextmenu');
    await page.getByTestId('row-actions-sheet').waitFor();
    await shot('13-row-actions');
    await page.keyboard.press('Escape');
    await page.getByTestId('row-actions-sheet').waitFor({ state: 'detached' });
  });
  await step('conversation', async () => {
    await page
      .getByRole('link', { name: /Priya Nair/ })
      .first()
      .click();
    await page.getByTestId('mobile-chat-header').waitFor();
    metrics.m360Conversation = await page.evaluate(() => ({
      headerHeight: Math.round(
        document.querySelector('[data-testid=mobile-chat-header]').getBoundingClientRect().height,
      ),
    }));
    await shot('14-chat-header');
    await page.getByTestId('chip-assignee').click();
    await page.getByTestId('assign-sheet').waitFor();
    await shot('15-assign-sheet');
    await page
      .getByTestId('assign-sheet')
      .getByRole('button', { name: /\(you\)/ })
      .click();
    await page.getByTestId('assign-sheet').waitFor({ state: 'detached' });
    await page.getByTestId('chip-add-tag').click();
    await page.getByTestId('chat-tags-sheet').waitFor();
    await shot('16-chat-tags-sheet');
    await page.getByTestId('chat-tags-sheet').getByRole('button', { name: 'VIP' }).click();
    await page.getByRole('searchbox').fill('Bulk order');
    await shot('17-chat-tags-create');
    await page.getByRole('button', { name: /Add .Bulk order./ }).click();
    await page.getByTestId('chat-tags-done').click();
    await page.getByTestId('chat-tags-sheet').waitFor({ state: 'detached' });
    await page.getByTestId('chat-chips').getByText('Bulk order').waitFor();
    await shot('18-chat-tags-saved');
    await page.getByTestId('mobile-chat-more').click();
    await page.getByTestId('chat-more-sheet').waitFor();
    await shot('19-chat-more-sheet');
    await page.keyboard.press('Escape');
  });
  await step('group', async () => {
    await page.goto('/');
    await page
      .getByRole('link', { name: /Kopi Lovers Club/ })
      .first()
      .click();
    await page.getByTestId('mobile-chat-header').waitFor();
    await shot('20-group-header');
  });
  // Owner 2026-11-07: tags on groups too, and the same tags on every screen.
  await step('group tags', async () => {
    await page.getByTestId('chip-add-tag').click();
    await page.getByTestId('chat-tags-sheet').waitFor();
    await page.getByRole('searchbox').fill('Events');
    await page.getByRole('button', { name: /Add .Events./ }).click();
    await shot('23-group-tags-sheet');
    await page.getByTestId('chat-tags-done').click();
    await page.getByTestId('chat-tags-sheet').waitFor({ state: 'detached' });
    await page.getByTestId('chat-chips').getByText('Events').waitFor();
    await shot('24-group-tags-saved');
    await page.getByRole('button', { name: /Open group info/ }).click();
    await page.getByTestId('chat-tags-row').waitFor();
    await shot('25-group-info-tags');
  });
  await step('group row and filter', async () => {
    await page.goto('/');
    await page.getByTestId('swipe-row').first().waitFor();
    const group = page.locator('[data-testid=swipe-row]', { hasText: 'Reseller Group' });
    await group.locator('> div').nth(1).dispatchEvent('contextmenu');
    await page.getByTestId('row-actions-sheet').waitFor();
    await shot('26-group-row-actions');
    await page.getByTestId('row-actions-sheet').getByRole('button', { name: 'Tags' }).click();
    await page.getByTestId('chat-tags-sheet').waitFor();
    await shot('27-group-row-tags-sheet');
    await page.keyboard.press('Escape');
    await page.getByTestId('chat-tags-sheet').waitFor({ state: 'detached' });
    await page.getByTestId('chip-tag').click();
    await page.getByTestId('tag-filter-sheet').getByRole('button', { name: 'Wholesale' }).click();
    await page.getByTestId('tag-filter-sheet').waitFor({ state: 'detached' });
    await page
      .getByRole('link', { name: /Reseller Group/ })
      .first()
      .waitFor();
    await shot('28-tag-filter-includes-groups');
    await page.getByRole('button', { name: 'Clear tag filter' }).click();
  });
  await step('customer details tags', async () => {
    await page.goto('/');
    await page
      .getByRole('link', { name: /Farah Aziz/ })
      .first()
      .click();
    await page.getByRole('button', { name: /Open customer details/ }).click();
    await page.getByTestId('chat-tags-row').waitFor();
    await shot('29-customer-details-tags');
  });
  await ctx.close();
}

// ---------- Phone, 390 px; dark; Malay; Chinese: the main screens ----------
for (const opts of [
  { size: 'm390' },
  { size: 'm360', scheme: 'dark' },
  { size: 'm360', locale: 'ms' },
  { size: 'm360', locale: 'zh-CN' },
]) {
  const { ctx, page, shot, step, suffix } = await session('aisyah', opts);
  await step('list', async () => {
    await openList(page);
    if (opts.size === 'm390') metrics.m390 = await measure(page);
    await shot('01-list');
    await page.getByTestId('inbox-switcher').click();
    await page.getByTestId('inbox-switcher-sheet').waitFor();
    await shot('02-inbox-switcher');
    await page.keyboard.press('Escape');
    await page.getByTestId('inbox-switcher-sheet').waitFor({ state: 'detached' });
    await page.getByTestId('chip-tag').click();
    await page.getByTestId('tag-filter-sheet').waitFor();
    await shot('05-tag-filter-sheet');
    await page.keyboard.press('Escape');
  });
  await step('chat', async () => {
    await page
      .getByRole('link', { name: /Farah Aziz/ })
      .first()
      .click();
    await page.getByTestId('mobile-chat-header').waitFor();
    await shot('14-chat-header');
    await page.getByTestId('chip-add-tag').click();
    await page.getByTestId('chat-tags-sheet').waitFor();
    await shot('16-chat-tags-sheet');
  });
  void suffix;
  await ctx.close();
}

// ---------- Lite (one number) and a team member ----------
{
  const { ctx, page, shot, step } = await session('aisyah', { size: 'm360', edition: 'lite' });
  await step('lite', async () => {
    await openList(page);
    await shot('21-lite-one-number');
  });
  await ctx.close();
}
{
  const { ctx, page, shot, step } = await session('meiling', { size: 'm360' });
  await step('agent', async () => {
    await openList(page).catch(() => page.waitForTimeout(1500));
    await shot('22-agent-one-number');
  });
  await ctx.close();
}

// ---------- Design system reference page (/design-system), light and dark ----------
for (const opts of [
  { size: 'desktop', scale: 1 },
  { size: 'desktop', scale: 1, scheme: 'dark' },
  { size: 'm360' },
  { size: 'm360', scheme: 'dark' },
]) {
  const { ctx, page, shot, step, suffix } = await session('aisyah', opts);
  await step('design system', async () => {
    await page.goto('/design-system');
    await page.getByTestId('design-system').waitFor();
    await page.waitForTimeout(600);
    await shot('40-design-system');
    await page.screenshot({
      path: join(OUT, `41-design-system-full-${suffix}.png`),
      fullPage: true,
    });
    passed.push(`41-design-system-full-${suffix}`);
    if (opts.size === 'm360') {
      await page.getByTestId('ds-sheet').scrollIntoViewIfNeeded();
      await page.getByTestId('ds-sheet').click();
      await page.getByRole('dialog').waitFor();
      await shot('42-design-system-sheet');
    }
  });
  await ctx.close();
}

// ---------- Desktop 1280 px: unchanged ----------
{
  const { ctx, page, shot, step } = await session('aisyah', { size: 'desktop', scale: 1 });
  await step('desktop', async () => {
    await page.goto('/');
    await page
      .getByRole('link', { name: /Priya Nair/ })
      .first()
      .waitFor();
    if ((await page.getByTestId('mobile-list-header').count()) > 0)
      problems.push('desktop: phone header rendered');
    await shot('30-desktop-list');
    await page
      .getByRole('link', { name: /Priya Nair/ })
      .first()
      .click();
    await page.getByRole('combobox', { name: 'Assigned to' }).waitFor();
    await shot('31-desktop-chat');
    // Group tags on desktop: list row, Group info panel, the same editor (a dialog here), the filter.
    await page
      .getByRole('link', { name: /Kopi Lovers Club/ })
      .first()
      .click();
    await page.getByRole('button', { name: /Open group info/ }).click();
    await page.getByTestId('chat-tags-row').waitFor();
    await shot('32-desktop-group-info-tags');
    await page.getByTestId('chat-tags-edit').click();
    await page.getByTestId('chat-tags-sheet').waitFor();
    await shot('33-desktop-group-tags-dialog');
    await page.keyboard.press('Escape');
    await page.getByTestId('chat-tags-sheet').waitFor({ state: 'detached' });
    await page
      .getByRole('link', { name: /Priya Nair/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Customer details', exact: true }).first().click();
    await page.getByTestId('chat-tags-row').waitFor();
    await shot('34-desktop-customer-tags');
    await page.getByRole('button', { name: 'Filter by tag' }).click();
    await page.getByRole('option', { name: 'Wholesale' }).click();
    await page
      .getByRole('link', { name: /Reseller Group/ })
      .first()
      .waitFor();
    await shot('35-desktop-tag-filter-groups');
  });
  await ctx.close();
}

writeFileSync(
  join(OUT, 'mobile-results.json'),
  JSON.stringify({ passed: passed.length, problems, metrics }, null, 2),
);
console.log(JSON.stringify({ passed: passed.length, problems, metrics }, null, 2));
await browser.close();
