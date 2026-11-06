# Scheduled tasks for AI agents

Status: **confirmed 2026-11-06** (see "Mock and confirmation"); production on `feat/scheduled-tasks-impl`.
Created 2026-11-06 (creationOrder 35). Owner request (Jazz, 2026-11-06, relayed by the main session): "every
morning, message this person or group about something". Examples: weekdays at 8:30 post today's bookings from Google
Calendar to the Staff group; every morning send a client a reminder; daily list overdue tasks from a Sheet in a
project group. Lite core, so Lite and Enterprise both get it. **Keep it simple.**

## Scope

A **Scheduled tasks** card on each AI agent's page (`/admin/members/ai/:agentId`, admins only), below Groups. Each
task has:

- **Name** (≤ 60 characters).
- **On/off**.
- **Schedule**: one **time** (HH:MM, 5-minute steps) and **days**: Every day / Weekdays (Mon–Fri) / Chosen days
  (any of Mon…Sun). Read in the business time zone `ai_timezone` (Settings → AI, default `Asia/Kuala_Lumpur`).
  One time per task, so a task runs at most once a day.
- **Send to**: **one existing** chat or group of the agent's inbox, picked from a search list (groups first, then
  people). Never a phone number typed in, never a list.
- **Instruction** in plain words (≤ 1,000 characters), e.g. "Tell the team today's appointments from the calendar.
  Skip if there are none."

At the time, the agent runs **one turn** for that chat with its own knowledge and connector look-ups and sends **one
message** there, or nothing (`no_reply`) when there is nothing to say. The message shows in the chat like an AI
message with a **Scheduled · <task name>** mark.

Out of scope (v1): several times a day, monthly/one-off dates, several recipients, templates for the Business API
window, attachments, a task list outside the agent page, tasks for teammates (non-AI), catch-up of missed runs
beyond 15 minutes.

## Run (server)

`packages/server/src/scheduled/` (new; `repo.ts` is its only SQL):

1. **Scheduler** `scheduled/service.ts` (`ctx.services.scheduled`), started by an initializer after AI, like the
   phrase builder (`ai/phrases/service.ts`: first tick after a start delay, then `setInterval`, timers `unref`'d,
   stopped in `shutdown`). Tick every **30 s** (start delay 20 s). For each enabled task it computes the latest
   scheduled time `slot` ≤ now in `ai_timezone` (Intl, so daylight-saving zones work) and:
   - no row for `(task_id, slot)` and `now − slot ≤ 15 min` → **run**;
   - no row and `now − slot > 15 min` (the app was off or paused too long) → write one `skipped/missed` row for
     that slot only, never send. **No catch-up** later.
   - A unique key `(task_id, slot)` in `ai_scheduled_runs`, inserted **before** the turn (state `running`), makes
     each task run **at most once per scheduled time**, across restarts and two ticks.
2. **Pause**: while the agent is off or deleted, the AI connection is not `connected` (`expired`, `error`,
   signed out), the access gate is closed (`ctx.access`), or the inbox's WhatsApp is not connected, the slot waits;
   if the condition clears inside the 15-minute grace the task runs, else the row is `skipped` with the reason
   (`agent_off`, `ai_disconnected`, `access_closed`, `wa_disconnected`). The card shows the same pause as a banner.
3. **Checks before the turn** (fail closed → `skipped`): the chat still exists, is in the agent's inbox
   (`agentForChat` / inbox of the chat key) and is not a removed inbox (`chat_gone`); a Business API inbox with
   `capabilities.replyWindowHours` and a closed window (`replyWindowOpen`, `inboxes/reply-window.ts`) →
   `window_closed` (the free-form rule, no template in v1); a chat whose number moved → `chat_gone`.
4. **Turn**: `AiService.scheduledTurn(task, signal)` reuses the live path (`ai/agent/turn.ts`, `prompt.ts`): same
   `GUARDRAILS`, core and agent instructions; input `conversation` = the chat's last 20 messages (context only),
   `currentSituation` gains `scheduledTask: { name, instruction, now }` (date/time in `ai_timezone`) and **no**
   customer details beyond what the live prompt already gives for that chat type. Allowed decisions: `answer` (send
   the reply) and `no_reply` (send nothing → `skipped/nothing_to_say`). `handoff`, `ask_resolution` and `resolve`
   become `skipped/needs_team` (no hand-over, no notification, nothing claimed). `AGENT_MAX_STEPS` = 4, the normal
   turn timeout, no retries; a failure → `failed/ai_unavailable` or `failed/lookup_failed`.
