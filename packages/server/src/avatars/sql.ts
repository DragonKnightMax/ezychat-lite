import type { DB } from '../db/index.js';

/**
 * Short content hashes of the stored photos among `keys`, in one query (keys without a stored photo
 * are absent). The chat list adds them to `avatarUrl` as `?v=<hash>`.
 */
export function avatarHashes(db: DB, keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  const rows = db
    .prepare(
      `SELECT key, hash FROM avatars
       WHERE key IN (SELECT value FROM json_each(?)) AND has_photo = 1 AND hash IS NOT NULL`,
    )
    .all(JSON.stringify(keys)) as Array<{ key: string; hash: string }>;
  for (const r of rows) out.set(r.key, r.hash);
  return out;
}
