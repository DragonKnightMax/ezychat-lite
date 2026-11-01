import type { DB } from '../db/index.js';
import { HttpError } from '../http/errors.js';

/**
 * The inbox scope of a report request: `undefined` (no `inbox`) counts every inbox together, else
 * that one inbox, removed ones included (admins keep their chats read only). Unknown → 404.
 */
export function reportInboxScope(db: DB, inbox: number | undefined): number[] | undefined {
  if (inbox === undefined) return undefined;
  if (!db.prepare('SELECT 1 FROM inboxes WHERE id = ?').get(inbox))
    throw new HttpError(404, 'not_found', 'Inbox not found');
  return [inbox];
}
