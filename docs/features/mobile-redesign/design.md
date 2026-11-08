# Mobile redesign (phone 360–430 px)

Status: **proposal, waiting for the owner's confirmation**. Created 2026-11-07 (creationOrder 39). Branch
`feat/mobile-redesign`, workbook [docs/workbooks/feat\_\_mobile-redesign.md](../../workbooks/feat__mobile-redesign.md).
Design and mock only: no production code until the owner confirms the mock.

Owner request (Jazz, 2026-11-07, relayed by the main session): "Can u improve the mobile view, I felt it can be better
like new chat, tagging, switch diff inbox, pls design follow best practices, can take reference of whatsapp and other
similar app".

## Mock and baseline

- Mock: [mock/index.html](mock/index.html) (the whole app, run with `run.ts`), README [mock/README.md](mock/README.md),
  screenshots in [mock/screenshots](mock/screenshots) (`mobile-shots.mjs`), before shots in
  [mock/screenshots/before](mock/screenshots/before) (`audit-shots.mjs` on the baseline mock).
- Baseline: `latestConfirmed` **forward-message**, `docs/features/forward-message/mock` at
  **2549b7afac813d8c2c957d15d653b2a150325866** (confirmed 2026-11-07), copied byte-identical from `main` `fffb93e`
  without its screenshots. It carries new-chat, partner-role, scheduled-tasks, google-drive and sql-accounting.
- `node docs/features/mobile-redesign/mock/snapshot.mjs --check`: 123 frozen frontend files unchanged, 10 intentional
  deltas in this proposal, 48 inherited files unchanged (the forward-message files are now frozen too), 67 added files.
- Inherited gaps (unchanged): the mock's web source predates message edit/delete, WhatsApp Safety on messages, Ask Ezy
  and Fix English in the composer. The list, header and filter code it changes is close to the app (`apps/web/src`
  `ChatList.tsx`, `ChatFilters.tsx`, `InboxPage.tsx`, `ConversationHeader.tsx` differ by a few dozen lines, none of
  them layout), so the audit below holds for the app.

```bash
npx tsx --conditions=ezychat-source docs/features/mobile-redesign/mock/run.ts --fake-wa
node docs/features/mobile-redesign/mock/mobile-shots.mjs   # PW_CHROMIUM=<chromium> if needed; fresh mock
```

Open `http://localhost:7489/` on a phone or in the browser's device mode (360 or 390 px), sign in as `aisyah`
(admin), `daniel` (agent, 2 numbers) or `meiling` (agent, 1 number), password `demo-pass-123`.

## Design system (added scope, owner via the main session 2026-11-07)

