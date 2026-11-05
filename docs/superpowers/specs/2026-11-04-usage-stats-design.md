# Anonymous usage stats

Owner decision (Jazz, 2026-11-04): replace the "No tracking in Lite" rule with anonymous usage stats in the core
(Lite and Enterprise), on by default, with a switch to turn them off, never personal data, sent server-side only to
our licence portal, which forwards them to Google Analytics 4. The GA keys live only in the portal
(anchorsprint/anchor-licence-portal#10 relay, #11 admin settings card); the app holds no GA id or secret.

## Why

The website funnel ends at the download. These events show where new installs stop: installed → admin created →
WhatsApp linked → AI connected → AI agent on → first message sent, plus daily active installs.

## Payload (the whole contract)

Shared `UsageEvent` (`packages/shared/src/usage.ts`), strict, equal to the portal's `POST /v1/usage` body:

| Field       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `installId` | random UUID in setting `usage_install_id`, made for usage stats only                                       |
| `product`   | `EZC-LITE` (edition `lite`) or `EZC-ENT` (edition `enterprise`); any other edition sends nothing           |
| `version`   | app version (semver; anything else is not sent)                                                            |
| `os`        | `windows` / `mac` / `linux`                                                                                |
| `mode`      | `standalone` / `service`                                                                                   |
| `event`     | `app_installed`, `admin_created`, `wa_linked`, `ai_connected`, `ai_agent_on`, `first_message_sent`, `app_active` |

Never: names, phone numbers, JIDs, chats, message text, emails, IP addresses, company, keys, counts tied to people.

## Behaviour

- `packages/server/src/usage/service.ts` is the only sender. Milestones are read from the app's own state (users,
  inbox status, AI connection, `ai_agents`, sent team messages), each sent once (remembered in `usage_sent`);
  `app_active` once per calendar day (UTC) while the server runs.
- Checks run at start, on `inbox:status`, `ai:connection-changed`, `message:status`, `access:opened`, after the
  first-admin setup, and hourly.
- Fire-and-forget POST, 10 s, `redirect: 'error'`; a network error, 5xx or 429 is tried again at the next check, any
  other 4xx is not.
- Nothing is sent with `--fake-wa`, in dev mode (except `EZYCHAT_USAGE_ENDPOINT` with `--mode dev --fake-wa`, for a
  local portal), while the access gate is closed, or while the switch is off.
- Logs: event name, HTTP status, counts. Never the payload's install id.

## Switch

Setting `usage_stats` (missing = on). `GET /api/settings` → `usageStats`; `PATCH /api/settings` {usageStats} (admins),
audited `usage_stats.update` {before, after}. Turning it on checks at once; turning it off stops the round in flight.

UI: Settings → General, card "Privacy" with "Share anonymous usage stats" (saved at once) and an InfoTip listing what
is sent and never sent; the same switch on the setup wizard's Ready step (ticked by default).

## Mock

One switch in an existing settings page plus one row on the wizard's Ready step, both built from existing patterns
(LAN switch row, InfoTip). The owner approved going ahead without a mock round ("just go", 2026-11-04). The design
lives here rather than in `docs/features/` so the five-folder mock retention is not disturbed.

## Not covered / follow-ups

- Install → website link (the download form's visitor is not tied to the install id).
- Enterprise: nothing extra; the edition string gives `EZC-ENT`. Its release notes must mention the switch.
