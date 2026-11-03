// Isolated Dev Build for AI agents with a MOCK model (never calls OpenAI/ChatGPT or any outside host):
//   npx tsx --conditions=ezychat-source e2e/agents-devbuild.ts --fake-wa --port 7491 [--max-inboxes 3]
// The mock model answers from what it was given, so a check can read the prompt back from the reply:
//   "[<name>] guard=<yes|no> business=<MARK-… words seen> internal=<MARK-… words seen>"
// A customer message containing LEAK makes it repeat its internalKnowledge (the leak check must stop it).
// Google Calendar (fake Google): BOOK calls check_free_times and offers the first time; CONFIRM checks
// the free times again, then calls book_appointment with the first time offered in that chat (and an
// email written in the same message) and repeats what the tool said.
// Partner connectors (start it with the env lines of `node e2e/partner-mcp/cli.mjs`): STOCK, INVOICE and
// QUOTE call the partner tools (see mockDecision); check: e2e/devbuild-partner-check.mjs.
// Reply suggestions: drafts from the best-matching business-context sentence (LEAK copies internalKnowledge).
// Fix English: grammar fixes from a fixed list of slips (have/has, ship/shipped, you/your, a/an, i, capitals).
// Hand-off rules: consultation, CHECKIN, RESOLVE and HUMAN (see mockDecision); check: e2e/devbuild-handoff-check.mjs.
// Group agents (--max-agents 2): in a group that reads every message, a message with "Policy no:" and
// "Amount:" calls add_sheet_row on the tab Claims and repeats what it said; a claim without an amount
// asks for it; anything else gets no_reply. Check: e2e/devbuild-claims-check.mjs.
// Data lives in a fresh OS temp folder (prefix ezychat-agents-devbuild-). Checks: e2e/devbuild-agents-check.mjs,
// e2e/devbuild-suggestions-check.mjs, e2e/devbuild-calendar-check.mjs.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FakeWaAdapter } from '@ezychat/wa';
import type { AiDecision } from '@ezychat/shared';
import type { AiPrompt, AiRewritePrompt } from '../packages/server/src/ai/provider-types.js';
import { createContext, runInitializers, shutdownServices } from '../packages/server/src/main.js';
import { createLogger } from '../packages/server/src/logger.js';
import { createAiService } from '../packages/server/src/ai/service.js';
import { buildApp } from '../packages/server/src/app.js';
import { attachRealtime } from '../packages/server/src/realtime/index.js';

if (!process.argv.includes('--fake-wa')) throw new Error('--fake-wa required');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const port = Number(arg('--port') ?? 7491);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const maxInboxes = arg('--max-inboxes') === undefined ? undefined : Number(arg('--max-inboxes'));
const maxAgents = arg('--max-agents') === undefined ? undefined : Number(arg('--max-agents'));
const dataDir = await mkdtemp(join(tmpdir(), 'ezychat-agents-devbuild-'));
const logger = await createLogger({ dataDir, stdout: false });
const { version } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

// Nothing leaves this machine: only loopback fetches are allowed.
const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('External calls blocked in the mock AI agents check');
  return localFetch(input, init);
};

const ctx = await createContext(
  {
    dataDir,
    host: '127.0.0.1',
    port,
    mode: 'dev',
    fakeWa: true,
    webDistDir: resolve('apps/web/dist'),
    version,
    ...(maxInboxes === undefined ? {} : { maxInboxes }),
    ...(maxAgents === undefined ? {} : { maxAgents }),
  },
  { wa: new FakeWaAdapter(), log: logger.log },
);
await runInitializers(ctx);

/** Runs one offered tool the way the AI SDK would. */
async function runTool(prompt: AiPrompt, name: string, input: object, signal: AbortSignal) {
  const execute = prompt.tools?.[name]?.execute as
    ((input: object, options: object) => Promise<string>) | undefined;
  if (!execute) return null;
  return execute(input, { toolCallId: `mock-${name}`, messages: [], abortSignal: signal });
}

/** The first free time each chat was offered (the mock's memory of its own BOOK replies). */
const offered = new Map<string, string>();

