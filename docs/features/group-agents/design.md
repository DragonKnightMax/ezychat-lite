# Group agents: several AI agents per number, sheet tabs per agent

Status: **confirmed by the owner 2026-11-03** on the preview mock (see "Mock and confirmation"); built in PR #269 (unit tests, e2e; Dev Build with real AI, WhatsApp and Google is the owner's check). Created 2026-11-03 (creationOrder 29). Branch `claude/determined-feynman-y5uo0g` from `main`
(`1564247`).

## Owner request (2026-11-03)

- "on google sheet connector, can we allow user to define recording like? capture the claim information into
  google sheet?"
- "the instruction should be on agent, connector only control what tab available to use, and now we need allow
  create diff agent to handle diff group chat in enterprise, so that we can allow business to easily create claim
  recording agent, type basic instruction, add gsheet connector and choose the tab for custom use and disable
  other lead, product use, and we define the agent like when receive claim in these format capture it and save
  into tab {tab name} in google sheet".
- Owner answers (2026-11-03):
  1. In a group the claim agent reads **every** member message (not only when tagged or quoted).
  2. No reply setting: whether and how the agent confirms in the group is written in the agent's instructions.
  3. Lite keeps **1** AI agent; Enterprise sets its own agent limit, independent of the number of inboxes.

## Target journey (Enterprise)

1. Admin → Members → **New AI agent** → preset Custom, name "Claims agent", instructions:
   "When a member posts a claim in this format (Policy no, Date, What happened, Amount), save it to the tab
   **Claims**. Reply 'Recorded ✅' quoting the message. If a detail is missing, ask for it."
2. Agent page: **Direct chats** off, **Groups** on.
3. Connectors → Google Sheets → Settings → agent "Claims agent": choose the spreadsheet, tab **Claims** = Add
   rows, every other tab Off (Products, Leads).
4. Group info of each claims group: **AI agent** = Claims agent, **Reads every message** on.
5. A member posts a claim → the agent saves one row to Claims and replies as its instructions say.

## Part A: Google Sheets gives tab access, the agent has the instructions

| Rule      | Proposal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings  | Per agent: one spreadsheet (unchanged) and a list of its tabs, each **Off**, **Read** or **Add rows**. Replaces `lookupTab`/`lookup`/`leadsTab`/`addLeads` in the JSON `sheets_agent_settings.settings` (no table change).                                                                                                                                                                                                                                                                                                                                                   |
| Upgrade   | Permanent start-up code maps the old fields: `lookupTab` + `lookup` → Read, `leadsTab` + `addLeads` → Add rows. An agent that used Add leads gets one line appended to its saved instructions only if it has none about the sheet: "Add customers who want to buy to the tab {leadsTab}." (audited, kept as a setup version).                                                                                                                                                                                                                                                |
| Tools     | `read_sheet_rows {tab, query}` and `add_sheet_row {tab, values: {column: value}}`. Their descriptions list only this agent's tabs for that access, each with its column names (first row, read when the turn starts, cached 5 min). No tab on Add rows = no `add_sheet_row`; same for Read.                                                                                                                                                                                                                                                                                  |
| Columns   | Values are matched to the tab's first-row names (case and spacing ignored); unknown names are refused with the list of valid ones. Columns named Date, Name, WhatsApp, Group, AI agent are filled by EzyChat (business time zone, saved/WhatsApp name, the sender's number, the group's name so one sheet can serve many groups, e.g. one per branch, agent name) unless the AI passes a value.                                                                                                                                                                              |
| Empty tab | Add rows needs a first row; Settings shows "Add column names in the first row of this tab" and the tool is not offered for it.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Refresh   | Settings shows when the tabs were last checked and a **Refresh** button: `POST /api/connectors/google-sheets/agents/:agentId/refresh` (admins, 1 a 10 s per install) reads the tab names and first rows from Google again and clears the 5-minute column cache, so the AI uses the new columns from its next reply. Result marks a new tab (Off until an admin turns it on), changed columns and a removed tab (its access is dropped on Save, never silently). Opening Settings also checks once.                                                                           |
| Guards    | Values written with `valueInputOption=RAW`. Every value the AI passes (other than auto columns) must come from the person it records for (the customer in a direct chat, the member in a group): their text, or a file they sent (see Part C). A typed value must appear in their messages (spacing/case ignored, numbers and dates normalised); a value read from a file is allowed only when the turn was given that file. Else refused with "ask the person for it". Never in Try it.                                                                                     |
| Limit     | No limit on rows: a tab can keep growing for as long as the business uses it. One guard only: the same row is never saved twice (key: chat, tab, message id and a hash of the values, so a retry or a re-read batch adds nothing, while one PDF with three invoices still adds three rows). Rows are added only in a turn started by a person's message, so the AI cannot loop on its own. Google's per-minute write quota is handled by queueing (retry after the minute), never by dropping a row. Migration adds `tab`, `message_id` and `values_hash` to `sheets_leads`. |
| Prompt    | No sheet text in `CORE_RULES` (unchanged connector-neutral rule). The tool descriptions carry the tabs; the agent's instructions say when to use them.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Logs      | Activity: who, when, agent, tab, `row_added` / `looked_up` / `failed`; never values. Log lines: tool, tab count, ok, ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Presets   | The Sales preset text gets "Add buyers to the leads tab when one is available" so new sales agents keep today's behaviour.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Part B: several agents per WhatsApp number (Enterprise)

