import { afterEach, describe, expect, it } from 'vitest';
import { CustomerProfileBody, type Chat } from '@ezychat/shared';
import { getAliases } from '../src/chats/aliases.js';
import { linkedChats, seedAllFromLinked, seedFromLinked } from '../src/customers/linked.js';
import { CustomerRepo } from '../src/customers/repo.js';
import { getChats } from '../src/wa-bridge/index.js';
import { createUserAndLogin } from './auth-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

// One customer who writes to two of our WhatsApp numbers keeps the same contact details in both
// inboxes. Tags stay per inbox (an agent never learns the tags of an inbox they cannot open).
const PN = '60123456789@s.whatsapp.net';
const LID = '987654321012345@lid';
const LID_NEW = '555555555555555@lid';
const OTHER = '60199999999@s.whatsapp.net';
const GROUP = '120363000000000009@g.us';
const empty = { name: null, company: null, email: null, otherPhone: null, address: null };

const open: TestApp[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

async function app(inboxes = 2): Promise<TestApp> {
  const t = await makeTestApp({ maxInboxes: 3, inboxes });
  open.push(t);
  return t;
}

async function admin(t: TestApp) {
  const { user } = await createUserAndLogin(t, { role: 'admin' });
  return { userId: user.id, ip: null, isAdmin: true };
}

const dm = (t: TestApp, jid: string, inbox: number) =>
  getChats(t.ctx).upsertFromWa({ jid, type: 'dm', name: 'WhatsApp name' }, inbox);

const auditRows = (t: TestApp) =>
  (
    t.ctx.db
      .prepare("SELECT meta FROM audit_log WHERE action = 'customer.profile_update' ORDER BY id")
      .all() as Array<{ meta: string }>
  ).map((r) => JSON.parse(r.meta) as Record<string, unknown>);

describe('customer profile shared across inboxes', () => {
  it('a name saved in one inbox shows on the same number’s chat in the other inbox', async () => {
    const t = await app();
    const actor = await admin(t);
    dm(t, PN, 1);
    dm(t, PN, 2);
    const updated: string[] = [];
    t.ctx.bus.on('chat:updated', (c: Chat) => updated.push(c.jid));
    const customers = t.ctx.services.customers!;

    customers.save(
      `${PN}#2`,
      CustomerProfileBody.parse({ name: 'Zack', company: 'Osiris', tags: ['VIP'] }),
      actor,
    );

    for (const jid of [PN, `${PN}#2`]) {
      expect(customers.profile(jid).profile).toMatchObject({ name: 'Zack', company: 'Osiris' });
      expect(getChats(t.ctx).get(jid)?.name).toBe('Zack');
    }
    expect(customers.profile(`${PN}#2`).profile.tags).toEqual(['VIP']);
    expect(customers.profile(PN).profile.tags).toEqual([]);
    // both inboxes' lists hear about it; audit keeps the count, never the value
    expect(updated.sort()).toEqual([PN, `${PN}#2`]);
    expect(auditRows(t).at(-1)).toMatchObject({
      chatJid: `${PN}#2`,
      changed: ['name', 'company', 'tags'],
      linkedChats: 1,
    });
    expect(JSON.stringify(auditRows(t))).not.toContain('Zack');

    // editing from the other side syncs back, and clearing a field clears it everywhere
    customers.save(PN, CustomerProfileBody.parse({ name: 'Zack Lim', tags: ['Supplier'] }), actor);
    expect(customers.profile(`${PN}#2`).profile).toMatchObject({
      name: 'Zack Lim',
      company: null,
      tags: ['VIP'],
    });
    expect(customers.profile(PN).profile.tags).toEqual(['Supplier']);

    // a tags-only change stays in its own inbox
    const audits = auditRows(t).length;
    customers.save(PN, CustomerProfileBody.parse({ name: 'Zack Lim', tags: [] }), actor);
    expect(auditRows(t)).toHaveLength(audits + 1);
    expect(auditRows(t).at(-1)).toMatchObject({ changed: ['tags'], linkedChats: 0 });
    expect(customers.profile(`${PN}#2`).profile.tags).toEqual(['VIP']);
  });

  it('links the phone-number chat in one inbox with the WhatsApp ID chat in another', async () => {
    const t = await app();
    const actor = await admin(t);
    expect(getAliases(t.ctx).learn({ jid: PN, alias: LID }, 'message').kind).toBe('added');
    t.ctx.db
      .prepare(
        "INSERT INTO chats (jid, type, name, updated_at, inbox_id, wa_jid) VALUES (?, 'dm', '', 0, 1, ?)",
      )
      .run(PN, PN);
    dm(t, LID, 2);
    expect(linkedChats(t.ctx.db, PN)).toEqual([`${LID}#2`]);
    expect(linkedChats(t.ctx.db, `${LID}#2`)).toEqual([PN]);

    t.ctx.services.customers!.save(`${LID}#2`, CustomerProfileBody.parse({ name: 'Farah' }), actor);
    expect(t.ctx.services.customers!.profile(PN).profile.name).toBe('Farah');
  });

  it('never links a different person, a group, or a number WhatsApp moved to someone else', async () => {
    const t = await app();
    const actor = await admin(t);
    dm(t, PN, 1);
    dm(t, OTHER, 2);
    getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'Partners' }, 1);
    getChats(t.ctx).upsertFromWa({ jid: GROUP, type: 'group', name: 'Partners' }, 2);
    expect(linkedChats(t.ctx.db, PN)).toEqual([]);
    expect(linkedChats(t.ctx.db, GROUP)).toEqual([]);
    expect(linkedChats(t.ctx.db, 'not#a#key')).toEqual([]);

    // PN belonged to LID, then WhatsApp re-pointed it to LID_NEW: PN's old chat is the old owner's
    const aliases = getAliases(t.ctx);
    aliases.learn({ jid: PN, alias: LID }, 'message');
    dm(t, LID, 2);
    expect(linkedChats(t.ctx.db, PN)).toEqual([`${LID}#2`]);
    expect(aliases.learn({ jid: PN, alias: LID_NEW }, 'message').kind).toBe('repointed');
    dm(t, LID_NEW, 2);
    expect(linkedChats(t.ctx.db, PN)).toEqual([]);
    expect(linkedChats(t.ctx.db, `${LID_NEW}#2`)).toEqual([]);

    t.ctx.services.customers!.save(PN, CustomerProfileBody.parse({ name: 'Old owner' }), actor);
    expect(t.ctx.services.customers!.profile(`${LID_NEW}#2`).profile.name).toBeNull();
    expect(t.ctx.services.customers!.profile(`${OTHER}#2`).profile.name).toBeNull();
  });

  it('a new chat in another inbox starts with the profile the team already saved', async () => {
    const t = await app();
    const actor = await admin(t);
    dm(t, PN, 1);
    t.ctx.services.customers!.save(
      PN,
      CustomerProfileBody.parse({ name: 'Zack', email: 'z@osiris.my', tags: ['Supplier'] }),
      actor,
    );
    const chat = dm(t, PN, 2);
    expect(chat.name).toBe('Zack');
    const copy = t.ctx.services.customers!.profile(`${PN}#2`).profile;
    const original = t.ctx.services.customers!.profile(PN).profile;
    expect(copy).toMatchObject({ name: 'Zack', email: 'z@osiris.my', tags: [] });
    expect(copy.updatedAt).toBe(original.updatedAt);
    // its own stable id (ids are unique per profile row)
    expect(copy.id).not.toBe(original.id);
  });

  it('re-saving an unchanged profile brings a chat that drifted apart back in line', async () => {
    const t = await app();
    const actor = await admin(t);
    dm(t, PN, 1);
    dm(t, PN, 2);
    // drift written straight to the table, as data from before the sync existed
    new CustomerRepo(t.ctx.db).save(`${PN}#2`, { ...empty, name: 'Stale' }, [], null, 1);
    new CustomerRepo(t.ctx.db).save(PN, { ...empty, name: 'Zack' }, [], null, 2);
    t.ctx.services.customers!.save(PN, CustomerProfileBody.parse({ name: 'Zack' }), actor);
    expect(t.ctx.services.customers!.profile(`${PN}#2`).profile.name).toBe('Zack');
    expect(auditRows(t).at(-1)).toMatchObject({ changed: [], linkedChats: 1 });
    // nothing to do: no write, no audit row
    const before = auditRows(t).length;
    t.ctx.services.customers!.save(PN, CustomerProfileBody.parse({ name: 'Zack' }), actor);
    expect(auditRows(t)).toHaveLength(before);
  });

  it('start-up fills empty linked chats and never overwrites a saved profile', async () => {
    const t = await app();
    const db = t.ctx.db;
    const repo = new CustomerRepo(db);
    const raw = (jid: string, inbox: number, wa: string) =>
      db
        .prepare(
          "INSERT INTO chats (jid, type, name, updated_at, inbox_id, wa_jid) VALUES (?, 'dm', '', 0, ?, ?)",
        )
        .run(jid, inbox, wa);
    raw(PN, 1, PN);
    raw(`${PN}#2`, 2, PN);
    raw(OTHER, 1, OTHER);
    raw(`${OTHER}#2`, 2, OTHER);
    repo.save(PN, { ...empty, name: 'Zack' }, ['VIP'], null, 10);
    // a chat with tags but no saved details still takes the details, and keeps its tags
    db.prepare(
      "INSERT INTO customer_tags (chat_jid, tag, tag_key, created_at) VALUES (?, 'Lead', 'lead', 1)",
    ).run(`${PN}#2`);
    repo.save(OTHER, { ...empty, name: 'Mine' }, [], null, 10);
    repo.save(`${OTHER}#2`, { ...empty, name: 'Theirs' }, [], null, 20);

    expect(seedAllFromLinked(db)).toBe(1);
    expect(repo.get(`${PN}#2`)).toMatchObject({ name: 'Zack', tags: ['Lead'], updatedAt: 10 });
    expect(repo.get(OTHER)?.name).toBe('Mine');
    expect(repo.get(`${OTHER}#2`)?.name).toBe('Theirs');
    expect(seedFromLinked(db, `${PN}#2`)).toBe(false);
    expect(seedAllFromLinked(db)).toBe(0);
  });

  it('with one inbox (Lite) nothing is linked', async () => {
    const t = await app(1);
    dm(t, PN, 1);
    expect(linkedChats(t.ctx.db, PN)).toEqual([]);
    expect(seedAllFromLinked(t.ctx.db)).toBe(0);
  });
});
