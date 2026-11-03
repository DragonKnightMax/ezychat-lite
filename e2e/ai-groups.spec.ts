import type { Page } from '@playwright/test';
import {
  chatHref,
  expect,
  expectNoHorizontalScroll,
  inboxHeading,
  projectTag,
  test,
} from './helpers';

/**
 * AI agents in WhatsApp groups (docs/features/ai-groups/design.md): the agent page Groups card and
 * the Group info row. No model is called: the agent stays off (a fresh e2e install has no AI
 * connection), so Group info says so. Lite has one shared agent: its "Answer in groups" switch is
 * set through the API (idempotent) and toggled in the page only by the desktop project.
 */
const DESKTOP = 'desktop-chromium';

async function agentId(page: Page): Promise<number> {
  const list = async () =>
    ((await (await page.request.get('/api/ai/agents')).json()) as { agents: { id: number }[] })
      .agents;
  if (!(await list()).length) {
    const origin = new URL(page.url()).origin;
    await page.request.post('/api/ai/agents', {
      headers: { Origin: origin },
      data: {
        displayName: 'Help desk',
        enabled: false,
        preset: 'faq',
        instructions: 'Answer questions about the shop.',
        handoffRules: 'Hand over refunds.',
      },
    });
  }
  await expect.poll(async () => (await list()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  return (await list())[0]!.id;
}

test('Groups card and Group info: switch a group on for the AI', async ({
  page,
  baseURL,
}, info) => {
  const tag = projectTag(info).replace(/\D/g, '').padStart(2, '0').slice(-2);
  const groupJid = `1203630888000${tag}@g.us`;
  const group = `Kopi Lovers ${tag}`;
  const origin = { Origin: new URL(baseURL!).origin };
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  const id = await agentId(page);
  const made = await page.request.post('/api/dev/fake-group', {
    headers: origin,
    data: {
      groupJid,
      name: group,
      generated: 3,
      members: [{ phone: `601622155${tag}`, name: 'Nurul Huda', role: 'admin' }],
    },
  });
  expect(made.status(), await made.text()).toBe(200);
  await page.request.post('/api/dev/fake-incoming', {
    headers: origin,
    data: { chatJid: groupJid, text: 'Morning all!', senderName: 'Nurul Huda' },
  });
  const on = await page.request.put(`/api/ai/agents/${id}/groups`, {
    headers: origin,
    data: { enabled: true },
  });
  expect(on.status(), await on.text()).toBe(200);

  // Agent page: add the group through Add groups (Reads every message ticked by default).
  await page.goto(`/admin/members/ai/${id}`);
  const card = page.getByTestId('agent-groups');
  await expect(card.getByTestId('answer-in-groups')).toBeVisible();
  const listenSwitch = card.getByRole('switch', { name: `Reads every message in ${group}` });
  if (!(await listenSwitch.isVisible())) {
    await card.getByTestId('add-groups').click();
    const dialog = page.getByRole('dialog', { name: /Add groups to/ });
    await dialog.getByLabel(new RegExp(group)).check();
    await dialog.getByTestId('add-groups-save').click();
    await expect(dialog).toBeHidden();
  }
  await expect(listenSwitch).toHaveAttribute('aria-checked', 'true');
  await expectNoHorizontalScroll(page, 'agent page groups card');
  const chat = (await (
    await page.request.get(`/api/chats/${encodeURIComponent(groupJid)}/ai-group`)
  ).json()) as { enabled: boolean; agentEnabled: boolean };
  expect(chat.enabled).toBe(true);

  // Group info: the agent itself is off (no AI connection here), so the row says so.
  await page.goto(chatHref(groupJid));
  await page.getByRole('button', { name: `Open group info for ${group}` }).click();
  const panel = page
    .getByRole('complementary', { name: 'Group info' })
    .or(page.getByRole('dialog', { name: 'Group info' }));
  const row = panel.getByTestId('group-ai-row');
  await expect(row.getByText('AI agent in this group')).toBeVisible();
  if (!chat.agentEnabled)
    await expect(row.getByText(/is off\. Nothing is answered in groups/)).toBeVisible();
  await expectNoHorizontalScroll(page, 'group info AI row');
});

test('Answer in groups switch turns off and on (desktop)', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== DESKTOP, 'one project changes the shared agent');
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  const id = await agentId(page);
  await page.goto(`/admin/members/ai/${id}`);
  const card = page.getByTestId('agent-groups');
  const master = card.getByTestId('answer-in-groups');
  await expect(master).toBeVisible();
  const state = async () =>
    (
      (await (await page.request.get(`/api/ai/agents/${id}/groups`)).json()) as {
        enabled: boolean;
      }
    ).enabled;
  const before = await state();
  await master.click();
  await expect.poll(state).toBe(!before);
  await master.click();
  await expect.poll(state).toBe(before);
  expect(new URL(baseURL!).origin).toBeTruthy();
});

/**
 * Group-only agents (docs/features/ai-direct-chats/design.md): "Answer direct chats" off with
 * "Answer in groups" on shows the group-only note; switched back on at the end (the agent is shared
 * by every spec). The assignee filter is covered by unit tests and the Dev Build check: here the
 * agent stays off (no AI connection), so it is never offered as an assignee anyway.
 */
test('Answer direct chats off makes a group-only agent (desktop)', async ({
  page,
  baseURL,
}, info) => {
  test.skip(info.project.name !== DESKTOP, 'one project changes the shared agent');
  const origin = { Origin: new URL(baseURL!).origin };
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  const id = await agentId(page);
  const groupsOn = await page.request.put(`/api/ai/agents/${id}/groups`, {
    headers: origin,
    data: { enabled: true },
  });
  expect(groupsOn.status(), await groupsOn.text()).toBe(200);
  const saved = async () =>
    (
      (await (await page.request.get(`/api/ai/agents/${id}/groups`)).json()) as {
        answerDirect: boolean;
      }
    ).answerDirect;

  try {
    await page.goto(`/admin/members/ai/${id}`);
    const card = page.getByTestId('agent-direct');
    const toggle = card.getByTestId('answer-direct');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(saved).toBe(false);
    await expect(card.getByTestId('direct-group-only')).toBeVisible();
    await expectNoHorizontalScroll(page, 'agent page direct chats card');
    await toggle.click();
    await expect.poll(saved).toBe(true);
    await expect(card.getByTestId('direct-group-only')).toHaveCount(0);
  } finally {
    await page.request.put(`/api/ai/agents/${id}/direct`, {
      headers: origin,
      data: { enabled: true },
    });
  }
});
