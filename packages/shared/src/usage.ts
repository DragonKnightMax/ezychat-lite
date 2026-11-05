import { z } from 'zod';

/**
 * Anonymous usage stats (design: docs/superpowers/specs/2026-11-04-usage-stats-design.md). The server sends one of these
 * to the licence portal relay (`POST https://license.anchorsprint.app/v1/usage`), which forwards it to
 * Google Analytics. This is the WHOLE payload: the portal refuses any other field, and nothing in it
 * names a person, a company, a number, a chat or a message.
 */
export const USAGE_EVENTS = [
  'app_installed',
  'admin_created',
  'wa_linked',
  'ai_connected',
  'ai_agent_on',
  'first_message_sent',
  'app_active',
] as const;
export const UsageEventName = z.enum(USAGE_EVENTS);
export type UsageEventName = z.infer<typeof UsageEventName>;

/** Every event counts once per install, except this one (once per calendar day). */
export const USAGE_DAILY_EVENT: UsageEventName = 'app_active';

const SEMVER = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;

export const UsageEvent = z.strictObject({
  /** A random UUID made for usage stats only (setting `usage_install_id`), never used elsewhere. */
  installId: z.string().uuid(),
  product: z.enum(['EZC-LITE', 'EZC-ENT']),
  version: z.string().max(60).regex(SEMVER),
  os: z.enum(['windows', 'mac', 'linux']),
  mode: z.enum(['standalone', 'service']),
  event: UsageEventName,
});
export type UsageEvent = z.infer<typeof UsageEvent>;
