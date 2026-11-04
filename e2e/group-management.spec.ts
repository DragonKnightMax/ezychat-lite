import type { Page, TestInfo } from '@playwright/test';
import {
  chatHref,
  expect,
  expectNoHorizontalScroll,
  inboxHeading,
  projectTag,
  signIn,
  test,
} from './helpers';

/**
 * Group management (design docs/features/group-management/design.md): an EzyChat admin changes a
 * WhatsApp group from Group info through the fake WhatsApp. Nothing here reaches real WhatsApp.
 */

/** Per project and run, so desktop and phone runs (and re-runs) never share a group or number. */
function ids(info: TestInfo, slot: number) {
  const tag = projectTag(info).replace(/\D/g, '').padStart(1, '0').slice(-1);
  const run = String(Date.now()).slice(-5);
  return {
    tag,
    run,
    groupJid: `12036308${slot}${tag}${run}@g.us`,
    phone: (n: number) => `6019${slot}${tag}${run}${String(n).padStart(2, '0')}`,
  };
}

async function makeGroup(
  page: Page,
  baseURL: string,
  body: Record<string, unknown> & { groupJid: string; name: string },
) {
  const origin = { Origin: new URL(baseURL).origin };
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  const res = await page.request.post('/api/dev/fake-group', { headers: origin, data: body });
  expect(res.status(), await res.text()).toBe(200);
  const msg = await page.request.post('/api/dev/fake-incoming', {
    headers: origin,
    data: { chatJid: body.groupJid, text: 'Meeting Friday 8pm', senderName: 'Farid' },
  });
  expect(msg.status(), await msg.text()).toBe(200);
}

async function openGroupInfo(page: Page, groupJid: string, name: string) {
  await page.goto(chatHref(groupJid));
  await page.getByRole('button', { name: `Open group info for ${name}` }).click();
  const panel = page
    .getByRole('complementary', { name: 'Group info' })
    .or(page.getByRole('dialog', { name: 'Group info' }));
  await expect(panel).toBeVisible();
  return panel;
}

test('group management: rename, add, invite after a privacy refusal, remove and a setting', async ({
  page,
  baseURL,
}, info) => {
  test.setTimeout(90_000);
  const { tag, groupJid, phone } = ids(info, 1);
  const name = `SME Founders ${tag}`;
  const privacy = phone(2);
  await makeGroup(page, baseURL!, {
    groupJid,
    name,
    description: 'Monthly meetups for founders.',
    members: [
      { phone: phone(10), name: 'Farid', role: 'member' },
      { phone: phone(11), name: 'Nurul Aisyah', role: 'admin' },
    ],
    meRole: 'superadmin',
    settings: { announce: false, locked: true, memberAdd: 'admins', approval: false },
    joinRequests: [phone(20)],
    privacyRefuses: [privacy],
  });

  const panel = await openGroupInfo(page, groupJid, name);
  await expect(panel.getByTestId('group-description')).toHaveText('Monthly meetups for founders.');
  const manage = panel.getByRole('region', { name: 'Manage group' });
  await expect(manage.getByRole('button', { name: 'Edit info' })).toBeEnabled();
  await expect(manage.getByTestId('join-requests')).toContainText('1 person asked to join');
  await expectNoHorizontalScroll(page, 'group admin bar');

  // Rename.
  await manage.getByRole('button', { name: 'Edit info' }).click();
  const edit = page.getByRole('dialog', { name: 'Group name and description' });
  await edit.getByLabel('Group name').fill(`${name} KL`);
  await expect(edit.getByTestId('group-name-count')).toHaveText(`${name.length + 3} / 100`);
  await expectNoHorizontalScroll(page, 'edit group dialog');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByText('Group updated')).toBeVisible();
  await expect(panel.getByText(`${name} KL`, { exact: true })).toBeVisible();

  // Add one number: added.
  await manage.getByRole('button', { name: 'Add member' }).click();
  let add = page.getByRole('dialog', { name: 'Add a member' });
  await expect(add).toContainText('Adding many strangers can get your number banned');
  await add.getByLabel('WhatsApp number').fill(`+${phone(1)}`);
  await expectNoHorizontalScroll(page, 'add member dialog');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toBeHidden();
  await expect(page.getByText(`+${phone(1)} was added`)).toBeVisible();

  // A number whose privacy refuses adds: Send invite only on click, then sent.
  await manage.getByRole('button', { name: 'Add member' }).click();
  add = page.getByRole('dialog', { name: 'Add a member' });
  await add.getByLabel('WhatsApp number').fill(privacy);
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add.getByText("Couldn't add this person")).toBeVisible();
  await expectNoHorizontalScroll(page, 'add privacy refusal');
  await add.getByRole('button', { name: 'Send invite' }).click();
  await expect(add.getByText('Invite sent')).toBeVisible();
  await add.getByRole('button', { name: 'Done' }).click();
  await expect(add).toBeHidden();

  // Remove a member, after the confirm.
  await panel.getByRole('searchbox', { name: 'Search members' }).fill('Farid');
  await panel
    .getByRole('list', { name: 'Group members' })
    .getByRole('button', { name: /Farid/ })
    .click();
  await panel.getByRole('button', { name: 'Remove from group' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove Farid from the group?' });
  await expect(confirm).toBeVisible();
  await expectNoHorizontalScroll(page, 'remove confirm');
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText('Farid was removed')).toBeVisible();
  const list = panel.getByRole('list', { name: 'Group members' });
  await expect(list).toBeVisible();
  await panel.getByRole('searchbox', { name: 'Search members' }).fill('Farid');
  await expect(list.getByRole('button', { name: /Farid/ })).toHaveCount(0);
  await panel.getByRole('searchbox', { name: 'Search members' }).fill('');

  // A group setting, and Recent changes lists what was done here.
  await manage.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Group settings' });
  const announce = settings.getByRole('switch', { name: 'Only admins send messages' });
  await expect(announce).toHaveAttribute('aria-checked', 'false');
  await announce.click();
  await expect(announce).toHaveAttribute('aria-checked', 'true');
  const history = settings.getByTestId('group-history');
  await expect(history).toContainText('renamed the group');
  await expect(history).toContainText('removed Farid');
  await expectNoHorizontalScroll(page, 'group settings');
  await settings.getByRole('button', { name: 'Done' }).click();
  await expect(settings).toBeHidden();
});

