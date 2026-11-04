import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { createAvatarStore, type AvatarResult, type AvatarStore } from './store.js';

declare module '../context.js' {
  interface Services {
    avatars?: AvatarStore;
  }
}

/** A known photo or a known "no photo": the browser may keep it for a day. */
export const AVATAR_DAY = 'private, max-age=86400';
/**
 * A photo asked for by its content hash (`?v=<hash>`): kept a week, not "immutable". The server learns of a
 * new photo only when someone asks again after its 24 h refresh, so a browser that never asks would keep an
 * old photo forever.
 */
export const AVATAR_VERSIONED = 'private, max-age=604800';

/** The one photo store of this server (`<data>/avatars/`), shared by every route. */
export function avatarStore(ctx: AppContext): AvatarStore {
  return (ctx.services.avatars ??= createAvatarStore({
    db: ctx.db,
    dir: join(ctx.config.dataDir, 'avatars'),
    log: ctx.log.child({ mod: 'avatars' }),
  }));
}

/** The photo key of a group member (chat keys are used as they are). */
export const memberAvatarKey = (identityKey: string) => `m:${identityKey}`;

/**
 * Answers an avatar request from the store: the bytes with an ETag (304 when the browser has them),
 * 204 for "no photo" (cached a day) and 204 `no-store` when nothing is known (a failed lookup).
 */
export function sendAvatar(req: FastifyRequest, reply: FastifyReply, r: AvatarResult) {
  if (r.kind === 'failed') return reply.header('cache-control', 'no-store').code(204).send();
  if (r.kind === 'none') return reply.header('cache-control', AVATAR_DAY).code(204).send();
  const etag = `"${r.hash}"`;
  const v = (req.query as Record<string, unknown> | undefined)?.v;
  reply.header('cache-control', v === r.hash ? AVATAR_VERSIONED : AVATAR_DAY).header('etag', etag);
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch?.split(',').some((t) => t.trim().replace(/^W\//, '') === etag))
    return reply.code(304).send();
  return reply
    .header('content-type', 'image/jpeg')
    .header('x-content-type-options', 'nosniff')
    .send(r.bytes);
}