5. **Tools**: `agentTurnTools(…, { lookupsOnly: true })` as a group turn has: knowledge search, Google Calendar
   `check_free_times`-style reads, Sheets `read_sheet_rows`, Drive `list_drive_files`/`read_drive_file`, SQL Account
   stock look-up only (no own-record tools: the scheduled chat is not "the customer" asking), MCP look-ups, extension
   look-ups. **Write tools: none in v1**, with one exception the owner asked for: Google Sheets `add_sheet_row` when
   that tab is already on **Add rows** for this agent. With no person's message in a scheduled turn, the
   "the person wrote it" rule leaves only the automatic columns unless the tab's `aiValues` switch is on (then
   looked-up or worked-out values, as documented in `docs/connector-design.md` Part D). Never `book_appointment`,
   `save_file_to_drive` (no inbound file), `sql_create_quotation` or an MCP write tool.
6. **Checks on the reply**: the leak check (`ai/leak-check.ts`, Internal items → `skipped/confidential_leak`), the
   WhatsApp format pass, ≤ 4,000 characters.
7. **Send**: `messages.sendText(jid, { text, clientId: 'sched-<runId>' }, aiUserId)` through the normal message
   service and **send queue** (FIFO per chat, ≥ 1 s gap, `composing` presence; `clientId` makes a retry idempotent).
   The send **never claims, assigns, reopens or resolves** the chat (like a group turn, `claimOnReply` skipped) and
   never notifies. `wa_unavailable` while queued keeps the job pending as today; `expired` → `failed/send_failed`.
   The row stores the message id, never the text.
8. **Groups**: a task may post to any group of the agent's inbox; it does **not** need the group's "AI answers in
   this group" switch, and posting does not turn it on. Replies people send afterwards follow the normal group rules
   (`ai/groups.ts`: only when the group is on for this agent and tagged/quoted/listening). A quote of the scheduled
   message counts as quoting the agent's AI user, as today.
9. **Direct chats**: allowed for an agent with Direct chats off (`answer_direct`) too: the admin chose that chat;
   the agent still does not answer the person's replies there unless it already owns the chat by the normal rules.

## Guards (WhatsApp ban risk)

- Existing chats and groups of the agent's inbox only; `chatJid` checked on save **and** before every run. Never a
  new number (`checkNumber` is never called), never a list, one message per run.
- At most **10 tasks per agent** (409 `scheduled_task_limit`).
- Once per scheduled time (unique `(task_id, slot)`), once a day per task (one time).
- Missed runs: only inside 15 minutes, never later.
- Paused while the agent is off, the AI connection is broken, the access gate is closed or WhatsApp is disconnected.
- Business API window closed → skipped with `window_closed`.
- **Run now** (admins): 3 per task per hour and 20 per admin per hour (429 `rate_limited`); same checks and send
  path, row `trigger = 'run_now'`, `by_user_id`.
- **Preview** (admins, Try it-style): one turn with `notRun` for every write tool, nothing sent or stored, 20 a
  minute per admin; answers `{ result: 'sent' | 'skipped', text | reason, lookups: [{ title, sourceLabel }] }`.
- Logs and audit: task, run and agent ids and the chat key only; never the instruction, the reply text or a name. Log lines `scheduled_run` {taskId, runId, agentId, result, reason, ms, tools: names}.

## Data (migration `036_scheduled_tasks.sql`)

```sql
CREATE TABLE ai_scheduled_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  time_minutes INTEGER NOT NULL CHECK (time_minutes BETWEEN 0 AND 1435),  -- minutes after midnight
  days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 127),                   -- bit 0 = Sunday … bit 6 = Saturday
  day_rule TEXT NOT NULL CHECK (day_rule IN ('daily', 'weekdays', 'custom')),
  chat_jid TEXT NOT NULL,                                                 -- opaque chat key; no FK (chats merge)
  instruction TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_scheduled_tasks_agent ON ai_scheduled_tasks(agent_id);
CREATE TABLE ai_scheduled_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES ai_scheduled_tasks(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,                 -- the scheduled time (ms); Run now: the press time
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'run_now')),
  by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'sent', 'skipped', 'failed')),
  reason TEXT,
  message_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX idx_ai_scheduled_runs_slot ON ai_scheduled_runs(task_id, slot) WHERE trigger = 'schedule';
ALTER TABLE messages ADD COLUMN scheduled_task_id INTEGER;  -- no FK: the mark outlives a deleted task
```

Runs are pruned to the last 100 per task. A start-up sweep turns rows left `running` (crash) into
`failed/interrupted`. `mergeChat` moves `ai_scheduled_tasks.chat_jid` like every table keyed by chat (identity
migration); removing an inbox or deleting/re-binding the agent disables its tasks (rows kept, `enabled = 0`).
`upgrade-from-oldest.test.ts` needs no seed change (new tables only).

