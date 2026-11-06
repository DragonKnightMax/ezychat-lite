# Limited chat access (an agent who sees only chosen chats)

Status: **confirmed 2026-11-06** (mock revision `846a09c`); production on branch `feat/limited-agent-impl`.
Created 2026-11-06 (creationOrder 36; built beside scheduled-tasks, 35). The folder keeps its first name, `partner-role`, so PR #314 stays the same.

Owner request (Jazz, 2026-11-06, relayed by the main session): let an admin give a support agent (for example an
outsourced one) access to **only the direct chats and groups the admin chooses**, in the Lite core (Lite and Enterprise).

Owner decisions (2026-11-06, relayed): first "Partner role" idea (new role, company, partner page, end dates, history
limit, notes switch) was **too complicated**. Now:

- **No new role.** An existing agent gets one setting, **Chats this member can see**: **All chats** (default, as today) /
  **Only chosen chats**.
- Inside the chosen chats the agent works **exactly like any agent**: internal notes, group member numbers, customer
  details, quick replies, reply suggestions, Fix English, reactions, AI take-over and assignment all as today.
- The only differences come from **one scope check**: other chats are invisible (404); no new chat and no chat opened
  from a group member; no Ask Ezy (it reads across chats). Admin pages and MCP are admin-only already.
- Chats are managed **only from the member** (Edit member). The "Who can see this chat" entry in the chat header was
  optional ("only if it costs nothing extra") and is **left out**: it needs its own route, dialog and admin directory
  read, so it is not free.

Mock: [mock/index.html](mock/index.html) (run instructions in [mock/README.md](mock/README.md)), screenshots in
[mock/screenshots](mock/screenshots) (10 states × desktop 1280 / mobile 360 × light / dark, `member-chats-shots.mjs`,
40 shots, 0 page errors, 0 overflow). Workbook: [docs/workbooks/feat\_\_partner-role.md](../../workbooks/feat__partner-role.md).

## Mock baseline

- Cloned from `latestConfirmed` **google-drive**, `docs/features/google-drive/mock` at **442b6317254a1a86b7df66bb86335f2d0047caec**
  (confirmed 2026-11-05; byte-identical to `main` 171f3aa). Screenshots not copied.
- As the index asked, the confirmed **sql-accounting** mock (e33aabbd) was merged in: the diff of
  `group-management@26116d59` → `sql-accounting` (4 added files, 14 changed) applied on the clone; the 6 catalog JSON
  conflicts merged key by key (only new keys added), `ConnectorsGalleryPage.tsx` and `run.ts` by hand.
- Inherited gaps (unchanged): message-edit-delete, whatsapp-safety, group-agents and claims-template screens.
- Files changed for this proposal: `mock/reference.json` → `limitedChatsChanges`. Everything else is identical to the
  clone + SQL Account merge.

## Where it lives in the app

Admin → Members → **Edit** (an agent; not shown for admins or AI agents). Below Role, **Chats this member can see**:

- **All chats**: every chat of the inboxes they can open (Enterprise: their inbox access; Lite: the one inbox). Today's
  behaviour and the default for every existing and new agent.
- **Only chosen chats**: a list of the chosen direct chats and groups (remove with ×) and a search to add more (open and
  resolved chats, groups marked). With none chosen, a warning says the agent sees no chats. The choice saves with the
  dialog's Save. Changing the role to Admin clears it (an admin sees everything).
- Members list: under the Agent badge, "Only 3 chosen chats" (warning tone; "No chats chosen" for none). In Enterprise
  the Inbox access cell shows "—" for a limited agent, because the chosen chats replace inbox access (below).

The limited agent's own app is the normal inbox with only the chosen chats. Opening any other chat (old link,
notification of a removed chat) shows **You can't open this chat** (the app answers 404). In Group info a member's
details show as for any agent, but instead of **Open chat / Message** a line says they can only open the chats an admin
chose. With nothing chosen the list says **No chats yet**.

## Data (migration 036)

```sql
-- 036_member_chats.sql
ALTER TABLE users ADD COLUMN chat_scope TEXT NOT NULL DEFAULT 'all' CHECK (chat_scope IN ('all', 'chosen'));
CREATE TABLE member_chats (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_jid TEXT    NOT NULL,   -- opaque chat key; no FK (chats can merge, see below)
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_jid)
);
CREATE INDEX idx_member_chats_chat ON member_chats(chat_jid);
```

