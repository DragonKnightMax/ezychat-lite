// Screen review of group management in Group info (docs/features/group-management/design.md, the 17 states of
// its checklist) against a fresh standalone server with --fake-wa:
//   npx tsx packages/server/src/cli.ts --data <tmp> --port <port> --mode dev --fake-wa --web-dist apps/web/dist
//   node e2e/group-management-screens.mjs <port> <outDir>
// Desktop 1280 / phone 360, light / dark; reports page errors and horizontal overflow. States the fake phone
// cannot produce (not on WhatsApp, offline, a Business API connection) answer the web from a stubbed route; the
// screens themselves are the real app. Never touches real WhatsApp.
import { randomBytes } from 'node:crypto';
import {
  apiPost,
  launchBrowser,
  screensArgs,
  shot,
  signInDemoAdmin,
  SIZES,
} from './screens-common.mjs';

const { base, out } = screensArgs('.group-management-screens');
const cookie = await signInDemoAdmin(base);
const problems = [];

async function api(method, path, body, c = cookie) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { origin: base, 'content-type': 'application/json', cookie: c },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// An agent with access to the inbox (for the read-only view); throwaway secrets for this temp server only.
const secret = () => randomBytes(12).toString('base64url');
const first = secret();
const AGENT = { username: 'farid', displayName: 'Farid', secret: secret() };
await api('POST', '/users', {
  username: AGENT.username,
  displayName: AGENT.displayName,
  role: 'agent',
  password: first,
});
const login = (pw) =>
  apiPost(base, '/auth/login', { username: AGENT.username, password: pw }).then((r) => r.cookie);
await api(
  'POST',
  '/auth/change-password',
  { currentPassword: first, newPassword: AGENT.secret },
  await login(first),
);
const agentCookie = await login(AGENT.secret);

let seq = 0;
/** A fresh fake group (its own JID per screen set, so changes never leak between sizes). */
async function makeGroup(extra = {}) {
  const n = ++seq;
  const groupJid = `1203630777${String(n).padStart(4, '0')}@g.us`;
  const p = (i) => `60197${String(n).padStart(3, '0')}${String(i).padStart(3, '0')}`;
  await api('POST', '/dev/fake-group', {
    groupJid,
    name: 'SME Founders KL',
    description:
      'Monthly meetups for founders in Klang Valley. Share events, ask questions, no spam please.',
    members: [
      { phone: p(1), name: 'Nurul Aisyah', role: 'admin' },
      { phone: p(2), name: 'Farid Rahman', role: 'member' },
      { phone: p(3), name: 'Siti Nurhaliza binti Abdullah', role: 'member' },
      { phone: p(4), name: 'Tan Wei Ming', role: 'member' },
    ],
    generated: 8,
    joinRequests: [p(20), p(21)],
    privacyRefuses: [p(30)],
    ...extra,
  });
  await api('POST', '/dev/fake-incoming', {
    chatJid: groupJid,
    text: 'Meetup this Friday 8pm at Common Ground?',
    senderJid: `${p(1)}@s.whatsapp.net`,
    senderName: 'Nurul Aisyah',
  });
  return { groupJid, p };
}

const browser = await launchBrowser();

async function context(size, scheme, c) {
  const ctx = await browser.newContext({ ...SIZES[size], baseURL: base, colorScheme: scheme });
  const [name, value] = c.split('=');
  await ctx.addCookies([{ name, value, url: base }]);
  return ctx;
}

async function openGroupInfo(page, groupJid) {
  await page.goto(`/chats/${encodeURIComponent(groupJid)}`);
  await page.getByRole('button', { name: 'Open group info for SME Founders KL' }).click();
  const panel = page
    .getByRole('complementary', { name: 'Group info' })
    .or(page.getByRole('dialog', { name: 'Group info' }));
  await panel.waitFor();
  await page.waitForTimeout(500);
  return panel;
}

/** Answer GET …/group with `patch` applied (states the fake phone cannot produce). */
async function stubState(page, patch) {
  await page.route(/\/api\/chats\/[^/]+\/group$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: patch(body) });
  });
}

const BUSINESS_CAPS = {
  editInfo: true,
  addMembers: false,
  inviteOnly: true,
  removeMembers: true,
  admins: false,
  inviteLink: true,
  resetInviteLink: true,
  settings: [],
  joinRequests: true,
  maxMembers: 8,
  nameMax: 128,
  descriptionMax: 2048,
};