test('group management at 360 px: the bar, a dialog and the member actions fit', async ({
  page,
  baseURL,
}, info) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const { tag, groupJid, phone } = ids(info, 2);
  const name = `Kedai Runcit Pelanggan Setia ${tag}`;
  await makeGroup(page, baseURL!, {
    groupJid,
    name,
    description: 'A long description that wraps. '.repeat(8),
    members: [{ phone: phone(10), name: 'Siti Nurhaliza binti Abdullah', role: 'admin' }],
    joinRequests: [phone(20), phone(21)],
  });
  const panel = await openGroupInfo(page, groupJid, name);
  const manage = panel.getByRole('region', { name: 'Manage group' });
  await expect(manage.getByTestId('join-requests')).toContainText('2 people asked to join');
  await expectNoHorizontalScroll(page, 'group admin bar 360');
  await manage.getByRole('button', { name: 'Invite link' }).click();
  const link = page.getByRole('dialog', { name: 'Invite link' });
  await expect(link.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await expectNoHorizontalScroll(page, 'invite link 360');
  await link.getByRole('button', { name: 'Done' }).click();
  await expect(link).toBeHidden();
  await panel.getByRole('button', { name: /Siti Nurhaliza/ }).click();
  await expect(panel.getByRole('button', { name: 'Remove as admin' })).toBeVisible();
  await expectNoHorizontalScroll(page, 'member actions 360');
});

test('group management: an agent sees Group info read-only', async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(90_000);
  const { tag, run, groupJid, phone } = ids(info, 3);
  const name = `Agents Read Only ${tag}`;
  await makeGroup(page, baseURL!, {
    groupJid,
    name,
    description: 'Agents can read this.',
    members: [{ phone: phone(10), name: 'Farid', role: 'member' }],
  });
  const origin = new URL(baseURL!).origin;
  const username = `grpagent${tag}${run}`;
  const temp = 'agent-temp-123';
  const created = await page.request.post('/api/users', {
    headers: { Origin: origin },
    data: { username, displayName: `Group Agent ${tag}`, role: 'agent', password: temp },
  });
  expect(created.ok(), await created.text()).toBe(true);

  // A fresh sign-in: the project's saved admin session must not carry over.
  const agent = await (
    await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  ).newPage();
  try {
    await signIn(agent, username, temp);
    await expect(agent).toHaveURL(/\/change-password$/);
    await agent.getByLabel('Current password').fill(temp);
    await agent.getByLabel('New password', { exact: true }).fill(`${temp}-new`);
    await agent.getByLabel('Confirm new password').fill(`${temp}-new`);
    await agent.getByRole('button', { name: 'Save password' }).click();
    await expect(inboxHeading(agent)).toBeVisible();

    const panel = await openGroupInfo(agent, groupJid, name);
    await expect(panel.getByTestId('group-description')).toHaveText('Agents can read this.');
    const manage = panel.getByRole('region', { name: 'Manage group' });
    await expect(manage).toContainText('Only EzyChat admins can change this group.');
    await expect(manage.getByRole('button')).toHaveCount(0);
    await panel.getByRole('button', { name: /Farid/ }).click();
    await expect(panel.getByRole('button', { name: 'Remove from group' })).toHaveCount(0);
    await expectNoHorizontalScroll(agent, 'agent group info');
  } finally {
    await agent.context().close();
  }
});