- An explicit `chat_scope` (not "has rows"): "Only chosen chats" with nothing chosen must mean **no chats**, never all.
- `ALTER TABLE … ADD COLUMN` with a constant default needs no table rebuild; every existing user is `'all'`.
- `mergeChat` (identity migration, alias merges) moves `member_chats` like every table keyed by `chat_jid`
  (`INSERT OR IGNORE … SELECT`, then delete).
- Admins ignore `chat_scope`; a role change to admin sets it back to `'all'` and deletes the rows (no hidden leftovers).
- `upgrade-from-oldest.test.ts`: assert the column and table exist and old users read `'all'`; no seed change.

## Enforcement: the one scope check (`inboxes/access.ts`)

```ts
export type InboxScope = 'all' | ReadonlySet<number> | ChosenChats;
interface ChosenChats { kind: 'chats'; jids: ReadonlySet<string> }
export function scopeFor(ctx, user) {
  if (user.role === 'agent' && user.chatScope === 'chosen') return chosenChats(ctx, user.id); // FIRST
  if (user.role === 'admin' || user.kind === 'ai') return 'all';
  if (isSingleInbox(ctx)) return 'all';
  …
}
export function canOpenChat(scope, chat: { jid: string; inbox_id: number }): boolean
```

- The chosen-chats branch returns **before** `isSingleInbox`, so the Lite "everyone opens inbox 1" shortcut never applies
  to a limited agent. Chosen chats **replace** inbox access (an admin may choose chats from any inbox); `canOpen(scope,
inboxId)` is **false** for a `ChosenChats` scope, so nothing inbox-wide (counts, inbox lists, templates of an inbox)
  ever opens through it.
- `requireChatAccess` / `requireMessageAccess` (`inboxes/service.ts`) use `canOpenChat`. Every `:jid` route already goes
  through `chatJidParam` and every message-id route through `requireMessageAccess`, so they answer **404** outside the
  chosen chats with no per-route change. Inside, nothing changes (notes, members with numbers, profile, suggestions…).
- **Lists**: `ChatListScope` gains `chatJids`; `GET /chats` (list, search, tag filter, counts), `/customer-tags` and the
  chat stats read only the chosen chats.
- **Sockets** (`realtime/socket.ts`): a limited agent joins `user:<id>`, `all` and rooms `chat:<jid>` for each chosen
  chat, never `inbox:<id>`. Chat events go to `inbox:<id>` **and** `chat:<jid>`; `syncInboxRooms` becomes `syncRooms`
  and also runs on `member_chats:changed` (no reconnect needed). `typing` is accepted only for a chosen chat.
- **Push / notifications / AI hand-off**: recipients from `usersWhoCanOpenChat(jid)` = `usersWhoCanOpen(inbox)` minus
  limited agents, plus limited agents who chose that chat. **Owner rule (2026-11-06): a limited agent gets no
  notification of any kind for a chat they cannot open**: new inbound messages, AI hand-offs ("needs a team member",
  group hand-offs included), unassigned chats, the desktop `notification:new`, web push and socket events. Hand-off and
  unassigned pushes go only to `usersWhoCanOpenChat`; each path has its own test.
- **Assignment**: the `assignee_no_access` check uses `canOpenChat`, so a limited agent can be assigned only their chosen
  chats; removing a chat from their list unassigns them (system line, no customer message).
- **Not available to a limited agent (403 `chat_scope_limited`)**: `POST /chats/:jid/members/:member/chat` (open or
  start a chat from a group member) and `/ask-ezy*`. There is no other "new chat" route for agents (`send_to_new_number`
  is an MCP admin token tool). `GET /chats/:jid/members/:member/about` and avatars stay as for any agent.
- **MCP**: tokens are created only by admins, and `InboxReadPort` takes the token owner's scope anyway (defence in
  depth). Admin pages, Reports, Safety admin and connectors are `requireAdmin` already: nothing to add.

## API (shared zod first)

- `User` gains `chatScope: 'all' | 'chosen'` (zod default `'all'`, so older clients and Enterprise keep parsing).
- `GET /api/users/:id/chats` (admin) → `{ scope, chats: Array<{ jid, name, type }> }`.
- `PUT /api/users/:id/chats` (admin) `{ scope, chats: string[] }` (≤ 2,000; unknown keys 400; replaces the set; `scope:
'all'` deletes the rows). 400 `not_an_agent` for an admin or AI user.
- `GET /api/me` carries `chatScope`; socket `chat:access` to the user when their chats change (the web refetches the
  list and an open chat turns into "You can't open this chat").

## Audit (ids only)

`user.chat_scope` {targetId, before, after, added: count, removed: count} on every save; the chat keys go in `meta.added`
/ `meta.removed` (ids, never names or text). No per-message audit: a limited agent's sends are ordinary sends.

