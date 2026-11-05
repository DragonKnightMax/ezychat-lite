import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../../../packages/server/src/context.js';
import { createInboxSendPort } from '../../../../packages/server/src/mcp/send.js';
import { seedGroups } from './groups.js';

/** Fictional data through the existing services and API, never a real linked WhatsApp account. */
export async function seedDemo(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = ctx.services.auth!;
  const password = 'demo-pass-123';
  const users = [
    { username: 'aisyah', displayName: 'Aisyah', role: 'admin' as const },
    { username: 'daniel', displayName: 'Daniel', role: 'agent' as const },
    { username: 'meiling', displayName: 'Mei Ling', role: 'agent' as const },
  ].map((user) => auth.createUser({ ...user, password, mustChangePassword: false }));
  const origin = `http://127.0.0.1:${ctx.config.port}`;
  const cookie = `sid=${auth.createSession(users[0]!.id, { ip: '127.0.0.1', userAgent: 'reference-seed' })}`;
  const call = async (method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown) => {
    const response = await app.inject({
      method,
      url: `/api${path}`,
      headers: { host: new URL(origin).host, origin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    if (response.statusCode >= 400) throw new Error(`Seed ${path}: ${response.statusCode}`);
    return response.json();
  };
  for (const [shortcut, body] of [
    ['hours', 'We open daily 8am–10pm. Kitchen closes at 9.30pm.'],
    ['delivery', 'Delivery within 5 km of Georgetown. Free above RM40.'],
    ['menu', 'Kopi O RM3.50 · Teh Tarik RM4 · Nasi Lemak Ayam RM12.'],
  ])
    await call('POST', '/quick-replies', { shortcut, body });
  await call('PATCH', '/ai/connection', {
    mode: 'api',
    model: '',
    apiKey: 'sk-demo-placeholder-not-a-key',
  });
  const ai = ctx.services.ai!.status();
  await call('PUT', '/ai', {
    displayName: 'Aina', // custom-agents: the server's AI member is agent 1 (Aina) of the mock.
    enabled: false,
    instructions: ai.settings.instructions,
    handoffRules: ai.settings.handoffRules,
  });
  await call('POST', '/ai/documents/text', {
    name: 'Menu and opening hours',
    text: 'Kopi Apong opens daily 8am–10pm. Kopi O RM3.50, Teh Tarik RM4, Nasi Lemak Ayam RM12. Delivery within 5 km of Georgetown, free above RM40.',
  });
  const chats = [
    [
      '60123110021@s.whatsapp.net',
      'Farah Catering Co',
      'Can I book catering for 30 people this Saturday?',
    ],
    ['60125550142@s.whatsapp.net', 'Ahmad Zulkifli', 'Is the shop open on Hari Raya?'],
    ['60127020388@s.whatsapp.net', 'Tan Wei Jie', '你好，请问可以送到 Gurney Drive 吗？'],
    ['60128814455@s.whatsapp.net', 'Priya Nair', 'My order #1042 has not arrived yet.'],
    ['60129001234@s.whatsapp.net', 'Jason Lim', 'How much is a large Kopi Peng?'],
    ['60126677889@s.whatsapp.net', 'Nurul Huda', 'Can I order two Nasi Lemak for pickup at 1pm?'],
    // Proposed (ai-reply-suggestions): a Malay enquiry for the suggestion chips.
    ['60131234567@s.whatsapp.net', 'Siti Rahman', 'Ada hantar ke Bayan Lepas tak? Berapa caj?'],
  ];
  const firstIds: string[] = [];
  for (const [chatJid, senderName, text] of chats)
    firstIds.push((await call('POST', '/dev/fake-incoming', { chatJid, senderName, text })).id);
  await call('PUT', `/chats/${encodeURIComponent(chats[0]![0]!)}/profile`, {
    name: 'Farah Aziz',
    company: 'Farah Catering Co',
    email: 'orders@farahcatering.example',
    address: 'Georgetown, Penang',
    tags: ['VIP', 'Catering'],
  });
  await call('PATCH', `/chats/${encodeURIComponent(chats[0]![0]!)}`, { assignedTo: users[2]!.id });
  await call('POST', `/chats/${encodeURIComponent(chats[0]![0]!)}/notes`, {
    body: 'Repeat customer. Confirm the catering deposit with staff.',
  });
  await call('PATCH', `/chats/${encodeURIComponent(chats[1]![0]!)}`, { status: 'resolved' });
  const groupJid = '120363025550001@g.us';
  await call('POST', '/dev/fake-group', {
    groupJid,
    name: 'Kopi Apong Regulars',
    generated: 12,
    members: [
      {
        phone: '60123110021',
        name: 'Farah Aziz',
        role: 'admin',
        about: 'Farah Catering Co, Penang',
      },
      { phone: '60126677889', name: 'Nurul Huda' },
    ],
  });
  const cendol = await call('POST', '/dev/fake-incoming', {
    chatJid: groupJid,
    senderJid: '60123110021@s.whatsapp.net',
    senderName: 'Farah Aziz',
    text: 'Is the durian cendol back this weekend?',
  });
  // Proposed (emoji-reactions): reactions the fake phone delivers, through the fake-WhatsApp dev
  // route: a busy group message (grouped emojis, a long name, the phone's own), and the phone's
  // 🙏 on Jason's question.
  for (const [emoji, senderJid, senderName] of [
    ['👍', '60126677889@s.whatsapp.net', 'Nurul Huda'],
    ['👍', '60190000001@s.whatsapp.net', 'Muhammad Hafiz bin Abdul Rahman Shah (Butterworth)'],
    ['😋', '60190000002@s.whatsapp.net', 'Priya Nair'],
  ] as const)
    await call('POST', '/dev/fake-reaction', {
      messageId: cendol.id,
      emoji,
      senderJid,
      senderName,
    });
  await call('POST', '/dev/fake-reaction', { messageId: cendol.id, emoji: '❤️', fromMe: true });
  await call('POST', '/dev/fake-reaction', { messageId: firstIds[4], emoji: '🙏', fromMe: true });
  // Proposed (MCP send): an assistant token that may send, and one reply it sent through the real
  // send port, so the token list badge and the "via AI assistant" line show without a real AI client.
  const created = await call('POST', '/integrations/tokens', {
    name: 'Claude – office laptop',
    expiresInDays: 90,
    canSend: true,
  });
  await call('POST', '/integrations/tokens', { name: 'ChatGPT – reports only', expiresInDays: 30 });
  // Proposed (MCP send to a new number): a token that may also message new numbers, and one chat it
  // started with a number that was not in the inbox (the customer has not written yet).
  const outreach = await call('POST', '/integrations/tokens', {
    name: 'Claude – event follow-ups',
    expiresInDays: 30,
    canSend: true,
    canMessageNewNumbers: true,
  });
  const resolved = ctx.services.apiTokens!.resolve(created.secret as string);
  if (!resolved.ok) throw new Error('seed token');
  createInboxSendPort(ctx).sendText(resolved.principal, {
    jid: chats[0]![0]!,
    text: 'Yes, we can cater for 30 this Saturday. The set is RM12 per person; I will confirm the deposit today.',
    requestId: 'seed-assistant-0001',
  });
  // Proposed (emoji-reactions): Farah reacts 👍 to that reply once the fake phone has sent it.
  for (let i = 0; i < 100; i++) {
    const sent = ctx.db
      .prepare(
        "SELECT id FROM messages WHERE chat_jid = ? AND from_me = 1 AND id NOT LIKE 'local-%' LIMIT 1",
      )
      .get(chats[0]![0]!) as { id: string } | undefined;
    if (sent) {
      await call('POST', '/dev/fake-reaction', { messageId: sent.id, emoji: '👍' });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const outreachToken = ctx.services.apiTokens!.resolve(outreach.secret as string);
  if (!outreachToken.ok) throw new Error('seed outreach token');
  await createInboxSendPort(ctx).sendToNewNumber(outreachToken.principal, {
    phone: '+60 13-999 0001',
    text: 'Hi, this is Aisyah. Thank you for visiting our booth at the food fair. As you asked, here is our catering menu: https://example.com/menu',
    requestId: 'seed-assistant-new-0001',
  });
  await seedBooking(ctx, call);
  // Proposed (ai-groups): three groups where the agent answers when tagged or quoted (or stays off).
  await seedGroups(ctx, call);
}

/**
 * Proposed (google-calendar): a chat where the AI checked free times and booked a table in Google
 * Calendar. The AI's replies go through the normal message service as the AI member; the two
 * "AI checked / booked" lines are `ai_tool_used` chat events (the booking carries start and end).
 */
async function seedBooking(
  ctx: AppContext,
  call: (method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown) => Promise<any>,
): Promise<void> {
  const jid = '60124448899@s.whatsapp.net';
  const ai = ctx.db.prepare("SELECT id FROM users WHERE kind = 'ai' ORDER BY id LIMIT 1").get() as
    { id: number } | undefined;
  if (!ai) return;
  const sentCount = () =>
    (
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ? AND from_me = 1 AND id NOT LIKE 'local-%'",
        )
        .get(jid) as { n: number }
    ).n;
  const waitSent = async (n: number) => {
    for (let i = 0; i < 40 && sentCount() < n; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const event = (payload: Record<string, unknown>) =>
    ctx.db
      .prepare(
        "INSERT INTO chat_events (chat_jid, type, actor_id, payload, at) VALUES (?, 'ai_tool_used', ?, ?, ?)",
      )
      .run(jid, ai.id, JSON.stringify(payload), Date.now());
  // Next Friday, 7:30 pm Malaysia time (UTC+8), 90 minutes.
  const now = new Date();
  const friday = new Date(now);
  friday.setUTCDate(now.getUTCDate() + ((5 - now.getUTCDay() + 7) % 7 || 7));
  const start = new Date(
    Date.UTC(friday.getUTCFullYear(), friday.getUTCMonth(), friday.getUTCDate(), 11, 30),
  );
  const end = new Date(start.getTime() + 90 * 60_000);
  await call('POST', '/dev/fake-incoming', {
    chatJid: jid,
    senderName: 'Lim Mei Ying',
    text: 'Hi, can I book a table for 6 this Friday evening?',
  });
  // The AI owns the chat (as when it claims a new chat), so its replies are not cancelled.
  ctx.db.prepare('UPDATE chats SET assigned_to = ? WHERE jid = ?').run(ai.id, jid);
  event({ title: 'Check free times', sourceLabel: 'Google Calendar', calendar: 'free_times' });
  ctx.services.messages!.sendText(
    jid,
    {
      text: 'Hi Mei Ying! For 6 people this Friday we have 6:00 pm, 7:30 pm or 8:45 pm free. Which time suits you?',
      clientId: 'seed-booking-1',
    },
    ai.id,
  );
  await waitSent(1);
  await call('POST', '/dev/fake-incoming', {
    chatJid: jid,
    senderName: 'Lim Mei Ying',
    text: '7:30pm please, under Mei Ying',
  });
  event({
    title: 'Book appointment',
    sourceLabel: 'Google Calendar',
    booking: {
      start: start.toISOString(),
      end: end.toISOString(),
      calendar: 'Kopi Apong bookings',
    },
  });
  ctx.services.messages!.sendText(
    jid,
    {
      text: 'Booked! A table for 6 this Friday, 7:30–9:00 pm, under Mei Ying. See you then! To change it, just reply here and our team will help.',
      clientId: 'seed-booking-2',
    },
    ai.id,
  );
  await waitSent(2);
  // Demo data: the seeded AI member is off, so the AI service cancels its queued replies; show
  // them as delivered, as they would be with the AI on.
  ctx.db
    .prepare(
      "UPDATE messages SET status = 'sent', error = NULL WHERE chat_jid = ? AND from_me = 1 AND status = 'failed'",
    )
    .run(jid);
}
