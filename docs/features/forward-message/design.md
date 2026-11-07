# Forward a message

Status: **confirmed 2026-11-07** with every proposed answer (see "Owner decisions"). Created 2026-11-07
(creationOrder 38). Branch `feat/forward-message`, workbook
[docs/workbooks/feat\_\_forward-message.md](../../workbooks/feat__forward-message.md). Production work on
`feat/forward-message-impl`.

Owner request (Jazz, 2026-11-07, relayed by the main session): forward a message to another chat, in the **Lite
core** (Lite and Enterprise both get it). **Keep it simple.** Forward from a message's menu, pick one or a few
existing chats or groups the user may open (cap 5, against bulk sending and ban risk), never a new number (that is
New chat). Send it as WhatsApp's "Forwarded" through the normal send queue as the user, re-using the stored file.
Respect WhatsApp Safety, the Business API reply window and inbox access. Show "Forwarded" in our chat view, for
our copies and for forwarded messages customers send us.

Owner's real case (added 2026-11-07, relayed by the main session): **forward a 70 MB video from a chat on one
WhatsApp number to a chat on another number.** Today that is impossible: there is no forward, and the composer's upload
cap is 64 MB (`MEDIA_UPLOAD_LIMIT_BYTES` in `packages/shared/src/api.ts`, `fastifyMultipart` `fileSize` in
`packages/server/src/app.ts`), so re-uploading fails too. Hence: forward is **server-side** and re-uses the stored
file (never the 64 MB upload; only WhatsApp's limits apply), **cross-inbox forwarding is a must-have case**, a video
above WhatsApp's video limit can go **as a file**, and large copies show **sending** and **failed + Retry** states
(see [Large files](#large-files)).

## Mock and baseline

- Mock: [mock/index.html](mock/index.html) (the whole app, run with `run.ts`), README [mock/README.md](mock/README.md),
  screenshots in [mock/screenshots](mock/screenshots) (`forward-shots.mjs`).
- Baseline: `latestConfirmed` **new-chat**, `docs/features/new-chat/mock` at
  **e7dc8cfacdb7a4066c02016e96fc645187668270** (confirmed 2026-11-06; byte-identical on `main` 2bb1c87), copied
  without its screenshots. It carries scheduled-tasks, google-drive and the sql-accounting screens.
- As the index asks, the confirmed **partner-role** (limited chat access) files were copied in: partner-role at
  **846a09cc9561a7a65e984572591e3ee458f47d2d** (confirmed 2026-11-06) was built from google-drive
  `442b6317254a1a86b7df66bb86335f2d0047caec`, so its changes were merged three ways with that revision as the base:
  4 added files copied (`member-chats.ts`, `member-chats-shots.mjs`, `src/mock/memberChats.ts`,
  `src/admin/MemberChatsField.tsx`); `MembersPage.tsx`, `ChatList.tsx`, `Conversation.tsx`, `GroupPanel.tsx` merged
  cleanly; `proposal.ts` and `seed.ts` kept both sides; `run.ts` and `README.md` kept new-chat's side; the 3
  `admin.json` catalogs merged key by key (only partner-role's own `limitedChats.*` keys added).
- Inherited gaps (unchanged): the mock's web source predates message edit/delete (the app's ⋮ `MessageMoreMenu`),
  WhatsApp Safety on messages, group agents and the claims template. The mock therefore adds a minimal ⋮ menu with
  Forward only, and a **Mock only** switch for "Safety locked".

Run (from the repository root, after `npm install`):

```bash
npx tsx --conditions=ezychat-source docs/features/forward-message/mock/run.ts --fake-wa
node docs/features/forward-message/mock/forward-shots.mjs   # PW_CHROMIUM=<chromium> if Playwright's own is missing
```

Open `http://localhost:7489/`, sign in as `aisyah` (admin), `daniel` (agent) or `ravi` (agent limited to 3 chosen
chats), password `demo-pass-123`. Open **Priya Nair** (a photo), hover the photo → **⋮ → Forward**.

### Files this proposal adds or changes in the mock

| File                                        | What                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/inbox/ForwardDialog.tsx` (new)         | The dialog: preview, chosen chats, search, list, refusals, Mock only box               |
| `src/inbox/MessageMoreMenu.tsx` (new)       | ⋮ menu with Forward (stand-in for the app's `MessageMoreMenu`) and the Forwarded label |
| `src/mock/forward.ts` (new)                 | Mock state hook (scenario, forwarded marks, Safety locks)                              |
| `forward.ts` (new, runner)                  | Stand-in for `POST /api/messages/:id/forward`; real send queue, audit; seed            |
| `forward-shots.mjs` (new)                   | The screenshot run (page-error and overflow checks)                                    |
| `fixtures/event-walkthrough.mp4` (new)      | A 9 KB video the mock presents as 70 MB (sizes and limits are mock state)              |
| `src/inbox/MessageBubble.tsx`               | ⋮ menu beside Reply, Forwarded label at the top of the bubble, the dialog              |
| `src/inbox/ReactionPicker.tsx`              | Touch press-and-hold bar: Forward under Reply                                          |
| `src/admin/audit-actions.ts`                | `message.forwarded` label; `messageId`, `chatJids` fields; `messageIds` hidden         |
| `src/i18n/locales/{en,ms,zh-CN}/inbox.json` | `mockForward.*`                                                                        |
| `src/i18n/locales/{en,ms,zh-CN}/admin.json` | Audit action and field labels                                                          |
| `proposal.ts`, `seed.ts`, `run.ts`          | Register the routes and the seed; temp folder and banner name                          |

### Screen and state checklist (`mock/screenshots/<shot>-<desktop|mobile>-light.png`, 1280 px / 360 px)

| #   | Screen / state                                                                                                              | Shot                                |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | Message menu: ⋮ → Forward (desktop); press-and-hold bar → Forward (touch)                                                   | `01-menu-forward`                   |
| 2   | Dialog: what is forwarded, 0 of 5 chosen, search, chats and groups of the user's inboxes                                    | `02-dialog-list`                    |
| 3   | Search ("kopi")                                                                                                             | `03-search`                         |
| 4   | Two chosen in two inboxes: chips, "Each chat gets it from its own number" (+ dark, ms, zh-CN)                               | `04-picked-two-inboxes`             |
| 5   | 5 of 5: note, other rows disabled                                                                                           | `05-five-of-five`                   |
| 6   | Business API chat with the 24-hour window closed: row disabled with the reason                                              | `06-window-closed-row`              |
| 7   | Safety locked file: danger banner, no list, Forward disabled                                                                | `07-safety-locked`                  |
| 8   | ⋮ menu: Forward disabled "Locked by WhatsApp Safety" (desktop)                                                              | `08-menu-locked`                    |
| 9   | WhatsApp offline: danger banner, Forward disabled                                                                           | `09-offline`                        |
| 10  | Sent: toast "Forwarded to 2 chats"                                                                                          | `10-sent-toast`                     |
| 11  | The copy in the other chat with "Forwarded"                                                                                 | `11-copy-forwarded-label`           |
| 12  | A customer's forwarded message: "Forwarded"                                                                                 | `12-inbound-forwarded`              |
| 13  | "Forwarded many times" (+ dark, ms, zh-CN)                                                                                  | `13-inbound-forwarded-many`         |
| 14  | Forwarding a many-times message: one chat at a time (1 of 1)                                                                | `14-many-times-one-chat`            |
| 15  | One chat: toast "Forwarded to Kopi Apong Staff" with **Open chat** (a PDF)                                                  | `15-sent-one-open-chat`             |
| 16  | Admin → Activity: "Message forwarded", message and chats (ids)                                                              | `16-activity`                       |
| 17  | Limited agent (Ravi): only the 3 chosen chats are listed                                                                    | `17-limited-agent-list`             |
| 18  | Lite: one inbox, no inbox chips                                                                                             | `18-lite-dialog`                    |
| 19  | The owner's case: a 70 MB video on Catering (linked phone): size, large-file note, Send as Video / File                     | `19-video-70mb-dialog`              |
| 20  | 70 MB video to a Business API chat (Online orders) + a group on Kopi Apong: Video disabled, goes as a file, own-number note | `20-video-70mb-cross-inbox-as-file` |
| 21  | 120 MB video: the Business API chat is greyed out "files up to 100 MB"                                                      | `21-video-120mb-too-large-row`      |
| 22  | Sending a large copy: "Sending 70 MB to WhatsApp…" in the other chat                                                        | `22-sending-large`                  |
| 23  | Upload failed: the copy shows Failed with Retry                                                                             | `23-upload-failed-retry`            |

Mock simplifications (not the design): inboxes, chat→inbox and reply windows live in the browser, so the browser
tells the stand-in route which chosen chats have a closed window (the app reads `chats.last_inbound_at` and the
inbox's capabilities on the server); the "Forwarded" marks and Safety locks are kept in the runner's memory, not on
the message; "Safety locked" and "WhatsApp offline" are dashed **Mock only** buttons; Activity shows raw chat ids.
Seed: Priya's photo, Farah's catering menu PDF and "70 MB" event hall video (a small MP4; the runner keeps the pretend size, forces the type to document for "as a file", and the dashed buttons add Slow upload, Upload fails and Video 120 MB), Jason's promo (arrived "Forwarded"), Nurul's rumour ("Forwarded
many times").

### Five-folder retention

This mock takes creationOrder **38**. Folders before it: template-store (32, kept as live tooling:
`scripts/template-store.test.mjs` and `scripts/export-templates.mjs` import its `publisher/`), sql-accounting (34),
scheduled-tasks (35), partner-role (36), new-chat (37). This PR removes **sql-accounting** (34; confirmed revision
`e33aabbd3db038dabb0eb8375c96363f3a157d3b` recorded in the index; its screens live on in scheduled-tasks, new-chat
and this mock; nothing imports the folder, the code only names `design.md` in comments, which stay valid in git
history at that revision). Folders left: template-store (tooling), scheduled-tasks, partner-role, new-chat,
forward-message.

## Scope

In (v1):

- **Forward** on a message's ⋮ menu (desktop: hover/focus, beside Reply; touch: the press-and-hold bar under Reply).
- A dialog: what is forwarded (type icon + text, caption or file name), a search over the chats and groups the user
  may open, a checklist, the chosen chats as removable chips, "n of 5 chosen", **Forward to n chats**.
- One message to **1–5 existing chats or groups**. Never a number that has no chat (that is New chat).
- Each copy is sent as WhatsApp "Forwarded" (linked phone) through the **normal send queue**, as the signed-in user,
  from the WhatsApp number of the chat it goes to; files are re-sent from the stored copy.
- **Forwarded** / **Forwarded many times** at the top of the bubble for our copies and for customers' forwarded
  messages (live and history).
- Audit `message.forwarded`, rate limit 30 forwards a minute per user.

Out (v1): forwarding several messages at once (multi-select); forwarding to a new number, a list, a broadcast or a
contact card; adding a comment to a forward (send it as a normal message after); forwarding from MCP / Ask Ezy / the
AI agent; templates in the dialog (a closed window is fixed from that chat); location, contact card, poll and other
types the app does not store today (they never reach the inbox, so there is nothing to forward); "starred"/"forward
history" views.

## Who can forward what

The rule: **whoever may reply in the source chat may forward from it, into chats they may open.** No new setting.

| Who                                     | Forward                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| Admin                                   | From any chat, to any chat of an active inbox                                           |
| Agent                                   | From chats of their inboxes (`inbox_members`) to chats of their inboxes; others are 404 |
| Limited agent (`chat_scope = 'chosen'`) | Only between their chosen chats (`canOpenChat` on the source and on every target)       |
| AI member / AI agents                   | Never (no tool, no route for the AI user)                                               |
| MCP token / Ask Ezy                     | Never in v1 (no tool)                                                                   |
| Removed inbox                           | Its chats stay read only: Forward from it works (admins), forward into it answers 409   |

**Across inboxes (must-have; Enterprise, several WhatsApp numbers):** number A → a chat on number B is allowed when
the user can open both chats (`canOpenChat` on the source and on each target). The copy goes from the **target
chat's** number (a chat key belongs to one inbox; `connections.adapter(inboxOfKey(target))`), so the file is
uploaded again by number B: nothing is shared between the two WhatsApp sessions. Each chosen chat follows its own
number's rules (reply window, connection state, media limits, `forwardedMark`). The dialog shows each chat's inbox
chip and says "Each chat gets the message from its own WhatsApp number" when a chosen chat is on another number
(mock shots 04, 20). Lite has one inbox: no chips, no note.

## Large files

What limits apply (sources: Meta's Cloud API media reference, developers.facebook.com/docs/whatsapp/cloud-api/reference/media,
checked 2026-11-07; Baileys 7.0.0-rc14 source in `node_modules/baileys/lib/Utils/messages*.js`):

| Connection               | Video sent as video                                      | Document (any file, incl. a video)    | Image      | Audio  |
| ------------------------ | -------------------------------------------------------- | ------------------------------------- | ---------- | ------ |
| Business API (Cloud API) | **16 MB** (H.264 + AAC only)                             | **100 MB**                            | 5 MB       | 16 MB  |
| Linked phone (Baileys)   | **not published**; proposed setting 64 MB until measured | **2 GB** (WhatsApp's announced limit) | (as video) | 16 MB¹ |

- Baileys itself has **no size cap**: it encrypts the file to a temp file and uploads it (`encryptedStream`,
  `uploadWithNodeHttp`); its upload has no timeout unless `mediaUploadTimeoutMs` is set (we leave it unset or set
  it high, e.g. 10 minutes, so a 70 MB upload on a slow line is not cut off).
- WhatsApp's own apps send large videos "as a document" to keep quality; the linked-phone video limit is not in
  WhatsApp's documentation (third-party sources give 16 MB to 100 MB depending on app and connection). **The Dev Build
  check measures it** against real WhatsApp (64 MB, 70 MB, 100 MB as a video) and the measured value goes into
  `LINKED_PHONE_CAPABILITIES.mediaLimits`. ¹ audio limit for the linked phone: same check.
- Our own send path keeps one rule: **every check before anything is sent**, per chosen chat, from that chat's
  inbox's `WaCapabilities.mediaLimits` (new optional capability `{ video, image, audio, document }` in bytes; absent
  = no limit known, WhatsApp's answer decides).

Rules:

1. A video bigger than a chosen chat's **video** limit can still go **as a file** (`sendAs: 'file'` → Baileys
   `document` with the original file name and `video/mp4`; Cloud API `document`). The dialog shows **Send as: Video |
   File** for videos; when any chosen chat cannot take it as a video, Video is disabled and the note says "This video
   (70 MB) is too big to send as a video to the chats you chose (up to 16 MB). It goes as a file, in full quality."
   One choice for the whole forward (simple), not per chat.
2. A file bigger than a chosen chat's **document** limit (e.g. 120 MB to a Business API number, 100 MB) cannot be
   picked: the row is greyed out "Too large for this number: files up to 100 MB". The server answers 413
   `too_large_for_whatsapp` if it gets one anyway; 413 `too_large_as_video` for `sendAs: 'original'` above the video
   limit.
3. The file is read **from disk by path**, never into memory per copy: `WaSendFile` gets `path?: string` and the
   Baileys adapter passes `{ url: path }` (streamed). With Baileys' `mediaCache` set on the socket (cache key =
   media type + path, `Utils/messages.js` `prepareWAMessageMedia`), **five copies on the same number upload the 70 MB
   once**; another number uploads it again (separate session). The fake adapter reads the path.
4. Each copy has its own `media/` entry (hard link where the file system allows, else a copy), so deleting or
   expiring one message never removes another's file.
5. **Sending state:** a queued copy is `pending` with the clock tick; for a file of 20 MB or more the bubble adds
   "Sending 70 MB to WhatsApp…" with a spinner (Baileys reports no upload progress, so no percentage). The dialog
   warns before sending: "Large file (70 MB). Each copy is uploaded to WhatsApp again, so it can take a few minutes."
6. **Failure:** an upload error or WhatsApp's refusal fails that copy (`failed`, error "Upload to WhatsApp failed" /
   "Too large for WhatsApp") with the existing **Retry** (re-sends from the stored file, same `resendId` rule). The
   send queue's 10-minute expiry counts while a job waits, not while it uploads. Other copies are not affected.
7. Large uploads do not block other chats: the queue is per chat; a 70 MB copy delays only later messages in that
   one chat (FIFO), as with any media today.

Raising the general upload limit (composer, `POST /chats/:jid/media`) is **separate from forwarding** and an owner
decision (open question 6): proposed **100 MB** for every type, checked again per inbox against `mediaLimits` (a
Business API video above 16 MB is offered as a file), with the browser warning above 25 MB on a phone connection. The
multipart limit and `MEDIA_UPLOAD_LIMIT_BYTES` change together; the media route already streams.

## Which messages can be forwarded

| Message                                                                                    | Forward | Sent as                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Text (inbound or outbound)                                                                 | yes     | Text; group tags (`@123…`) go as plain text, mentions are not carried                                                       |
| Photo, video, document/PDF, sticker                                                        | yes     | The stored file re-sent (`sendMedia`), caption kept, file name kept                                                         |
| Voice note / audio                                                                         | yes     | Voice note stays a voice note (`voiceNote`, same length/waveform rules), audio as audio                                     |
| A sent template (Business API)                                                             | yes     | Its filled text as free text (window rules of the target apply)                                                             |
| History media still `pending`                                                              | yes     | Downloaded first (`ensureMedia`); unavailable → 502 `media_unavailable`, nothing sent                                       |
| Safety **High** (locked, released or deleted), or a flagged file whose AI check is running | **no**  | ⋮ item disabled "Locked by WhatsApp Safety"; route 409 `safety_locked` (fail closed, admins too, as MCP `get_message_file`) |
| Deleted for everyone / hidden for the team                                                 | no      | No ⋮ item; 409 `message_deleted`                                                                                            |
| Not sent yet (`local-…`, pending or failed)                                                | no      | No ⋮ item (like Reply); 409 `message_not_sent`                                                                              |
| System lines, chat events                                                                  | no      | No menu                                                                                                                     |
| Location, contact card, poll, …                                                            | —       | Not stored by the app today (Baileys mapping drops them), so never shown                                                    |

Quotes, reactions, edits history and the original sender's name are **not** carried (WhatsApp does not either).

## WhatsApp's "Forwarded" mark

**Sending (Baileys).** `WaSendOptions` gets `forwarded?: { score: number }`. The Baileys adapter adds
`contextInfo: { isForwarded: true, forwardingScore: score }` to the content it already builds in `sendText` /
`sendMedia` (text, image, video, audio, document and sticker content all accept `contextInfo`). We do **not** use
Baileys' `{ forward: WAMessage }`: it needs the original raw message with its media keys, which the adapter keeps
only in a small live cache, history media URLs expire, and it cannot cross inboxes. Re-sending the stored bytes
works after a restart, for history media and from another number; it costs one upload per copy.

`score` = the source's score + 1 (a message that was not forwarded gives 1). WhatsApp shows **Forwarded many times**
from score 5 (`FORWARD_MANY_TIMES_SCORE`) and lets such a message go to **one chat at a time**; we follow both
(400 `forward_many_times` above one chat). Both values are to be checked against real WhatsApp in the Dev Build.

**Receiving (Baileys).** `mapWAMessage` reads `contextInfo.isForwarded` / `forwardingScore` from the content carrier
it already reads (`extendedTextMessage`, image, video, audio, document, sticker; a plain `conversation` text has no
context and is never forwarded) into `WaIncomingMessage.forwardingScore?: number` (absent = not forwarded). Live and
history both.

**Business API (Enterprise `wa-cloud`) and other adapters.** New optional capability
`WaCapabilities.forwardedMark?: boolean` (linked phone and the fake: true; absent = false). Without it the copy goes
as a normal message (the Cloud API has no forwarded flag); our own bubble still shows "Forwarded" because the score
is stored. The core decides only from the capability, never from an inbox type.

## Data (migration 038)

```sql
-- 038_message_forwarding.sql
ALTER TABLE messages ADD COLUMN forwarding_score INTEGER;  -- NULL = not forwarded; inbound and outbound
ALTER TABLE messages ADD COLUMN media_size INTEGER;        -- bytes of the stored file; NULL = not known yet
```

`media_size` is written when a file is stored (upload, download, forward) and filled lazily from `stat` when a
message without it is presented with media `ok`; it gives `Message.mediaSize` for the dialog's size line and limits.

No backfill (old messages stay unmarked; history imported later carries the mark). `upgrade-from-oldest` needs no
seed change (nullable column, no data moved). The send queue rebuilds jobs from rows (`jobFromRow`), so a pending
forwarded copy restored after a restart keeps its score.

## Contract (`packages/shared`)

```ts
export const FORWARD_MAX_CHATS = 5;
export const FORWARD_MANY_TIMES_SCORE = 5;
export const FORWARD_PER_MINUTE = 30;

/** POST /api/messages/:id/forward */
export const ForwardMessageBody = z.object({
  to: z.array(z.string().min(1).max(256)).min(1).max(FORWARD_MAX_CHATS),
  /** One per dialog opening: a retry answers the same messages and sends nothing again. */
  clientRequestId: z.string().min(1).max(64),
  /** Videos: 'file' sends it as a document (above a chat's video limit, or by choice). */
  sendAs: z.enum(['original', 'file']).default('original'),
});
export const ForwardMessageResponse = z.object({ messages: z.array(MessageSchema) });

// MessageSchema: `forwarded` (absent/null = not forwarded). The score itself stays on the server.
forwarded: z.object({ manyTimes: z.boolean() }).nullable().optional(),
mediaSize: z.number().int().nonnegative().nullable().optional(),

// Inbox (what GET /api/inboxes already returns per inbox): WhatsApp's per-message limits, bytes.
mediaLimits: z.object({ video: z.number(), image: z.number(), audio: z.number(), document: z.number() })
  .partial().nullable().optional(),
```

The dialog's list uses the existing `GET /api/chats?q=` (already filtered on the server by inbox access and chosen
chats) and the chats' `lastInboundAt` + the inbox's `replyWindowHours` (already sent for the reply-window note) to
grey out closed windows. No other new route.

## Server

`MessageService.forward(id, body, user)` (`messages/forward.ts`, called by `routes/messages.ts`):

1. `requireMessageAccess(user, id)` → 404 outside the user's inboxes / chosen chats. The AI user is refused (403).
2. Source checks (above table): system, `local-`, deleted, hidden → 409; Safety `levelOf(id) === 'high'` or
   `!cacheable(id)` → 409 `safety_locked`.
3. Targets: de-duplicated; every one `canOpenChat(user, jid)` else **404** (never a hint which); a chat key that
   exists (no new chats: unknown → 404); `refuseSend` (removed inbox 409 `inbox_removed`, unconnected 409);
   `chatNumberMoved` → 409; `replyWindowOpen` → 409 `window_closed`; inbox WhatsApp not open → 503
   `wa_disconnected` (refused, not queued: a forward to several chats should not sit for 10 minutes and expire);
   score above `FORWARD_MANY_TIMES_SCORE` with more than one chat → 400 `forward_many_times`. **All targets are
   checked before anything is sent**: one bad chat sends nothing.
4. Rate limit: 30 a minute per user, each chosen chat counts one (429 `rate_limited`), counted after the checks.
5. Media: `ensureMedia(id)` (pending history media downloaded through the download limiter); `null`/`unavailable`
   → 502 `media_unavailable`. Size against each chosen chat's `mediaLimits` (Large files rules 1–2: 413
   `too_large_as_video` / `too_large_for_whatsapp`). Each copy gets its own file under `media/` (hard link, else copy), so deleting one
   message never removes another's file.
6. For each target, the same outgoing path as the composer (`insertOutgoing`): `claimOnReply` (an unassigned chat
   becomes the forwarder's; a teammate's forward into an AI-owned chat takes it over, as a reply does), row with
   `sent_by_user_id`, `forwarding_score`, `client_id = <clientRequestId>:<n>`, `wa_remote_jid` from `replyTarget`,
   then the inbox's **send queue** (FIFO per chat, ≥ 1 s apart, `composing` presence, `wa_unavailable` keeps it
   pending). `sendJob` passes `forwarded: { score }` when the adapter has `forwardedMark`.
7. Idempotent: a repeat `clientRequestId` from the same user answers the copies already made.
8. Audit `message.forwarded` `{ messageId, chatJids, messageIds }` (ids only; never text, captions or file names).
   Log `mod:"messages"` `forward` with user id, count, type, ms.
9. `message:new` per copy to the target chat's room (`inbox:<id>` / `chat:<jid>`); nothing new for push (our own
   outbound messages never notify).

`present()` maps `forwarding_score` → `forwarded: { manyTimes: score >= 5 }`.

AI: forwarded copies are team messages (a person sent them). In the AI's conversation an inbound forwarded message
is written `[forwarded] …` so the agent does not take a forwarded text as the customer's own words (one line in
`prompt.ts` conversation rendering, data not instructions as today).

## Web (`apps/web`)

- `inbox/MessageActions.tsx` `MessageMoreMenu`: **Forward** first, then Edit/Delete; ⋮ shows for every message with
  Forward. Disabled with "Locked by WhatsApp Safety" for a High file. Touch: `ReactionPicker` bar gets Forward under
  Reply.
- `inbox/ForwardDialog.tsx` (`ResponsiveDialog`, drawer on phones), `api/forward.ts` (`useForwardMessage`).
- `MessageBubble.tsx`: the Forwarded line (icon + italic muted text) above quote/media/body.
- i18n `inbox.forward.*` in en/ms/zh-CN; admin audit labels.
- `web-client-contract.test.ts` covers `POST /api/messages/:id/forward`.

## Security invariant (AGENTS.md text to add)

> Forward (`messages/forward.ts`, `POST /api/messages/:id/forward`): only a signed-in person (never the AI user, MCP or
> Ask Ezy), only from a message they may open to 1–5 **existing** chats they may open (`canOpenChat` per chat, else
> 404, limited agents included); never a new number. Every chat is checked before anything is sent. A file Safety
> rated High, or one still awaiting its AI check, is never forwarded (fail closed, admins too). Copies go through
> the normal send queue as the user, from the target chat's own inbox, with the reply window and removed-inbox
> refusals; 30 forwards a minute per user. Audit `message.forwarded` and logs carry ids and counts only.

## Test plan

- **Shared:** `ForwardMessageBody` (0 and 6 chats refused, lengths), `forwarded` default.
- **wa (Baileys):** `mapWAMessage` reads `isForwarded`/`forwardingScore` on extended text, image, document, audio;
  plain `conversation` = not forwarded; adapter `sendText`/`sendMedia` with `forwarded` add `contextInfo` (and keep
  mentions); fake adapter records the score and `simulateIncoming` takes one.
- **Large files (server):** `sendAs: 'original'` above a chat's video limit → 413 and nothing sent; `'file'` → document
  with the file name; above a document limit → 413; limits read per chosen chat's inbox (two inboxes, two limits);
  the adapter gets a `path`, not a buffer; `media_size` stored and presented; a failed upload fails only that copy
  and Retry re-sends it.
- **Server (`messages/forward.test.ts`):** text and media to 2 chats (queued in order, `sent_by_user_id`, score 1,
  claim); score + 1 of a forwarded source; many-times → 400 with 2 chats, ok with 1; 6 chats → 400; agent to a chat
  of another inbox → 404 and nothing sent; limited agent source/target outside the chosen chats → 404; AI user 403;
  Safety High and pending check → 409; deleted, hidden, `local-` → 409; window closed on one of 2 → 409 and nothing
  sent; removed inbox → 409; offline → 503; pending history media downloaded; unavailable → 502; rate limit 30 →
  429; same `clientRequestId` → same messages, nothing new; audit meta ids only; files are separate copies; restart
  restores a pending copy with its score; `present()` `forwarded.manyTimes`.
- **Ingest:** an inbound forwarded message (live and history) stores the score.
- **Contract:** `web-client-contract.test.ts` sees the new call.
- **Web:** `ForwardDialog.test.tsx` (search, pick, cap, closed-window row, many-times cap 1, refusals → banners, toast
  and Open chat), `MessageBubble.test.tsx` (label once / many), `MessageActions.test.tsx` (Forward item, disabled
  locked).
- **e2e** `e2e/forward-message.spec.ts` (fake WA): forward a text and a photo to 2 chats, label on both copies, Activity
  row; limited agent sees only chosen chats; Lite one inbox.
- **Dev Build check** (`docs/dev-build-checks.md`) and **real WhatsApp** smoke for the Baileys change (sent copy shows
  "Forwarded" on the recipient's phone; "Forwarded many times" at score 5; a forwarded message from a phone shows
  the label). Large files: a 70 MB video sent as a video and as a file from a linked phone (measure the video limit:
  64, 70, 100 MB), a 70 MB video to a Business API chat (as a file), five copies on one number (one upload: check the
  log for the `mediaCache` hit), an upload cut off mid-way (Failed + Retry). Until then: "untested against real
  WhatsApp".
- Network: no listener changes (no security review needed for that rule).

## Owner decisions (confirmation record)

Owner (Jazz) **confirmed the Forward mock on 2026-11-07** (relayed by the main session, session_01J4pmGkCf1Mvdepudm8WQAd)
with all proposed answers to the open questions; confirmed mock revision `2549b7afac813d8c2c957d15d653b2a150325866`:

1. **Offline:** refuse while the chosen chat's WhatsApp number is offline (503 `wa_disconnected`, nothing queued).
2. **Claiming:** a forward claims the chat like a reply (an unassigned chat becomes the forwarder's; a forward into an
   AI-owned chat takes it over).
3. **Limits:** at most 5 chats per forward, 30 forwards a minute per user.
4. **Business API:** copies go without WhatsApp's "Forwarded" mark (the Cloud API has none); our app still shows it.
5. **AI:** an inbound forwarded message appears as `[forwarded] …` in the AI's conversation.
6. **Upload limit:** the composer's upload limit rises from 64 MB to **100 MB** for every type, checked per number
   against WhatsApp's limits; a Business API video above 16 MB is offered as a file.
7. **Linked-phone video limit:** 64 MB until the Dev Build measures WhatsApp's real limit; above it the video goes as a
   file.

The questions as they were asked:

1. **Offline:** refuse while that WhatsApp number is offline (proposed), or queue like a typed reply (sent when it
   reconnects, fails after 10 minutes)?
2. **Claiming:** a forward into an unassigned chat makes it the forwarder's, and into an AI-owned chat takes it over
   from the AI, exactly like typing a reply (proposed). Or should a forward never change the assignee?
3. **Cap 5** per forward and **30 a minute** per user: keep, or lower (e.g. 3)?
4. **Business API copies** go without WhatsApp's "Forwarded" mark (the Cloud API has none) but show it in our app.
   Fine?
5. The AI sees an inbound forwarded message as `[forwarded] …` (proposed). Keep?
6. **Upload limit:** raise the composer's upload limit from 64 MB to **100 MB** for every type (checked per number
   against WhatsApp's limits; a Business API video above 16 MB is offered as a file), or keep 64 MB and let large
   files come in only through WhatsApp and Forward? Larger documents (up to WhatsApp's 2 GB on a linked phone) would
   need streaming uploads end to end and are proposed for later.
7. **Linked-phone video limit:** use 64 MB until the Dev Build measures WhatsApp's real limit, then set the measured
   value (proposed)? Above it, the video goes as a file.
