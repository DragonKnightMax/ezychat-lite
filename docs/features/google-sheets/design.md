# Google Sheets connector

Status: **built, mock not yet confirmed by the owner** (see "Mock and confirmation" below).
Created 2026-11-02 (creationOrder 27). Builds on the Google Calendar connector (design in git history:
`docs/features/google-calendar/design.md` at `d249783`) and the connector list
(`anchorsprint/ezychat-connectors`, entry `connectors/google-sheets/`).

## Scope

A core (Lite and Enterprise) built-in connector, like Google Calendar:

- **Choose a sheet**: the admin picks the spreadsheet in **Google's own file picker** (search, recent
  files). EzyChat gets access only to the picked files (`drive.file`), never to the rest of the Drive.
- **Read rows** (look-up, on by default once a sheet is chosen): the AI agent reads one tab of one
  spreadsheet (first row = column names) and answers prices, stock, opening hours or a FAQ from it.
- **Add leads** (changes data, off until an admin turns it on): the AI adds the customer as one row of a
  second tab: date (AI time zone), name, WhatsApp number, email, a one-line request, AI agent name.

Out of scope: editing or deleting existing rows, several spreadsheets per agent,
reading more than A1:Z1000, formulas, charts.

## Reused from the app

| Part                                                                      | Source                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Gallery card, page header, Beta badge and notice                          | `admin/connectors/ConnectorsGalleryPage.tsx`, `connector-ui.tsx` (`useBuiltinEntry`) |
| Overview / Settings / Activity tabs, `?tab=` and `&agent=`                | `ConnectorDetailPage.tsx` (Google Calendar tabs minus Bookings)                      |
| Google sign-in window, polling, blocked-window and cancel states          | `google-connect.tsx` (moved out of `GoogleCalendarAccountCard.tsx`, now shared)      |
| Account card, expired / unreachable banners, Disconnect dialog            | `GoogleSheetsAccountCard.tsx` (same layout as Google Calendar's)                     |
| Per-agent card, switches, SaveBar, paused banner                          | `SheetsSettingsCard.tsx` (same patterns as `BookingSettingsCard.tsx`)                |
| Agent page → Connectors row                                               | `AgentConnectorsCard.tsx`                                                            |
| Server sign-in (PKCE, loopback callback, encrypted tokens, problem state) | `connectors/google-account.ts` (generic version of the calendar's)                   |

## Server

- `connectors/google-sheets/` — `sheets.ts` (Sheets API v4: spreadsheet meta, values A1:Z1000, append with
  `valueInputOption=RAW` so a customer's `=…` is never run), `match.ts` (rows for a query: whole tab up to
  20 rows, else word/CJK-character score, ≤ 20 rows and 8,000 characters), `service.ts`, `tools.ts`,
  `repo.ts` (only SQL), `fake.ts` (`--fake-wa` without a Google app).
- Migration 030: `sheets_agent_settings`, `sheets_leads`, `sheets_activity`. Chat merge and the Lite →
  Enterprise import move them (settings and lead records only when both use the same Google account).
- Routes `/api/connectors/google-sheets/*` (admins): status, connect, progress, host-only callback,
  disconnect, `POST /picker` + `GET /picker/:requestId` (file picker session and its result),
  `POST /spreadsheet {link}` (name and tabs of a sheet already picked), agents/:agentId GET/PUT, activity.
- File picker (`picker-page.ts`): `picker-page`, `picker.js`, `picker-config` (a fresh access token,
  once per session) and `picker-result` are **host-only** (like the callback), guarded by a one-time token
  (10 min). The page has its own CSP allowing only Google's picker script and frames; the app window's
  CSP is unchanged (the picker opens in the system browser). Needs `GOOGLE_PICKER_API_KEY` +
  `GOOGLE_PICKER_APP_ID` (env, or bundled by `scripts/google-oauth-define.mjs` from release secrets);
  without them real-Google builds show Not available. The fake picker lists the fake's sheets. Dev: `/api/dev/fake-google-sheets` (state), `/api/dev/fake-google-sheets/consent`.
- AI tools `read_sheet_rows` {query} and `add_lead_row` {request, name?, email?} (core names reserved).
  Guards for a lead row: switched on, a direct chat (never a group, never Try it), at most one row per chat
  and spreadsheet in 24 hours, a name (saved/WhatsApp, or written by the customer in this chat), an email
  only as the customer wrote it. A Google failure ends the turn with `lookup_failed`.
- Logs and Activity: who and when only, never row values or chat text.

## Screens and states (checklist)

- Gallery: card (Not connected, Connected, Needs attention, Beta from the list).
- Overview: About with both tools, Beta notice, account card (not configured, disconnected with Connect,
  waiting for Google, blocked window, cancelled/expired/error, connected, expired, unreachable),
  Disconnect dialog, Your data.
- Settings: not connected; connected with no sheet; Choose a sheet (picker window, blocked window,
  cancelled, expired, could not open); sheet chosen (name + Open in Google Sheets, Choose another sheet); Read rows tab choice; Add leads switch (disabled without a sheet) + tab choice; validation;
  paused banner (expired / unreachable); a saved tab Google no longer lists; 2+ agents picker.
- Activity: empty, looked up, lead added, failed.
- Agent page → Connectors: Reads the sheet / Reads the sheet and adds leads / Adds leads / Off.

## Owner decisions still open (my calls, easy to change)

1. **Google scope**: owner chose 2026-11-02 option A, Google's file picker with `drive.file`
   (non-sensitive: only the files the admin picks). Owner to do in `ezychat-prod`: add `drive.file` to the
   consent screen, enable the Google Picker API, create a browser API key limited to the Picker API, and
   add repository secrets `GOOGLE_PICKER_API_KEY` and `GOOGLE_PICKER_APP_ID` (the project number).
2. **Separate sign-in** from Google Calendar (own tokens), so a team can use a different Google account and
   disconnecting one never stops the other.
3. **One lead row per customer per day**; the AI decides when the customer showed real buying interest.
4. **Beta + notice** in the connector list while Google reviews the scope, like Google Calendar.

## Mock and confirmation

Not done in this change: the cumulative HTML mock (clone of the latest confirmed mock,
`docs/features/group-mentions/mock` at `f6f0d2b`, plus these screens) and the owner's confirmation are
still owed before this leaves draft. The screens reuse confirmed Google Calendar patterns one for one.