`docs/design-system.md` is now the single design system for Lite and Enterprise (AGENTS.md rule PRs #327 and
anchorsprint/ezychat-enterprise#96). This PR:

- adds **Mobile patterns** (app bar and number switcher, FAB, filter chips, sheets vs dialogs vs pages, swipe and
  press and hold, detail header with chips, selection bar, composer and keyboard, bottom navigation vs menu, empty
  states, pull to refresh, back behaviour), each as a do / don't rule linked to the mock screens;
- adds **Editions**: where Enterprise screens (lock screen, licence, connectors, wa-cloud inbox, extension slots)
  use the shared patterns;
- fixes what the redesign changes or what was out of date: radius classes (the file called 16 px `--radius-lg`;
  `index.css` maps `--radius-lg` to 10 px and 16 px is `rounded-xl`), `--overlay` and the number (inbox) colours
  as identity tones, the 15 px phone list size, chip hit areas, toast position on phones, `ResponsiveDialog`, the
  phone layout below `md`, and the "add it to the design system in the same PR" rule;
- adds the living reference page **`/design-system`** to the mock
  (`docs/features/mobile-redesign/mock/src/design-system/DesignSystemPage.tsx`, no sign-in): colour tokens read from
  the real `index.css` (light and dark values), type scale, spacing, radius, elevation, touch targets, components and
  states (buttons, filter chip, badges, number chip and badge, status, inputs, list row, sheet, confirm dialog, toast
  with Undo, banners, skeleton, empty state, FAB, tabs), the mobile patterns with their screens, and the editions
  table; a Light/Dark switch at the top. Screens `40-design-system`, `41-design-system-full` (whole page),
  `42-design-system-sheet`.

## Tags on every chat and every screen (owner 2026-11-07)

Owner (relayed by the main session): "Follow existing — all can add tag to group chat and individual chat, check on
other screen." Decisions:

1. **Who**: any teammate who can open the chat may add, remove and create tags, as today. No admin-only rule
   (answers open question 5).
2. **Groups get tags** like direct chats: from the chat header (**+ Tag** chip), a list row's press-and-hold sheet
   and Group info, on phone and desktop. Group rows show their tag chips; the Tag filter, tag search and tag
   suggestions include tagged groups.
3. **One look, one editor**: a tag is a `secondary` pill everywhere; every place that edits tags opens the same
   **Tags** editor (`ChatTagsSheet`: a bottom sheet on phones, a dialog on desktop); Customer details and Group info
   get the same **Tags** row (chips + **Edit tags** / **+ Tag**).

### Tag screens audit (before → after)

| Screen                                    | Before (app today)                                                    | After (this proposal)                                                                          | Shots                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Chat list row (phone + desktop)           | Direct chats: 1 tag (+N) on narrow rows, 2 on wide; groups: never     | Same for direct chats **and groups** (plain pill, no icon: the row has no room)                | `01-list`, `28-tag-filter-includes-groups`, `30-desktop-list`                          |
| Chat header (phone)                       | No tags                                                               | Tag chips (tag icon) + **+ Tag** in the chip strip, direct chats and groups                    | `14-chat-header`, `18-chat-tags-saved`, `24-group-tags-saved`                          |
| Chat header (desktop)                     | No tags                                                               | Unchanged (the side panel holds them; desktop header change left for phase 2, open question 9) | `31-desktop-chat`                                                                      |
| Customer details (phone + desktop)        | Tags only as read-only pills; editing means Edit → whole profile form | **Tags** row on top with **Edit tags** → the Tags editor; the profile form keeps its tag field | `29-customer-details-tags`, `34-desktop-customer-tags`                                 |
| Group info (phone + desktop)              | No tags                                                               | **Tags** row under the group name, same editor                                                 | `25-group-info-tags`, `32-desktop-group-info-tags`, `33-desktop-group-tags-dialog`     |
| Row press-and-hold sheet (phone)          | (new)                                                                 | **Tags** for direct chats and groups                                                           | `13-row-actions`, `26-group-row-actions`, `27-group-row-tags-sheet`                    |
| Tag filter (phone sheet, desktop popover) | Tags of direct chats; filters direct chats only                       | Tags of direct chats and groups; the filter returns tagged groups too                          | `05-tag-filter-sheet`, `28-tag-filter-includes-groups`, `35-desktop-tag-filter-groups` |
| Search                                    | Finds direct chats by tag text (profile search)                       | Also groups by tag text (same SQL; it already reads `customer_tags` by chat)                   | (no shot: same list)                                                                   |
| Reports                                   | No tags                                                               | No change (tags are not a report dimension)                                                    | –                                                                                      |
| MCP `list_chats` / `get_chat`, Ask Ezy    | `tags` on direct chats (`Chat.tags`)                                  | `tags` on groups too (same field, from the read model); Ask Ezy shows what MCP returns         | –                                                                                      |
| AI agent prompt                           | Never tags (`aiCustomer`)                                             | Unchanged: never tags, direct or group                                                         | –                                                                                      |

### Server and contract change (phase 1 scope)

- **Storage: no new table and no schema migration.** `customer_tags (chat_jid, tag, tag_key, created_at)` is keyed
  by chat with no foreign key and no type check, so a group's tags go in the same table. The tag filter
  (`TAG_FILTER`), tag search (`PROFILE_SEARCH`) and suggestions (`CustomerRepo.suggest`) already read it by
  `chat_jid` and therefore include groups once groups have rows (proved in the mock, which writes the real table).
  Upgrades: nothing to move; `upgrade-from-oldest` unaffected. Group chats are never merged by alias, so
  `chats/merge.ts` needs nothing new; Lite import already copies `customer_tags`; `customers/linked.ts` keeps skipping
  groups (tags are not shared between linked chats anyway).
- **Read model**: `rowToChat` returns `profile_tags` for groups too (today `dm ? r.profile_tags : []`).
- **Route**: new `PUT /api/chats/:jid/tags { tags }` for direct chats and groups (shared `ChatTagsBody`: ≤ 10 tags,
  ≤ 30 characters, normalised as `CustomerProfileBody.tags`; `customerTagKey` de-duplicates). Through
  `chatJidParam` (`requireChatAccess`: 404 outside the caller's inboxes and, for an agent limited to chosen chats,
  outside those chats). It replaces only the tags, so a concurrent profile edit is never overwritten; the profile
  route keeps accepting tags for direct chats. The mock's stand-in is `PUT /api/mock/group-tags/:jid`
  (`group-tags.ts`).
- **Realtime**: the saved chat is emitted like a profile save, so lists and headers update for everyone who may open
  the chat (`inbox:<id>` / `chat:<jid>` rooms).
- **Audit**: `chat.tags` {chatJid, fields: ['tags'], count}, field names and ids only, never the tag text (same rule as
  customer profile audits). Logs: counts only.
- **Shared schema**: `ChatTagsBody`, `ChatTagsResponse { tags }`; `Chat.tags` documented as "direct chats and groups".
- **Web**: `ChatTagsSheet` and `ChatTagsRow` (one editor everywhere), `useChatTags` replaced by `chat.tags`.
- **Tests**: route limits, 404 outside access (agent, limited agent), group and direct chat, audit without text,
  read model returns group tags, filter/search/suggest include a tagged group, contract test entry, e2e: tag a group
  on 360 px and desktop.

### Security and invariants

- Tagging needs only the right to open the chat (inbox access; chosen chats for limited agents); the route is under
  `/api` with session + Origin checks, never MCP or the AI (MCP stays read-only for tags).
- Tag suggestions keep their access scoping (`suggest(…, inboxIds, chatJids)`), so a limited agent sees only tags
  of chats they may open.
- Tags never reach the AI prompt (direct or group) and never appear in audit rows or logs as text.

## Audit (before), 360 px, seeded demo

| Measure                                   | Before                                               | After (mock)            |
| ----------------------------------------- | ---------------------------------------------------- | ----------------------- |
| Space above the first chat row            | **259 px** (33 % of 780)                             | **105 px**              |
| Chat rows visible at 360 × 780            | 7                                                    | 9 (10 at 390 × 844)     |
| Controls under 44 px tall in the list top | 7 (tabs 37 px, select 36)                            | 0                       |
| Chat header height                        | 117 px (two rows)                                    | 101 px (row + chips)    |
| Taps to add a tag to a customer           | 5 (Customer → Add details → tag field → type → Save) | 3 (+ Tag → pick → Done) |
| Taps to switch number                     | 2 (select, no unread)                                | 2 (sheet with unread)   |

Before shots ([screenshots/before](mock/screenshots/before)):

| Shot                         | What it shows                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `01-list.png`                | Four stacked filter rows (search, inbox select, Mine/Unassigned/All, Open/Resolved + Tag) and a version line |
| `02-inbox-switch-select.png` | Switching number is a full-width select: no unread per number, no connection state                           |
| `03-tag-filter-popover.png`  | Tag filter hides behind a small "Tag" button; a desktop popover on a phone                                   |
| `04-new-chat-dialog.png`     | New chat is a 40 px icon in the header next to "Admin" (no label on a phone)                                 |
| `05-conversation.png`        | Two-row header; assignee select truncates to "Unassig…"; Customer and Notes are unlabelled icons             |
| `06-customer-panel.png`      | Tags live inside the profile form: Add details → edit → Save                                                 |
| `08-group-conversation.png`  | Group header: chip, member count and AI badge squeezed into one line                                         |
| `10-admin.png`               | Admin on a phone: hamburger top right, "< Inbox" back                                                        |

Pain points, by the owner's three topics and the rest of the journey:

1. **New chat** is hard to find on a phone: an unlabelled 40 × 44 px icon at the top, away from the thumb.
2. **Tagging**: filtering by tag is a small button opening a desktop popover; tagging a customer needs the whole
   profile form (5 taps); the list shows tags but you cannot act on them.
3. **Switching number**: a select with "All inboxes (3)" and no unread counts or connection state per number; it
   costs a full row even when you never switch.
4. **List density**: 259 px of filters push the chats down; Mine/Unassigned/All and Open/Resolved are two segmented
   controls of 37 px; the "EzyChat Lite · v0.1.79" line takes a row at the bottom; the header "Admin" button repeats
   the account menu's **Admin settings**.
5. **Rows**: the inbox name chip ("Online orders") takes a third of the name line; no swipe or press-and-hold, so
   assign and resolve always mean opening the chat.
6. **Chat header**: two rows; assignee truncated; Customer and Notes icon-only; group subtitle cramped.
7. **Toasts** appear at the top over the chat header.
8. **Composer** (phase 2): the Quick replies / Suggest reply row and the reply-window line add ~80 px under the box;
   attach and emoji are separate 44 px buttons outside the field.

## Patterns chosen and why

References (patterns only; EzyChat keeps its own tokens, shadcn components and look): WhatsApp / WhatsApp Business
(chip filters All / Unread / Groups, FAB for a new chat, swipe and long-press on rows), Gmail and Slack mobile
(account / workspace switcher in a sheet with unread per account), Intercom / Chatwoot / Respond.io mobile (assignee
and tags as chips in the conversation header), Material 3 (extended FAB that shrinks on scroll, filter chips, bottom
sheets, 48 dp targets, snackbars with Undo at the bottom), Apple HIG (44 pt targets, sheets with a grabber, swipe
actions duplicated in a menu).

| Pattern                                                                                                                                   | Why                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **One 56 px top bar**: number switcher as the title, search icon, account                                                                 | The title is the place users look for "where am I"; search opens on demand (WhatsApp, Gmail)                      |
| **Filter chips** in one scrolling row: All · Unread (n) · Mine · Unassigned · Groups · Tag ▾ · Resolved                                   | One row instead of three; single tap; counts show what is waiting; familiar from WhatsApp                         |
| **Number switcher sheet** with unread per number, connection dot, "Manage numbers" for admins                                             | Account-switcher pattern; unread elsewhere also shows as a dot on the title                                       |
| **Small number badge on the photo** in the list (phone only)                                                                              | Keeps the name line for the name; the full name chip stays in the chat header and on desktop                      |
| **Extended FAB "New chat"**, bottom right, shrinks to its icon on scroll                                                                  | Thumb reach and discoverability; Material 3 / WhatsApp; the list gets bottom padding so the last row is reachable |
| **Swipe right = Assign to me, swipe left = Resolve**, toast with **Undo**                                                                 | The two most common triage actions without opening the chat; Undo because swipes happen by accident               |
| **Press and hold a row** → action sheet (Assign to me, Choose who handles it, Tags, Mark as read, Resolve, Customer details / Group info) | Every swipe action is also in a menu (accessibility, discoverability)                                             |
| **Chat header: one row + chip strip** (assignee ▾, tags, + Tag, Notes; groups: AI badge)                                                  | Assignee readable, tags editable in place, labels visible; Resolve stays one tap                                  |
| **Tag sheet**: search or type to add, tick/untick, Done                                                                                   | 3 taps; no profile form; creating a tag is typing it (max 10 per customer, 30 characters, as today)               |
| **Assign sheet**: You first, big rows                                                                                                     | Replaces the narrow select                                                                                        |
| **Admin stays in the account menu** (no "Admin" header button on phones), version moves to About                                          | The menu already has Admin settings; frees the header; no bottom bar for 2–3 items (open question 3)              |
| **Toasts at the bottom** above the composer / FAB on phones                                                                               | Thumb reach; never cover the header                                                                               |

Desktop (768 px and wider) is unchanged: the phone parts render only below the `md` breakpoint, the breakpoint at which
the inbox already turns from two columns into one. `30-desktop-list` and `31-desktop-chat` show it.

## Scope

### Phase 1 (this mock; proposed for the first build)

1. Phone list header: number switcher title, search on demand, account menu; filter chips (All, Unread with count,
   Mine, Unassigned, Groups, Tag ▾, Resolved).
2. Number switcher sheet (2+ numbers only; Lite and one-number agents keep the plain "Inbox" title).
3. Tag filter sheet (one tag, as today) and the chat's Tags sheet (add, remove, create).
4. New chat FAB (same rules as today: admins always, team members when Settings allows it).
5. Row gestures: swipe right / left with Undo, press and hold for the action sheet.
6. Chat header: one row (back, photo + name, Resolve, ⋮) + chip strip (assignee, tags, + Tag, Notes, group AI badge);
   ⋮ sheet (Customer details / Group info, Choose who handles it, Tags, Notes, Resolve).
7. Quick wins: number badge on photos, no version line and no "Admin" button on phones, toasts at the bottom.

### Phase 2 (designed here in words; mocked after phase 1 is confirmed)

- **Composer**: emoji inside the field (left), attach inside the field (right), one ✦ button opening a sheet with
  Quick replies, Suggest reply and Fix English; the reply-window line as a small chip above the box only when under 2 h.
- **Message actions**: press and hold → the existing bar (react, reply, forward) plus Copy / Edit / Delete in a sheet;
  swipe a bubble right to reply (exists: `useSwipeReply`).
- **Customer details and Group info** as full-height sheets with the grabber; tags at the top of Customer details.
- **Keyboard and safe areas**: composer pinned with `interactive-widget=resizes-content` / `visualViewport`, list
  pull-to-refresh, back gesture closes sheets first.
- **Empty states** per chip ("All caught up" for Unread is in this mock).

### Phase 3 (only if the owner wants it)

- Selection mode in the list (bulk assign / resolve). (Bottom navigation: owner said no, 2026-11-07. New chat
  "Send from" on the number being viewed moved into phase 1.)

## Rules (phase 1)

- Filters keep today's server contract: `assigned`, `status`, one `tag`, `q`. **New:** `unread=1` and
  `type=group|dm` on `GET /api/chats` (shared `ChatListQuery`), filtered on the server like the others (the mock
  filters in the browser). The chip counts come from a new `GET /api/inboxes/unread` → `{ total, byInbox: { id: n } }`
  (chats with unread messages the caller may open; limited agents: their chosen chats only). Both respect inbox access
  and limited chat access exactly like the list.
- Tags: the Tags editor saves only the tags through the new `PUT /api/chats/:jid/tags` (direct chats and groups;
  see "Tags on every chat and every screen"). The mock saves direct chats through the whole-profile
  `PUT …/profile` and groups through the stand-in `PUT /api/mock/group-tags/:jid`.
- Swipe and the action sheet use the existing `PATCH /api/chats/:jid` (assign, status) and `POST …/read`; Undo sends
  the previous value back. No new permission: the same people who can assign and resolve today.
- The number switcher only filters the list (as the select does today); it never changes access. Kept per browser.
- No network or listener change. The new tags route follows the existing access rules (see Security and invariants).

## Screen and state checklist (`mock/screenshots/<shot>-<size>-<scheme>[-locale].png`)

Sizes: `m360` (360 × 780 touch), `m390` (390 × 844 touch), `desktop` (1280). Light unless noted.

| #   | Screen / state                                                                              | Shot                                                         |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Chat list: switcher title, chips, number badges, FAB (+ 390, dark, ms, zh-CN)               | `01-list`                                                    |
| 2   | Number switcher sheet: All numbers + 3 numbers, unread, connection (+ 390, dark, ms, zh-CN) | `02-inbox-switcher`                                          |
| 3   | Switched to Catering: title and number, dot for unread elsewhere                            | `03-switched-catering`                                       |
| 3b  | New chat from Catering: Send from starts on Catering (owner 2026-11-07)                     | `03b-new-chat-sends-from-catering`                           |
| 4   | Unread chip on                                                                              | `04-chip-unread`                                             |
| 5   | Tag filter sheet (+ 390, dark, ms, zh-CN)                                                   | `05-tag-filter-sheet`                                        |
| 6   | Filtered by VIP: chip "VIP ×"                                                               | `06-tag-filtered`                                            |
| 7   | Search open ("kopi")                                                                        | `07-search`                                                  |
| 8   | New chat sheet from the FAB                                                                 | `08-new-chat-sheet`                                          |
| 9   | FAB shrunk while scrolling                                                                  | `09-fab-compact-on-scroll`                                   |
| 10  | Swipe right: Assign to me                                                                   | `10-swipe-assign`                                            |
| 11  | After the swipe: toast with Undo, "You" on the row                                          | `11-swipe-assigned-toast`                                    |
| 12  | Swipe left: Resolve                                                                         | `12-swipe-resolve`                                           |
| 13  | Press and hold: row action sheet                                                            | `13-row-actions`                                             |
| 14  | Chat header: one row + chips (+ 390, dark, ms, zh-CN)                                       | `14-chat-header`                                             |
| 15  | Assign sheet                                                                                | `15-assign-sheet`                                            |
| 16  | Tags sheet (+ 390, dark, ms, zh-CN)                                                         | `16-chat-tags-sheet`                                         |
| 17  | Tags sheet: typing a new tag → "Add “Wholesale”"                                            | `17-chat-tags-create`                                        |
| 18  | Tags saved: chips in the header, toast at the bottom                                        | `18-chat-tags-saved`                                         |
| 19  | ⋮ sheet                                                                                     | `19-chat-more-sheet`                                         |
| 20  | Group header: assignee chip, AI badge in the strip                                          | `20-group-header`                                            |
| 21  | Lite (one number): plain "Inbox" title, no badges                                           | `21-lite-one-number`                                         |
| 22  | Team member with one number (Mei Ling)                                                      | `22-agent-one-number`                                        |
| 23  | Desktop list, unchanged                                                                     | `30-desktop-list-desktop-light`                              |
| 24  | Desktop chat, unchanged                                                                     | `31-desktop-chat-desktop-light`                              |
| 25  | Design system page, top (desktop + 360, light + dark)                                       | `40-design-system`                                           |
| 26  | Design system page, whole page (desktop + 360, light + dark)                                | `41-design-system-full`                                      |
| 27  | Design system page: a bottom sheet on a phone (light + dark)                                | `42-design-system-sheet`                                     |
| 28  | Group header: tag chips; + Tag adds "Events" (group Tags editor)                            | `23-group-tags-sheet`, `24-group-tags-saved`                 |
| 29  | Group info with the Tags row (phone)                                                        | `25-group-info-tags`                                         |
| 30  | Press and hold a group row → Tags                                                           | `26-group-row-actions`, `27-group-row-tags-sheet`            |
| 31  | Tag filter "Wholesale" returns the tagged group                                             | `28-tag-filter-includes-groups`                              |
| 32  | Customer details with the Tags row (phone)                                                  | `29-customer-details-tags`                                   |
| 33  | Desktop Group info with tags; the same editor as a dialog                                   | `32-desktop-group-info-tags`, `33-desktop-group-tags-dialog` |
| 34  | Desktop Customer details with the Tags row                                                  | `34-desktop-customer-tags`                                   |
| 35  | Desktop tag filter returns the tagged group                                                 | `35-desktop-tag-filter-groups`                               |

`mobile-results.json`: 66 shots, 0 page errors, 0 horizontal overflow, 0 list controls under 44 px.

Not yet covered (phase 2 screens; the owner may want them before confirming): composer, message press-and-hold, the
Customer details sheet, Group info, Admin on a phone, the keyboard open, empty states other than Unread / Groups.

## Components and routes touched (production, phase 1)

| App file (`apps/web/src`)                         | Change                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbox/InboxPage.tsx`                             | Phone: `MobileListHeader` instead of header + `ChatFilters`; FAB; no version line                                                           |
| `inbox/ChatList.tsx`                              | `unread` / `type` filters; rows wrapped in `ChatRowActions` on phones; bottom padding                                                       |
| `inbox/ChatListItem.tsx`                          | Number badge on the photo on phones; no inbox chip there                                                                                    |
| `inbox/ConversationHeader.tsx`                    | Phone variant `MobileConversationHeader`                                                                                                    |
| `inbox/Conversation.tsx`                          | `?info=1` opens Group info (from the row sheet)                                                                                             |
| `inbox/NewChatDialog.tsx`                         | Export the dialog for the FAB                                                                                                               |
| `main.tsx` / `components/ui/sonner.tsx`           | Toasts at the bottom on phones                                                                                                              |
| new `inbox/mobile/*`                              | `MobileListHeader`, `InboxSwitcherSheet`, `TagSheet`, `AssignSheet`, `ChatRowActions`, `NewChatFab`, `MobileConversationHeader`, `phone.ts` |
| new `components/app/FilterChip.tsx`               | The chip as an app composite (the mock uses a styled `<button>`; ESLint forbids raw buttons in feature code)                                |
| `i18n/locales/{en,ms,zh-CN}/inbox.json`           | `mobile.*`                                                                                                                                  |
| `docs/design-system.md`                           | Updated in this PR (Mobile patterns, Editions, fixes)                                                                                       |
| `inbox/CustomerPanel.tsx`, `inbox/GroupPanel.tsx` | Tags row (`ChatTagsRow`) with the shared Tags editor                                                                                        |
| `packages/server` `chats/repo.ts`, new tags route | `rowToChat` returns group tags; `PUT /api/chats/:jid/tags`; audit `chat.tags`                                                               |
| `packages/shared` `ChatListQuery`                 | `unread`, `type`                                                                                                                            |
| `packages/server` `routes/chats.ts`, `inboxes`    | the two filters; `GET /api/inboxes/unread`; recommended `PUT /api/chats/:jid/tags`                                                          |

Tests to add with the build: list filters (server), unread counts by access (admin / agent / limited agent), tags
route limits and audit, `MobileListHeader` / sheets / swipe threshold and Undo (web), contract test entries, the e2e
phone project (360 px) for switch number, tag a chat, swipe, New chat.

## Owner decisions (2026-11-07, relayed by the main session)

The mock itself is **not yet confirmed**: the owner confirms it after seeing the group tagging and the tag-screens
audit. These answers are recorded now:

1. Swipe right = **Assign to me**, swipe left = **Resolve**, both with Undo.
2. Chips stay as shown (All · Unread · Mine · Unassigned · Groups · Tag · Resolved); a phone opens on **All**.
3. Admin stays in the account menu; **no bottom bar**.
4. Resolve in the phone chat header is icon only at 360 px, labelled from 375 px.
5. Any teammate who can open the chat creates and adds tags, on **direct chats and groups** ("Follow existing";
   see "Tags on every chat and every screen").
6. New chat's **Send from starts on the number being viewed** (built into the mock: `03b-new-chat-sends-from-catering`).
7. Phase 2 order: **composer first**, then message actions, then the Customer details and Group info sheets.
8. The Mobile patterns and the Editions table in `docs/design-system.md` are **the rules for both editions**.
9. Desktop chat header: "Rest as proposed", so tags stay in the side panels (Customer details, Group info) on
   desktop; the header is unchanged.

## Open questions for the owner (all answered 2026-11-07, see above)

1. **Swipe directions**: right = Assign to me, left = Resolve (Undo on both). Keep, or another pair (e.g. Mark as read)?
2. **Chips**: All · Unread · Mine · Unassigned · Groups · Tag · Resolved. Right set and order? Should a phone open on
   **Mine** instead of **All**?
3. **Admin on a phone**: keep it in the account menu (proposed), or add a bottom bar (Chats · Admin · Me)?
4. **Resolve in the chat header**: icon with label from 375 px, icon only on 360 px phones. OK, or move Resolve into ⋮?
5. ~~Tags~~: **answered 2026-11-07**: any teammate who can open the chat adds, removes and creates tags, on direct
   chats and groups ("Follow existing"). See "Tags on every chat and every screen".
6. **Number switcher**: remembered per phone (like today's filter). And should New chat's "Send from" start on the
   number you are viewing? (proposed: yes, phase 1)
7. **Phase 2 order**: composer first, or message actions, or the Customer details / Group info sheets?
8. **Design system**: are the new Mobile patterns and the Editions table right as the rules for both editions?
9. **Desktop chat header**: show the tag chips there too (like the phone strip), or keep them in the side panels?

## Five-folder retention

This mock takes creationOrder **39**. Folders before it: template-store (kept as live tooling:
`scripts/template-store.test.mjs` imports its `publisher/`), scheduled-tasks (35), partner-role (36), new-chat (37),
forward-message (38). This PR removes **scheduled-tasks** (35; confirmed revision
`426c2eb766f24e520fd4f59b66ab837c11296045` recorded in the index, last commit touching the folder `afc97fd8`; its
screens live on in new-chat, forward-message and this mock; nothing imports the folder, code comments and `AGENTS.md`
only name its `design.md`, which stays readable in git history at that revision). Folders left: template-store
(tooling), partner-role, new-chat, forward-message, mobile-redesign.

## Confirmation record

- 2026-11-07: proposal sent to the owner (through the main session) with the before/after screenshots. Waiting.
