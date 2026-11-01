// Lite's own address (an app-managed Cloudflare named tunnel) moves with a merge when the target
// has no own address yet, so the team keeps opening the same address and the DNS record stays
// in use. The hand-over then releases it in Lite's folder (`releaseLiteAddress`), so the two apps
// never run the same tunnel.
import { z } from 'zod';
import type { SecretBox } from '../crypto/secret.js';
import type { DB } from '../db/index.js';
import {
  CLOUDFLARE_AUTH_KEY,
  CLOUDFLARE_DOMAINS_KEY,
  CLOUDFLARE_MANAGED_KEY,
  CLOUDFLARE_OWNED_KEY,
} from '../tunnel/cloudflare-setup.js';
import { TUNNEL_HOSTNAME_KEY, TUNNEL_MODE_KEY, TUNNEL_TOKEN_KEY } from '../tunnel/manager.js';

/** Every setting a managed own address is made of, in the order they are read and written. */
export const ADDRESS_KEYS = [
  TUNNEL_MODE_KEY,
  TUNNEL_TOKEN_KEY,
  TUNNEL_HOSTNAME_KEY,
  CLOUDFLARE_MANAGED_KEY,
  CLOUDFLARE_AUTH_KEY,
  CLOUDFLARE_DOMAINS_KEY,
  CLOUDFLARE_OWNED_KEY,
] as const;

const Owned = z.array(z.object({ id: z.string() }).passthrough());
const Managed = z.object({ id: z.string(), hostname: z.string() }).passthrough();

const raw = (db: DB, key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value ?? null;

const json = (value: string | null): unknown => {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const open = (box: SecretBox, value: string | null): string | null => {
  if (value === null) return null;
  try {
    return box.decrypt(value);
  } catch {
    return null;
  }
};

/** True when the target already has an own address (or a half-saved one): it keeps its own. */
export function hasOwnAddress(db: DB): boolean {
  return (
    json(raw(db, TUNNEL_MODE_KEY)) === 'named' ||
    raw(db, TUNNEL_TOKEN_KEY) !== null ||
    Boolean(json(raw(db, TUNNEL_HOSTNAME_KEY))) ||
    json(raw(db, CLOUDFLARE_MANAGED_KEY)) !== null
  );
}

/**
 * Copies Lite's app-managed own address into the target (inside the merge transaction) and
 * returns its hostname; null when it does not move: the target has its own address, Lite has none
 * or set its tunnel up in the Cloudflare dashboard (its origin port cannot be updated by the app),
 * or Lite's secrets cannot be read. Secrets are sealed again with the target's key.
 */
export function moveOwnAddress(
  target: DB,
  lite: DB,
  liteSecret: SecretBox | null,
  targetSecret: SecretBox,
): string | null {
  if (!liteSecret || hasOwnAddress(target)) return null;
  if (json(raw(lite, TUNNEL_MODE_KEY)) !== 'named') return null;
  const managed = Managed.safeParse(json(raw(lite, CLOUDFLARE_MANAGED_KEY)));
  const hostname = json(raw(lite, TUNNEL_HOSTNAME_KEY));
  if (!managed.success || hostname !== managed.data.hostname) return null;
  const token = open(liteSecret, raw(lite, TUNNEL_TOKEN_KEY));
  const auth = open(liteSecret, raw(lite, CLOUDFLARE_AUTH_KEY));
  // Without Lite's Cloudflare sign-in the target could not move the origin to its own port.
  if (!token || !auth) return null;

  const ownedOf = (db: DB) => {
    const parsed = Owned.safeParse(json(raw(db, CLOUDFLARE_OWNED_KEY)));
    return parsed.success ? parsed.data : [];
  };
  const owned = ownedOf(target);
  for (const t of ownedOf(lite)) if (!owned.some((o) => o.id === t.id)) owned.push(t);

  upsert(target, TUNNEL_MODE_KEY, JSON.stringify('named'));
  upsert(target, TUNNEL_TOKEN_KEY, targetSecret.encrypt(token));
  upsert(target, TUNNEL_HOSTNAME_KEY, JSON.stringify(hostname));
  upsert(target, CLOUDFLARE_MANAGED_KEY, JSON.stringify(managed.data));
  // The managed tunnel belongs to Lite's Cloudflare account: its sign-in and domains come along
  // (the target had no address, so its own sign-in, if any, was not in use).
  upsert(target, CLOUDFLARE_AUTH_KEY, targetSecret.encrypt(auth));
  upsert(target, CLOUDFLARE_DOMAINS_KEY, raw(lite, CLOUDFLARE_DOMAINS_KEY) ?? '[]');
  upsert(target, CLOUDFLARE_OWNED_KEY, JSON.stringify(owned));
  return managed.data.hostname;
}

/**
 * Hand-over part for a moved address: turns Lite's own address off and forgets the moved tunnel,
 * so "Use EzyChat Lite again" (any Lite version) starts without it and its setup refuses the
 * address. Lite's Cloudflare sign-in stays. Returns the undo that writes the old values back into
 * Lite's database (pass it a fresh connection: this one is closed by then).
 */
export function releaseLiteAddress(lite: DB): (db: DB) => void {
  const before = new Map(ADDRESS_KEYS.map((key) => [key, raw(lite, key)]));
  const managed = Managed.safeParse(json(before.get(CLOUDFLARE_MANAGED_KEY) ?? null));
  const owned = Owned.safeParse(json(before.get(CLOUDFLARE_OWNED_KEY) ?? null));
  lite.transaction(() => {
    upsert(lite, TUNNEL_MODE_KEY, JSON.stringify('off'));
    for (const key of [TUNNEL_TOKEN_KEY, TUNNEL_HOSTNAME_KEY, CLOUDFLARE_MANAGED_KEY])
      upsert(lite, key, null);
    if (managed.success && owned.success)
      upsert(
        lite,
        CLOUDFLARE_OWNED_KEY,
        JSON.stringify(owned.data.filter((t) => t.id !== managed.data.id)),
      );
  })();
  return (db) => db.transaction(() => before.forEach((value, key) => upsert(db, key, value)))();
}

/** Writes one raw settings value; null deletes the row. */
function upsert(db: DB, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
}
