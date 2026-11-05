# Connector design rules

Owner rule (Jazz, 2026-11-05): every connector is **use-case agnostic, scalable and adaptable**. Read this before
designing or changing a connector (built-in like Google Calendar, Sheets, Drive, or a partner MCP connector).

## 1. The connector grants access; the agent's instructions decide the use

- A connector page holds only **what an AI agent may reach and do**: the account, which resource (calendar,
  spreadsheet and tabs, Drive folder and files), and one switch per capability (look-ups on, changes off by default).
- **When, why and what for** lives in the agent's **instructions** on the agent page (Admin → Members → AI agent),
  never on the connector. No use-case settings on a connector page: no "save receipts", "add leads", "claims",
  file-type ticks, folder-naming schemes, example instructions to copy, or business wording in tool names.
- A connector page may point to the agent's instructions with one plain line and a link, nothing more.
- Example (Google Drive): the connector holds the folder, Save files on/off, Read files on/off and the picked files.
  "Save claim forms into a folder per customer" is an instruction; the tool takes an optional sub-folder name the
  agent chooses from its instructions.

## 2. Tools are generic and describe themselves

- Name tools by the action on the system (`save_file_to_drive`, `read_sheet_rows`, `add_sheet_row`), never by a
  business use (`add_lead_row` was replaced for this reason).
- Build tool descriptions per turn from what this agent may use (its tabs and their live columns, its picked files),
  so a new use needs a new instruction, not a release.
- Core AI rules stay connector-neutral (no tool or connector name in `CORE_RULES`); a connector brings its own tool
  descriptions and result notes.

## 3. Guards are about safety, never about the use case

- Server guards enforce what must hold for every use: the agent's own resources only, values only from the person
  or their files, never twice for the same message, WhatsApp Safety locks, size caps, Try it never writes, fail
  closed and hand over (`lookup_failed`) when the outside system fails.
- Never encode a business rule as a guard ("only receipts", "one lead a day"): that belongs in instructions.

## 4. Scalable and adaptable

- Settings are **per AI agent** (any number of agents, any number of inboxes), stored as JSON that old releases'
  saves map into on read (permanent start-up code, never a one-release migration).
- One sign-in per connector per install; least-privilege scopes (`drive.file`, picker) before wider ones.
- The same contract works for built-in and partner connectors: entry in the connector list (`builtin` or `mcp`),
  capabilities as tools with read/write access, Activity keeps who and when only (never contents or values).
- A new connector should be addable by data (connector list entry + tool module + guards), without changes to the
  agent prompt, the agent page or other connectors.

## Checklist for a connector design

- [ ] Does any setting on the connector page describe a use case? Move it to the agent's instructions.
- [ ] Are tool names and descriptions generic, built from the agent's allowed resources?
- [ ] Are guards only safety guards (scope, provenance, idempotency, Safety, size, Try it)?
- [ ] Do settings work per agent, for N agents and N inboxes, and survive an upgrade from any older release?
- [ ] Is the Google/partner scope the least that works?

## Google Sheets: AI-filled values, formulas and new sheets

Applies sections 1–3 to the Google Sheets connector (owner decisions 2026-11-05). Part A–C of the original Sheets
design are in git history (`docs/features/group-agents/design.md` before the five-folder retention removed it).

### Part D: AI-filled values and formulas (owner decision 2026-11-05)

Owner (Jazz), 2026-11-05: "Why so many limitations, give this setting to sheet connector, admin can allow connector to
write formula and number". Approved going ahead without a mock round (his words); no mock folder was added (a sixth
folder would prune an older reference for two switches). The switches follow the existing switch row of the
connector pages (`ToolSwitchRow`).

