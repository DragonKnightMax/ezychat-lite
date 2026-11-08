import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiPrincipal } from '../api-tokens/index.js';
import type { AppContext } from '../context.js';
import { errors } from '../http/errors.js';
import { scopeFor, scopeIds } from '../inboxes/access.js';
import { maxBytesOfInboxes } from '../inboxes/media-limits.js';
import type { UploadStore } from '../uploads/store.js';
import { MCP_UPLOADS_PATH } from './settings.js';

/** The request's Content-Length, when it sent a usable one. */
export function declaredLength(req: FastifyRequest): number | undefined {
  const length = Number(req.headers['content-length']);
  return Number.isFinite(length) && length >= 0 ? length : undefined;
}

/** The file of an upload request: the raw body (name in X-File-Name) or one multipart `file` part. */
async function uploadedFile(
  req: FastifyRequest,
  maxBytes: number | undefined,
): Promise<{ body: Readable; name: string | undefined; declared: number | undefined }> {
  if (req.isMultipart()) {
    const fileSize = maxBytes === undefined ? Number.POSITIVE_INFINITY : maxBytes + 1;
    const part = await req.file({ limits: { fileSize, files: 1, fields: 4, parts: 5 } });
    if (part?.fieldname !== 'file') {
      part?.file.resume();
      throw errors.validation('Send the file as the multipart part named "file".');
    }
    // The multipart framing makes Content-Length a little larger than the file: not checked early.
    return { body: part.file, name: part.filename, declared: undefined };
  }
  const body = req.body as Readable | undefined;
  if (typeof body?.pipe !== 'function') throw errors.validation('The file is empty.');
  const header = req.headers['x-file-name'];
  return {
    body,
    name: Array.isArray(header) ? header[0] : header,
    declared: declaredLength(req),
  };
}

/**
 * POST /mcp/uploads: a file for send_image / send_file / send_video (design
 * docs/features/mcp-file-upload/design.md). Registered inside the /mcp scope, so its `onRequest`
 * (off → 404, LAN → 403, Origin, IP limit, token, token limit) runs first, before any byte of the
 * body is read; then only a token that may send. The body is never parsed or held in memory: it is
 * streamed to a private file. There is no size cap of our own: the largest file any of the token
 * owner's WhatsApp numbers takes, and the free disk space.
 */
export async function registerUploadRoute(
  scope: FastifyInstance,
  ctx: AppContext,
  principalOf: (req: FastifyRequest) => ApiPrincipal,
  uploads: UploadStore,
): Promise<void> {
  await scope.register(async (up) => {
    up.removeContentTypeParser(['application/json', 'text/plain']);
    up.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    // A refused upload may not have been read: close the connection rather than drain the rest.
    up.addHook('onSend', (_req, reply, payload, done) => {
      if (reply.statusCode >= 400) reply.header('connection', 'close');
      done(null, payload);
    });
    up.post(
      MCP_UPLOADS_PATH,
      {
        onRequest: (req, _reply, done) => {
          if (!principalOf(req).scopes.has('inbox:send'))
            return done(
              errors.forbidden('This access token cannot send messages, so it cannot upload'),
            );
          done();
        },
      },
      async (req, reply) => {
        const principal = principalOf(req);
        const maxBytes = maxBytesOfInboxes(ctx, scopeIds(ctx, scopeFor(ctx, principal.user)));
        const file = await uploadedFile(req, maxBytes);
        const uploaded = await uploads.receive(principal.tokenId, file.body, {
          name: file.name,
          declaredLength: file.declared,
          maxBytes,
        });
        return reply.status(201).header('cache-control', 'no-store').send(uploaded);
      },
    );
  });
}