/** The mock model: answers with what it was given (see the header). */
async function mockDecision(prompt: AiPrompt, signal: AbortSignal): Promise<AiDecision> {
  signal.throwIfAborted();
  const input = JSON.parse(prompt.input) as {
    internalKnowledge: string;
    businessKnowledge: string;
    conversation: Array<{ speaker: string; text: string }>;
  };
  const last =
    [...(input.conversation ?? [])].reverse().find((turn) => turn.speaker === 'customer')?.text ??
    '';
  const chatKey = JSON.stringify(input.conversation?.[0] ?? '');
  // A group that reads every message: claims go to the sheet, everything else gets no reply.
  const situation = (
    input as { currentSituation?: { group?: { newMessages?: unknown; messageToAnswer?: string } } }
  ).currentSituation?.group;
  if (situation?.newMessages !== undefined) {
    const text = String(situation.messageToAnswer ?? '');
    const policy = /Policy no:\s*(\S+)/i.exec(text)?.[1];
    const amount = /Amount:\s*(?:RM\s*)?([\d.,]+)/i.exec(text)?.[1];
    const what = /What happened:\s*(.+)/i.exec(text)?.[1]?.trim();
    if (policy && amount) {
      const values: Record<string, string> = { 'Policy no': policy, Amount: amount };
      if (what) values['What happened'] = what;
      const output = await runTool(prompt, 'add_sheet_row', { tab: 'Claims', values }, signal);
      return {
        reply: output === null ? 'sheet=not-offered' : `Recorded: ${output}`,
        action: 'answer',
      };
    }
    if (policy) return { reply: `What is the claim amount for ${policy}?`, action: 'answer' };
    return { reply: '', action: 'no_reply' };
  }
  if (last.includes('BOOK')) {
    const output = await runTool(prompt, 'check_free_times', {}, signal);
    if (output === null) return { reply: 'calendar=not-offered', action: 'answer' };
    const first = (JSON.parse(output) as { freeTimes?: Array<{ start: string; time: string }> })
      .freeTimes?.[0];
    if (!first) return { reply: 'calendar=no-free-times', action: 'answer' };
    offered.set(chatKey, first.start);
    return { reply: `Free: ${first.time}. Shall I book it?`, action: 'answer' };
  }
  if (last.includes('CONFIRM')) {
    const start = offered.get(chatKey);
    // Like real models: check the free times again in the turn that books (a newer offer after the
    // customer's answer must not block the booking).
    if (start) await runTool(prompt, 'check_free_times', {}, signal);
    // An email the customer wrote in this message goes with the booking (a real model does the same).
    const email = /[^\s@]+@[^\s@]+\.[^\s@]+/.exec(last)?.[0];
    const output = start
      ? await runTool(prompt, 'book_appointment', { start, ...(email ? { email } : {}) }, signal)
      : null;
    return { reply: output === null ? 'book=not-offered' : output, action: 'answer' };
  }
  // Partner connectors (signed test list of e2e/partner-mcp): STOCK <sku> calls check_stock, INVOICE
  // <number> calls find_invoice, QUOTE <sku> x<qty> @<iso time> NAME <first last> calls
  // create_quotation with the email of the same message; the reply is what the tool said.
  const partner = (suffix: string) =>
    Object.keys(prompt.tools ?? {}).find((tool) => tool.endsWith(`__${suffix}`));
  const partnerCall = async (suffix: string, args: object) => {
    const tool = partner(suffix);
    const output = tool ? await runTool(prompt, tool, args, signal) : null;
    return { reply: output === null ? `${suffix}=not-offered` : output, action: 'answer' as const };
  };
  const stock = /STOCK (\S+)/.exec(last);
  if (stock) return partnerCall('check_stock', { query: stock[1] });
  const invoice = /INVOICE (\S+)/.exec(last);
  if (invoice) return partnerCall('find_invoice', { invoice_number: invoice[1] });
  const quote = /QUOTE (\S+) x(\d+) @(\S+)(?: NAME (\S+ \S+))?/.exec(last);
  if (quote) {
    const email = /[^\s@]+@[^\s@]+\.[^\s@]+/.exec(last)?.[0];
    return partnerCall('create_quotation', {
      sku: quote[1],
      quantity: Number(quote[2]),
      delivery_at: quote[3],
      ...(quote[4] ? { customer_name: quote[4] } : {}),
      ...(email ? { customer_email: email } : {}),
    });
  }
  // Hand-off rules (e2e/devbuild-handoff-check.mjs): a consultation request is answered with a
  // discovery question only when the rules given say it is discovery (else needs_action, the old
  // behaviour); CHECKIN answers with a check-in line (ask_resolution); a "yes" with RESOLVE tries to
  // close the chat with the old goodbye; HUMAN asks for a person.
  if (/consultation/i.test(last))
    return prompt.instructions.includes('is discovery, not an action')
      ? { reply: 'Happy to set that up! What would you like to cover?', action: 'answer' }
      : {
          reply: "Sorry, I can't book it myself. A team member will help you shortly.",
          action: 'handoff',
          handoffReason: 'needs_action',
        };
  if (last.includes('CHECKIN'))
    return {
      reply: 'Yes, we supply H100 GPUs. Does that answer your question?',
      action: 'ask_resolution',
    };
  if (last.includes('RESOLVE'))
    return { reply: 'Thank you! I will close this chat now.', action: 'resolve' };
  if (last.includes('HUMAN'))
    return {
      reply: 'A team member will help you shortly.',
      action: 'handoff',
      handoffReason: 'asked_for_human',
    };
  // A change request (e.g. in a WhatsApp group): hand over, as real models do (needs_action).
  if (last.includes('CHANGE'))
    return {
      reply: 'A team member will reply soon.',
      action: 'handoff',
      handoffReason: 'needs_action',
    };
  const name = /Your name: (.+)/.exec(prompt.instructions)?.[1] ?? '?';
  if (prompt.input.includes('LEAK'))
    return { reply: `Sure: ${input.internalKnowledge}`, action: 'answer' };
  const guard = prompt.instructions.startsWith('Safety rules') ? 'yes' : 'no';
  // Which knowledge reached this agent: every MARK-<word> in its business and internal parts.
  const marks = (text: string) =>
    [...new Set(text.match(/MARK-[A-Z]+/g) ?? [])].sort((a, b) => a.localeCompare(b)).join(',') ||
    'none';
  const business = marks(input.businessKnowledge);
  const internal = marks(input.internalKnowledge);
  return {
    reply: `[${name}] guard=${guard} business=${business} internal=${internal}`,
    action: 'answer',
  };
}

