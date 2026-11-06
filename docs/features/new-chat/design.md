# New chat (message a number that is not in the inbox yet)

Status: **confirmed 2026-11-06** (with one change: the daily limit is an admin setting; see "Mock and confirmation
record"). Production work on `feat/new-chat-impl`. Created 2026-11-06 (creationOrder 37). Branch `feat/new-chat`, workbook `docs/workbooks/feat__new-chat.md`.

Owner request (Jazz, 2026-11-06, relayed by the main session): a **New chat** button that starts a conversation
with a phone number that is not in the inbox yet. Lite core, so Lite and Enterprise both get it, for both
connection types: a linked phone (Baileys) and the WhatsApp Business API (Enterprise `wa-cloud`; core `fake-api`
in dev).

Owner decisions (2026-11-06):

1. Admins can always start new chats.
2. An admin switch in Settings lets team members (agents) start new chats too. **Off by default**; the admin can
   turn it on and off again. Audited with before/after.
3. Keep it simple: one number at a time. No paste-a-list, no bulk, no CSV.
4. (Confirmation, 2026-11-06) The daily new-number limit for a linked phone is an **admin setting**: Settings →
   General → New chats → "New chats per day, per WhatsApp number", default **20**, the admin may raise or lower it,
   **0 = no limit**, the WhatsApp ban warning beside it, audited before/after. Shared with MCP `send_to_new_number`,
   which keeps its own per-token cap on top.
5. (Confirmation) Counts in memory for v1; Business API new chats only the 5 an hour per user; the default country
   code comes from the sending inbox's own number (+60 fallback); a new chat is assigned to the starter and the AI
   does not answer until it is handed back.
6. (Confirmation) Limited agents (`chat_scope = 'chosen'`, limit-an-agent feature #318) can never start a new chat.

## Mock and baseline

- Mock: [mock/index.html](mock/index.html) (the whole app, run with `run.ts`), README [mock/README.md](mock/README.md).
- Baseline: the latest owner-confirmed mock, **scheduled-tasks** (`docs/features/scheduled-tasks/mock`, revision
  `426c2eb766f24e520fd4f59b66ab837c11296045`, confirmed 2026-11-06), copied from `main` afc97fd without its
  screenshots. It is a clone of google-drive with the confirmed sql-accounting screens merged in, so this mock carries
  Google Drive, SQL Account and Scheduled tasks.
- History: this proposal was first built on google-drive (`442b6317`, plus its own sql-accounting merge, commit
  `9b2a13e`). scheduled-tasks merged and became `latestConfirmed` while this PR was open, so the new-chat deltas were
  moved onto a fresh copy of it (added files copied; `proposal.ts`/`run.ts` merged three ways with google-drive as
  the base; catalog keys added by key). Nothing of the earlier own sql-accounting merge remains.
- `mock/reference.json` records the baseline, the files this proposal adds or changes and the frozen hashes.
  `node docs/features/new-chat/mock/snapshot.mjs --check` passes. The confirmed scheduled-tasks mock already fails its
  own `--check` on 7 files (the index calls it advisory); `inheritedFrozenDrift` lists them, copied unchanged.

Run (from the repository root, after `npm install`):

```bash
npx tsx --conditions=ezychat-source docs/features/new-chat/mock/run.ts --fake-wa
node docs/features/new-chat/mock/new-chat-shots.mjs   # PW_CHROMIUM=<chromium> if Playwright's own is missing
```

Open `http://localhost:7489/`, sign in as `aisyah` (admin) or `daniel` (team member), password `demo-pass-123`.

### Files this proposal adds or changes in the mock

| File                                        | What                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/inbox/NewChatDialog.tsx` (new)         | Header button + dialog: number step, Business API template step, Mock only box      |
| `src/admin/NewChatSection.tsx` (new)        | Settings → General card with the team-members switch                                |
| `src/mock/newChat.ts` (new)                 | Mock state hook, phone normalising and formatting                                   |
| `new-chat.ts` (new, runner)                 | Mock routes standing in for the proposed API; real chat, profile, assignment, audit |
| `new-chat-shots.mjs` (new)                  | The screenshot run (56 shots, page-error and overflow checks)                       |
| `src/inbox/InboxPage.tsx`                   | `<NewChatButton />` in the chat list header                                         |
| `src/admin/SettingsPage.tsx`                | `<NewChatSection />` under the General form                                         |
| `src/admin/audit-actions.ts`                | Labels for `chat.new_number`, `settings.new_chat_staff`; `userId` shown as a name   |
| `src/mock/inboxes.ts`                       | `setChatInbox` (a new chat belongs to the inbox it was started from)                |
| `src/i18n/locales/{en,ms,zh-CN}/inbox.json` | `mockNewChat.*`                                                                     |
| `src/i18n/locales/{en,ms,zh-CN}/admin.json` | `mockNewChat.*`, audit action and field labels                                      |
| `proposal.ts`, `run.ts`                     | Register the routes; temp folder and banner name                                    |

### Screen and state checklist (screenshots in `screenshots/`, `*-desktop-light.png` 1280 px, `*-mobile-light.png` 360 px)

| #   | Screen / state                                                        | Shot                         |
| --- | --------------------------------------------------------------------- | ---------------------------- |
| 1   | Header button, admin                                                  | `01-header-admin`            |
| 2   | Dialog empty (Send from, number, name, ban warning) + dark, ms, zh-CN | `02-dialog-empty`            |
| 3   | Invalid number                                                        | `03-invalid`                 |
| 4   | Number typed ("You will message +60 …"), name, ban warning            | `04-typed-warning`           |
| 5   | Checking WhatsApp…                                                    | `05-checking`                |
| 6   | Chat opened, assigned to the starter, normal composer                 | `06-chat-opened`             |
| 7   | Not on WhatsApp                                                       | `07-not-on-whatsapp`         |
| 8   | Already a chat → Open chat                                            | `08-existing`                |
| 9   | Daily limit reached                                                   | `09-daily-limit`             |
| 10  | WhatsApp disconnected                                                 | `10-offline`                 |
| 11  | Business API inbox chosen (template note instead of the ban warning)  | `11-api-number`              |
| 12  | Template picker with the paid-conversation note                       | `12-api-templates`           |
| 13  | Variables + preview (+ dark, ms, zh-CN)                               | `13-api-variables-preview`   |
| 14  | Template send error (no chat created)                                 | `14-api-send-error`          |
| 15  | Chat after the template: free text locked until the customer replies  | `15-api-chat-after-template` |
| 16  | Settings → General, switch off                                        | `16-settings-off`            |
| 17  | Switch on, unsaved                                                    | `17-settings-on-unsaved`     |
| 18  | Audit log: `chat.new_number`, `settings.new_chat_staff`               | `18-activity`                |
| 19  | Team member, switch on: button shown                                  | `19-header-staff-on`         |
| 20  | Team member's inbox choice (only their inboxes)                       | `20-staff-inbox-choice`      |
| 21  | Team member, switch off: no button                                    | `21-header-staff-off`        |
| 22  | Lite (one inbox: no Send from)                                        | `22-dialog-lite`             |
| 23  | Daily limit field empty → error (confirmation change)                 | `23-settings-limit-invalid`  |
| 24  | Daily limit 0 → "No limit" text, ban warning                          | `24-settings-limit-none`     |
| 25  | Daily limit 10 (unsaved) with the ban warning                         | `25-settings-limit-10`       |

The run ends with `screenshots/new-chat-results.json`: 62 screenshots, 0 page errors, 0 horizontal overflow.

Mock simplifications (not the design): inboxes, the chat→inbox map and the edition live in the browser
(localStorage), so a chat started in one browser shows under the first inbox in another; the server cannot tell
inboxes apart, so "already a chat" matches the number in any inbox; Activity shows the mock's inbox id (`main`,
`support`) where the app shows the inbox name; the template picker's `Template` / `Utility` labels in zh-CN and
`All inboxes` are untranslated inherited business-api mock strings. Fixed demo rules: a number ending in **0** is
not on WhatsApp, `012-555 0142` already has a chat, the dashed **Mock only** box switches WhatsApp offline, daily
limit and template failure.

### Five-folder retention

scheduled-tasks (35) and partner-role (36) merged first; partner-role was built in parallel from google-drive. This
mock takes creationOrder **37**. To keep five mock folders, this PR prunes **group-management** (31; confirmed
revision `26116d59b3b9ca31b202163dc599cb96b1bf6f5e` in the index) and **google-drive** (33; confirmed revision
`442b6317254a1a86b7df66bb86335f2d0047caec` in the index, its screens live on in scheduled-tasks and new-chat), and
archives **claims-template** (30, folder already removed on `main`) in the index. **template-store** (32) is older but
stays: its `publisher/` folder is live tooling that `scripts/export-templates.mjs` and `scripts/template-store.test.mjs`
import. Folders left: template-store (tooling), sql-accounting, scheduled-tasks, partner-role, new-chat.
`latestConfirmed` becomes new-chat; the next clone copies in partner-role's files (its design.md lists them).

## Scope

In:

- A **New chat** button in the chat list header, shown only to people allowed to start new chats.
- A dialog: **phone number** (default Malaysia +60; `012-345 6789`, `+60 12…`, `60 12…`, `0060…` and `+65 …`
  accepted), **Send from** (only with more than one visible inbox), **Name (optional)** saved to the customer
  profile. "You will message +60 12-345 6789" shows the normalised number before anything is sent.
- If the number already has a chat **in that inbox** (alias-aware: phone JID or LID), the dialog offers **Open
  chat** instead of creating anything.
- Linked phone: check on WhatsApp, ban warning, open the chat with the normal composer.
- Business API: approved template first; the chat exists only once the template is sent.
- The new chat is **assigned to the person who started it**.
- Settings → General: **Team members can start new chats** (off by default).
- Audit `chat.new_number` and `settings.new_chat_staff`; logs carry ids only.

Out (v1): several numbers at once, lists, CSV, scheduled sends; starting a **group**; starting a chat from a
customer profile or a contact book; the AI starting new chats (MCP `send_to_new_number` stays the only automated
path, under its own token scope); a per-person on/off (the switch is team-wide).

## Who can start a new chat

| Who                                           | New chat                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| Admin                                         | Always, from every active inbox                                                 |
| Team member (agent), switch **off** (default) | Never; no button; the routes answer 403 `new_chat_not_allowed`                  |
| Team member, switch **on**                    | Only from inboxes they belong to (`inbox_members`); others answer 404           |
| Limited agent (`chat_scope = 'chosen'`)       | **Never**, whatever the switch says (403)                                       |
| Partner role (Enterprise, another session)    | **Never**, whatever the switch says (403)                                       |
| The AI member / AI agents                     | Never (no tool; `send_to_new_number` is MCP-only, token scope `inbox:send_new`) |
| An MCP token                                  | Only through `send_to_new_number`, as today, now through the shared service     |

The rule is an allowlist: `role === 'admin' || (role === 'agent' && chat_scope !== 'chosen' && new_chat_staff)`. Any other role an edition adds
is refused unless it changes this rule on purpose.

## Flow by connection type (decided from capabilities only)

The core never reads `inboxes.type`. It reads `capabilitiesOf(wa)`:

| `capabilities`                                   | Flow                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `replyWindowHours === null` (linked phone, fake) | **Checked**: `checkNumber` → create an empty chat → open it; first message is free text or media      |
| `replyWindowHours !== null` and `templates`      | **Template first**: no number check; send the template; create the chat only on success               |
| `replyWindowHours !== null` and no `templates`   | Not available: the inbox is shown disabled in Send from, the routes answer 409 `new_chat_unsupported` |

### Linked phone (checked)

1. **Check** (`POST /api/inboxes/:id/new-chat/check`, no WhatsApp call, not counted): normalise the number; refuse a
   linked number of any inbox (`ownJids()`, like MCP); look up an existing chat in that inbox through
   `AliasStore.route(chatKey(inboxId, '<digits>@s.whatsapp.net'))` (finds the LID chat when the PN/LID pair is
   known) → `{ next: 'existing', chatJid }`; else `{ next: 'check' }`. WhatsApp disconnected → 503 `wa_disconnected`.
2. **Start** (`POST /api/inboxes/:id/new-chat`): same pre-checks again (never trust step 1), then **count** (limits
   below), then `wa.checkNumber(digits)` → null: 404 `not_on_whatsapp` (still counted). The JID WhatsApp returns is
   looked up again (a message may have arrived meanwhile, `raced` in MCP); else `chats.upsertFromWa({ jid, type: 'dm',
name: null }, inboxId)`. Then the optional name is saved to `customer_profiles` (through `CustomerRepo.save`, so
   linked chats in other inboxes share it), the chat is assigned to the starter (`chats.patch(..., { assignedTo })`,
   the normal "X took this chat" event), audit, and the web opens `/chats/:jid` with the composer focused.
3. The **ban warning** is always in the dialog (warning tone): "Only message people who expect it. WhatsApp can ban a
   number that messages people who did not ask for it. Start a chat only when the person agreed to be contacted."
4. Nothing is sent by New chat itself. The first message goes through the normal composer and send queue (text,
   media, voice note, quick replies all work). An empty chat stays if nobody writes (like Group info → Message).

### Business API (template first)

1. **Check** answers `{ next: 'template' }` (no `checkNumber`: the Cloud API has no lookup; an unknown number fails
   on send).
2. The dialog's second step is the existing template picker (the reply-window one): approved templates of the
   inbox (`GET /api/inboxes/:id/templates`), variables (`{{1}}` prefilled with the first name typed in Name), a live
   preview, templates with a media header or buttons listed but not sendable (as today). A note says: "Each template
   starts a paid conversation with Meta. Marketing templates cost more than utility ones."
3. **Start** with `template: { name, language, params }`: validated like `POST /chats/:jid/template`
   (`template_not_found`, `template_not_sendable`, `template_params`); then `wa.sendTemplate(waJid, …)` is called
   **directly, not queued** (no chat exists yet to queue in). Only when WhatsApp accepts it: the chat is created,
   the outbound message is stored with its WhatsApp id (the same stored form as `sendTemplate` today: the filled body
   with the template's name and language), name, assignment and audit as above. Any failure → 502 `template_failed`
   (or 503 offline) and **nothing is created**.
4. The chat has no `last_inbound_at`, so the existing window logic keeps free text locked ("The 24-hour reply window
   has closed … Send a template") until the customer replies.

## Limits (counted before WhatsApp is asked)

| Limit                                          | Value                                                    | Scope / note                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| New numbers per **linked-phone inbox** per day | Setting `new_chat_daily_limit`, default 20; 0 = no limit | Shared by the app and MCP `send_to_new_number` (one budget per WhatsApp number). 429 `new_chat_daily_limit`. Not for Business API |
| New numbers per **user** per hour              | 5                                                        | App only, every inbox type. 429 `new_chat_hourly_limit` with `Retry-After`                                                        |
| MCP per token per day                          | 20                                                       | Unchanged (`SEND_LIMITS.newNumbersPerDay`), on top of the inbox budget                                                            |
| Check route                                    | 60/min per user                                          | Plain rate limit (it never asks WhatsApp)                                                                                         |

Counted on **Start**, before `checkNumber` (every check asks WhatsApp about a stranger's number); a "not on WhatsApp"
answer still counts; an existing chat, a format error or an own number does not. In-memory `WindowLimiter`s, like
MCP today (a restart resets them; owner-confirmed for v1). The limit is read on every Start, so a change applies at
once. The dialog shows "3 of 20 new chats used today on Kopi Apong" for linked-phone inboxes, or "3 new chats started
today on Kopi Apong (no daily limit)" when the setting is 0. A Business API inbox has no daily count (Meta limits and
charges business-started conversations); only the 5 an hour per user applies.

## Shared service (reuse MCP `send_to_new_number`)

Extract from `packages/server/src/mcp/send.ts` a core service `packages/server/src/chats/new-chat.ts`
(`ctx.services.newChat`, created in `initMessaging` after the message service):

```ts
interface NewChatService {
  /** Format, own number, existing chat (alias-aware), capability, connection; never asks WhatsApp. */
  precheck(actor: NewChatActor, inboxId: number, phone: string): NewChatPrecheck;
  /** Counted, then checkNumber + empty chat (checked) or template send + chat (template first). */
  start(
    actor: NewChatActor,
    inboxId: number,
    input: NewChatStart,
  ): Promise<{ chatJid: string; created: boolean }>;
}
type NewChatActor =
  { via: 'app'; user: UserRow; ip: string | null } | { via: 'mcp'; user: UserRow; tokenId: number };
```

- `normalizePhone(raw, defaultCountry)` moves to `packages/shared` (the web's live preview and the server use the
  same function; table-driven tests).
- MCP `sendToNewNumber` keeps its contract (scope check, `requestId` idempotency, token limits, `NEW_NUMBER_WARNING`,
  `template_required` for a window inbox) and calls `newChat.start({ via: 'mcp', … })` for the check + create, then
  its own `send()`. Its tests stay green unchanged except the audit action (below).
- Group Info → Message (`groups/service.ts startChat`) stays as it is: it opens a chat with a known group member,
  needs no number check and is not limited; it only reuses the service's "existing chat" lookup.

## Settings

- **`new_chat_staff`** (`settings` table, `'1'`/`'0'`; missing = off, so existing installs need no migration and
  stay admin-only).
- **`new_chat_daily_limit`** (integer 0–1000 as text; missing = 20; 0 = no limit).
- `GET /api/settings` gains `newChatStaff: boolean` (zod default `false`) and `newChatDailyLimit: number` (zod
  default 20); `PATCH /api/settings` `{ newChatStaff?, newChatDailyLimit? }` (admins); audits
  **`settings.new_chat_staff`** and **`settings.new_chat_daily_limit`** `{ before, after }`, each only when it changes.
- Everyone learns whether they may start a chat from `GET /api/me` → `canStartNewChat: boolean` (computed on the
  server from role, chat scope and setting; zod default `false`), refreshed on the existing `settings:changed`
  socket event, so the button appears or disappears without a reload.
- Web: Settings → General card **New chats**: "Start a WhatsApp chat with a number that is not in the inbox yet.
  Admins can always do this." Switch **Team members can start new chats** with its on/off line; field **New chats per
  day, per WhatsApp number** (`a day`, hint, "No limit" text at 0, error outside 0–1000) with the ban warning banner
  "A high limit can get your number banned"; one Save.

## API contract (zod in `packages/shared/src/new-chat.ts`)

```ts
export const NewChatCheckBody = z.object({ phone: z.string().trim().min(1).max(40) });
export const NewChatCheckResponse = z.discriminatedUnion('next', [
  z.object({ next: z.literal('existing'), phone: z.string(), chatJid: z.string() }),
  z.object({
    next: z.literal('check'),
    phone: z.string(),
    usedToday: z.number().int(),
    dailyLimit: z.number().int(),
  }),
  z.object({ next: z.literal('template'), phone: z.string() }),
]);
export const NewChatBody = z.object({
  phone: z.string().trim().min(1).max(40),
  name: z.string().trim().max(100).optional(),
  /** Idempotency: a retry with the same id answers the first result and counts nothing. */
  clientRequestId: z.string().uuid(),
  template: SendTemplateBody.optional(), // { name, language, params }
});
export const NewChatResponse = z.object({ chatJid: z.string(), created: z.boolean() });
```

| Route                                  | Who                         | Answers                                                                                                                                                                                                                                  |
| -------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/inboxes/:id/new-chat/check` | allowed users, inbox access | 200 above · 400 `invalid_number` / `own_number` · 403 `new_chat_not_allowed` · 404 inbox · 409 `inbox_removed` / `new_chat_unsupported` · 503 `wa_disconnected`                                                                          |
| `POST /api/inboxes/:id/new-chat`       | same                        | 201 created / 200 existing · above + 404 `not_on_whatsapp` · 429 `new_chat_daily_limit` / `new_chat_hourly_limit` · 400 `template_required` / `template_not_found` / `template_not_sendable` / `template_params` · 502 `template_failed` |

Both are mutating `/api` routes: session + Host + Origin checks as usual; `web-client-contract.test.ts` covers the
web calls. Server messages stay English; the web maps the codes to `inbox:newChat.problems.*`.

## Inbox access

`canOpen(scopeFor(ctx, user), inboxId)` or 404 (never "exists but not yours"); a removed inbox 409 `inbox_removed`.
Agents see only their inboxes in Send from. Lite (one inbox) shows no Send from. The new chat gets the inbox's
chat key (`<waJid>#<id>` for inbox 2+), so it lands in that inbox's socket room and only people with access see it.
An edition limit never widens access.

## Audit and logs

- `chat.new_number` `{ inboxId, chatJid, userId, via: 'app' | 'mcp', tokenId? }`, never the number's name or the
  message/template text. MCP writes this action too (replacing `mcp.new_chat`; old rows keep their label).
- The optional name goes through the profile save, audited as today (`customer.profile_update`, field names only).
- `settings.new_chat_staff` and `settings.new_chat_daily_limit` `{ before, after }`.
- Logs (`mod: 'new-chat'`): inbox id, user id, via, outcome (`created`, `existing`, `not_on_whatsapp`, `limit`,
  `template_failed`), ms. Never the phone number, name or template values.

## Security invariant (proposed text for AGENTS.md)

> - New chat (`chats/new-chat.ts`, `/api/inboxes/:id/new-chat[/check]`): only admins, or agents while
>   `new_chat_staff` is on, and only from inboxes they may open (else 404); limited agents (`chat_scope = 'chosen'`) and every
>   other role (partner, AI) are refused. One number per request; counted before `checkNumber` (the admin's daily limit per linked
>   phone, default 20, 0 = none, shared with MCP `send_to_new_number`; 5 an hour per user); a template-first inbox (`replyWindowHours`) creates the chat only after
>   WhatsApp accepted the template. Audit `chat.new_number` and logs carry ids only, never the number's name or
>   message text. The core decides the flow from `WaCapabilities`, never from an inbox type name.

## Migration and upgrade

None. `new_chat_staff` missing = off, `new_chat_daily_limit` missing = 20; counts are in memory (confirmed for v1).
`upgrade-from-oldest.test.ts` is unaffected.

## Test plan

Unit (server, Vitest, fake WA and `fake-api` inbox):

- `normalizePhone` table: local `01x`, `+60`, `60`, `0060`, spaces/dashes/brackets, `+65`, too short/long, letters.
- Permissions: admin yes; agent off → 403; agent on → yes, only member inboxes (404 otherwise); limited agent
  (`chat_scope = 'chosen'`) → 403 with the switch on; a non-agent role
  (partner fixture) → 403 with the switch on; AI user → 403.
- Existing chat: by phone JID, by LID through `jid_aliases`, inbox 2 key; another inbox's chat does not count.
- Own number (any inbox, also a removed one) → 400; disconnected → 503; removed inbox → 409.
- Counted before the check; not-on-WhatsApp counted; existing/invalid not counted; daily limit shared with MCP
  (19 app + 1 MCP → the 21st refused on either path); a changed limit applies at once; 0 = no limit; Business API
  never counted daily; hourly per user; `clientRequestId` retry counts once.
- Raced chat (inbound arrives during `checkNumber`) → `created: false`, no duplicate.
- Template first: no `checkNumber` call; validation errors; send failure → no chat row, no message, no audit; success
  → one chat, one outbound message, `last_inbound_at` null, free text 409 `window_closed`.
- Assignment event, profile name saved, audit meta exact (no text), log line fields.
- Settings: PATCH audits before/after only on change (both keys; limit range 0–1000); `canStartNewChat` in `/api/me`; socket refresh.
- MCP `send_to_new_number` regression suite unchanged (except `chat.new_number` audit).

Contract: `web-client-contract.test.ts` (literal paths). Web: dialog states (Testing Library), catalog tests for
en/ms/zh-CN. E2E (fake WA): admin starts a chat and sends; agent with the switch off sees no button, on sees it;
`multi-inbox` project: agent's Send from lists only their inboxes; `fake-api` inbox: template flow, send error,
window-closed panel after. Dev Build: linked phone `checkNumber` against **real WhatsApp** on a test number (never a
real customer); Business API untested without an Enterprise `wa-cloud` number (say so).

Screen review per AGENTS.md before done (1280/360, light/dark, all states above).

## Owner answers (2026-11-06)

1. Daily budget per WhatsApp number shared by the app and MCP: **yes**, and it is an **admin setting** (default 20,
   0 = no limit); MCP keeps its own 20 per token on top.
2. Counts **in memory** for v1.
3. Business API new chats: **only 5 an hour per user** (no daily count).
4. Default country: **the sending inbox's own country code**, +60 fallback.
5. Assigned to the starter; the AI **does not answer** until it is handed back.

## As built (feat/new-chat-impl)

- Status and settings have their own routes instead of `/api/settings` + `/api/me`: `GET /api/new-chat` (everyone:
  `allowed`, `staffEnabled`, `dailyLimit`, `perUserPerHour`, and the user's inboxes with `mode`, `usedToday`,
  `countryCode`) and `PUT /api/new-chat/settings` {staffEnabled?, dailyLimit?} (admins). The Settings card saves both
  in one request; the button follows `allowed` (refetched on focus).
- Template-first sends go through `MessageService.sendFirstTemplate` (validated like `sendTemplate`, sent directly,
  stored as `sent`); 502 `template_failed` / 503 `wa_disconnected` create nothing.
- MCP `send_to_new_number` calls `NewChatService.openChecked` and audits `chat.new_number` with `via: 'mcp'` and
  `tokenId` (replacing `mcp.new_chat`).
- The header button is icon-only (aria-label and tooltip "New chat"): beside Ask Ezy, Admin and the account menu, a
  text label pushed the header past the 360 px list. Screens: `docs/screenshots/new-chat/`.

## Mock and confirmation record

| Date       | Event                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-06 | Mock and design created (this PR). Waiting for the owner's confirmation; nothing is approved.                                                                                                                                                                                                                                                                                                                                                             |
| 2026-11-06 | Rebased onto scheduled-tasks (latestConfirmed) after it merged; creationOrder 36.                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-11-06 | **Confirmed** by the owner (Jazz), relayed by the main session (session_01J4pmGkCf1Mvdepudm8WQAd): "The owner CONFIRMED the New chat mock on 2026-11-06, with one change": the daily new-number limit for personal WhatsApp is an admin setting (default 20, 0 = no limit, ban warning beside it, audited before/after, shared with MCP); suggested answers 1–5 stand; limited agents never start a new chat. Mock updated (Settings field, shots 23–25). |