## Proposed security invariant (AGENTS.md, extends "Inbox access")

> - An agent with `chat_scope = 'chosen'` (`inboxes/access.ts`) opens only the chats in `member_chats`: `scopeFor` returns
>   that scope before the admin, AI and single-inbox branches, `canOpen(inboxId)` is false for it, and every per-chat,
>   media and message-id route answers 404 outside those chats; lists, search, tags, stats, sockets (`chat:<jid>` rooms,
>   rebuilt on change), push, assignment and AI hand-off follow the same check. Such an agent cannot open or start a
>   chat from a group member or use Ask Ezy. "Chosen" with no rows means no chats, never all.

## Test plan

Unit (server, `packages/server/test/member-chats.test.ts`, real `makeTestApp`):

- scope: `'all'` agent unchanged; chosen with 0 / 1 / 2 chats; Lite single inbox (limited agent still scoped, other
  agents `'all'`); chats from two inboxes; `canOpen` false; admin role change resets; merged chat keeps the row.
- route matrix: every route in the `web-client-contract` table called as a limited agent on a chosen and an unchosen
  chat → 2xx / 404 / 403 as above; the test fails when a new `:jid` route is missing from the matrix.
- lists/search/tags/stats; member chat 403; Ask Ezy 403; notes and members unchanged inside a chosen chat.
- sockets: events of chosen chats only; add/remove re-syncs rooms without reconnect; typing filtered.
- notifications, one test each, for a limited agent and a chat outside their list (none received) and inside it
  (received): inbound push, `notification:new`, AI hand-off push, group hand-off push, unassigned-chat push, web push to a
  subscribed device, socket `message:new` / `chat:updated` / `message:reactions` / `typing`.
- assignment only to chosen chats; removal unassigns.
- `PUT /users/:id/chats` validation, idempotence, audit with ids only; `upgrade-from-oldest` runs 036.
- Web unit: `MemberChatsField` (all/chosen, add, remove, none warning), Members note, list filter, "You can't open
  this chat". E2E `e2e/member-chats.spec.ts` (fake WA): admin limits an agent to one chat → agent sees only it, replies,
  opens group info without Message → admin removes it → agent's open chat turns into "You can't open this chat" live;
  desktop + mobile. Dev Build check in `D:\dev\test-env\lite`. `/security-review` on the implementation PR (access
  control change; no listener change).

## States in the mock (checklist)

| #   | State                                                                 | Screenshot                |
| --- | --------------------------------------------------------------------- | ------------------------- |
| 1   | Members: "Only 3 chosen chats", "No chats chosen"                     | `01-members`              |
| 2   | Edit member, All chats (default)                                      | `02-edit-all-chats`       |
| 3   | Edit member, Only chosen chats (3) + add search                       | `03-edit-chosen-chats`    |
| 4   | Edit member, Only chosen chats with none chosen (warning)             | `04-edit-none-chosen`     |
| 5   | Many chosen (12, long group name, scrolling list)                     | `05-edit-many-chosen`     |
| 6   | Limited agent's list (only the chosen chats)                          | `06-limited-list`         |
| 7   | Limited agent in a chosen chat (Customer, Notes, assignment as usual) | `07-limited-chat`         |
| 8   | Group info member: number shown, no Open chat / Message               | `08-limited-group-member` |
| 9   | Another chat's link: "You can't open this chat"                       | `09-limited-not-chosen`   |
| 10  | Limited agent with nothing chosen: "No chats yet"                     | `10-limited-no-chats`     |

Also interactive (not shot): remove a chat in Edit member and Save while `ravi` has it open in another browser → the
chat leaves the list and the open chat turns into "You can't open this chat" within seconds. Strings: `admin.json` →
`limitedChats.*` in en / ms / zh-CN. Ask Ezy is not in the mock baseline, so its refusal has no screen.

## Owner answers (2026-11-06)

1. **Chosen chats may come from any inbox**; they replace inbox access while the agent is limited.
2. **A limited agent can be assigned only their chosen chats**, and removing a chat unassigns them.
3. **No notification of any kind** for chats a limited agent cannot see (see Enforcement → Push).

## Mock and confirmation

- 2026-11-06: first proposal (Partner role) built; owner simplified it twice the same day (no history limit, notes
  always hidden, no end date; then no new role at all). This version: one setting on the agent.
- 2026-11-06: **owner confirmed** this mock (revision `846a09c`), relayed verbatim by the main session: "The owner
  CONFIRMED the simplified limited-agent mock (2026-11-06) with your proposed answers" (both open questions as
  proposed), plus the notification rule above.
