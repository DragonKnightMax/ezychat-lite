import type { WaMediaLimits } from '@ezychat/wa';
import type { AppContext } from '../context.js';
import { capabilitiesOf } from './types.js';

/**
 * The largest file a WhatsApp connection takes of any kind (its document limit on every connection
 * we know), or undefined when it reports no limit (WhatsApp's answer then decides).
 */
export function largestMediaLimit(limits: WaMediaLimits | undefined): number | undefined {
  const values = Object.values(limits ?? {}).filter((v): v is number => typeof v === 'number');
  return values.length ? Math.max(...values) : undefined;
}

/** The largest file an inbox's connection takes; undefined for none known or no connection. */
export function inboxMaxBytes(ctx: AppContext, inboxId: number): number | undefined {
  let limits: WaMediaLimits | undefined;
  try {
    limits = capabilitiesOf(ctx.inboxes.connections.adapter(inboxId)).mediaLimits;
  } catch {
    return undefined; // a removed inbox: the send refuses it with its own code
  }
  return largestMediaLimit(limits);
}

/** The largest file any of these inboxes takes; undefined when one of them knows no limit. */
export function maxBytesOfInboxes(
  ctx: AppContext,
  inboxIds: readonly number[],
): number | undefined {
  let max = 0;
  for (const id of inboxIds) {
    const own = inboxMaxBytes(ctx, id);
    if (own === undefined) return undefined;
    max = Math.max(max, own);
  }
  return inboxIds.length ? max : undefined;
}
