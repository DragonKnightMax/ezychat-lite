# Google Drive connector

Status: **confirmed 2026-11-05, built** (see "Mock and confirmation" and "As built").
Created 2026-11-05 (creationOrder 33). Owner request (Jazz, 2026-11-05): a Google Drive connector so an AI agent can
(1) save files to Google Drive and (2) read files from Google Drive, both through one connector. Built like Google
Sheets (`packages/server/src/connectors/google-sheets/`, design in git history `docs/features/google-sheets/design.md`
at `f3e8f37`) on the shared Google sign-in `connectors/google-account.ts`.

## Scope

A core (Lite and Enterprise) built-in connector, listed in Admin → Connectors beside Google Calendar and Sheets
(`builtin` entry `google-drive` in the connector list and in `connectors/list/builtin-list.ts`):

- **Sign-in**: its own Google account connection (`google_drive_tokens`, `google_drive_problem`), separate from
  Calendar and Sheets, so disconnecting one never stops another. Scope `drive.file` only.
- **Per AI agent**: one **folder** (picked in Google's own file picker), **Save files** (off by default; a change to
  the business's data), **Read files** (on by default once a folder is picked) with the list of **files the AI may
  read** (picked in the picker, at most 50). Nothing else: the connector is **use-case agnostic**
  (`docs/connector-design.md`, owner 2026-11-05). What to save or read, when, and into which sub-folder is said in the
  agent's **instructions** on the agent page; the Settings tab only links to them.
- **AI tools** (core names reserved): `save_file_to_drive`, `list_drive_files`, `read_drive_file`.
- **Activity** (who and when) and the chat line "Aina saved a file to Google Drive" / "Aina read a file".

Out of scope (v1): editing, renaming, moving or deleting Drive files; reading files the admin did not pick; Shared
drives' special permissions beyond what `drive.file` gives; OCR of scanned PDFs or images; Google Slides; video and
audio saving (a voice note is not a file to keep).

## Google scope decision (recorded 2026-11-05)

What `drive.file` gives (Google "Choose Drive API scopes"; non-sensitive): per-file access to files **the app
created** and files **the user opened or shared with the app through the Google Picker**. Picking a **folder** in the
picker (`setSelectFolderEnabled(true)`) grants access to that folder item: the app can create files and sub-folders
in it, and everything it creates stays accessible. Google documents nothing that extends the grant to the folder's
**existing children**; developer reports (Nango, product-oracle #81) find files inside a picked folder still answer
404 until each is picked. So with `drive.file`:

| Need                                         | `drive.file`                  |
| -------------------------------------------- | ----------------------------- |
| Save into the picked folder (+ sub-folders)  | Yes                           |
| Read files EzyChat saved                     | Yes                           |
| Read files the admin picks in the picker     | Yes (each file, multi-select) |
| Read any file already in the folder, unasked | No (would need a wider scope) |

Options for reading "whatever is in the folder":

| Option                                  | Classification | Google cost                                                                          | Reach                     |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------ | ------------------------- |
| A. `drive.file` + admin picks the files | Non-sensitive  | None beyond brand verification (already done for Sheets)                             | Only what is picked       |
| B. `drive.readonly`                     | Restricted     | Restricted-scope review + yearly third-party security assessment (CASA), weeks, paid | Every file in the account |
| C. `drive` (full)                       | Restricted     | Same as B                                                                            | Every file, read + write  |

**Decision: A.** It meets the request (save into a folder; read the files the business wants the AI to answer from)
with the least privilege, no new Google review, and the same picker the owner already enabled for Sheets
(`GOOGLE_PICKER_API_KEY`, `GOOGLE_PICKER_APP_ID`). The cost is one step for the admin: **Add files** in the picker
(multi-select, opened in the agent's folder). B/C would give a desktop app read access to the whole Drive of the
business for a feature that needs a handful of files; not worth the audit or the risk. If owners later ask for "read
everything in the folder", revisit with B as a separate, opt-in sign-in.

Owner to do in `ezychat-prod` (once): add `https://www.googleapis.com/auth/drive.file` to the consent screen if not
already there (Sheets added it), keep the Picker API enabled; no new secret.

## Rules (fail closed)

**Save files** (`save_file_to_drive {file, subfolder?}`):

1. The tool lists this chat's newest inbound files of the last 24 hours (at most 10; in a group only those of the
   turn's senders) as labels `file1`…`file10` and the model picks a **label** (never a URL, path, bytes, message id
   or file name from the model). The server maps the label to the stored message and checks: same chat, inbound
   (`from_me = 0`), not deleted, has media, media downloaded (history media `pending` is downloaded on demand first,
   like `GET /api/media/:id`), any media type (photo, document, video, voice note), size ≤ **25 MB**.
2. **WhatsApp Safety**: never a message with a High safety item or quarantined media (`safety_locked`), never a
   `cantInspect` ZIP. Refusal text tells the AI to hand over (`sensitive`), and Activity records "skipped".
3. In a **group** (decided: allowed, like `add_sheet_row`, the one other write a group turn keeps): only when the
   agent answers that group and the message was sent by a member in the turn's batch (`SheetRecordContext`
   personJids/messageIds), so a later message cannot make the AI save someone else's older file.
4. **Never twice**: table `drive_saved_files` keyed by (agent, chat, message id, folder id); a retry answers
   "already saved" and adds nothing.
5. **Name**: EzyChat names it `YYYY-MM-DD HHmm <Photo|PDF|Document> <4-char ref>.<ext>` in the AI time zone, the
   extension from the type read from the bytes (not the customer's file name). Sub-folder: optional `subfolder` the
   agent passes when its instructions say so (e.g. "a folder per customer"); one level, sanitised (no `/`, control
   or bidi characters, max 80 characters), else the folder itself. Sub-folders are created by EzyChat (so
   `drive.file` covers them) and remembered by id (`drive_folders`).
6. **Try it** never saves (`notRun`). Save files off, no folder, Google expired/unreachable → the tool is not
   offered or answers "not available"; a Google failure ends the turn with `lookup_failed` (hand-over), like Sheets.
7. Upload: Drive API v3 multipart (≤ 5 MB) or resumable upload (> 5 MB), `uploadType` with `supportsAllDrives=true`,
   parents = the folder; the AI is told "saved" only after Google answers with the new file id.

**Read files** (`list_drive_files {query?}` + `read_drive_file {fileId}`):

1. Offered only when Read files is on and at least one picked file is readable. `list_drive_files` returns only the
   agent's picked files (name, kind, modified time, id) that match the words of `query` (all when ≤ 20).
2. `read_drive_file` accepts only an id from that list (others: "not available"). Google Docs → export
   `text/plain`; Google Sheets → export `text/csv` (first sheet); PDF / Word (.docx) / text / CSV / Markdown → download
   ≤ 10 MB and extract with the existing `extractKnowledgeIsolated` worker (unpdf, mammoth). Text capped at
   **20,000 characters** per call (the rest summarised as "truncated; ask for a narrower question"), cached 2 minutes.
3. Results are **facts for the reply**, data never instructions (same wording as `read_sheet_rows`); a Drive look-up
   counts as a look-up source (`agentLookupsAvailable`), so an agent with readable files may run with an empty
   Business context.
4. Files a customer sent and the AI saved are **never** readable through these tools (no cross-chat leaks): the read
   list holds only files an admin picked.
5. Allowed in group turns and Try it (look-ups).

**Logs, audit, Activity**: logs carry event, tool, ok, ms, counts, sizes and kinds only; never file names, contents,
folder names or customer names. Audit `google_drive.connect` / `.disconnect` / `.agent_settings` {agentId, fields}.
Activity rows store kind, agent id, chat id, time and reason (`saved`, `read`, `skipped` {safety|size|unavailable},
`failed`); the page joins the chat's name at read time like Sheets. Chat line: `ai_tool_used` with `drive`
{action: saved|read}.

## Server

- `connectors/google-drive/` — `drive.ts` (Drive v3 client: files.get, files.list by ids, create folder, multipart
  and resumable upload, export, download with byte cap), `service.ts`, `tools.ts`, `repo.ts` (only SQL), `fake.ts`
  (`FakeGoogleDrive`: picker grants, folders, uploads in memory; `/api/dev/fake-google-drive*`), `names.ts` (file and
  folder names), picker page reuse (`picker-page.ts` made generic: view = folders or files, multi-select, parent).
- Migration 034: `drive_agent_settings` (agent_id PK, settings JSON), `drive_saved_files`, `drive_folders`,
  `drive_activity`. `chats/merge.ts` moves the chat-keyed rows.
- Routes `/api/connectors/google-drive/*` (admins): status, connect, progress, host-only callback, disconnect,
  `POST /picker {kind: folder|files, agentId}` + `GET /picker/:requestId`, picker page/config/result (host-only,
  one-time token, 10 min), `GET/PUT /agents/:agentId`, `GET /activity`.
- Shared contract in `packages/shared` (`DriveAgentSettings`, status, picker, activity) first.

## Web

`admin/connectors/GoogleDrivePage.tsx` (Overview / Settings / Activity, `?tab=` and `&agent=`), reusing
`google-connect.tsx`, the account-card layout of `GoogleSheetsAccountCard.tsx`, `AgentPicker`, SaveBar and paused
banner patterns of `SheetsSettingsCard.tsx`; `AgentConnectorsCard.tsx` row; catalog `connectors.googleDrive.*` in
en / ms / zh-CN; InfoTip `driveFiles` ("Why pick files?"); every screen at 360 px.

## Screens and states (checklist, all in the mock)

- Gallery: Google Drive card (Not connected / Connected / Needs attention) beside Google Calendar.
- Overview: About (Save a file = changes data; Find, Read = look-ups), account card (not connected with Connect,
  consent with the `drive.file` wording, connected, sign-in expired with Sign in again, unreachable, Disconnect
  confirm), Your data.
- Settings: not connected; no folder; folder picker (and blocked window); folder chosen (Open in Google Drive, Choose
  another folder: clears the picked files); Save files switch disabled without a folder, on with the four safety
  rules; Read files with the file list (kind, text size, no-text warning, remove), Add files picker opened in the
  folder, at most 50; one line linking to the agent's instructions; Save bar (unsaved, discard); paused banner; 2+ agents
  picker (inherited `AgentSettings`).
- Activity: empty, saved, read, skipped (Safety, too large), failed.
- Agent page → Connectors: "No folder chosen", "Saves files", "Reads N files", "Saves files and reads N files", Off.
- Mock only simulator: photo saved, PDF, question answered from a picked file, no readable file, Save files off,
  Safety-locked, too large, paused → hand-over.

## Reused from the app

| Part                                              | Source                                                        |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Google sign-in (PKCE, loopback, encrypted tokens) | `connectors/google-account.ts`                                |
| File picker page, one-time session, CSP           | `connectors/google-sheets/picker-page.ts`, `service.ts`       |
| Tool wrapper, `ai:tool_call`, `lookup_failed`     | `connectors/google-sheets/tools.ts`, `ai/agent/turn-tools.ts` |
| Who the record is for in a group                  | `connectors/google-sheets/record.ts` (`SheetRecordContext`)   |
| PDF / Word text                                   | `ai/knowledge.ts` via `extractKnowledgeIsolated`              |
| Safety lock                                       | `safety/service.ts`, `routes/media.ts` (`safety_locked`)      |
| Pages, cards, SaveBar, picker states              | `admin/connectors/*` (Sheets)                                 |

## Owner decisions (my calls, easy to change)

1. Scope `drive.file`, read = files the admin picks (option A above).
2. Save files **off** by default; Read files **on** once a folder is picked. No use-case settings on the connector
   (owner 2026-11-05): sub-folders and which files to keep come from the agent's instructions.
3. Saving allowed in **groups** (sender of the batch only), like Sheets rows.
4. Limits: 25 MB a saved file; 50 readable files per agent; 10 MB per read file and 20,000 characters per read.
5. Any media type up to 25 MB (the instructions say which to keep).
6. Separate Google sign-in from Calendar and Sheets.
7. Beta badge in the connector list while it is new, like Sheets.

## Mock and confirmation

Mock: `docs/features/google-drive/mock/` (clone of `group-management` at `26116d59b3b9ca31b202163dc599cb96b1bf6f5e`,
the `latestConfirmed` baseline), README at the top of `mock/README.md`, intentional changes in `mock/reference.json`
→ `proposalChanges`, screenshots `mock/screenshots/` (`drive-shots.mjs`, 16 states × desktop/mobile × light/dark, no
page errors, no horizontal overflow). Retention: `in-app-feedback` (creationOrder 28) removed, last at `32a58d6`.

Confirmation: owner (Jazz) 2026-11-05, first on the agnostic rule ("so the connetor should be use case agnostic, Agent
will have instruction in agent setting, not on connector"; the mock was revised, rule recorded in
`docs/connector-design.md`), then relayed verbatim by the main session: "what confirm drive, google drive need allow
read and write", and in the owner's exact words relayed later the same day: "yes confirm drive, continue it,
untill all working and create pr and merge and archive the session" = confirmed with both capabilities (Save files = write, Read files = read) and decisions 1–7 as
proposed. Confirmed mock revision: `442b6317254a1a86b7df66bb86335f2d0047caec`.

## As built (differences from the text above)

- Save input is a file **label** (see Rules), not a message id: the model never sees message ids.
- Skip reasons are `safety`, `size` and `unavailable` (download failed); "already saved" is a success, not a skip.
- Drive's private app property `ezychatKey` (hash of message + folder) lets a retry after a crash find the file it
  already uploaded, besides the `drive_saved_files` record.
- The Settings file list shows the kind only (no text size: the server does not download files to list them).
- Not built: the connector list repo entry (`anchorsprint/ezychat-connectors`) — the app's `builtin-list.json` carries
  the entry until the repo publishes one.
