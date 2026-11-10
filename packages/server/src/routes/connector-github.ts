import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GitHubAgentSettings, GitHubTokenBody } from '@ezychat/shared';
import { requireAdmin } from '../auth/guards.js';
import { getGitHub } from '../connectors/github/service.js';
import type { AppContext } from '../context.js';
import { clientIp } from '../http/client-ip.js';
import { errors, parse } from '../http/errors.js';

const AgentParams = z.object({ agentId: z.coerce.number().int().positive() });
const RequestParams = z.object({ requestId: z.string().regex(/^[a-f0-9]{24}$/) });
const RepoQuery = z.object({ refresh: z.enum(['0', '1']).optional() });
const FakeBody = z.object({
  mode: z.enum(['ok', 'unavailable', 'rate_limited']).optional(),
  installed: z.boolean().optional(),
});
const FakeDeviceBody = z.object({ action: z.enum(['approve', 'deny', 'expire']) });

/**
 * Admin → Connectors → GitHub (admins only): sign-in (device flow or a fine-grained token),
 * the repositories GitHub shares, per-agent settings and the activity list. Lite only for now
 * (owner decision Q3): other editions register nothing here (404).
 */
export default async function connectorGitHubRoutes(app: FastifyInstance, ctx: AppContext) {
  const github = getGitHub(ctx);
  if (ctx.edition !== 'lite' || !github) return;
  const admin = { preHandler: requireAdmin(ctx) };
  const actor = (req: FastifyRequest) => ({ userId: req.user!.id, ip: clientIp(req) });

  app.get('/connectors/github', admin, async () => github.status());

  app.post('/connectors/github/device', admin, async (req) => github.startDevice(actor(req)));

  app.get('/connectors/github/device/:requestId', admin, async (req) => {
    const { requestId } = parse(RequestParams, req.params);
    const progress = await github.deviceProgress(requestId);
    if (!progress) throw errors.notFound('Sign-in request');
    return progress;
  });

  app.post('/connectors/github/device/:requestId/cancel', admin, async (req, reply) => {
    const { requestId } = parse(RequestParams, req.params);
    github.cancelDevice(requestId);
    return reply.status(204).send();
  });

  app.post('/connectors/github/token', admin, async (req) => {
    const { token } = parse(GitHubTokenBody, req.body ?? {});
    return github.connectToken(token, actor(req));
  });

  app.post('/connectors/github/check', admin, async () => github.check());

  app.post('/connectors/github/disconnect', admin, async (req) => github.disconnect(actor(req)));

  app.get('/connectors/github/repos', admin, async (req) => {
    const { refresh } = parse(RepoQuery, req.query ?? {});
    return github.repoList(refresh === '1');
  });

  app.get('/connectors/github/agents/:agentId', admin, async (req) => {
    const { agentId } = parse(AgentParams, req.params);
    return github.agentView(agentId);
  });

  app.put('/connectors/github/agents/:agentId', admin, async (req) => {
    const { agentId } = parse(AgentParams, req.params);
    // Unknown agent first (404), then the body (400).
    await github.agentView(agentId);
    const body = parse(GitHubAgentSettings, req.body ?? {});
    return github.putSettings(agentId, body, actor(req));
  });

  app.get('/connectors/github/activity', admin, async () => ({ activity: github.activity() }));

  // Fake GitHub (--fake-wa only): its state and the person on github.com/login/device.
  const fake = github.fake;
  if (!fake) return;

  app.get('/dev/fake-github', admin, async () => ({
    mode: fake.mode,
    installed: fake.installed,
    userCode: fake.latestDevice()?.userCode ?? null,
  }));

  app.post('/dev/fake-github', admin, async (req) => {
    const body = parse(FakeBody, req.body ?? {});
    if (body.mode) fake.mode = body.mode;
    if (body.installed !== undefined) fake.installed = body.installed;
    return github.status();
  });

  app.post('/dev/fake-github/device', admin, async (req) => {
    const { action } = parse(FakeDeviceBody, req.body ?? {});
    if (!fake.answerDevice(action)) throw errors.notFound('Sign-in request');
    return { ok: true };
  });
}
