import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { requireAdmin } from '../../../../packages/server/src/auth/guards.js';
import { audit } from '../../../../packages/server/src/db/audit.js';
import { CustomerRepo } from '../../../../packages/server/src/customers/repo.js';
import { CustomerProfileBody } from '@ezychat/shared';
import type { FakeWaAdapter } from '@ezychat/wa';
import { registerSendReactions } from './send-reactions.js';
import { registerReplySuggestions } from './reply-suggestions.js';
import { registerPhraseDictionary } from './phrase-dictionary.js';
import { registerGoogleCalendar } from './google-calendar.js';
import { registerReports } from './reports.js';
import { registerConnectorList } from './connector-list.js';
import { registerGroups } from './groups.js';
import { registerEditDelete } from './edit-delete.js';

const DEMO_JID = '60129900001@s.whatsapp.net';
const INTRODUCTION =
  'My name is Jay Low. My company is Anchor Sprint. Please replace my email with jay@example.com.';

/** Deterministic prototype fixtures, not a production extraction/scoring implementation. */
export function registerProposal(app: FastifyInstance, ctx: AppContext, wa: FakeWaAdapter): void {
  registerFirstSetup(app, ctx, wa);
  registerSendReactions(app, ctx, wa);
  registerReplySuggestions(app, ctx, registerPhraseDictionary(app, ctx));
  registerGoogleCalendar(app, ctx);
  // Baseline addition (reports, confirmed): GET /api/mock/reports and the scenario switch.
  registerReports(app, ctx);
  // Proposed (connector-list): the connector list and partner (MCP) connectors.
  registerConnectorList(app, ctx);
  // Proposed (ai-groups): the agent answers in WhatsApp groups when mentioned.
  registerGroups(app, ctx);
  // Proposed (message-edit-delete): edit, delete for everyone / for me, incoming edits and deletes.
  registerEditDelete(app, ctx, wa);
  let enabled = false;
  const setting = () => ({
    enabled,
    connected: ctx.services.ai?.status().connection.state === 'connected',
  });
  app.get('/api/mock/enrichment', { preHandler: requireAdmin(ctx) }, setting);
  app.put('/api/mock/enrichment', { preHandler: requireAdmin(ctx) }, async (request) => {
    enabled = z.object({ enabled: z.boolean() }).parse(request.body).enabled;
    return setting();
  });
  const repo = new CustomerRepo(ctx.db);
  ctx.bus.on('message:received', ({ chat, message }) => {
    if (
      !enabled ||
      !setting().connected ||
      message.fromMe ||
      chat.type !== 'dm' ||
      chat.jid !== DEMO_JID ||
      message.body !== INTRODUCTION
    )
      return;
    const before = repo.get(chat.jid);
    const next = CustomerProfileBody.parse({
      name: 'Jay Low',
      company: 'Anchor Sprint',
      email: 'jay@example.com',
      otherPhone: before?.otherPhone ?? '',
      address: before?.address ?? '',
      tags: before?.tags ?? [],
    });
    const candidates = [
      {
        field: 'name',
        score: 100,
        points: [30, 25, 20, 15, 10],
        reason: 'Customer explicitly introduced themselves.',
      },
      {
        field: 'company',
        score: 95,
        points: [25, 25, 20, 15, 10],
        reason: 'Demo fixture: company ownership supported by conversation context.',
      },
      {
        field: 'email',
        score: 100,
        points: [30, 25, 20, 15, 10],
        reason: 'Customer explicitly requested a new email.',
      },
    ] as const;
    const fields = candidates
      .filter((candidate) => before?.[candidate.field] !== next[candidate.field])
      .map((candidate) => ({
        ...candidate,
        operation: before?.[candidate.field] ? 'replaced' : 'added',
        threshold: before?.[candidate.field] ? 95 : 90,
      }));
    if (!fields.length) return;
    ctx.db.transaction(() => {
      repo.save(
        chat.jid,
        {
          name: next.name,
          company: next.company,
          email: next.email,
          otherPhone: next.otherPhone || null,
          address: next.address || null,
        },
        next.tags,
        null,
        Date.now(),
      );
      audit(ctx.db, {
        userId: null,
        action: 'customer.enrichment_update',
        ip: null,
        meta: {
          chatJid: chat.jid,
          changed: fields.map((field) => field.field),
          enrichment: {
            fields,
            average: fields.reduce((sum, field) => sum + field.score, 0) / fields.length,
            messageId: message.id,
            policy: 'demo-v1',
          },
        },
      });
    })();
    const updated = ctx.services.chats!.get(chat.jid);
    if (updated) ctx.bus.emit('chat:updated', updated);
  });
  app.post('/api/mock/enrichment/preview', { preHandler: requireAdmin(ctx) }, async (request) => {
    if (!enabled) return { delivered: false };
    const response = await app.inject({
      method: 'POST',
      url: '/api/dev/fake-incoming',
      headers: {
        host: request.headers.host ?? '',
        origin: request.headers.origin ?? '',
        cookie: request.headers.cookie ?? '',
      },
      payload: { chatJid: DEMO_JID, senderName: 'Jay (WhatsApp)', text: INTRODUCTION },
    });
    if (response.statusCode >= 400) throw new Error(`Demo message failed: ${response.statusCode}`);
    return { delivered: true, chatJid: DEMO_JID };
  });
}