/** One screen set (scheme × size): the 17 states. */
async function captureSet(scheme, size) {
  const tag = `${size}${scheme === 'dark' ? '-dark' : ''}`;
  const ctx = await context(size, scheme, cookie);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
  const snap = (file) => shot(page, out, problems, tag, `group-admin-${file}`);
  const dialog = (name) => page.getByRole('dialog', { name });

  // 01 admin bar with description and join requests
  const { groupJid, p } = await makeGroup();
  let panel = await openGroupInfo(page, groupJid);
  const manage = panel.getByRole('region', { name: 'Manage group' });
  await manage.waitFor();
  await snap('01-bar');

  // 02 edit info (long description)
  await manage.getByRole('button', { name: 'Edit info' }).click();
  await dialog('Group name and description')
    .getByLabel('Description')
    .fill(
      'Monthly meetups for founders in Klang Valley. Share events, ask questions, introduce your business once, no spam please. Admins approve new members. '.repeat(
        3,
      ),
    );
  await snap('02-edit');
  await dialog('Group name and description').getByRole('button', { name: 'Cancel' }).click();

  // 03 add member, 04 privacy refusal, 05 invite sent
  await manage.getByRole('button', { name: 'Add member' }).click();
  const add = dialog('Add a member');
  await add.getByLabel('WhatsApp number').fill(p(30));
  await snap('03-add');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await add.getByRole('button', { name: 'Send invite' }).waitFor();
  await snap('04-privacy');
  await add.getByRole('button', { name: 'Send invite' }).click();
  await add.getByRole('button', { name: 'Done' }).waitFor();
  await snap('05-invited');
  await add.getByRole('button', { name: 'Done' }).click();

  // 06 not on WhatsApp (the fake phone has every valid number on WhatsApp: stub the answer)
  await page.route(/\/api\/chats\/[^/]+\/group\/members$/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 422, json: { error: 'not_on_whatsapp' } })
      : route.continue(),
  );
  await manage.getByRole('button', { name: 'Add member' }).click();
  await add.getByLabel('WhatsApp number').fill('60123000999');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(500);
  await snap('06-not-on-whatsapp');
  await add.getByRole('button', { name: 'Cancel' }).click();
  await page.unroute(/\/api\/chats\/[^/]+\/group\/members$/);

  // 07 member detail, 08 remove confirm
  await panel.getByRole('searchbox', { name: 'Search members' }).fill('Farid');
  await panel.getByRole('button', { name: /Farid Rahman/ }).click();
  await panel.getByRole('button', { name: 'Remove from group' }).waitFor();
  await snap('07-member');
  await panel.getByRole('button', { name: 'Remove from group' }).click();
  await page.getByRole('alertdialog').waitFor();
  await snap('08-remove-confirm');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForTimeout(800);

  // 09 invite link, 10 reset confirm
  await openGroupInfo(page, groupJid);
  await manage.getByRole('button', { name: 'Invite link' }).click();
  await dialog('Invite link').getByRole('button', { name: 'Copy link' }).waitFor();
  await snap('09-link');
  await dialog('Invite link').getByRole('button', { name: 'Reset link' }).click();
  await page.getByRole('alertdialog').waitFor();
  await snap('10-reset-confirm');
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Reset link', exact: true })
    .click();
  await page.waitForTimeout(500);
  await dialog('Invite link').getByRole('button', { name: 'Done' }).click();

  // 11 settings with Recent changes
  await manage.getByRole('button', { name: 'Settings' }).click();
  const settings = dialog('Group settings');
  await settings.getByRole('switch', { name: 'Only admins send messages' }).click();
  await page.waitForTimeout(600);
  await snap('11-settings');
  await settings.getByRole('button', { name: 'Done' }).click();

  // 12 not a group admin
  const notAdmin = await makeGroup({ meRole: 'member' });
  await openGroupInfo(page, notAdmin.groupJid);
  await snap('12-not-admin');

  // 13 offline
  await stubState(page, (b) => ({ ...b, online: false }));
  await openGroupInfo(page, groupJid);
  await snap('13-offline');
  await page.unrouteAll({ behavior: 'wait' });

  // 14–16 Business API connection (invite only, 8 members, no admins or settings)
  const api8 = await makeGroup({ generated: 0 });
  await stubState(page, (b) => ({ ...b, caps: BUSINESS_CAPS, settings: {} }));
  panel = await openGroupInfo(page, api8.groupJid);
  await snap('14-business-api');
  await manage.getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(400);
  await snap('15-business-api-settings');
  await dialog('Group settings').getByRole('button', { name: 'Done' }).click();
  await panel.getByRole('searchbox', { name: 'Search members' }).fill('Tan Wei');
  await panel.getByRole('button', { name: /Tan Wei Ming/ }).click();
  await panel.getByRole('button', { name: 'Remove from group' }).waitFor();
  await snap('16-business-api-member');
  await page.unrouteAll({ behavior: 'wait' });
  await ctx.close();

  // 17 agent: read-only
  const actx = await context(size, scheme, agentCookie);
  const apage = await actx.newPage();
  apage.on('pageerror', (e) => problems.push(`${tag} agent pageerror: ${e.message}`));
  await openGroupInfo(apage, groupJid);
  await shot(apage, out, problems, tag, 'group-admin-17-agent');
  await actx.close();
  console.log(`${tag}: 17 states`);
}

const SETS = ['light', 'dark'].flatMap((scheme) =>
  ['desktop', 'mobile'].map((size) => [scheme, size]),
);
// One set after another: they share the server and its fake phone.
await SETS.reduce(
  (prev, [scheme, size]) => prev.then(() => captureSet(scheme, size)),
  Promise.resolve(),
);

await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no page errors, no overflow');
process.exit(problems.length ? 1 : 0);
