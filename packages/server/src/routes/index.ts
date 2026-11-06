import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { ServerExtension } from '../extensions.js';
import { errors } from '../http/errors.js';
import { publicRoutesPrefix } from '../http/origin.js';
import health from './health.js';
import access from './access.js';
import setup from './setup.js';
import auth from './auth.js';
import users from './users.js';
import chats from './chats.js';
import groups from './groups.js';
import messages from './messages.js';
import notes from './notes.js';
import customers from './customers.js';
import media from './media.js';
import quickReplies from './quick-replies.js';
import push from './push.js';
import tunnel from './tunnel.js';
import settings from './settings.js';
import audit from './audit.js';
import wa from './wa.js';
import dev from './dev.js';
import clientErrors from './client-errors.js';
import ai from './ai.js';
import aiGroups from './ai-groups.js';
import scheduledTasks from './scheduled-tasks.js';
import directory from './directory.js';
import integrations from './integrations.js';
import oauth from './oauth.js';
import inboxes from './inboxes.js';
import aiTemplates from './ai-templates.js';
import templates from './templates.js';
import replySuggestions from './reply-suggestions.js';
import askEzy from './ask-ezy.js';
import fixEnglish from './fix-english.js';
import connectors from './connectors.js';
import connectorGoogleSheets from './connector-google-sheets.js';
import connectorSqlAccount from './connector-sql-account.js';
import connectorGoogleDrive from './connector-google-drive.js';
import connectorList from './connector-list.js';
import connectorMcp from './connector-mcp.js';
import reports from './reports.js';
import safety from './safety.js';
import liteImport from './lite-import.js';
import feedback from './feedback.js';

export type RouteModule = (app: FastifyInstance, ctx: AppContext) => Promise<void>;

export const routeModules: RouteModule[] = [
  health,
  access,
  setup,
  auth,
  users,
  chats,
  groups,
  messages,
  notes,
  customers,
  media,
  quickReplies,
  push,
  tunnel,
  settings,
  audit,
  wa,
  dev,
  clientErrors,
  ai,
  aiGroups,
  scheduledTasks,
  directory,
  integrations,
  oauth,
  inboxes,
  aiTemplates,
  templates,
  replySuggestions,
  askEzy,
  fixEnglish,
  connectors,
  connectorGoogleSheets,
  connectorSqlAccount,
  connectorGoogleDrive,
  connectorList,
  connectorMcp,
  reports,
  safety,
  liteImport,
  feedback,
];

/**
 * Registers every route module under /api, each in its own encapsulated scope (hooks stay local),
 * then each extension's routes under /api/ext/<name> (so they cannot shadow a core path and
 * inherit the global Host/Origin hooks).
 */
export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(
    async (api) => {
      for (const mod of routeModules) {
        await api.register(async (scope) => mod(scope, ctx));
      }
    },
    { prefix: '/api' },
  );
  for (const ext of ctx.extensions) await registerPublicRoutes(app, ctx, ext);
  for (const ext of ctx.extensions) {
    const routes = ext.routes;
    if (!routes) continue;
    await app.register(async (scope) => routes(scope, ctx), { prefix: `/api/ext/${ext.name}` });
  }
}

type RawRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * An extension's public routes at /api/ext/<name>/public: no session and no Origin check (see
 * createOriginHook), the raw body kept as `request.rawBody`, and `verify` before every handler
 * (401 `{ error: 'unauthorized' }`). The Host allowlist and the access gate still apply. Neither
 * the body nor the headers are logged.
 */
async function registerPublicRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  ext: ServerExtension,
): Promise<void> {
  const pub = ext.publicRoutes;
  if (!pub) return;
  const log = ctx.log.child({ mod: 'ext', extension: ext.name });
  await app.register(
    async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        '*',
        { parseAs: 'buffer' },
        (req: RawRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
          req.rawBody = body;
          if (!body.length) return done(null, undefined);
          const type = String(req.headers['content-type'] ?? '').toLowerCase();
          if (!type.startsWith('application/json') && !/\+json\b/.test(type))
            return done(null, body);
          try {
            done(null, JSON.parse(body.toString('utf8')));
          } catch {
            done(errors.validation('Invalid JSON body'));
          }
        },
      );
      scope.addHook('preHandler', async (req, reply) => {
        let ok = false;
        try {
          ok = (await pub.verify(req as RawRequest)) === true;
        } catch (err) {
          log.warn(
            { errName: err instanceof Error ? err.name : typeof err, url: req.routeOptions?.url },
            'public route verify failed',
          );
        }
        if (!ok) {
          log.warn({ url: req.routeOptions?.url, method: req.method }, 'public route refused');
          return reply.status(401).send({ error: 'unauthorized' });
        }
      });
      await pub.routes(scope, ctx);
    },
    { prefix: publicRoutesPrefix(ext.name) },
  );
}
