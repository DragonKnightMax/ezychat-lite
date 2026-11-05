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
