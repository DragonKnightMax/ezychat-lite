import {
  chatHref,
  customerJid,
  expect,
  expectNoHorizontalScroll,
  inboxHeading,
  projectTag,
  test,
} from './helpers';

test('a teammate edits and deletes a sent message; the customer’s edits and deletes show; admins hide one', async ({
  page,
  baseURL,
}, info) => {
  const tag = projectTag(info);
  const jid = customerJid(info, 71);
  const origin = { Origin: new URL(baseURL!).origin };
  const touch = info.project.name !== 'desktop-chromium';
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  const post = async (path: string, data: Record<string, unknown>, status = 200) => {
    const r = await page.request.post(path, { headers: origin, data });
    expect(r.status(), await r.text()).toBe(status);
    return r.json() as Promise<{ id: string }>;
  };
  const question = await post('/api/dev/fake-incoming', {
    chatJid: jid,
    senderName: 'Ahmad Edits',
    text: 'Great, 3 Kopi Peng for pickup at 11am please.',
  });
  const wrong = await post('/api/dev/fake-incoming', {
    chatJid: jid,
    senderName: 'Ahmad Edits',
    text: 'Sorry, wrong chat',
  });
  await page.goto(chatHref(jid));
  await post(
    `/api/chats/${encodeURIComponent(jid)}/messages`,
    { text: 'We open 10am to 6pm on Hari Raya.', clientId: `edit-${tag}-${Date.now()}` },
    201,
  );
  const sent = page.locator('[data-message-id]').filter({ hasText: 'on Hari Raya' });
  await expect(sent).not.toHaveAttribute('data-message-id', /^local-/);
  // By id from here: the text changes, and goes once the message is deleted.
  const reply = page.locator(`[data-message-id="${await sent.getAttribute('data-message-id')}"]`);
  const row = reply.locator('..');

  // Desktop: the ⋮ menu (keyboard path, as for reactions). Touch: press-and-hold bar → Edit / Delete.
  const choose = async (action: 'Edit' | 'Delete') => {
    if (touch) {
      await row.getByTestId('reaction-picker-button').focus();
      await page.keyboard.press('Enter');
      await page.getByTestId('reaction-picker').getByRole('button', { name: action }).click();
    } else {
      await row.getByTestId('message-more').focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: action }).click();
    }
  };

  await choose('Edit');
  const box = page.getByTestId('edit-text');
  await expect(box).toHaveValue('We open 10am to 6pm on Hari Raya.');
  await expectNoHorizontalScroll(page, 'edit dialog');
  await box.fill('We open 10am to 4pm on Hari Raya.');
  await page.getByTestId('edit-save').click();
  await expect(reply).toContainText('We open 10am to 4pm on Hari Raya.');
  await reply.getByTestId('edited-label').click();
  // The earlier version in the popover (the hidden chat list on phones shows the preview too).
  await expect(
    page.getByText('We open 10am to 6pm on Hari Raya.').filter({ visible: true }),
  ).toHaveCount(1);
  await expect(page.getByText(/Changed by You/)).toBeVisible();
  await page.keyboard.press('Escape');

  await choose('Delete');
  await expect(page.getByTestId('delete-for-me')).toBeVisible();
  await expectNoHorizontalScroll(page, 'delete dialog');
  await page.getByTestId('delete-for-everyone').click();
  await expect(reply.getByTestId('deleted-body')).toContainText('You deleted this message');

  // The customer edits and deletes through WhatsApp (the fake phone).
  await post('/api/dev/fake-edit', {
    messageId: question.id,
    body: 'Great, 4 Kopi Peng for pickup at 11.30am please.',
  });
  const edited = page.locator(`[data-message-id="${question.id}"]`);
  await expect(edited).toContainText('4 Kopi Peng for pickup at 11.30am');
  await expect(edited.getByTestId('edited-label')).toBeVisible();
  await post('/api/dev/fake-revoke', { messageId: wrong.id });
  const deleted = page.locator(`[data-message-id="${wrong.id}"]`);
  await expect(deleted.getByTestId('deleted-body')).toContainText('deleted this message');
  await expect(deleted).not.toContainText('Sorry, wrong chat');
  await deleted.getByTestId('show-original').click();
  await expect(deleted).toContainText('Sorry, wrong chat');

  // Admin: Delete for me hides the customer's edited message for the whole team.
  const editedRow = edited.locator('..');
  if (touch) {
    await editedRow.getByTestId('reaction-picker-button').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('reaction-picker').getByRole('button', { name: 'Delete' }).click();
  } else {
    await editedRow.getByTestId('message-more').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Delete' }).click();
  }
  await expect(page.getByTestId('delete-for-everyone')).toHaveCount(0);
  await page.getByTestId('delete-for-me').click();
  await expect(edited).toHaveCount(0);
  // After a reload: the deletes and the hidden message stay as they are.
  await page.reload();
  await expect(reply.getByTestId('deleted-body')).toContainText('You deleted this message');
  await expect(page.locator(`[data-message-id="${wrong.id}"]`)).toBeVisible();
  await expect(edited).toHaveCount(0);
  await expectNoHorizontalScroll(page, 'conversation after changes');
});