| Rule                | Proposal                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Limit               | `runCli({ maxAgents })` separate from `maxInboxes` (default `maxInboxes`, so Lite stays 1 and nothing changes without the option). Enterprise passes its own number. 409 `agent_limit` unchanged.                                                                                                                                                                                                                   |
| Direct chats        | Still at most **one** agent per inbox answers direct chats (the agent with Direct chats on). 409 `inbox_has_direct_agent` replaces `inbox_has_agent` for a second one; any number of group-only agents per inbox.                                                                                                                                                                                                   |
| Groups              | `ai_group_chats` gains `agent_id` (migration). Group info → AI: switch **On** + **AI agent** select (agents of this inbox with Groups on). Existing rows get the inbox's current agent. `agentForChat` for a group = its row's agent; direct chat = the inbox's direct agent.                                                                                                                                       |
| Reads every message | `ai_group_chats.listen` (default off). Off = today's rule (tag or quote). On = every live member message of that group starts a turn of that group's agent. The turn may end with `no_reply` (nothing sent). Only live messages, never history, never the linked number's own or an AI message.                                                                                                                     |
| Writes in groups    | Today a group turn is look-ups only. New: a group turn may use `add_sheet_row` (only this tool; booking and connector writes stay off in groups). Values must come from the message's sender. Group hand-over unchanged.                                                                                                                                                                                            |
| Batching            | Listen mode has no daily cap. Messages arriving close together in one group are handled as one turn (it starts 8 s after the last message and sees all new ones), so a claim sent as text + photo + PDF is one turn. Loop guard in listen mode: the AI pauses only after 10 AI messages in a row with no person's message between them (a busy group of members never trips it); tag/quote mode keeps today's rule. |
| Assign / release    | Removing an agent, turning its Groups off or deleting it turns its groups' AI off (rows kept, agent cleared), never moves them to another agent.                                                                                                                                                                                                                                                                    |
| Routes              | `PUT /api/chats/:jid/ai-group` {enabled, agentId?, listen?}; `GET` adds `agentId`, `listen`, `agents` (choices). Old body {enabled} keeps working (agent = the only group agent of the inbox, else 400 `agent_required`).                                                                                                                                                                                           |
| Audit               | `ai.group_switch` adds agentId and listen before/after.                                                                                                                                                                                                                                                                                                                                                             |

## One agent, many groups (owner use case 2026-11-03)

One Claims agent listens to "Claims KL", "Claims Penang", "Claims JB" (one group per branch) and saves every claim
to the same Claims tab of one spreadsheet, where the team processes them. Nothing per group needs its own agent,
connector or tab:

- Agent page → Groups card lists the agent's groups (exists today) and gains **Add groups**: a multi-select of
  this inbox's groups, each added with Reads every message on. Each row has its Reads every message switch and
  Remove. Group info shows the same setting for one group (both write `ai_group_chats`).
- The Group column (auto) tells the team which branch a row came from; a Branch column can instead be filled by
  the agent's instructions ("Branch = KL for Claims KL").
- One Google sign-in, one spreadsheet, one tab for all groups.

## Part C: values from images and PDFs (invoices, claim forms, receipts)

| Rule          | Proposal                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Images        | Already supported: a turn gets the newest images of the batch (`ai/images.ts`: JPEG/PNG/WebP, ≤ 5 MB). New: up to 10 images per turn when the agent has a tab on Add rows (an invoice photo set), else 3 as today.                                                                                                                                                                                |
| PDFs          | New: PDFs sent by the person go to the model as files (AI SDK `type: 'file'`, `application/pdf`; OpenAI and Claude read text and scanned pages). ≤ 10 MB and ≤ 20 pages each, at most 3 per turn. A provider mode that cannot take files gets the PDF's text layer instead (`document-worker.ts`, the Business context extractor); a scanned PDF there is skipped and the agent asks for a photo. |
| Safety        | Only files that WhatsApp Safety did not flag High (quarantined files never reach the model). File type from the bytes, never the name. Word, Excel, ZIP and other files are not read (agent says it cannot open them).                                                                                                                                                                            |
| Source column | A tab with a column named Source (or File) gets the file name and the message time automatically, so the team can find the original in the chat. The file itself stays in EzyChat; saving files to Google Drive is a later step.                                                                                                                                                                  |
| Wrong reads   | The model can misread a blurry photo. Instructions can ask the agent to repeat the key values in its reply ("Recorded: INV-1042, RM 1,250.00 ✅") so the sender can correct it; a correction is saved as a new row (no row updates in this version).                                                                                                                                              |
| Logs          | File count, pages and type only; never file names, content or values.                                                                                                                                                                                                                                                                                                                             |

