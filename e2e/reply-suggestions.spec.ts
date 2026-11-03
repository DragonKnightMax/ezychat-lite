import {
  chatHref,
  chatItem,
  customerJid,
  expect,
  expectNoHorizontalScroll,
  fakeIncoming,
  inboxHeading,
  projectTag,
  test,
} from './helpers';

// Never contacts a model: the status and the two draft calls are answered in the browser, so the
// whole composer flow runs against the real web app without any provider.
const DRAFTS = {
  suggestions: [
    { label: 'Confirm price, ask the name', text: 'Two Nasi Lemak Ayam at RM12 each. Your name?' },
    { label: 'Offer a drink with it', text: 'Noted! Would you like a Kopi O (RM3.50) with it?' },
  ],
  noAnswer: false,
  handoffRule: null,
};

test('a teammate picks an AI draft or accepts the grey completion, on desktop and phone', async ({
  page,
  baseURL,
}, info) => {
  const jid = customerJid(info, 91);
  await page.route('**/api/reply-suggestions', (route) =>
    route.fulfill({ json: { enabled: true, connected: true, state: 'on', upgraded: false } }),
  );
  await page.route('**/ai/suggestions', (route) => route.fulfill({ json: DRAFTS }));
  await page.route('**/ai/complete', (route) =>
    route.fulfill({ json: { completion: 'two Nasi Lemak are RM24.' } }),
  );
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  await fakeIncoming(
    page,
    { chatJid: jid, text: 'Can I order two Nasi Lemak for pickup at 1pm?', senderName: 'Nurul' },
    baseURL!,
  );
  await chatItem(page, jid).click();

  await page.getByRole('button', { name: 'Suggest reply' }).click();
  const chips = page.getByTestId('suggestion-chip');
  await expect(chips).toHaveCount(2);
  await expectNoHorizontalScroll(page, `suggestions ${info.project.name}`);
  await chips.first().click();
  const composer = page.getByLabel('Message', { exact: true });
  await expect(composer).toHaveValue(DRAFTS.suggestions[0]!.text);

  // Typed work is never replaced without asking.
  await composer.fill('Hi Nurul, sure');
  await page.getByRole('button', { name: 'Suggest reply' }).click();
  await chips.nth(1).click();
  await page.getByRole('button', { name: 'Keep my text' }).click();
  await expect(composer).toHaveValue('Hi Nurul, sure');

  // Completion after a full word: Tab on desktop, the Accept pill on a phone.
  await composer.fill('');
  await composer.pressSequentially('Hi Nurul, ', { delay: 20 });
  await expect(page.getByTestId('completion-ghost')).toContainText('two Nasi Lemak are RM24.');
  if (['mobile', 'iphone'].includes(info.project.name))
    await page.getByTestId('accept-completion').click();
  else await composer.press('Tab');
  await expect(composer).toHaveValue('Hi Nurul, two Nasi Lemak are RM24.');
});

test('Settings → AI shows the team-wide reply suggestions switch with its cost note', async ({
  page,
}, info) => {
  // One install-wide switch shared by the projects.
  test.skip(info.project.name !== 'desktop-chromium');
  await page.goto('/admin/settings/ai');
  const card = page.getByTestId('reply-suggestions-settings');
  await expect(card.getByText('Reply suggestions', { exact: true })).toBeVisible();
  await expect(card.getByText(/one request to your AI provider/)).toBeVisible();
  await expectNoHorizontalScroll(page, 'settings/ai reply suggestions');
});

test('a group chat offers Suggest reply and Summarise with Ezy too', async ({
  page,
  baseURL,
}, info) => {
  const tag = projectTag(info).replace(/\D/g, '').padStart(2, '0').slice(-2);
  const groupJid = `1203630777000${tag}@g.us`;
  const origin = { Origin: new URL(baseURL!).origin };
  await page.route('**/api/reply-suggestions', (route) =>
    route.fulfill({ json: { enabled: true, connected: true, state: 'on', upgraded: false } }),
  );
  await page.route('**/ai/suggestions', (route) => route.fulfill({ json: DRAFTS }));
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  const made = await page.request.post('/api/dev/fake-group', {
    headers: origin,
    data: {
      groupJid,
      name: `Nasi Lemak Club ${tag}`,
      members: [{ phone: `601266779${tag}`, name: 'Nurul Huda', role: 'admin' }],
    },
  });
  expect(made.status(), await made.text()).toBe(200);
  await page.request.post('/api/dev/fake-incoming', {
    headers: origin,
    data: { chatJid: groupJid, text: 'Two Nasi Lemak for 1pm?', senderName: 'Nurul Huda' },
  });
  await page.goto(chatHref(groupJid));

  await expect(page.getByTestId('ask-ezy-about-chat')).toBeVisible();
  await page.getByRole('button', { name: 'Suggest reply' }).click();
  const chips = page.getByTestId('suggestion-chip');
  await expect(chips).toHaveCount(2);
  await chips.first().click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    DRAFTS.suggestions[0]!.text,
  );
  await expectNoHorizontalScroll(page, `group suggestions ${info.project.name}`);
});
