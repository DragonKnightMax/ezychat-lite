import type { FastifyInstance } from 'fastify';
import { SetupAdminBody } from '@ezychat/shared';
import { getAuth, setSessionCookie } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { audit } from '../db/audit.js';
import { clientIp, isDirectLoopback, isHttps } from '../http/client-ip.js';
import { errors, parse } from '../http/errors.js';
import { isLoopbackHost } from '../http/host.js';

export default async function setupRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = getAuth(ctx);

  app.get('/setup/status', async () => ({ needsSetup: !auth.hasAnyUser() }));

  // Public but guarded: only before any user exists, and only from the local machine (never via tunnel).
  app.post('/setup/admin', async (req, reply) => {
    if (auth.hasAnyUser()) throw errors.notFound();
    // Host must be a loopback name too: blocks DNS-rebinding (evil.com -> 127.0.0.1) during setup.
    if (!isDirectLoopback(req) || !isLoopbackHost(req.headers.host)) {
      throw errors.forbidden('First-time setup is only allowed from this computer');
    }
    const body = parse(SetupAdminBody, req.body);
    const user = await auth.createFirstAdmin(body);
    const ip = clientIp(req);
    const token = auth.createSession(user.id, { ip, userAgent: String(req.headers['user-agent'] ?? '') });
    setSessionCookie(reply, token, isHttps(req));
    audit(ctx.db, { userId: user.id, action: 'setup.admin', ip, meta: { username: user.username } });
    void ctx.services.usage?.check();
    return user;
  });
}
