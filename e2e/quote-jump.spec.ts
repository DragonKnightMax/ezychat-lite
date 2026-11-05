import type { Page } from '@playwright/test';
import { chatItem, customerJid, expect, inboxHeading, test } from './helpers';

/** A customer message through the fake adapter; `quotedId` = a stored message it replies to. */
async function incoming(
  page: Page,
  baseURL: string,
  body: { chatJid: string; text: string; quotedId?: string },
): Promise<string> {
  const res = await page.request.post('/api/dev/fake-incoming', {
    data: { senderName: 'Mei', ...body },
    headers: { Origin: new URL(baseURL).origin },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const log = (page: Page) => page.getByRole('log', { name: 'Messages' });
const bubble = (page: Page, id: string) => log(page).locator(`[data-message-id="${id}"]`);

test('tap a quote to jump to the original, loading older messages when needed', async ({
  page,
  baseURL,
}, info) => {
  const jid = customerJid(info, 95);
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();

  // An original far back (more than one page of 50 newer messages), then a loaded one.
  const old = await incoming(page, baseURL!, { chatJid: jid, text: 'Old question: sizes?' });
  for (let i = 0; i < 55; i++)
    await incoming(page, baseURL!, { chatJid: jid, text: `filler ${i}` });
  const recent = await incoming(page, baseURL!, {
    chatJid: jid,
    text: 'Recent question: colours?',
  });
  const aboutColours = await incoming(page, baseURL!, {
    chatJid: jid,
    text: 'About the colours',
    quotedId: recent,
  });
  const aboutSizes = await incoming(page, baseURL!, {
    chatJid: jid,
    text: 'About the sizes',
    quotedId: old,
  });
  await chatItem(page, jid).click();

  // 1. The original is loaded: it is scrolled into view and highlighted.
  const toRecent = bubble(page, aboutColours).getByTestId('quote-jump');
  await expect(toRecent).toHaveAccessibleName(/Go to the quoted message/);
  await toRecent.click();
  const recentBubble = bubble(page, recent);
  await expect(recentBubble).toBeInViewport();
  await expect(recentBubble).toHaveAttribute('data-highlighted', 'true');
  await expect(recentBubble).not.toHaveAttribute('data-highlighted', 'true', { timeout: 5000 });

  // 2. The original is older than the loaded page: older messages load until it is there.
  await expect(bubble(page, old)).toHaveCount(0);
  await bubble(page, aboutSizes).getByTestId('quote-jump').click();
  const oldBubble = bubble(page, old);
  await expect(oldBubble).toBeInViewport();
  await expect(oldBubble).toHaveAttribute('data-highlighted', 'true');
});

test('a quote whose original is not in our records says so and stays put', async ({
  page,
  baseURL,
}, info) => {
  const jid = customerJid(info, 96);
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  await incoming(page, baseURL!, { chatJid: jid, text: 'Hi there' });
  // WhatsApp quoted a message we never stored (older than the history import).
  const followUp = await incoming(page, baseURL!, {
    chatJid: jid,
    text: 'Following up on that',
    quotedId: 'NEVER-STORED-QUOTE-1',
  });
  await chatItem(page, jid).click();

  const quote = bubble(page, followUp).getByTestId('quote-jump');
  await expect(quote).toContainText('Quoted message');
  // keyboard: the quote is a button
  await quote.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText("The original message isn't available")).toBeVisible();
  await expect(log(page).locator('[data-highlighted="true"]')).toHaveCount(0);
});