## Screens (mock checklist)

1. Admin → Members: two AI agents on one inbox (Sales: direct chats; Claims: groups only), New AI agent allowed
   until the edition's limit; Lite at its limit shows the existing upgrade hint.
2. Agent page Direct chats card: switching on for a second agent of the inbox → error "Sales agent already
   answers direct chats on this number".
3. Google Sheets → Settings per agent: spreadsheet, tab list (Off / Read / Add rows), column names under each tab, Refresh (new tab, changed columns),
   empty-first-row warning, a tab Google no longer lists, Claims agent with only Claims on Add rows.
4. Agent page → Connectors row: "Reads Products · Adds rows to Claims".
5. Agent page Groups card: Add groups (multi-select), three branch groups listening, Remove.
6. Group info: AI switch, AI agent select (one / several / none with Groups on), Reads every message switch with
   InfoTip.
7. Group chat: member posts a claim → AI reply per instructions ("Recorded ✅"), missing-detail question, a
   chat message that is not a claim (no reply).
8. Activity tab: row added to Claims, failed (value not in the message).
9. Group chat: member sends an invoice PDF and a receipt photo → one row each, reply repeats the key values; a
   Word file → "I can read photos and PDFs only".
10. Desktop 1280 / mobile 360, light and dark; en, ms, zh-CN.

## Baseline

Clone of the latest confirmed mock `docs/features/group-mentions/mock` at `f6f0d2b06f53c95c6b31c5994af00ef52cf5def4`
plus the screens of `whatsapp-safety` and `message-edit-delete` (index note), and the Google Sheets screens built
in `apps/web/src/admin/connectors/` (`SheetsSettingsCard.tsx`, no confirmed mock yet). Reused: agent page cards
(`AiMemberPage.tsx`: Direct chats, Groups, Connectors), Group info AI switch (ai-groups), `ConfirmDialog`, `SaveBar`.

Retention: 6th folder; `ai-direct-chats` (creationOrder 23, confirmed, last revision on `main` `1564247`) is
pruned in the same change.

## Open points (my calls, easy to change)

1. Sheet values are checked against the sender's own messages and files; a member posting a claim for someone
   else is fine as long as the values are in that member's message or file. Values read from a photo cannot be
   checked by the server; the reply that repeats them is the check.
2. PDFs ≤ 10 MB / 20 pages, up to 3 PDFs and 10 images per turn.
3. Batch window 8 s for listening groups.
4. Several agents per inbox and listen mode are core code; only the limit comes from the edition, so Lite with
   its 1 agent can also use listen mode in a group.

## Build plan (after confirmation)

1. Shared: `SheetsAgentSettings.tabs`, `AiGroupChat.agentId/listen`, `maxAgents` in health/edition info.
2. Server: start-up settings mapping; `add_sheet_row`/`read_sheet_rows` with tab + columns; guards; migration 031
   (`ai_group_chats.agent_id`, `listen`; sheet row log `tab`, `message_id`); `runCli({ maxAgents })`;
   direct-agent rule; group routing by `agent_id`; listen batching and loop guard; PDF file input per provider
   mode with text fallback; image limit 10 for record agents; upgrade test seed.
3. Web: Sheets tab list, Group info agent select + listen switch, agent errors; en/ms/zh-CN.
4. Enterprise: pass `maxAgents` (separate PR after the core release).

## Mock and confirmation

- **Preview (2026-11-03):** `mock/preview.html`, a standalone clickable preview of the new screens in the app's
  colour tokens (open the file in a browser; Mock only bar switches screens, simulates claims, Dark/Light).
  Screenshots desktop 1280 and mobile 360 in `mock/screenshots/` (no horizontal scroll at 360 px). Shown to the
  owner for direction.
- **Owner confirmation 2026-11-03:** after the preview screenshots, the Refresh button and the tool explanation the owner
  wrote "look good, implement it until it done with test, than create PR and merge". The owner chose to build from the
  preview; the cumulative full-app mock was not made (a recorded gap, not an approval of the rule's skip).
- **Not made:** the cumulative full-app mock (clone of `group-mentions` at `f6f0d2b` plus the
  WhatsApp Safety and edit/delete screens) with these screens added, and the owner's confirmation of it.
