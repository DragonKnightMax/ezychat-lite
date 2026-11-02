import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { FakeWaAdapter } from '@ezychat/wa';
import type { AiConnection, CloudflareSetupStatus, TunnelStatus } from '@ezychat/shared';
import { createContext, shutdownServices } from '../../../../packages/server/src/main.js';
import { initializers } from '../../../../packages/server/src/services.js';
import { buildApp } from '../../../../packages/server/src/app.js';
import { createLogger } from '../../../../packages/server/src/logger.js';
import { attachRealtime } from '../../../../packages/server/src/realtime/index.js';
import { initAi, createAiService } from '../../../../packages/server/src/ai/service.js';
import type { AiProvider } from '../../../../packages/server/src/ai/provider-types.js';
import { initTunnel } from '../../../../packages/server/src/tunnel/index.js';
import { initPush, createPushService } from '../../../../packages/server/src/push/index.js';
import { AI_PROVIDER_KEY } from '../../../../packages/server/src/ai/settings-keys.js';
import webConfig from '../../../../apps/web/vite.config.js';
import { seedDemo } from './seed.js';
import { seedEditDelete } from './edit-delete.js';
import { registerProposal } from './proposal.js';

// This runner belongs to the reference mock, never to the application startup path.
if (!process.argv.includes('--fake-wa'))
  throw new Error('Run this mock with --fake-wa explicitly.');
// --fresh: a first launch (no users, WhatsApp waiting for a QR scan, AI not connected).
const fresh = process.argv.includes('--fresh');
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const metadata = JSON.parse(await readFile(join(here, 'reference.json'), 'utf8'));
const port = Number(process.env.MOCK_UI_PORT ?? 7487);
const apiPort = Number(process.env.MOCK_API_PORT ?? 7486);
if (![port, apiPort].every((value) => Number.isInteger(value) && value > 1023 && value < 65536))
  throw new Error('Mock ports must be integers between 1024 and 65535.');
const dataDir = await mkdtemp(join(tmpdir(), 'ezychat-message-edit-delete-mock-'));
const logger = await createLogger({ dataDir, stdout: false });
const log = logger.log.child({ mod: 'mock', sourceRevision: metadata.sourceRevision });

// Model calls/downloads must never escape this demo. Cloudflare and push use the fixtures below.
const localFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('External requests are disabled in this interactive mock.');
  return localFetch(input, init);
};

// Proposed (ai-groups): the linked number is named like the business, so a group @mention of it
// reads "@Kopi Apong" (the app names the own number from the WhatsApp session).
const fakeWa = new FakeWaAdapter({
  autoOpen: !fresh,
  me: { jid: '60000000000@s.whatsapp.net', name: 'Kopi Apong' },
});
const ctx = await createContext(
  {
    dataDir,
    port: apiPort,
    host: '127.0.0.1',
    mode: 'standalone',
    fakeWa: true,
    webDistDir: null,
    version: metadata.appVersionAtProposal ?? metadata.appVersion,
  },
  { wa: fakeWa, log: logger.log },
);
let connection: AiConnection = fresh
  ? { state: 'signed_out', loginUrl: null, error: null }
  : { state: 'connected', loginUrl: null, error: null };
/**
 * Deterministic Try it / live answer: the business-context line sharing the most words with the
 * customer's last message, or the standard hand-off when nothing matches. No model is called.
 */
