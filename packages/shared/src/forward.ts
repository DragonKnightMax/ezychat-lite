import { z } from 'zod';
import { MessageSchema } from './models.js';

/**
 * Forward a message (design: docs/features/forward-message/design.md): one message to 1–5 existing chats
 * or groups the user may open, as WhatsApp's "Forwarded", through the normal send queue as the user.
 */

/** Chats one forward may go to (against bulk sending and ban risk). */
export const FORWARD_MAX_CHATS = 5;
/**
 * From this forwarding score WhatsApp shows "Forwarded many times" and lets the message go to one chat
 * at a time; we follow both.
 */
export const FORWARD_MANY_TIMES_SCORE = 5;
/** Forwards a person may send a minute; each chosen chat counts one. */
export const FORWARD_PER_MINUTE = 30;

/** POST /api/messages/:id/forward */
export const ForwardMessageBody = z.object({
  to: z.array(z.string().min(1).max(256)).min(1).max(FORWARD_MAX_CHATS),
  /** One per dialog opening: a retry answers the same messages and sends nothing again. */
  clientRequestId: z.string().min(1).max(64),
  /**
   * Videos: `file` sends it as a document (full quality, no preview), for a chat whose number cannot
   * take it as a video or by choice. Ignored for every other type.
   */
  sendAs: z.enum(['original', 'file']).default('original'),
});
export type ForwardMessageBody = z.infer<typeof ForwardMessageBody>;

/** The copies, one per chosen chat, in the order of `to`. */
export const ForwardMessageResponse = z.object({ messages: z.array(MessageSchema) });
export type ForwardMessageResponse = z.infer<typeof ForwardMessageResponse>;

/** True when a forwarding score shows as "Forwarded many times". */
export function forwardedManyTimes(score: number): boolean {
  return score >= FORWARD_MANY_TIMES_SCORE;
}
