import type { AppContext } from '../context.js';
import { PRIMARY_INBOX_ID, parseChatKey } from '../inboxes/keys.js';

/**
 * Asks WhatsApp for the profile photo URL of `chatKey` (`<waJid>#<inboxId>`; a plain JID is inbox 1),
 * through that inbox's own phone. Rejects when the lookup fails or the inbox was removed (its
 * adapter() throws); null is a real "no photo". The avatar store (`avatars/store.ts`) checks the URL
 * (https on WhatsApp's own hosts only), coalesces, bounds and keeps the result.
 */
export function profilePhotoLookup(ctx: AppContext, chatKey: string): () => Promise<string | null> {
  return async () => {
    const target = parseChatKey(chatKey);
    const wa =
      target.inboxId === PRIMARY_INBOX_ID
        ? ctx.wa
        : ctx.inboxes.connections.adapter(target.inboxId);
    return wa.getProfilePicture(target.waJid);
  };
}