/**
 * The mock draft model (reply suggestions): the business-context sentence that shares the most words
 * with the customer's last message, as two drafts; a completion continues that sentence after the
 * last typed word. A customer message with LEAK makes it copy internalKnowledge (must be dropped).
 */
function mockDraft(prompt: AiRewritePrompt, signal: AbortSignal): unknown {
  signal.throwIfAborted();
  // A phrase-list build: each business-context sentence as a fact phrase, the team's replies as
  // their own phrases (a cleaned reply with [name] must be dropped), and two greetings.
  const build = JSON.parse(prompt.input) as { teamReplies?: string[]; businessKnowledge: string };
  if (build.teamReplies)
    return {
      phrases: [
        ...build.businessKnowledge
          .split(/(?<=[.!?])\s+|\n/)
          .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
          .filter((line) => line.length >= 3)
          .map((text) => ({ text, language: 'en', source: 'context' })),
        ...build.teamReplies.map((text) => ({ text, language: 'en', source: 'team' })),
        {
          text: 'Thank you for your message! We will get back to you shortly.',
          language: 'en',
          source: 'team',
        },
        { text: 'Terima kasih atas mesej anda!', language: 'ms', source: 'team' },
      ],
    };
  // Fix English grammar check: a fixed list of slips corrected; numbers and the rest left as typed.
  const grammar = JSON.parse(prompt.input) as { text?: string };
  if (typeof grammar.text === 'string' && !('conversation' in grammar))
    return {
      corrected: grammar.text
        .replace(/\b(order|parcel|item|payment) have been\b/gi, '$1 has been')
        .replace(/\bbeen ship\b/gi, 'been shipped')
        .replace(/\b(check|confirm) you (email|order|address)\b/gi, '$1 your $2')
        .replace(/\ba (update|order|email|invoice)\b/gi, 'an $1')
        .replace(/\bi\b/g, 'I')
        .replace(
          /(^|[.!?]\s+)([a-z])/g,
          (_, before: string, c: string) => before + c.toUpperCase(),
        ),
    };
  const input = JSON.parse(prompt.input) as {
    internalKnowledge: string;
    businessKnowledge: string;
    conversation: Array<{ speaker: string; text: string }>;
    currentSituation: { task: 'suggest' | 'complete'; typed?: string };
  };
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const asked = words(
    [...input.conversation].reverse().find((turn) => turn.speaker === 'customer')?.text ?? '',
  );
  const leak = prompt.input.includes('LEAK');
  const sentences = input.businessKnowledge
    .split(/(?<=[.!?])\s+|\n/)
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim());
  const best = sentences
    .filter(Boolean)
    .map((line) => ({ line, score: [...words(line)].filter((w) => asked.has(w)).length }))
    .sort((a, b) => b.score - a.score)[0];
  const fact = leak ? input.internalKnowledge : best && best.score > 0 ? best.line : null;
  if (input.currentSituation.task === 'complete') {
    // A completion sees only the last messages (never the knowledge): complete from what was said.
    const said = input.conversation.flatMap((turn) =>
      turn.text.split(/(?<=[.!?])\s+/u).map((line) => line.trim()),
    );
    const last = [...words(input.currentSituation.typed ?? '')].pop();
    const line = said.findLast((l) => (last ? l.toLowerCase().includes(last) : false));
    const at = line && last ? line.toLowerCase().indexOf(last) + last.length : -1;
    // Like the prompt asks (and real models do): the whole current sentence as typed, then its end.
    const sentence = (input.currentSituation.typed ?? '')
      .split(/(?<=[.!?])\s+/u)
      .pop()!
      .trimEnd();
    return { completion: line && at > 0 ? sentence + line.slice(at) : null, grounded: !!line };
  }
  if (!fact) return { suggestions: [], noAnswer: true, handoffRule: null };
  return {
    suggestions: [
      { label: 'Answer now', text: fact, grounded: true },
      {
        label: 'Answer and ask what else',
        text: `${fact} What else can we prepare for you?`,
        grounded: true,
      },
    ],
    noAnswer: false,
    handoffRule: null,
  };
}