const demoAnswer = (input: string) => {
  let knowledge = '';
  let question = '';
  try {
    const parsed = JSON.parse(input) as {
      businessKnowledge?: string;
      conversation?: Array<{ speaker: string; text: string }>;
    };
    knowledge = parsed.businessKnowledge ?? '';
    question =
      [...(parsed.conversation ?? [])].reverse().find((turn) => turn.speaker === 'customer')
        ?.text ?? '';
  } catch {
    /* fall through to the hand-off */
  }
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2),
    );
  const asked = words(question);
  const best = knowledge
    .split(/\n|(?<=[.!?])\s+/)
    // Drop list markers and the "[item name]" header in front of each Business context item.
    .map((line) =>
      line
        .replace(/^\[[^\]]*\]\s*/, '')
        .replace(/^[-•*#\s]+/, '')
        .trim(),
    )
    .filter((line) => line.length > 3 && !line.endsWith(':'))
    // "open" also matches "opens": a shared start of four or more letters counts as the same word.
    .map((line) => ({
      line,
      score: [...words(line)].filter((w) =>
        [...asked].some(
          (q) => q === w || (q.length > 3 && w.length > 3 && (w.startsWith(q) || q.startsWith(w))),
        ),
      ).length,
    }))
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0
    ? { reply: `${best.line} Does that answer your question?`, action: 'ask_resolution' as const }
    : {
        reply: 'A team member will help you with this shortly.',
        action: 'handoff' as const,
        handoffReason: 'missing_facts' as const,
      };
};
const provider: AiProvider = {
  async generate(_settings, _key, prompt, signal) {
    signal.throwIfAborted();
    return demoAnswer(prompt.input);
  },
  async rewrite(_settings, _key, _prompt, signal) {
    signal.throwIfAborted();
    return {
      text: 'Answer enquiries clearly using the saved business facts. Hand requests requiring staff action to the team.',
      model: 'mock-model',
    };
  },
  connection: () => connection,
  // Simulated ChatGPT sign-in: "signing in" for 2.5 s, then connected. No page is opened.
  async login() {
    connection = { state: 'signing_in', loginUrl: null, error: null };
    setTimeout(() => {
      if (connection.state === 'signing_in')
        connection = {
          state: 'connected',
          loginUrl: null,
          error: null,
          email: 'owner@example.com',
        };
    }, 2500);
    return connection;
  },
  async submitCallbackUrl() {
    connection = { state: 'connected', loginUrl: null, error: null };
    return connection;
  },
  async logout() {
    connection = { state: 'signed_out', loginUrl: null, error: null };
  },
  async shutdown() {},
  async models() {
    return { models: [{ id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' }], source: 'fallback' };
  },
  knownModels: () => ['gpt-4.1-mini'],
  async resolveModel(model) {
    return model || 'gpt-4.1-mini';
  },
  async test(model) {
    return {
      ok: true,
      model: model || 'mock-model',
      reply: 'Demo connection check passed.',
      error: null,
    };
  },
};
let tunnel: TunnelStatus = {
  mode: 'off',
  state: 'stopped',
  url: null,
  hostname: null,
  lastError: null,
  logTail: [],
};
let cloudflare: CloudflareSetupStatus = {
  state: 'signed_out',
  loginUrl: null,
  error: null,
  domains: [],
  busy: false,
  managed: null,
};
const setTunnel = (next: TunnelStatus) => {
  tunnel = next;
  ctx.bus.emit('tunnel:status', next);
  return next;
};
const tunnelFixture = {
  status: () => tunnel,
  async start(body: { mode: 'quick' | 'named'; hostname?: string }) {
    return setTunnel({
      ...tunnel,
      mode: body.mode,
      state: 'running',
      url:
        body.mode === 'quick'
          ? 'https://demo-quick.example'
          : `https://${body.hostname || 'inbox.demo.example'}`,
      hostname: body.hostname ?? null,
      lastError: null,
      logTail: ['Simulated tunnel; no public connection was created.'],
    });
  },
  async stop() {
    return setTunnel({
      mode: 'off',
      state: 'stopped',
      url: null,
      hostname: null,
      lastError: null,
      logTail: [],
    });
  },
  async restore() {},
  async shutdown() {},
};
const cloudflareFixture = {
  status: () => cloudflare,
  async login() {
    cloudflare = {
      ...cloudflare,
      state: 'connected',
      domains: [{ id: 'a'.repeat(32), name: 'demo.example', accountName: 'Demo account' }],
    };
    return cloudflare;
  },
  async cancelLogin() {
    return cloudflare;
  },
  async refresh() {
    return cloudflare;
  },
  async create(body: { subdomain: string; tunnelName: string }) {
    const hostname = `${body.subdomain}.demo.example`;
    cloudflare = {
      ...cloudflare,
      managed: { id: '00000000-0000-4000-8000-000000000001', name: body.tunnelName, hostname },
    };
    return tunnelFixture.start({ mode: 'named', hostname });
  },
  async reconcileOrigin() {},
  async shutdown() {},
};
for (const initialize of initializers) {
  if (initialize === initTunnel) {
    ctx.services.tunnel = tunnelFixture;
    ctx.services.cloudflareSetup = cloudflareFixture;
  } else if (initialize === initPush) {
    ctx.services.push = createPushService(ctx, { sender: async () => undefined });
  } else if (initialize === initAi) {
    ctx.services.ai = createAiService(ctx, { provider });
  } else await initialize(ctx);
}
const app = await buildApp(ctx);
registerProposal(app, ctx, fakeWa);
// New installs default to Sign in with ChatGPT (the proposal); the API key stays available.
if (fresh) ctx.settings.set(AI_PROVIDER_KEY, { mode: 'chatgpt', model: '' });
await app.listen({ host: '127.0.0.1', port: apiPort });
const realtime = attachRealtime(app.server, ctx);
await ctx.wa.connect();
if (fresh) fakeWa.simulateStatus({ state: 'qr', qr: `ezychat-mock-qr-${Date.now().toString(36)}` });
else if (!process.argv.includes('--empty')) {
  await seedDemo(app, ctx);
  await seedEditDelete();
}
const vite = await createServer({
  ...webConfig,
  configFile: false,
  root: here,
  define: {
    __APP_VERSION__: JSON.stringify(metadata.appVersionAtProposal ?? metadata.appVersion),
  },
  // Keep the web config's resolve (the ezychat-source condition: @ezychat/* from source, not dist).
  resolve: { ...webConfig.resolve, alias: { '@': join(here, 'src') } },
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    fs: { allow: [root] },
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
      '/socket.io': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false, ws: true },
    },
  },
});
await vite.listen();
log.info({ port, apiPort, dataDir }, 'interactive app mock ready');
process.stdout.write(
  `Proposed message-edit-delete mock (${fresh ? 'fresh install' : 'seeded demo'}): http://localhost:${port}/\nTemporary demo data: ${dataDir}\n`,
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await vite.close();
  realtime.close();
  await app.close();
  await shutdownServices(ctx);
  await ctx.wa.disconnect();
  ctx.db.close();
  logger.close();
  process.exit(0);
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