## Contract (`packages/shared/src/scheduled-tasks.ts`)

```ts
ScheduledDayRule = z.enum(['daily', 'weekdays', 'custom']);
ScheduledTaskBody = z.object({
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5][05]$/),
  dayRule: ScheduledDayRule,
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),   // custom only, ≥ 1 then
  chatJid: z.string().min(1).max(200),
  instruction: z.string().trim().min(1).max(1000),
});
ScheduledRun = { id, at, trigger, byUserName: string | null, result: 'sent'|'skipped'|'failed', reason, messageId };
ScheduledTask = ScheduledTaskBody & { id, chat: { jid, name, type: 'dm'|'group' } | null, nextRunAt: number|null,
  lastRun: ScheduledRun | null };
ScheduledTasksResponse = { tasks, max: 10, paused: 'agent_off'|'ai_disconnected'|'wa_disconnected'|'access_closed'|null,
  timeZone: string };
ScheduledPreviewBody = { chatJid, instruction }; ScheduledPreviewResponse = { result, text: string|null,
  reason: string|null, lookups: { title, sourceLabel }[] };
Message.scheduledTask = z.object({ id: z.number(), name: z.string().nullable() }).nullable().default(null);
```

## Routes (admins; `requireAdmin`, Host/Origin checks as usual)

| Method | Path                                                   | Notes                                                       |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| GET    | `/api/ai/agents/:agentId/scheduled-tasks`              | list + paused + max + time zone                             |
| POST   | `/api/ai/agents/:agentId/scheduled-tasks`              | create; 409 `scheduled_task_limit`, 400 `chat_not_in_inbox` |
| PATCH  | `/api/ai/agents/:agentId/scheduled-tasks/:taskId`      | edit / on-off                                               |
| DELETE | `/api/ai/agents/:agentId/scheduled-tasks/:taskId`      | messages keep their mark                                    |
| GET    | `/api/ai/agents/:agentId/scheduled-tasks/:taskId/runs` | last 30                                                     |
| POST   | `/api/ai/agents/:agentId/scheduled-tasks/:taskId/run`  | Run now; 429, 409 `paused`                                  |
| POST   | `/api/ai/agents/:agentId/scheduled-tasks/preview`      | no send, 20/min                                             |

The chat picker reuses `GET /api/chats?inbox=<agent inbox>&q=` (admins see every inbox). Audit actions
`scheduled_task.create|update|delete|run_now` with `{ agentId, taskId, chatJid }` and changed field names, never the
instruction text. MCP and Ask Ezy get nothing in v1. Extensions: none (`ServerExtension` unchanged).

## Web

`admin/AgentScheduledTasksCard.tsx` (card, rows, menu: Edit / Run now / History / Delete), `ScheduledTaskDialog.tsx`
(ResponsiveDialog: name, Send to = Popover + Command search, Time + SegmentedControl days + day checkboxes,
instruction, Preview), `ScheduledRunsDialog.tsx`; `inbox/MessageBubble.tsx` shows the mark from
`message.scheduledTask`. Catalog keys `ai.scheduled.*` (admin) and `message.scheduled*` (inbox) in en/ms/zh-CN.
The card shows the business time zone by name (from the response), not "Malaysia time" as the mock does.

## Screens and states (checklist, all in the mock)

- [x] Agent page card with a few tasks (on, off; next run; last result Sent / Failed)
- [x] Empty (agent with no tasks)
- [x] Long list (10 of 10, Add disabled with the limit text, long name wraps, Show all / Show fewer)
- [x] Add dialog: validation errors; chat picker with search (groups and people); Every day / Weekdays / Chosen
      days with day checkboxes; time with the time-zone note; instruction hint; Preview → would send (with the
      look-up line); Preview → would send nothing (nothing to tell)
- [x] Edit dialog (same, filled)
- [x] Run now: confirm, sent toast with Open chat, 3-an-hour limit, blocked while paused
- [x] History: Sent (Open chat), Skipped (nothing to tell, WhatsApp off, missed), Failed (AI, look-up), Run now by
- [x] Chat view: "Scheduled · Morning bookings" on the AI message, the existing "AI used … · Google Calendar" line
- [x] Paused: agent off, AI not connected, WhatsApp off (banner + "Paused" on rows)
- [x] Business API window closed → preview/Run now "would send nothing" with the reason
- [x] Desktop 1280 / mobile 360 (touch), light and dark; en, ms, zh-CN

## Reused from the app (mock baseline)