await ctx.services.ai!.shutdown();
ctx.services.ai = createAiService(ctx, {
  provider: {
    generate: (_settings, _key, prompt, signal) => mockDecision(prompt, signal),
    draft: async (_settings, _key, prompt, options, signal) => ({
      output: options.schema.parse(mockDraft(prompt, signal)),
      model: 'mock-model',
    }),
    connection: () => ({ state: 'connected', loginUrl: null, error: null }),
    login: async () => ({ state: 'connected', loginUrl: null, error: null }),
    logout: async () => {},
    shutdown: async () => {},
  },
});
ctx.settings.set('ai_inbox_provider', { mode: 'chatgpt', model: '' });

const app = await buildApp(ctx);
app.addHook('onSend', (_request, reply, payload, done) => {
  reply.header('x-agents-devbuild', 'mock-ai');
  done(null, payload);
});
const realtime = attachRealtime(app.server, ctx);
await app.listen({ port, host: '127.0.0.1' });
await ctx.inboxes.connections.connectAll();
process.stdout.write(
  JSON.stringify({ url: `http://127.0.0.1:${port}`, dataDir, maxInboxes }) + '\n',
);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  realtime.close();
  await app.close();
  await shutdownServices(ctx);
  await ctx.inboxes.connections.disconnectAll();
  ctx.db.close();
  logger.close();
  process.exit(0);
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
