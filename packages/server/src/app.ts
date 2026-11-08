import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ErrorCode } from '@ezychat/shared';
import type { AppContext } from './context.js';
import { errorHandler, sendError } from './http/errors.js';
import { contextHostPolicy, createHostHook } from './http/host.js';
import { createOriginHook } from './http/origin.js';
import { createAccessHook, hostOnlyHook } from './http/access.js';
import { registerSecurityHeaders } from './http/security-headers.js';
import { registerApiCacheHeaders, staticCacheControl } from './http/cache.js';
import { registerRoutes } from './routes/index.js';
import { registerMcp } from './mcp/route.js';
import { registerMcpOAuth } from './mcp/oauth-routes.js';

/**
 * The multipart file limit of a route that sets none. Routes that take files set their own: the
 * composer and MCP uploads stream to disk up to the WhatsApp number's limit, others are small.
 */
export const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: UPLOAD_LIMIT_BYTES, files: 1 } });
  registerSecurityHeaders(app);
  registerApiCacheHeaders(app);
  app.addHook('onRequest', createHostHook(contextHostPolicy(ctx)));
  // public extension routes (webhooks) carry no browser Origin; their own `verify` guards them
  app.addHook(
    'onRequest',
    createOriginHook(ctx.extensions.filter((e) => e.publicRoutes).map((e) => e.name)),
  );
  app.addHook('onRequest', hostOnlyHook);
  app.addHook('onRequest', createAccessHook(ctx.access));
  app.setErrorHandler(errorHandler);

  await registerRoutes(app, ctx);
  await registerMcp(app, ctx);
  await registerMcpOAuth(app, ctx);

  const webDist = ctx.config.webDistDir;
  const hasWeb = webDist !== null && existsSync(join(webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      // Built once with the web bundle, so each request avoids runtime compression work.
      preCompressed: true,
      globIgnore: ['**/*.br', '**/*.gz', '**/*.deflate'],
      setHeaders(res, path) {
        res.header('cache-control', staticCacheControl(relative(webDist, path)));
      },
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    // /mcp and /.well-known/* (MCP clients probe OAuth discovery) must never get the SPA page.
    const isApi =
      path === '/api' ||
      path.startsWith('/api/') ||
      path.startsWith('/socket.io') ||
      path === '/mcp' ||
      path.startsWith('/mcp/') ||
      path.startsWith('/.well-known/');
    if (!isApi && hasWeb && (req.method === 'GET' || req.method === 'HEAD')) {
      // static files (wildcard:false registers only files present at startup), else SPA fallback
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return sendError(reply, 404, ErrorCode.NOT_FOUND, `Route ${req.method} ${path} not found`);
  });

  return app;
}