Agent page cards (`AgentResolutionCard`, `AgentGroupsCard`: Card + Proposed badge + dashed Mock only box),
`ResponsiveDialog`, `SegmentedControl`, `ConfirmDialog`, `Banner`, Command/Popover picker, the chat list query, the
`ai_tool_used` chat line ("AI used <title> · <source>"), the group mock's AI send (`groups.ts#aiSay`).

## Owner decisions (proposed; change any)

1. One time per task (no "every 2 hours"); days Every day / Weekdays / Chosen days.
2. Missed runs: 15-minute grace, no later catch-up; a `missed` row shows in History.
3. Write tools: none, except Sheets `add_sheet_row` on a tab already set to Add rows.
4. Handoff from a scheduled turn = skipped, no notification (nobody asked a question).
5. Run now limits 3 per task / hour, 20 per admin / hour; Preview 20 / minute.
6. Groups need not have "AI answers" on; posting does not turn it on.
7. Business API: skip when the 24 h window is closed (no template in v1).
8. Admins only (agents cannot see or edit tasks); the mark in the chat is visible to everyone with inbox access.

## Open questions for the owner (answered 2026-11-06: all as proposed)

1. Is 10 tasks per agent right for Lite and Enterprise alike?
2. Should a skipped/failed run notify admins (push), or only show in History? (Proposed: History only.)
3. Business API inboxes: v1 skips outside the 24 h window. Add "send a template instead" later?
4. Allow `add_sheet_row` (proposed) or keep scheduled turns strictly read-only?

Answers: 1 yes, 10; 2 History only; 3 skip now, template later; 4 allowed. Owner decisions 1-8 stand as proposed.

## Mock and confirmation

- Mock: [mock/index.html](mock/index.html) (full app clone; README in [mock/README.md](mock/README.md)).
  Run `npx tsx --conditions=ezychat-source docs/features/scheduled-tasks/mock/run.ts --fake-wa`, open
  `http://localhost:7489/`, sign in `aisyah` / `demo-pass-123`, Admin → Members → Aina (press **Turn on** first:
  the seeded agent is off, which shows the paused state).
- Screenshots: `node docs/features/scheduled-tasks/mock/scheduled-shots.mjs` → [mock/screenshots](mock/screenshots)
  (64 shots, 0 page errors, 0 horizontal overflow at 1280 and 360, light and dark; ms and zh-CN on desktop light).
- **Baseline**: cloned from the latest owner-confirmed mock in `mock-index.json`, **google-drive**
  (`docs/features/google-drive/mock`, confirmed revision `442b6317254a1a86b7df66bb86335f2d0047caec`; copied from
  `main` `171f3aa`, where that folder is unchanged since merge `b551a47`). Per the index note, the confirmed
  **sql-accounting** mock files (revision `e33aabbd`) were merged in with a three-way merge against
  group-management `26116d59` (both added connector cards and catalog keys side by side; conflicts resolved by
  keeping both). Screenshots were not copied.
- Intentional changes over the baseline: added `scheduled-tasks.ts`, `scheduled-shots.mjs`,
  `src/admin/AgentScheduledTasksCard.tsx`, `src/mock/scheduledTasks.ts`, `src/mock/ScheduledMark.tsx`; changed
  `proposal.ts`, `seed.ts`, `run.ts` (temp folder name), `reference.json`, `README.md`, `src/admin/AgentPage.tsx`,
  `src/inbox/MessageBubble.tsx` and `mockScheduled` keys in `src/i18n/locales/{en,ms,zh-CN}/{admin,inbox}.json`;
  plus the sql-accounting merge (see `reference.json` → `baselineAdditions.sqlAccounting`).
- Inherited coverage gaps: those of google-drive / group-management (message-edit-delete, whatsapp-safety,
  group-agents and claims-template screens).
- **Retention**: this is the sixth feature folder, so `claims-template` (creationOrder 30, the oldest) is removed
  in this PR; its last revision is recorded in the index. **Parallel work**: another session adds
  `docs/features/partner-role` on its own branch at the same time. Whichever PR merges **second** resolves
  `mock-index.json` (both entries kept, next `creationOrder`) and removes the then-oldest folder
  (`group-management`, 31) so five remain.
- Confirmation: Owner (Jazz) confirmed the mock 2026-11-06 (relayed by the main session, session_01J4pmGkCf1Mvdepudm8WQAd) "with the proposed answers": 10 tasks per agent; skipped/failed runs in History only (no push); Business API outside the 24 h window skipped for now (template later); add_sheet_row allowed. Confirmed mock revision `426c2eb766f24e520fd4f59b66ab837c11296045`.