/**
 * Simple first-time setup fixtures (mock only): linking WhatsApp and checking an OpenAI key are
 * simulated. Production would check a key with one small real request before saving it.
 */
function registerFirstSetup(app: FastifyInstance, ctx: AppContext, wa: FakeWaAdapter): void {
  // "The phone scanned the QR code": the demo button under the QR in the setup wizard.
  app.post('/api/mock/wa/link', { preHandler: requireAdmin(ctx) }, async () => {
    if (wa.status.state !== 'open') wa.setConnected(true);
    return { state: wa.status.state };
  });
  // Linking with a phone-number code finishes on its own a few seconds after the code is shown.
  const requestPairingCode = wa.requestPairingCode.bind(wa);
  wa.requestPairingCode = async (phone: string) => {
    const code = await requestPairingCode(phone);
    setTimeout(() => {
      if (wa.status.state !== 'open') wa.setConnected(true);
    }, 6000);
    return code;
  };
  // Test key: a key starting with "sk-" passes; anything else fails with a clear message.
  app.post('/api/mock/ai/test-key', { preHandler: requireAdmin(ctx) }, async (request) => {
    const { apiKey } = z.object({ apiKey: z.string().trim().min(1).max(512) }).parse(request.body);
    await new Promise((resolve) => setTimeout(resolve, 700));
    // claude-provider: an Anthropic key pasted into the OpenAI field gets a pointer to the right option.
    if (apiKey.startsWith('sk-ant-'))
      return {
        ok: false,
        error: 'This is a Claude (Anthropic) key. Choose "Claude API key" as the connection.',
      };
    return apiKey.startsWith('sk-') && apiKey.length >= 10
      ? { ok: true, error: null }
      : { ok: false, error: 'OpenAI did not accept this key. Check that you copied all of it.' };
  });
  // claude-provider: Anthropic key test (production: GET https://api.anthropic.com/v1/models).
  // "sk-ant-" + 6 characters passes; a key containing "offline" passes with the warn-only result of
  // an unreachable Anthropic (production: only a 401 blocks saving); anything else is rejected.
  app.post('/api/mock/ai/test-claude-key', { preHandler: requireAdmin(ctx) }, async (request) => {
    const { apiKey } = z.object({ apiKey: z.string().trim().min(1).max(512) }).parse(request.body);
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (!apiKey.startsWith('sk-ant-') && apiKey.startsWith('sk-'))
      return {
        ok: false,
        error: 'This is an OpenAI key. Choose "OpenAI API key" as the connection.',
        warning: null,
      };
    if (!apiKey.startsWith('sk-ant-') || apiKey.length < 13)
      return {
        ok: false,
        error: 'Anthropic did not accept this key. Check that you copied all of it.',
        warning: null,
      };
    return apiKey.includes('offline')
      ? {
          ok: true,
          error: null,
          warning: 'Could not reach Anthropic to check the key. You can still save it.',
        }
      : { ok: true, error: null, warning: null };
  });
}
