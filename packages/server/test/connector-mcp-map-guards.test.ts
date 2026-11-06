// Declared guards on the values of a free-form map argument (a Notion-like page `properties` map,
// JSON Schema additionalProperties): cleanArgs keeps the map's keys, and every guard reads them
// by path and still fails closed.
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectorSetting, ConnectorTool } from '@ezychat/shared';
import { checkGuards, cleanArgs, type GuardInput } from '../src/connectors/mcp/guards.js';
import { boundedInputSchema } from '../src/connectors/mcp/mcp.js';
import { recordCall, recordValues } from '../src/connectors/mcp/repo.js';
import { getMessages } from '../src/wa-bridge/index.js';
import { makeTestApp, type TestApp } from './helpers.js';

const jid = '60123456789@s.whatsapp.net';
const zone = 'Asia/Kuala_Lumpur';

// notion-update-page: data.properties is a map of column name → value.
const schema = boundedInputSchema({
  type: 'object',
  properties: {
    page_id: { type: 'string' },
    data: {
      type: 'object',
      properties: {
        properties: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'null'] },
        },
      },
    },
  },
  required: ['page_id', 'data'],
})!;

const tool: ConnectorTool = {
  name: 'notion-update-page',
  title: { en: 'Update page' },
  description: { en: 'Update a page' },
  access: 'write',
  guards: {
    confirmFirst: true,
    valueFrom: { 'data.properties.SKU': 'search' },
    fromCustomer: ['data.properties.Email'],
    within: { 'data.properties.Delivery': 'hours' },
    limits: { perChat: 1 },
  },
};
const hours: ConnectorSetting = { id: 'hours', type: 'timeRange', label: { en: 'Hours' } };

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

describe('guards on free-form map values', () => {
  it('reads each guard path inside the map and refuses what fails', async () => {
    t = await makeTestApp();
    const db = t.ctx.db;
    const now = Date.now();
    // The proposal's author: any user row stands in for the AI agent's user here.
    const aiUser = t.ctx.services.auth!.createUser({
      username: 'aina',
      displayName: 'Aina',
      role: 'admin',
      password: 'password123',
      mustChangePassword: false,
    }).id;
    const input = (properties: Record<string, unknown>): GuardInput => {
      const args = cleanArgs(schema, { page_id: 'p1', data: { properties } });
      expect(args).not.toBeNull();
      return {
        db,
        connectorId: 'notion',
        tool,
        args: args!,
        chatJid: jid,
        aiUserId: aiUser,
        settings: { hours: ['09:00', '18:00'] },
        settingDefs: [hours],
        timeZone: zone,
        now,
        customerTexts: () => ['My email is mei@example.com'],
        savedContact: () => [],
      };
    };
    const good = {
      SKU: 'KA-KY-400',
      Email: 'mei@example.com',
      Delivery: '2026-11-02T10:00:00+08:00',
      Status: 'New',
    };
    // confirmFirst: no AI proposal yet.
    expect(checkGuards(input(good))).toEqual({ ok: false, reason: 'confirm_first' });
    await getMessages(t.ctx).ingest(
      {
        id: 'in-1',
        chatJid: jid,
        body: 'Yes please',
        type: 'text',
        fromMe: false,
        senderJid: jid,
        senderName: 'Mei',
        timestamp: now - 1000,
        quotedId: null,
        media: null,
      },
      'live',
    );
    db.prepare(
      `INSERT INTO messages (id, chat_jid, from_me, sent_by_user_id, type, body, timestamp, created_at)
       VALUES ('out-1', ?, 1, ?, 'text', 'Shall I update it?', ?, ?)`,
    ).run(jid, aiUser, now - 2000, now - 2000);
    // valueFrom: the SKU inside the map must come from the read tool.
    expect(checkGuards(input(good))).toEqual({
      ok: false,
      reason: 'value_from',
      arg: 'data.properties.SKU',
    });
    recordValues(db, 'notion', jid, 'search', ['KA-KY-400'], now);
    // fromCustomer: a missing or invented map value fails closed.
    expect(checkGuards(input({ ...good, Email: 'x@example.com' }))).toMatchObject({
      ok: false,
      reason: 'from_customer',
      arg: 'data.properties.Email',
    });
    const { Email: _, ...noEmail } = good;
    expect(checkGuards(input(noEmail))).toMatchObject({ ok: false, reason: 'from_customer' });
    // within: the delivery time inside the map must fit the hours.
    expect(checkGuards(input({ ...good, Delivery: '2026-11-02T22:00:00+08:00' }))).toMatchObject({
      ok: false,
      reason: 'within',
      arg: 'data.properties.Delivery',
    });
    expect(checkGuards(input({ ...good, Delivery: null }))).toMatchObject({
      ok: false,
      reason: 'within',
    });
    // Everything passes: the map (other columns included) is what goes to the partner.
    const passed = input(good);
    expect(passed.args).toEqual({ page_id: 'p1', data: { properties: good } });
    expect(checkGuards(passed)).toEqual({ ok: true, consentMessageId: 'in-1' });
    // limits: perChat 1, and the confirmation is used.
    recordCall(db, 'notion', tool.name, jid, now, 'in-1');
    expect(checkGuards(input(good))).toEqual({ ok: false, reason: 'limit' });
  });
});
