import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SqlAgentSettings, SqlConnectBody, SqlLinkBody, SqlMatchBody } from '@ezychat/shared';
import { requireAdmin } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { SqlError } from '../connectors/sql-account/client.js';
import { getSqlAccount } from '../connectors/sql-account/service.js';
import { clientIp } from '../http/client-ip.js';
import { errors, HttpError, parse } from '../http/errors.js';

const AgentParams = z.object({ agentId: z.coerce.number().int().positive() });
const DebtorQuery = z.object({ q: z.string().max(60).default('') });
const FakeScenarioBody = z.object({
  scenario: z.enum(['ok', 'no_dns', 'unreachable', 'private_ip', 'bad_keys', 'old_version']),
  phonesOnBranches: z.boolean().optional(),
});

const unavailable = () =>
  new HttpError(503, 'sql_unavailable', 'SQL Account is not connected or cannot be reached');

/**
 * Admin → Connectors → SQL Account (design docs/features/sql-accounting/design.md): connect with the
 * access key + secret key (saved only when SQL Account answered), test, per-agent object access,
 * chat → customer links and the activity list. Admins only; keys never leave the server.
 */
export default function connectorSqlAccountRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const sql = getSqlAccount(ctx);
  const admin = { preHandler: requireAdmin(ctx) };
  const actor = (req: FastifyRequest) => ({ userId: req.user!.id, ip: clientIp(req) });

  app.get('/connectors/sql-account', admin, () => Promise.resolve(sql.status()));

  app.post('/connectors/sql-account/connect', admin, (req) =>
    sql.connect(parse(SqlConnectBody, req.body ?? {}), actor(req)),
  );

  app.post('/connectors/sql-account/test', admin, () => sql.test());

  app.post('/connectors/sql-account/disconnect', admin, (req) =>
    Promise.resolve(sql.disconnect(actor(req))),
  );

  app.put('/connectors/sql-account/match', admin, (req) =>
    Promise.resolve(
      sql.setMatchByPhone(parse(SqlMatchBody, req.body ?? {}).matchByPhone, actor(req)),
    ),
  );

  app.get('/connectors/sql-account/agents/:agentId', admin, (req) => {
    const { agentId } = parse(AgentParams, req.params);
    const settings = sql.agentSettings(agentId);
    if (!settings) throw errors.notFound('AI agent');
    return Promise.resolve(settings);
  });

  app.put('/connectors/sql-account/agents/:agentId', admin, (req) => {
    const { agentId } = parse(AgentParams, req.params);
    const saved = sql.saveAgentSettings(
      agentId,
      parse(SqlAgentSettings, req.body ?? {}),
      actor(req),
    );
    if (!saved) throw errors.notFound('AI agent');
    return Promise.resolve(saved);
  });

  app.get('/connectors/sql-account/customers', admin, () => Promise.resolve(sql.customers()));

  app.get('/connectors/sql-account/debtors', admin, async (req) => {
    const { q } = parse(DebtorQuery, req.query ?? {});
    try {
      return await sql.debtors(q);
    } catch (error) {
      if (error instanceof SqlError) throw unavailable();
      throw error;
    }
  });

  app.put('/connectors/sql-account/links', admin, async (req) => {
    const body = parse(SqlLinkBody, req.body ?? {});
    let result: Awaited<ReturnType<typeof sql.link>>;
    try {
      result = await sql.link(body.jid, body.code, actor(req));
    } catch (error) {
      if (error instanceof SqlError) throw unavailable();
      throw error;
    }
    if (result === 'not_found') throw errors.notFound('Chat');
    if (result === 'unknown_code')
      throw new HttpError(400, 'unknown_code', 'SQL Account has no customer with this code');
    return { ok: true };
  });

  app.get('/connectors/sql-account/activity', admin, () => Promise.resolve(sql.activity()));

  // Fake SQL Account (--fake-wa only): what the fake API service answers next.
  const fake = sql.fake;
  if (!fake) return Promise.resolve();
  app.post('/dev/fake-sql-account/scenario', admin, (req) => {
    const body = parse(FakeScenarioBody, req.body ?? {});
    fake.scenario = body.scenario;
    if (body.phonesOnBranches !== undefined) fake.phonesOnBranches = body.phonesOnBranches;
    return Promise.resolve({ ok: true });
  });
  app.get('/dev/fake-sql-account/quotations', admin, () =>
    Promise.resolve(fake.data.salesquotation ?? []),
  );
  return Promise.resolve();
}