| Rule           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where          | **Per tab**, on a tab set to Add rows (`SheetTabSetting.aiValues`, `.formulas`, optional booleans in the settings JSON: no migration). Per tab fits the existing per-tab table: a leads tab and a quote tab of one agent want different rules. Missing = off; the server keeps them only on Add rows and only when on.                                                                                                                                                   |
| 1. AI values   | "Let the AI fill values it looked up or calculated": values for that tab skip the "the person wrote it" check. Auto columns, column matching, the 2,000-character cap and never-twice-per-message stay. The tool description marks the tab and says: only figures read with `read_sheet_rows` or worked out from those rows and the chat, never invented or estimated (no sheet text in `CORE_RULES`).                                                                   |
| 2. Formulas    | "Allow formulas": the append uses `valueInputOption=USER_ENTERED` (formulas run, numbers and dates parse). A formula runs only when the AI made it: switch 1 on, its text is in no person's message of the chat (any member in a group) and no file was given to the turn. Every other value that would parse as a formula (`=`, or `+`/`-`/`@` not a plain number), auto values included (a push name `=IMPORTXML(…)`), is written with a leading `'` so it stays text. |
| Formula guard  | Always on, fail closed: a formula the AI made is refused (`formula_blocked`, the tool asks for a plain value) when it contains a web address or link scheme anywhere, or calls IMPORTXML, IMPORTHTML, IMPORTDATA, IMPORTFEED, IMPORTRANGE, IMAGE, HYPERLINK, WEBSERVICE, GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE, ENCODEURL, FILTERXML, or any function whose name contains IMPORT, WEB, URL, HTTP, FETCH, LINK, MAIL or SEND (custom Apps Script functions).     |
| Residual risk  | A custom Apps Script function with a neutral name that the business itself added to the sheet could still fetch; only the business can add one. Formulas reading other tabs of the same spreadsheet are allowed (that is the point).                                                                                                                                                                                                                                     |
| Audit and logs | `google_sheets.agent_settings` meta adds `permissions: [{tab, switch, before, after}]`. Logs: `google_sheets_row_added` adds `asTyped` and the formula count; `google_sheets_formula_refused` the column count. Never values.                                                                                                                                                                                                                                            |

### Part E: create a new sheet from the connector page (owner decision 2026-11-05)

Owner (Jazz), 2026-11-05, relayed by the main session: "Ok allow user to create sheet from connector page". Same
no-mock decision as Part D (a dialog of existing primitives on the existing Settings card).

| Rule        | Decision                                                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry       | Settings card, next to Choose a sheet: **Create a new sheet** (admins only; the AI never creates a sheet). `POST /api/connectors/google-sheets/agents/:agentId/create` with a `SheetLayout` {name, tabs: [{title, columns[], access, formulas?: [{cell, formula}]}]}; 409 `not_connected`, 404 unknown agent.          |
| Google      | `spreadsheets.create` (allowed by `drive.file`: the app's own files), then one `values:batchUpdate` USER_ENTERED with each tab's column names (escaped with `'` when they look like formulas) and the layout's formulas (rows 2–1000, columns A–Z). Then saved as the agent's spreadsheet through `putSettings`.       |
| Formulas    | A layout's formulas are an admin's, but pass the same fail-closed `formulaReachesOut` check: one blocked formula refuses the whole layout (400 `formula_blocked`) before anything is created.                                                                                                                          |
| Two ways    | Blank (name, tabs, comma-separated column names, access per tab) or **{template} layout**: every template with an optional `sheet` (`AgentTemplateEntry.sheet`, list or built-in; the built-in Claims template has one) fills the same editable form. Agents do not record their template, so all layouts are offered. |
| Contract    | `sheet` is optional on template entries: older lists keep working and older apps strip it. The publishing repo must regenerate `schema/template-v1.json` (closed objects) before publishing a `sheet` (publisher README).                                                                                              |
| Audit, logs | `google_sheets.spreadsheet_created` {agentId, spreadsheetId, tabs, formulas} (counts, never names or cells) plus the usual `google_sheets.agent_settings`. Log `google_sheets_created` with counts.                                                                                                                    |
