import type { Locator } from '@playwright/test';
import { chatItem, customerJid, expect, fakeIncoming, inboxHeading, test } from './helpers';

/** A 1×1 PNG, as a screenshot on the clipboard. */
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A drag-and-drop or paste event carrying real files, as the OS hands them to the page. */
async function sendFiles(
  target: Locator,
  kind: 'drop' | 'paste',
  files: Array<{ name: string; type: string; text?: string; base64?: string }>,
) {
  await target.evaluate(
    (el, { kind, files }) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const data = f.base64 ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : f.text!;
        dt.items.add(new File([data], f.name, { type: f.type }));
      }
      if (kind === 'paste') {
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
        return;
      }
      for (const type of ['dragenter', 'dragover', 'drop'])
        el.dispatchEvent(
          new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
        );
    },
    { kind, files },
  );
}

test('drop and paste files into a chat, send them in order, copy a message out', async ({
  page,
  baseURL,
  context,
}, info) => {
  // Drag-and-drop and the hover Copy button are desktop entry points; touch is covered by unit tests.
  test.skip(info.project.name !== 'desktop-chromium');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const jid = customerJid(info, 93);
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  await fakeIncoming(
    page,
    { chatJid: jid, text: 'Can you send the price list?', senderName: 'Lim' },
    baseURL!,
  );
  await chatItem(page, jid).click();

  const conversation = page.getByRole('region', { name: /Lim/ });
  await sendFiles(conversation, 'drop', [
    { name: 'price-list.pdf', type: 'application/pdf', text: '%PDF-1.4 price list' },
    { name: 'terms.txt', type: 'text/plain', text: 'Terms' },
  ]);
  const tray = page.getByTestId('attachment-tray');
  await expect(tray).toContainText('2 files to send');
  const composer = page.getByLabel('Message', { exact: true });
  await sendFiles(composer, 'paste', [{ name: 'image.png', type: 'image/png', base64: PIXEL_PNG }]);
  await expect(tray).toContainText('3 files to send');
  await tray.getByRole('button', { name: /Remove pasted-/ }).click();
  await expect(tray).toContainText('2 files to send');

  await composer.fill('Here you go');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(tray).toBeHidden();

  const log = page.getByRole('log', { name: 'Messages' });
  await expect(log.locator('[data-message-id]', { hasText: 'price-list.pdf' })).toContainText(
    'Here you go',
  );
  await expect(log.locator('[data-message-id]', { hasText: 'terms.txt' })).toBeVisible();
  // Stored in the order they were added, the caption only on the first.
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/chats/${encodeURIComponent(jid)}/messages`);
      const body = (await res.json()) as {
        messages: Array<{ fromMe: boolean; mediaName: string | null; body: string | null }>;
      };
      return body.messages.filter((m) => m.fromMe).map((m) => [m.mediaName, m.body]);
    })
    .toEqual([
      ['price-list.pdf', 'Here you go'],
      ['terms.txt', null],
    ]);

  // Copy the customer's text out of the app.
  const incoming = log.locator('[data-message-id]', { hasText: 'Can you send the price list?' });
  await incoming.hover();
  await incoming.locator('..').getByRole('button', { name: 'Copy text' }).click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'Can you send the price list?',
  );
});
