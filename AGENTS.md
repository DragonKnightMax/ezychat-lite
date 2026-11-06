# AGENTS.md

Instructions for every AI coding agent working in this repository (Codex, Claude Code, Cursor, …).
This file is the single source of truth; `CLAUDE.md` imports it. Edit rules **here**.

EzyChat Lite: an Electron desktop app (macOS/Windows) that links one WhatsApp number through
Baileys and serves a shared team-inbox PWA locally, over LAN, or through a Cloudflare tunnel.
npm-workspaces monorepo: `packages/{shared,wa,server}`, `apps/{web,desktop}`, all named
`@ezychat/*`. Node 22+, TypeScript strict, ESM. Main dev machine is Windows 11.

## Before you start (required)

1. Read `docs/LEARNINGS.md` — past mistakes and the rules that came out of them.
   For a tech-debt review or a change in an area it lists, also read `docs/DEBT.md` (findings, fixes, open debt)
   and record new findings and fixes there.
2. Read `docs/design-system.md` before touching `apps/web`.
3. Check `git status`; never overwrite uncommitted work you didn't make.

## Commands

```bash
npm install                                   # all workspaces
npm run dev                                   # server (tsx watch, --fake-wa, data in ./data/dev, port 7420) + Vite web
npm test                                      # every Vitest project (packages/*, apps/*)
npm run test:coverage                         # same with coverage (totals vs the floors in vitest.config.ts)
npm run coverage:changed                      # after test:coverage: ≥ 90 % of the lines this branch changed are covered
npx vitest run packages/server/test/auth.test.ts                       # one file
npx vitest run packages/server/test/auth.test.ts -t "lock the account"  # one test by name
npm test -w @ezychat/server                   # one workspace
npm run lint                                  # ESLint
npm run typecheck                             # tsc --noEmit in each workspace + e2e/
npm run e2e                                   # Playwright: builds web, starts server --fake-wa on :7499 with .e2e-data
node e2e/screens.smoke.mjs <url> <outDir>     # every screen (desktop+mobile): page errors, blank, overflow, screenshots
node e2e/electron-screens.smoke.mjs <url> <outDir>  # same, inside a real Electron window
npm run e2e:electron-links                    # every screen in the REAL desktop window: each external link opens in the OS (Windows)
node e2e/marketing-screenshots.mjs <port> docs/screenshots  # demo-data screenshot library (docs/screenshots/README.md)
npm start -w @ezychat/desktop                 # build web + bundle server + tsc + launch Electron
npm run dist -w @ezychat/desktop              # fetch cloudflared/WinSW, build, electron-builder (host OS only)
npm run build:core                            # dist builds of shared/wa/server + the web library (apps/web/dist-lib)
npm run pack:core                             # @ezychat/* tarballs in .core-packs/ for local Enterprise development
npx tsx packages/server/src/cli.ts --data ./data/x --reset-admin       # print a new password for the first admin
npm run version:sync                          # copy root package.json version into every workspace
```

Installers land in `apps/desktop/release/` (`win-unpacked/` for `--dir` builds). Smoke a packaged build with
`ELECTRON_RUN_AS_NODE=1 "<release>/win-unpacked/EzyChat Lite.exe" <resources>/app.asar.unpacked/dist/server/server.cjs --data <tmp> --port 7432 --fake-wa`.

## Code graph (graphify)

A code-only knowledge graph of the source (`packages/`, `apps/`, `scripts/`, `e2e/`; `.graphifyignore` leaves out
docs, mocks, images and build output) lives in `graphify-out/` of the **primary checkout** (git-ignored, never
committed). It is built from the syntax tree: no AI, no cost.

- Before a broad search ("what calls X", "where is Y used", "what does this change touch"), ask the graph:
  `graphify query "<question>"`, `graphify path "A" "B"`, `graphify explain "X"`, or the `graphify` MCP tools
  (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`; pass `project_path` = the primary checkout).
  Exact symbol and file names work best. Then read the files it names; the graph is a map, not the source.
- From a worktree, query the primary checkout's graph; it shows `main`, not your branch.
- It stays current by itself: git hooks rebuild it after a commit or checkout in the primary checkout, and after
  `git pull` there (`post-merge`). Rebuild by hand with `graphify update .` (code only, about a minute).
- `graphify-out/GRAPH_REPORT.md` lists the central files ("god nodes") and the groups of related code.

## Architecture

**Process model.** `packages/server` is a standalone Node program that owns all state (SQLite, the
WhatsApp socket, cloudflared). The desktop app never embeds it:

- _Standalone_: Electron main (`apps/desktop/src/main.ts`) forks `dist/server-host.cjs` →
  `dist/server/server.cjs` (esbuild bundle) with `utilityProcess.fork`; data in the user's app-data dir.
  `server-host` moves to the next free port (up to 20) when the chosen one is taken, writes the effective port to `WATI_PORT_FILE` (the desktop saves it in `desktop.json`) and turns a `shutdown` IPC message into a graceful close.
- _Service_: WinSW (Windows, LocalSystem) or a launchd daemon (macOS) runs the Electron binary with
  `ELECTRON_RUN_AS_NODE=1`; data moves to `C:\ProgramData\…` / `/Library/Application Support/…`.
  On launch the desktop probes `/api/health`; if a server answers it becomes a plain client window
  and never starts a second server while the service is installed (`startup.ts#decideStartup`).
- The desktop clears the PWA service-worker cache when the web build changes (`clearWebCacheOnVersionChange`);
  F12 / Ctrl+Shift+I = DevTools, Ctrl+Shift+R = hard reload in the app window.

**Server CLI** (`packages/server/src/cli.ts`, `config.ts`): `--data <dir>` (required, or `WATI_DATA`),
`--port` (default 7420, else the persisted `port` setting), `--host` (default from the `lan_enabled`
setting: `127.0.0.1` or `0.0.0.0`), `--mode standalone|service|dev`, `--fake-wa`, `--web-dist <dir>`,
`--reset-admin`. Exit 3 = data dir locked by another server. `--fake-wa` is flag-only (never env) and
rejected in service mode.

**WhatsApp boundary.** `packages/wa` defines the `WaAdapter` interface. Only
`packages/wa/src/baileys/**` may import `baileys`; the server loads it lazily. The socket identifies as
`Browsers.ubuntu('Chrome')` (`WA_BROWSER`) — "Desktop" identities are rejected by WhatsApp (428 before any QR).
Linking: QR or phone-number pairing code (`requestPairingCode`). `FakeWaAdapter` is used by tests and
`--fake-wa`; with it, `POST /api/dev/fake-incoming` simulates inbound messages. History import defaults to
3 days; history media is stored `pending` and downloaded on demand (`GET /api/media/:id`, `POST …/redownload`).
PDFs (and photos sent as files) open in the app: `inbox/PdfViewer.tsx` draws them with pdf.js from fetched bytes
(`lib/pdf.ts`, lazy chunk + worker, 50 MB cap, `%PDF-` check); the media route still serves them as attachments.
Voice notes: the composer records Ogg/Opus in the browser (`lib/voice-recorder.ts`, opus-recorder's
WebAssembly encoder); `POST /chats/:jid/media` with `voiceNote=1` checks it is Ogg/Opus of at most 5 min
(`messages/voice-note.ts`, length counted from Opus packets) and sends it with `ptt: true`, length and a
waveform built from packet sizes (`messages.voice_note`; nothing is decoded on the request thread).
One person can arrive under a phone-number JID and a LID: chats are keyed by the LID once known
(`chats/aliases.ts`, table `jid_aliases`). Existing duplicates are merged only by the startup identity
migration (`chats/identity-migration.ts`, run by `initMessaging` before the message service, AI, HTTP
and `wa.connect()`; pairs read offline by `readStoredLidMappings`; pre-merge backup first). Runtime code
never merges: `AliasStore.route` picks the existing chat of either JID, routes resolve `:jid` through
`chatJidParam`, and replies go to the `wa_remote_jid` of the last inbound message. Never merge on a
name or number match. Emoji reactions (adapter event `reaction`; Baileys' upsert path only, plus
`WebMessageInfo.reactions` in history) live in `message_reactions` (`messages/reactions.ts`), one row per
stored message key and reactor (alias-resolved JID, `me` for the linked number), kept when the message
is not stored yet; `present()` attaches them in one batched query and `message:reactions` goes to the
chat's inbox room. Reactions never notify. Dev: `POST /api/dev/fake-reaction` (fake WA only).
Sending: `PUT /api/messages/:id/reaction` {emoji} ('' removes; one emoji, zod-checked; 30 a minute per user)
goes straight to `WaAdapter.sendReaction` (never queued; offline → 503), with the reply refusals; the
linked number's row (reactor `me`) keeps `sent_by_user_id` (teammate, `ReactionRepo.applyOwn`) until
WhatsApp reports another emoji from the phone. One reaction per number: the team shares it.
Edits and deletes (design `docs/features/message-edit-delete/design.md`, migration 029, `messages/changes.ts`):
Baileys `MESSAGE_EDIT` / `REVOKE` protocol messages (`baileys/protocol.ts`, upsert and history only) become adapter
events `messageEdited` / `messageDeleted`; the adapter skips the echo of its own changes. A change applies only in
the stored message's chat and only by its author (`changeAuthor`; a group admin may delete, never edit), else waits
in `message_changes_pending` until the message arrives. Team: `PATCH /api/messages/:id` {text} (15 min) and
`DELETE /api/messages/:id?scope=everyone` (2 days) for the teammate who sent it or an admin, `scope=me` (hidden for
the team, `chatModify` on the phone) for admins; never queued (offline → 503), 30 a minute per user, audit ids only.
Only with `WaCapabilities.editMessage` / `deleteForEveryone` / `deleteForMe` (absent = off, e.g. the Business API).
A deleted row keeps its text; `rowToMessage` sends it without body, media or quote, and only admins read the
original (`GET /api/messages/:id/edits`). Hidden rows leave `pageDesc`; the AI skips deleted messages and redrafts
when the customer changes a message mid-reply. Dev: `POST /api/dev/fake-edit`, `/api/dev/fake-revoke`.

**Inboxes (several WhatsApp numbers).** Design `docs/features/multi-inbox/design.md`. Each WhatsApp
number is an inbox (table `inboxes`, linked phone). `InboxConnections` (`inboxes/connections.ts`) holds one
`WaAdapter`, one bridge and one `SendQueue` per active inbox; `ctx.wa` is inbox 1 and `/api/wa/*` stays
inbox 1. Inbox 1 keeps `wa-auth/`, its chat keys and message ids (no relink, no data move); other inboxes
keep `wa-auth-inboxes/<id>/` (never inside `wa-auth/`: logout wipes the folder) and get keys
`<waJid>#<id>` / `<waId>#<id>` (`inboxes/keys.ts`). A chat key is opaque: read `chats.wa_jid`, send
`waJid`/`waMessageId` to WhatsApp. Alias routing and merges stay inside one inbox; `contacts` and
`jid_aliases` are shared. The limit comes from the edition: `runCli({ maxInboxes })` (Lite 1, 409
`inbox_limit` above it); `--max-inboxes` exists only with `--mode dev --fake-wa` (e2e project
`multi-inbox` on port 7498, `POST /api/dev/fake-link` is the scan). Inbox 1 cannot be removed; a removed
inbox keeps its chats read only for admins (409 `inbox_removed`). Web inbox UI shows only with 2+
visible inboxes; the Admin nav shows Inboxes instead of WhatsApp only when `maxInboxes > 1`.
Inbox types (design `docs/features/business-api/`): `inboxes.type` is `linked_phone` (the core's) or a type an
extension registers (`ServerExtension.inboxTypes`, e.g. Enterprise `wa-cloud`, the WhatsApp Business API);
`inboxes/types.ts` builds each inbox's adapter by type (an unknown type gets a disconnected placeholder).
`InboxService.create(…, { type, beforeConnect })` / `changeType` switch an inbox in place (same id, chat keys
and chats). The core reads what a connection can do only from `WaAdapter.capabilities` (`qrLink`, `history`,
`groups`, `replyWindowHours`, `templates`, `needsPublicUrl`), never from a type name. With `replyWindowHours`,
free-form sends (text, media, voice, reactions, queued jobs) answer 409 `window_closed` outside the window
(`chats.last_inbound_at`, live inbound only), templates go through `GET /inboxes/:id/templates` and
`POST /chats/:jid/template`, and the AI hands off with `window_closed`. `ServerExtension.publicRoutes` mounts
webhooks at `/api/ext/<name>/public` (no session, no Origin check for that prefix only, `verify` first).
Web: `WebExtension.inboxTypes` fills the type choice and slots of Admin → Inboxes and the setup wizard. Dev:
`--mode dev --fake-wa` adds the `fake-api` type (`POST /api/dev/fake-api-inbox`, `POST /api/dev/fake-window`).

**AI agents.** Design `docs/superpowers/specs/2026-10-22-custom-agents-design.md`. An install has up to
`maxAgents` AI agents (`runCli({ maxAgents })`, default `maxInboxes`; Lite 1, 409 `agent_limit`; `--max-agents` only with
`--mode dev --fake-wa`). Several agents may share an inbox (design `docs/features/group-agents/design.md`, migration 032
rebuilds `ai_agents` without the inbox UNIQUE), but only one answers its direct chats (409 `inbox_has_direct_agent`; a
new agent there starts group-only); each group names its agent in `ai_group_chats.agent_id` (`PUT
/api/ai/agents/:agentId/group-chats`, 409 `group_has_agent`; `PUT /api/chats/:jid/ai-group` {enabled, agentId?, listen?},
400 `agent_required`). `listen` ("Reads every message") starts a turn 8 s after the last live member message of a batch
(no tag needed, `no_reply` allowed; loop guard = 10 AI messages with no person's message between them); table `ai_agents` (`ai/agents.ts` is its only SQL: name and on/off stay on the `kind='ai'`
`users` row, preset `sales|faq|custom`, `instructions`/`handoff_rules` NULL = preset defaults, a saved blank
stays blank). Each agent owns its Business context items and setup versions (`agent_id`; every item SQL has
`AND agent_id = ?`) and answers only chats of its inbox (`agentForChat`; an AI assignee outside its inbox is
400 `assignee_not_inbox_agent`); re-binding, disabling, deleting an agent or removing its inbox releases its
chats first. A deleted agent's user stays (`ai_deleted_at`) for history names only. Start-up runs the permanent
`migrateMemberSetting` (old `ai_sales_member` texts → agent 1). Routes `/api/ai/agents/*`; the old `/api/ai*`
routes and MCP AI-setup tools without `agentId` mean the only agent, else inbox 1's (`defaultAgent`).
Extensions keep `agent: 'sales'` for every agent and get `agentId`. Internal items (`internal`, ≤ 10,000
characters per agent, 409 `internal_too_large`) go in full into `internalKnowledge`, never into
`search_business_context`; a reply with a ≥ 40-character run of one (`ai/leak-check.ts`, spacing and case
ignored) is not sent and hands over as `confidential_leak`. `service.ts` decides when an agent
claims, answers, hands off or resolves a chat; `prompt.ts` builds the single prompt used by live replies
and `POST /api/ai/try` (admin-only, no chat side effects); `POST /api/ai/edit` (admin-only, Edit with AI:
`ai/edit-prompt.ts` + `ai/agent/rewrite.ts`) only suggests a rewrite of one box — the page applies it to its
draft and its Save persists it; its log line holds field, ok, ms and model only — never the request,
the current text or the suggestion; closing the popup aborts the request and the model call. Reply suggestions
(design `docs/features/ai-reply-suggestions/design.md`): `POST /api/chats/:jid/ai/suggestions` and `…/ai/complete`
(any user with inbox access, direct chats and groups, 20 and 60 a minute) draft from the chat's agent knowledge even when
the agent is off (a group gets member names via `groupConversation`, `currentSituation.group`, no customer details; `AiService.draftReply`, `ai/draft-prompt.ts`: `GUARDRAILS` + fixed `DRAFT_RULES`, never
`CORE_RULES`); both use the "Model for suggestions" (`ai_reply_suggestions_model`: `fast` default = the connection's
fast model, `agent/draft.ts` ChatGPT `CHATGPT_FAST_DRAFT_MODELS` with reasoning `low`, `DRAFT_FAST_MODELS` for the
API-key modes; `agent`; or a model of the connection, `GET /api/ai/reply-suggestions/model`); a completion sees only
the last 6 messages and the typed text, never the knowledge; `ai/draft-check.ts` drops ungrounded drafts, numbers not
in the sources and Internal leaks; nothing is sent or stored; switch `ai_reply_suggestions` (admins,
`PUT /api/ai/reply-suggestions` {enabled?, model?}; status for everyone at `GET /api/reply-suggestions`), written off by
migration 020 for installs that existed before. Phrase list (design `docs/features/ai-phrase-dictionary/design.md`):
table `reply_phrases` per agent (migration 021, `ai/phrases/repo.ts` is its only SQL); `ai/phrases/service.ts` builds it
in the background (start, a business context change stable for one round, 30 team replies, weekly, Rebuild now; at most
24 AI calls a day; nothing while the switch is off, without a connection or with the gate closed) through
`AiService.buildPhrases`; team replies are cleaned of emails, long numbers and every customer name of the inbox
(`ai/phrases/check.ts`), phrases pass the draft fact and leak checks; the composer loads `GET /api/chats/:jid/ai/phrases`
and matches it locally (shared `matchPhrase`), Tab/Esc go to `…/phrases/:id/feedback`; admins use `/api/ai/phrases*`;
logs carry counts only (`phrase_build`). `resolution.ts` is the resolution guard;
`knowledge.ts` selects knowledge. Provider modes: API key (`api`, public OpenAI Responses API), Claude API key
(`claude`, Anthropic Messages API through `@ai-sdk/anthropic`, only in `ai/claude.ts`; 3 fixed models
`CLAUDE_MODELS`, key in the encrypted `ai_claude_api_key` setting, kept beside the OpenAI key; cloud voice is
off in this mode) or ChatGPT
(EXPERIMENTAL: direct PKCE sign-in, `chatgpt-oauth.ts` + `chatgpt-backend.ts` + `chatgpt-direct.ts`, tokens
only in the encrypted `ai_chatgpt_direct_tokens` setting; no Codex binary is bundled; protocol and sources in
`docs/ai-chatgpt-protocol.md`). A data dir with no saved connection defaults to ChatGPT mode
(`ai/settings-keys.ts`; an older save without a mode or a stored key stays API key); the default never signs
in, and the AI member stays off until an admin turns it on. `POST /api/ai/connection/test` (admin-only,
rate-limited, `ai/key-test.ts`) checks a key with `GET /v1/models` and never stores or logs it; only
`invalid_key` (401) blocks saving. Both modes run one agent turn on the Vercel AI SDK
(`ai/agent/turn.ts`: tools, structured decision with actions answer / ask_resolution / resolve / handoff / `no_reply` (empty reply, nothing sent, the AI keeps the chat), ≤ 4 steps, no transport retries but a malformed decision is asked once more; failures are `AgentTurnFailure` with `kind`, `causeName`, `status` for the `AI answer unavailable` log line; models in `ai/agent/models.ts`,
which keep `store:false` + encrypted reasoning and pass only our fixed error messages). Read tools are
built per chat in `ai/agent/tools.ts`, take no chat/person arguments, and are offered only when useful
(`search_business_context` above the 40,000-character budget, `get_older_messages` when the chat is
longer than the prompt). Rule for new data: push what is small and needed in most replies (customer
details, current situation); add a tool only for data that is large or rarely needed (each call costs
a model round trip). A rejected refresh sets `expired` and a blocked backend sets `error`; in both
the AI stops claiming and releases its chats without messaging customers. Knowledge = Business context items
(table `ai_documents`: uploaded files and text, up to 20); everything is sent while it fits
`AI_FULL_CONTEXT_CHARACTERS` (40,000), above that a CJK-aware selection picks chunks (no vector search).
Prompt layout for caching: the fixed `GUARDRAILS` block first (no interpolation, same for every agent), the
neutral core, then name, role text and hand-over rules, then input JSON in fixed order `internalKnowledge` →
`businessKnowledge` →
`conversation` → `currentSituation` last (date/time in `ai_timezone`, default Asia/Kuala_Lumpur; resolution
awaited; `customer` = the team's saved name, company, email, other phone and address via `aiCustomer`,
never tags, none in Try it); never put per-call or team-editable values earlier. A reply generated with
customer details that changed meanwhile is dropped and regenerated. `prompt_cache_key` is derived from the random `ai_install_id`,
the agent id (`cacheId = installId#agent:<id>`) and the model, never from customer data. Resolution guard: only a free-text confirmation closes a chat;
questions, objections, new requests and a "yes" carrying new facts (`addsNewFacts`) keep it open. The resolution
question is per agent (`ai_agents.resolution_check`, migration 026, card "Closing chats", `PUT
/api/ai/agents/:agentId/resolution-check`; default off for every agent): off, the AI never adds a check-in
line, never chooses ask_resolution/resolve (`guardResolution` turns them into an answer) and never closes a chat. The
business hand-off rules' "never hand over" cases win over needs_action, missing_facts and asked_for_human (only safety
and sensitive always apply); needs_action is only a concrete order, payment or account action, and a consultation,
meeting, demo or call request is discovery (`DISCOVERY_REQUEST`). A reply says "a team member will help" only with
handoff, and never announces closing the chat.
Order and delivery questions keep the chat with the AI. Web: `admin/AiConnectionSection.tsx` (Settings → AI),
`admin/AiMemberPage.tsx` + `AiContextPanel.tsx` (`/admin/members/ai/:agentId`, `/new?preset=`; `/admin/members/ai`
redirects), `admin/AiQuickConnect.tsx` (connect
card shared by the agent page and the setup wizard's AI assistant step: Account → WhatsApp → AI
assistant → Ready, `setup/SetupWizard.tsx` + `AiAssistantStep.tsx`). **Tests and e2e never call OpenAI or
ChatGPT**: use mock providers; `e2e/ai-member.spec.ts` saves a placeholder key and only exercises states
that need no model call (Try it with empty context hands off locally).

**Scheduled tasks** (design `docs/features/scheduled-tasks/design.md`, migration 036, `scheduled/` (`repo.ts` is its only
SQL), routes `/api/ai/agents/:agentId/scheduled-tasks*`, admins). Up to `SCHEDULED_TASKS_MAX` (10) tasks per agent; each
sends one message at one time on its days (`ai_timezone`, `scheduled/time.ts`) to ONE existing chat or group of the
agent's inbox (400 `chat_not_in_inbox`), never a new number or a list. `scheduled/service.ts` ticks every 30 s: a slot is
claimed once (`UNIQUE(task_id, slot)` in `ai_scheduled_runs`) and runs only within 15 minutes of its time; later it is
recorded `missed`, never caught up; a task created or edited after a slot skips it. Paused (`agent_off`, `access_closed`,
`ai_disconnected` via `AiService.answerReady`, `wa_disconnected`): the slot waits inside the grace. One
`AiService.scheduledTurn` (`SCHEDULED_RULES` + `currentSituation.scheduledTask`, look-ups only, `save_file_to_drive`
removed, Sheets `add_sheet_row` kept, answer or `no_reply`; handoff = skipped `needs_team`, no notification; leak check)
then `messages.sendText(…, { scheduledTaskId })`: never claims the chat, `messages.scheduled_task_id` gives
`Message.scheduledTask` ("Scheduled · <task>"), and the send queue asks `scheduled.canSend` instead of the AI's
`canSend`. Business API window closed → skipped `window_closed`. Run now 3/task/h and 20/admin/h (429 `rate_limited`,
409 `scheduled_paused`); preview 20/min, nothing sent or stored. Runs keep ids and reasons only (last 100); logs and
audit `scheduled_task.*` never hold the instruction or text. Lite import copies tasks switched off, no runs. Web:
`admin/AgentScheduledTasksCard.tsx`, `ScheduledTaskDialog.tsx`, `ScheduledRunsDialog.tsx`, `api/scheduled-tasks.ts`.

**AI in groups** (design `docs/features/ai-groups/design.md`). Off by default: `ai_agents.answer_groups` (agent page
Groups card) and `ai_group_chats` per group (Group info switch), migration 024; routes `/api/ai/agents/:agentId/groups`,
`/api/chats/:jid/ai-group`. `ai/groups.ts` answers only a live group message that tags the inbox's own JID/LID
(`mentionedJids`) or quotes a message the agent's AI user sent; everything else gets no reply. A group turn never
claims or assigns the chat (`claimOnReply` and `onChat` skip groups), offers look-ups only (no `book_appointment`, no
connector write tool), quotes the asker, and hands over with "A team member will reply soon." + `ai:group_handoff`
(push to the assignee, else everyone with inbox access; not counted in Reports' AI hand-overs). Loop guard: 10 AI
messages since the last teammate message pause the AI in that group (`AI_GROUP_LOOP_GUARD`, one paused line).
Group-only agents (design `docs/features/ai-direct-chats/design.md`): `ai_agents.answer_direct` (migration 027, default
on; `PUT /api/ai/agents/:agentId/direct`, audit `ai.direct_switch`). Read it only through `ai/direct.ts#answersDirect`:
an inbox whose adapter has no `groups` capability (Business API) ignores it. Off: `onInbound`/`eligible` skip direct
chats, `releaseDirect` returns the held ones (paused, like a disabled agent), assigning a direct chat answers 400
`agent_no_direct_chats`, and the directory marks the AI user `aiNoDirect` so the web leaves it out of direct chats.

**Fix English** (design `docs/features/grammar-fix/design.md`, mock `docs/features/grammar-fix/mock`). Team switch
`fix_english` (missing = on; migration 025 writes it off + `fix_english_upgraded` for installs with users), status for
everyone at `GET /api/fix-english` (`spelling` on/off, `grammar` on/off/`none`/`unavailable`), admins `PUT
/api/ai/fix-english`. Spelling never reaches the server: `apps/web/src/lib/spelling.ts` checks each word with `nspell` and
the British English Hunspell dictionary vendored in `apps/web/public/dictionaries/en-GB` (pinned to `dictionary-en-gb` by
`spelling.test.ts`; fetched by `lib/dictionary.ts` on first use, never precached), skips links, numbers, all-caps,
capitalised words inside a sentence, `LOCAL_WORDS` and the accepted words, and Fix all applies only a `safeFix`.
Grammar: `POST /api/chats/:jid/ai/fix-grammar` (any chat type, 120 a minute per user) → `AiService.fixGrammar`: one
structured `draft` call on the "Model for suggestions" with the fixed `FIX_GRAMMAR_RULES` and `{text}` only, then
`fix-english/grammar.ts#grammarIssues` diffs the corrected text into marks and drops changes to numbers, links, emails,
mentions, more than 4 words, or a rewrite; Malay/Chinese (`notEnglish`) is skipped before any call; logs counts only
(`fix_grammar`). Team words (`fix_english_words`, ≤ 500): any user adds (`POST /api/fix-english/words`), admins remove;
audited with the word; `GET` adds the words of every agent's non-Internal Business context. Web: `inbox/FixEnglish.tsx`
(hook, marks layer behind the box, card, Fix N / Ctrl+J / Undo), `admin/FixEnglishSection.tsx`; the composer turns the
browser's own `spellCheck` off while it marks spelling.

**Ask Ezy** (design `docs/features/ask-ezy/design.md`, mock `docs/features/ask-ezy/mock`). An in-app assistant
panel for every signed-in user: `POST /api/ask-ezy` (20 a minute per user) streams NDJSON (`step` per tool, then
`answer` or `error {code}`; shared `AskEzyEvent`). `ask-ezy/tools.ts` reuses the MCP `ToolDef`s as AI SDK tools for
the signed-in user (team members: the inbox read tools of their own inboxes; admins also the AI setup reads,
`try_ai_reply` and `propose_ai_setup_change`), never `update_ai_setup` or a send tool. One turn on the connection's
**fast model** (`AiService.assist`, `agent/assist.ts`, ≤ 6 steps, no retries) returns text plus typed blocks
(`AskEzyBlock`: stats, bars, heatmap, chats, customer, change, test); blocks are validated, invalid ones dropped,
chat and customer blocks filtered by inbox access. A proposed change is held in memory (`ask-ezy/changes.ts`, 30 min,
20 per user) and saved only by `POST /api/ask-ezy/changes/:id/apply` (admins; 409 `setup_changed` when the text moved
since Ezy read it; Undo restores it or removes an added item; versions via `{via:'app', reason:'Ask Ezy: …'}`).
Logs carry tool names, counts, ms and model, never question or answer text. Web: `apps/web/src/askezy/`.

**Send feedback** (design `docs/features/in-app-feedback/design.md`, mock `docs/features/in-app-feedback/mock`). Any
signed-in user: `POST /api/feedback` (multipart: `report` = shared `FeedbackReportBody`, 0–3 `file` parts, 10 MB each,
25 MB together, type read from the bytes in `feedback/files.ts`: PNG/JPEG/WebP/PDF/MP4, text only as `.txt`/`.log`; 5 an
hour and 20 a day per user, a retry with the same `clientReportId` is answered from memory and not counted again) and
`GET /api/feedback/defaults` (company, app details, the exact redacted log). `feedback/service.ts` builds the app
details on the server (`diagnostics.ts`: edition, version, Windows/macOS, mode, WhatsApp connected, AI mode, never
keys; the screen path without ids) and, only when ticked, the last 200 lines / 64 KB of the newest log (`log.ts`:
`redactLogLine` plus message text, names, numbers, chat ids, emails, IPs and the user folder removed; non-JSON lines
dropped). `feedback/portal.ts` posts to `https://license.anchorsprint.app/v1/feedback` (30 s, `redirect: 'error'`,
16 KB answer cap; `EZYCHAT_FEEDBACK_URL` only with `--mode dev --fake-wa`) and maps answers: 400/413/415/429 pass
through, 403 `product_closed` → 503 `feedback_closed`, anything else → 502 `feedback_unreachable`. Lite sends
`EZC-LITE` + a random `installRef` (setting `feedback_install_ref`); an edition answers `ServerExtension.feedbackAuth`
(`product`, `installId`, `secret`, `company?`, `portalOrigin?` https or loopback http), else a non-Lite edition answers
503 `feedback_unavailable`. Logs: type, area, file count and sizes, ms, reference only. Nothing of a report leaves the
computer until Send. Web: `components/app/FeedbackDialog.tsx` (`openFeedback`, `FeedbackHost` in `create-app.tsx`;
account menu, Admin Help & feedback, About, error panel); the desktop window's "Screenshot of this window" is
`window.watiCapture` (`apps/desktop/src/capture-ipc.ts`, inbox IPC guards, PNG of the asking window only).

**Usage stats** (design `docs/superpowers/specs/2026-11-04-usage-stats-design.md`). `usage/service.ts` (`ctx.services.usage`) is the only
sender: at start, on bus events (`inbox:status`, `ai:connection-changed`, `message:status`, `access:opened`), after the
first-admin setup and hourly it reads the app's own state for the milestones `app_installed`, `admin_created`,
`wa_linked`, `ai_connected`, `ai_agent_on`, `first_message_sent` (each once, remembered in `usage_sent`) and
`app_active` (once a day), and posts each as a shared `UsageEvent` to `https://license.anchorsprint.app/v1/usage`
(10 s, `redirect: 'error'`, no retry on a 4xx). Product from the edition (`lite` → `EZC-LITE`, `enterprise` →
`EZC-ENT`, else nothing). Never sends with `--fake-wa`, in dev (except `EZYCHAT_USAGE_ENDPOINT` with `--mode dev
--fake-wa`), while the access gate is closed or the switch is off (`usage_stats`, `PATCH /api/settings`
{usageStats}, audit `usage_stats.update` before/after). Logs event names, status and counts only.

**Events.** `wa-bridge` maps adapter events into services (ingest, status acks, chat/contact upserts).
Services emit on the typed in-process `Bus` (`bus.ts`); `realtime/socket.ts` fans out to Socket.IO
rooms (`all`, `admins`, `user:<id>`; QR codes and tunnel status go to `admins` only) and
`push/service.ts` sends notifications for `inbound:notify` and committed `ai:handoff` events to the
human assignee (or every active human user if unassigned). Connected recipients receive
`notification:new` (shown only by the desktop app, which has no push subscription), and every
subscribed phone or browser of each recipient receives web push, online or not; each send logs
`push_result` counts only. Handover is distinct from the earlier inbound
message, which may have arrived while the AI owned the chat.

**Customer profiles.** `packages/server/src/customers/`: one profile per direct chat
(`customer_profiles`, `customer_tags`), edited by any teammate, audited by changed field names only.
Profiles have a stable `id` (kept across merges) and no foreign key to `chats` (user data never
cascades). `rowToChat` prefers the profile name and adds `tags`/`whatsappName`; its rows come only
from `ChatRepo.get`/`list` (profile join + one batched tag query; SQL in `customers/sql.ts`). Every
outbound Message goes through the message service's `present()` (group `senderProfile` via
`AliasStore.route()`). `mergeChat` must move every table keyed by `chat_jid` (profiles via
`customers/merge.ts`). One person's direct chats in several inboxes share the contact fields (not tags):
`customers/linked.ts#linkedChats` (same JID or PN/LID pair, never a re-pointed number) is written on every
save and enrichment, seeds a new chat in `ChatRepo.ensure`, and fills empty chats at start-up. When the AI reads profiles, put them in `currentSituation`/`conversation`,
never earlier in the prompt.

**Customer enrichment.** `customers/enrichment.ts` uses the shared AI connection independently of
Sales Agent ownership. It is off by default and processes only live direct-chat text, with bounded
bursts and concurrency. `ai/agent/extract-customer.ts` is one structured call without tools/retries.
Accepted values require explicit self-ownership, an exact quote in a new message, profile syntax,
current evidence and per-field thresholds (add 90, replace 95). Cancel on staff edits, newer live
arrivals, setting/connection changes and shutdown; compare the profile again immediately before the
atomic profile/audit commit, and ensure the JID still routes to that same chat after an alias change.
Audit stores scores, field names and message references, never values
or raw evidence. Tests and the mock-AI Dev Build runner never call outside providers.

**Connectors** (design `docs/features/google-calendar/design.md`; rules `docs/connector-design.md`: use-case agnostic, scalable, adaptable; a connector grants access, the agent's instructions decide the use). Admin → Connectors (`admin/connectors/`) is a
gallery (`catalog.ts`) with one page per connector; every ready connector is core, only the custom MCP connector is
Enterprise (greyed out in Lite; an edition points a connector at its own page with `WebExtension.connectorLinks`).
Coming-soon connectors have Vote / Ask for a connector: a WhatsApp link (`useAppLinks().connectorRequest`, `null`
hides it); nothing is counted in the app. Google Calendar (`connectors/google-calendar/`, routes
`/api/connectors/google-calendar/*`, admins; migration 022): one Google account per install, sign-in with PKCE and a
loopback callback on the server's own port (`…/callback`, host-only, so it finishes only on that computer), tokens
only in the encrypted `google_calendar_tokens` setting; the app (Google "Desktop app" client of project `ezychat-prod`,
org anchorsprint.com) is `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` from the environment, else the one the release bundle carries
(`scripts/google-oauth-define.mjs`: esbuild `define` of `__EZYCHAT_GOOGLE_OAUTH__` from repository secrets in `release.yml`;
Enterprise does the same), without either the state is `not_configured`. With `--fake-wa` the fake Google is used only
when no app is configured (a Dev Build with the env pair signs in to real Google). Per AI agent (`calendar_agent_settings`): calendar, Check free times (on), Book
appointments (off; needs free times) and the rules. AI tools `check_free_times` / `book_appointment` (`tools.ts`,
offered through `ai/agent/turn-tools.ts`; core names reserved for extensions): the server books only a time it
offered in that chat (`calendar_offers`), after a newer customer message, inside the rules and still free (re-checked
just before the insert, idempotent event id) and only with a name, email and phone (`contact.ts`: the saved
contact or the WhatsApp name/number, else what the customer wrote in this chat, checked against their own messages;
`check_free_times` says which to ask for); never cancels or moves (hand-over); Try it never books (`notRun`).
`CORE_RULES` has one connector-neutral rule for tools that make a change (use only as the tool's description says,
report done only when it says so, never undo): no tool or connector name in the core rules, so a new connector
brings its own instructions (tool descriptions and result notes) and server guards. Google expired or unreachable: the AI stops
using it and hands booking chats over. Chat lines are `ai_tool_used` events with `calendar`; Activity keeps who and
when, never chat text. `--fake-wa` swaps in the fake Google (`fake.ts`, `/api/dev/fake-google/*`,
`/api/dev/fake-google-calendar`); tests never call Google.

**Google Sheets** (design `docs/features/google-sheets/design.md`). Core built-in connector like Google Calendar,
with its own Google sign-in (`connectors/google-account.ts`: the calendar's PKCE/loopback flow made generic; tokens in
the encrypted `google_sheets_tokens` setting; scope `drive.file`: only files picked in Google's file picker, whose page
`picker-page.ts` is host-only with its own CSP and needs `GOOGLE_PICKER_API_KEY`/`_APP_ID`). `connectors/google-sheets/`
(`repo.ts` is its only SQL, migration 030, routes `/api/connectors/google-sheets/*`, admins): per agent one spreadsheet
(picked, checked with Google) and per tab Off / Read / Add rows (`tabs`; old `lookupTab`/`leadsTab` saves are mapped on
read, `upgrade.ts` adds a leads line to the agent's instructions once). Tools `read_sheet_rows {tab, query}` and
`add_sheet_row {tab, values}` list only the agent's tabs with their first-row columns (cached 5 min, `POST
…/agents/:agentId/refresh` clears it); the agent's instructions say what to record. `add_sheet_row` fills Date, Name,
WhatsApp, Group, AI agent, Source, accepts other values only from the person's messages or a file they sent
(`values.ts`), never twice for the same message+values, no daily cap, RAW, also in group turns (the only write there),
never Try it. Per Add rows tab, two admin switches (off by default, `SheetTabSetting.aiValues` / `.formulas` in the
settings JSON, audited before/after; design `docs/connector-design.md` Part D): `aiValues` skips the "the person wrote it" check (the
tool description says only looked-up or worked-out figures); `formulas` appends `USER_ENTERED`, where only a formula the
AI made runs (aiValues on, not in any person's message, no file given) and never one that reaches outside the sheet
(`values.ts#formulaReachesOut`: web address, IMPORT*/IMAGE/HYPERLINK/WEBSERVICE/… → `formula_blocked`); every other
formula-like value, auto columns included, is written as text with a leading `'` (`asText`). Admins can **create a new
sheet** (`POST …/agents/:agentId/create`, shared `SheetLayout`; Part E): `spreadsheets.create` + one USER_ENTERED
`values:batchUpdate` (column names, the layout's formulas, same `formulaReachesOut` check → 400 `formula_blocked`),
then saved as the agent's; blank or from a template's optional `AgentTemplateEntry.sheet` (built-in Claims has one);
audit `google_sheets.spreadsheet_created` with counts only. Activity and
logs keep who and when only, never row values. `--fake-wa` without a Google app uses `FakeGoogleSheets`
(`/api/dev/fake-google-sheets*`, demo sheet `FAKE_SPREADSHEET_ID`).

**Google Drive** (design `docs/features/google-drive/design.md`). Core built-in connector like Sheets, its own Google
sign-in (`google_drive_tokens`, scope `drive.file`: a picked folder grants only the folder, so the AI reads only files the
admin picks; Google's picker in `folder` or multi-select `files` mode, `connectors/google-drive/picker-page.ts`).
`connectors/google-drive/` (`repo.ts` is its only SQL, migration 034, routes `/api/connectors/google-drive/*`, admins): per
agent one folder, Save files (off) and Read files (on) with ≤ 50 picked files inside the folder; nothing about the use
case (instructions decide). Tools: `save_file_to_drive {file, subfolder?}` picks a label of this chat's newest inbound
files (24 h, ≤ 10; group: the batch's senders), never a link or id from the model; never Safety High/quarantined, ≤ 25 MB,
once per message and folder (`drive_saved_files` + Drive app property `ezychatKey`), EzyChat names the file, optional
one-level sub-folder EzyChat creates (`drive_folders`), also in group turns, never Try it; `list_drive_files` /
`read_drive_file` read only the picked files (Docs/Sheets exported, PDF/Word via `extractKnowledgeIsolated`, ≤ 10 MB,
≤ 20,000 characters), never files saved from chats. Chat line `ai_tool_used` with `drive: {action:'saved'}`; Activity and
logs keep who/when/kind/size only. `--fake-wa` without a Google app uses `FakeGoogleDrive` (`/api/dev/fake-google-drive*`).
**SQL Account** (design `docs/features/sql-accounting/design.md`, beta, untested against a real SQL Account API).
Core built-in connector for SQL Account (eStream) through its API service (API Link, a paid module): HTTPS only to
`api.sql.my` (eStream's Postman collection; a saved `<32 hex>.sql.my` stays accepted) via the `connectors/mcp/net.ts` guard (no private address, no redirect, 10 s, 1 MB,
one request at a time, 30 a minute), AWS SigV4 (`connectors/sql-account/sigv4.ts`, region `ap-southeast-5`, service
`sqlaccount`, pinned to AWS test vectors); access key + secret key only in the encrypted `sql_account_connection`
setting, the key end shown. `connectors/sql-account/` (`repo.ts` is its only SQL, migration 035, routes
`/api/connectors/sql-account/*`, admins): Test connection is a signed `GET /agent`; states `no_dns`, `unreachable`,
`private_ip`, `bad_keys`, `old_version`, `unexpected`; never another way into SQL Account. Per AI agent and per object
(`SQL_OBJECTS` in shared `sql-account.ts`: stock items, customer, customer invoices (amount owed, off by default), sales
invoices, quotations, sales orders, delivery orders, payments) Off / Read / Read + create (create only for quotations; never update or delete). Own-record tools take no
customer argument: the chat is matched by a teammate link (`sql_account_links`) or a WhatsApp number exactly one SQL
Account customer has (never a name, never a code the customer types), the server adds the code to every request and
drops other customers' rows; no match → the tool tells the AI to hand over. Groups and Try it get the stock look-up
only. Quotation = `sql_quotation_preview` (items from a stock look-up in the chat, quantities the customer wrote, SQL
prices) then `sql_create_quotation` after an AI reply and a newer customer message (2 a chat, 20 an agent a day). The
amount owed comes only from `/customerinvoice` / `customer.outstanding`, said exactly as recorded with its time. The
phone index reads each customer's `sdsbranch` in the background (one every 4 s). Logs and Activity: tool, ok, ms, ids only. `--fake-wa` swaps in
`FakeSqlAccount` (`fake.ts`, checks SigV4 with `FAKE_SQL_ACCESS_KEY`/`FAKE_SQL_SECRET`; `/api/dev/fake-sql-account/*`).

**Connector list** (design `docs/features/connector-list/design.md`). The gallery comes from a signed list published
by the public repo `anchorsprint/ezychat-connectors` (one folder per connector: `connector.yaml`, `skill.md`,
`icon.svg`; its CI validates, builds `list-v1.json`, signs it with Ed25519 and uploads it with the icons to
`dl.ezychat.ai/connectors/`). Contract `packages/shared/src/connector-list.ts` (`ConnectorEntry` `schemaVersion` 1,
`minAppVersion`, editions, kinds `mcp` / `builtin` / `coming_soon`, sign-in `oauth` / `oauth_own_app` / `api_key` /
`credentials` / `none`, declared guards; JSON Schema for the repo from `scripts/connector-schema.mjs`). Server
`connectors/list/` (`ctx.services.connectorList`): downloads at start and when Admin → Connectors opens
(`POST /api/connectors/list/refresh`, one download per 30 s, no timer), accepts the list only when one of the two keys
in `keys.ts` verifies it, its `sequence` is not lower than the saved one and every icon matches its hash (SVG without
script); keeps the last good copy in `<data>/connectors/`, else the built-in list (`builtin-list.ts`, `minAppVersion`
0.0.0). Entries with an unknown schema are hidden, newer `minAppVersion` shows "Needs a newer EzyChat", a saved
connection whose entry left the list keeps working flagged "No longer available". `EZYCHAT_CONNECTOR_LIST_URL` /
`_TEST_KEY` are read only with `--mode dev --fake-wa`. Partner (MCP) connections `connectors/mcp/` (migration 023,
routes `/api/connectors/mcp/*`, admins; engine ported from Enterprise `ent-connectors`): SSRF-guarded https only
(`net.ts`; loopback only with `CONNECTORS_TEST_ALLOW_LOCAL=1` in dev with fake WhatsApp), secrets encrypted, only the
key end returned, OAuth callback host-only. Per agent, look-ups start on and tools that change data off; the core
enforces the entry's guards before every call (`guards.ts`: confirmFirst, valueFrom, fromCustomer, within, limits;
fail closed; Try it never runs a write tool) and logs ids, tool names, outcome and ms only. Test partners:
`e2e/partner-mcp/` (`node e2e/partner-mcp/cli.mjs`; e2e project `partners` on port 7497 via `e2e/start-partners.mjs`).

**Template list** (design `docs/features/template-store/design.md`). AI agent templates update without a release: the
publishing repo `anchorsprint/ezychat-connectors` (folder `templates/`, proposal files in
`docs/features/template-store/publisher/`) builds `templates-v1.json`, signs `ezychat-templates-v1\n` + the bytes with the
connector list keys (domain separation) and uploads it to `dl.ezychat.ai/templates/`. Contract
`packages/shared/src/template-list.ts` (`AgentTemplateEntry` schemaVersion 1, texts per en/ms/zh-CN with whole-English
fallback, `version`, `defaults`, `recommendedConnectors`; JSON Schema `scripts/template-schema.mjs`). Server
`templates/` (`ctx.services.templateList`): download at start and on `POST /api/ai/templates/refresh` (admins, once per
30 s, 10 a minute per admin, `redirect: 'error'`, 512 KB cap), signature + sequence + per-entry checks, control/bidi
characters removed before the schema check, last good copy in `<data>/templates/`, logs counts only;
`GET /api/ai/templates` sends only entries this app and edition can use. `EZYCHAT_TEMPLATE_LIST_URL` / `_TEST_KEY` only
with `--mode dev --fake-wa`. Web: the app's own templates (`admin/business-templates-data.ts`, catalogs
`ai.businessTemplates.<id>.*`, version 1) are the fallback; `galleryTemplates` merges (a list entry replaces one only
with a higher version, adds new ids, never removes); icons are names from the bundled `TEMPLATE_ICONS` (no image is
downloaded). A template only fills editable boxes after Apply. `npm run templates:export` rewrites the sample folder
(kept equal to the app by `scripts/template-store.test.mjs`).

**WhatsApp Safety** (design `docs/features/whatsapp-safety/design.md`, mock `docs/features/whatsapp-safety/mock`).
`ctx.services.safety` (`safety/service.ts`) checks every inbound message at ingest (`messages/service.ts` calls `inspect`
before presenting it; history: name and text only). Local rules `safety/rules.ts` (real type from the first bytes, a
ZIP's file list only via `safety/zip.ts`: never run, opened or extracted; bounded, fails closed to `cantInspect`) and
`safety/policy.ts#decide` (critical rule = High; the AI may raise or confirm, lower only a rules-only Warning). AI check
`AiService.checkSafety` (fast model, fixed `SAFETY_CHECK_RULES`, text + file names + ZIP names, never bytes; 200 a day
per inbox; logs level/category/ms only). Table `safety_items` (one per flagged message, migration 028), `safety_numbers`
(scam / blocked / trusted, shared by inboxes), `safety_downloads`. High files move to `media/quarantine/<path>.bin`; the
media route answers agents 403 `safety_locked` (recorded), serves admins `application/octet-stream` + `no-store`, and
refuses redownload. `Message.safety` comes from `present()`. Blocking: optional `WaCapabilities.block` /
`blockWindowHours` + `WaAdapter.setBlocked` (Baileys `updateBlockStatus`, fake). Auto-block (`safety_auto_block`, off)
only on a critical rule from a number that is not an existing customer, never in groups. The AI agent hands a High
message over (`sensitive`). Routes `/api/safety*` (admins), `/api/safety/chats/:jid` (inbox access),
`/api/reports/safety`. Web: `inbox/SafetyMessage.tsx`, `admin/SafetyPage.tsx`, `admin/SafetyReport.tsx`.

**Reports.** Design `docs/features/reports/design.md`. `GET /api/reports?days=7|30|90[&inbox=<id>]` (admins; no
`inbox` = every inbox together, else that one inbox, removed ones included, unknown 404 through `reports/scope.ts`; the
page's inbox choice shows with 2+ visible inboxes and also scopes `/api/reports/safety`; zod `Report` in
`packages/shared/src/reports.ts`) is counted on request by `reports/report.ts` (direct chats
only, business time zone `ai_timezone`; wait and reply times reuse `chats/activity.ts`). A new customer is a
chat whose first message is the customer's and is not older than WhatsApp's link time (the inbox's first stored
`created_at`, i.e. the history import); missed = no reply within `MISSED_LEAD_MS` (1 h); "waiting after AI
hand-off" = open chats whose last `ai.handoff` audit row has no later reply from a person (teammate or phone).
MCP `get_stats` carries `customers` from the same function. Web: `admin/ReportsPage.tsx` + `ReportCharts.tsx`
(HTML/SVG in colour tokens, no chart library; every chart has Show as table).

**New chat** (design `docs/features/new-chat/design.md`, mock `docs/features/new-chat/mock`). `chats/new-chat.ts`
(`ctx.services.newChat`) is the only way to start a chat with a stranger's number: the inbox's **New** dialog
(`GET /api/new-chat`, `POST /api/inboxes/:id/new-chat/check` (never asks WhatsApp), `POST /api/inboxes/:id/new-chat`
{phone, name?, clientRequestId, template?}) and MCP `send_to_new_number` (`openChecked`). Admins always; agents while
`new_chat_staff` is on (admins, `PUT /api/new-chat/settings`, audit `settings.new_chat_staff` before/after), from their
inboxes; never an agent limited to chosen chats, the AI or another role. The flow comes from `WaCapabilities` only: no
`replyWindowHours` → `checkNumber`, empty chat assigned to the starter, normal composer; a window with `templates` →
`MessageService.sendFirstTemplate` sends the template directly (not queued) and creates the chat only once WhatsApp took
it. Phone numbers: shared `normalizeLocalPhone` (a leading 0 gets the inbox's own country code, +60 fallback). Limits,
in memory, counted before WhatsApp is asked: `new_chat_daily_limit` per linked-phone inbox (default 20, 0 = none,
audit `settings.new_chat_daily_limit`; shared with MCP, which keeps its 20 per token on top) and 5 an hour per user.
Audit `chat.new_number` {inboxId, chatJid, userId, via, tokenId?}; logs ids only.

**Group info.** `packages/server/src/groups/service.ts` + `routes/groups.ts`: `GET /chats/:jid/members`
reads `WaAdapter.getGroupInfo` (Baileys `groupMetadata`) with a 5-minute cache invalidated by the
`groupChanged` event, names members from contacts and existing chats only (never inferred), and links
existing direct chats via `AliasStore.route`. About (`getAbout`) and member photos are fetched per person
on request; `POST …/members/:member/chat` creates an empty direct chat (audited) and never sends. Dev:
`POST /api/dev/fake-group` (fake WA only) builds a group with generated members.

**Contract.** zod schemas in `packages/shared` define every REST body/response and socket payload.
Change the schema first; server and web both import it.

**Editions and extensions** (design: `docs/superpowers/specs/2026-10-15-open-core-editions-design.md`;
engineer guide with examples: `docs/editions-engineer-guide.md`).
Lite is the open core; other editions add features through extension points and never patch core code.
_Server_: `runCli(argv, env, { edition, extensions })` (`run-cli.ts`; Lite's `cli.ts` passes no product, i.e.
edition `lite` with no extensions) takes `ServerExtension`s (`extensions.ts`): a name (`/api/ext/<name>` prefix,
`lite`/`core` reserved), an optional `migrationsDir` tracked per extension in `extension_migrations`
(never touches the core `user_version`), `init(ctx)` after every core initializer, and `routes` mounted
after core routes (add `requireUser`/`requireAdmin` yourself; Host/Origin checks still apply).
`agentTools(ctx, { agent: 'sales', chatJid | null, signal })` (`ai/agent/extension-tools.ts`) adds AI SDK
tools to one Sales Agent turn (live and Try it). They share `AGENT_MAX_STEPS` and the turn's abort/timeout,
and `dispose` runs in `finally`. `hasAgentLookups(ctx, { agent })` (sync, no network) tells the core that look-ups are available: the empty-Business-context hand-over (live, Try it) and the "add business context before turning on" check then let the agent run, and the prompt counts look-up results as facts. Core tool names are reserved and the first extension wins a duplicate name.
A tool that throws (`ToolHandoverError` or any other error) aborts the turn and hands over with
`lookup_failed`. Every call emits `ai:tool_call` {agent, chatJid, tool, source, title, ok, ms} and logs
tool/source/ok/ms only. Each successful live look-up stores an `ai_tool_used` chat event
{title, sourceLabel} (the "AI looked up …" line). `tryAgentReply` and `tunnelPublicUrls` are public. `ctx.access` (`access/gate.ts`, `http/access.ts`) lets an edition close an access gate with a code: every `/api` and `/mcp` call then answers 403 `{ error: code }` except `GET /api/health`, `GET /api/access` and host-only routes; sessions are deleted, Socket.IO refuses, the AI member, enrichment, send queue (no expiry while closed), tunnel and push pause, and WhatsApp keeps storing messages. Lite never closes it. Routes under `/api/ext/<name>/host/` are host-only (direct loopback peer + loopback Host + no `CF-Connecting-IP`, no session, open while closed).
`/api/health` reports `edition`; its `app` value stays `wa-team-inbox`. _Web_:
`createInboxApp({ extensions, productName })` (`apps/web/src/create-app.tsx`; Lite's `main.tsx` passes `[]`;
catalog strings name the app only through `{{product}}`, default "EzyChat Lite", except the share-the-app texts) takes
`WebExtension`s (`src/extensions/types.ts`, `validateWebExtensions`): routes only at `/ext/<name>/…`
(signed-in) or `/admin/ext/<name>/…` (admin shell and guard), admin nav links (absolute paths),
Settings → Integrations sections, and catalogs whose keys start with `ext.<name>.` (read with
`useExtensionTranslation`), `agentSections` (rows under Business context on each agent page, not on the new-agent page; `useAgentSection()` gives the row its `{ agentId, displayName, preset }`), route
`section` (an agent sub-page marks a core admin item active and names it in the phone header) and
adminNav `useBadge` (a count, or an attention dot in the warning tone); `banners` (one slim bar slot, first non-null wins), `lockScreen` (full page while the gate is closed; core `PausedScreen` otherwise), `createInboxApp({ links })` + `useAppLinks()` (About/issue/source/release/feedback/support links; `null` hides one) and brand files exported as `@ezychat/web/public/*`; every extension element is
wrapped in an `ErrorBoundary`. _Desktop_:
identity lives in `apps/desktop/src/product.ts`; `LITE_PRODUCT` holds the upgrade-contract values
(app ID, data/profile folders, service ID, launchd label, health `app`, update feed, installer and exe
names), pinned by `product.test.ts` against `electron-builder.yml`/`package.json`. `defineProduct` also takes `statusSections` (declarative cards in the desktop status window, actions handled in main, only `https:`/`mailto:` opened) and `updateFeed: { kind: 'url' }` (JSON manifest, for private editions) and `defaultPort` (a new install's
port; an edition installed next to Lite needs its own, Lite keeps 7420). Desktop catalogs name the app only
through `{{product}}` (`t()` fills in the active productName). Code reads
`activeProduct()`, never literals; another edition calls `startDesktop(defineProduct({…}))` from
`@ezychat/desktop` (`src/index.ts`; sets the product, then dynamic-imports main; Lite's Electron entry stays
`dist/main.js`). Files the shell ships (server host, preloads, status page in `dist/renderer`) are found from
the package folder (`dirname(<compiled main>)`), never `app.getAppPath()`; the edition's app provides the
layout (`dist/server/server.cjs`, `dist/package.json`, `resources/{web,tray,cloudflared,winsw}`,
`resources/app-icon.png`). `apps/desktop/scripts/build.mjs` builds it (tsc + renderer copy; keeps the server
bundle); the cloudflared/WinSW fetch scripts live in `apps/desktop/scripts/` (`--out <resources>`, also bins). The desktop adopts a running server only when health `app` and `edition ?? 'lite'`
match. _Packages_: shared/wa/server export `dist/` (`scripts/build-package.mjs`), `@ezychat/web` exports
`dist-lib/` (`vite.lib.config.ts` + `scripts/build-web-lib.mjs`: ESM, dependencies external, one
precompiled CSS with font files); inside the monorepo imports resolve to `src/` through the
`ezychat-source` export condition (tsconfig `customConditions`, Vite/Vitest `resolve.conditions`, esbuild,
`.npmrc` node-options, each package's `vitest.config.ts`); a plain `node`/`tsx` run outside npm needs
`--conditions=ezychat-source`. `scripts/pack-contract.test.mjs` pins the tarball contents and
`.github/workflows/publish-packages.yml` publishes on `v*` tags (npm trusted publishing via GitHub OIDC; dry run until the repo variable `NPM_TRUSTED_PUBLISHING` is `true`; a package not yet on npm is skipped with a warning: its first version is published by hand). Enterprise
(`anchorsprint/ezychat-enterprise`) consumes pinned published `@ezychat/*` versions, never a
git submodule or a committed `file:` dependency; to try an unreleased core it installs `npm run pack:core`
tarballs (`scripts/use-local-core.mjs` there), so never break `pack:core`. A change to a shared contract or an extension API is ready only after the Enterprise typecheck, lint and tests pass on that local core (then `npm ci` there); new response fields get zod defaults. Lite never imports Enterprise
code. Only each package's `index` exports are public API; anything else is internal and may change.

**Send queue** (`messages/send-queue.ts`): FIFO per chat, chats in parallel, ≥1s between sends in a
chat, `composing` presence before each send. Jobs wait while disconnected and fail as `expired` after
10 min; `wa_unavailable` errors keep the job pending. Pending jobs are persisted and restored on start.

**Data dir:** `app.db` (SQLite, migrations in `db/migrations`), `wa-auth/` (Baileys creds),
`media/`, `secret.key` (AES key for settings secrets such as the tunnel token), `logs/` (pino-roll,
daily, 14 kept), `backups/` (`VACUUM INTO app-YYYYMMDD.db` + `wa-auth-YYYYMMDD/`, nightly, 7 kept),
`models/whisper-small/` (optional voice model, downloaded on demand; see `docs/ai-sales-agent.md`),
plus a lock file. Tests never download the real model or call OpenAI. Live app data on Windows: `%APPDATA%\WA Team Inbox\data`.
The Windows program is `EzyChat Lite.exe` in `Program Files\EzyChat Lite` since 0.1.17 (the updater
still accepts the legacy `WA Team Inbox.exe`). The data folders, desktop profile, service ID and app ID
are intentional upgrade contracts; do not rename them when changing visible branding. The updater
jumps straight to the newest release (Lite: GitHub releases; Enterprise: `latest.json`), never through the
versions between: every upgrade step lives in a numbered migration or in permanent start-up code, never
only in one release, and `packages/server/test/upgrade-from-oldest.test.ts` (schema 1 → latest in one
start) must keep passing; extend its seed when a migration moves existing data. Workspaces are published to npm as `@ezychat/*`
(shared, wa, server, web, desktop); the desktop package ships the shell, never the server bundle.

**Logging.** Structured pino JSON in `<data>/logs/*.log`; child loggers carry `mod` (`wa`, `messages`,
`web`, …). Browser errors (window errors, unhandled rejections, React error boundaries) are POSTed to
`/api/client-errors` and logged as `mod:"web"`, msg `"client error"` with stack + componentStack.

**Native modules.** `better-sqlite3` and `@node-rs/argon2` are Node-API prebuilds: tests run them on
the system Node ABI, the packaged app loads the same binaries under Electron (`npmRebuild: false`).
Do not run `electron-rebuild` on the workspace; it breaks `npm test`. If `desktop start` fails to load
a native module in dev, set `WATI_DESKTOP_RUNTIME=node` to run the server with system Node.

## Security invariants (do not break; each has tests)

- First-admin setup (`routes/setup.ts`) only while no user exists, only from a direct loopback peer
  with a loopback `Host`, and never through the tunnel.
- `CF-Connecting-IP` is trusted only when the socket peer is loopback and its single value is a valid
  IP (`http/client-ip.ts`); it keys rate limits and decides `Secure` cookies. Unknown named-tunnel
  hosts are allowed only on this proxy boundary, consistently for HTTP and Socket.IO. Rate limits
  count an IPv6 client by its /64 network (`http/rate-limit-key.ts`), never by the single address;
  logs and audit rows keep the full address.
- Every request passes the Host allowlist (`http/host.ts`, DNS-rebinding defence: loopback, IP
  literals, single-label/`.local`, current tunnel hostnames). Mutating `/api` requests need
  `Origin` host == `Host` (`http/origin.ts`); Socket.IO checks Origin too.
- Media (`routes/media.ts`) renders inline only for an allowlist of raster/audio/video types;
  everything else is an attachment, served with a `sandbox` CSP and `nosniff`.
- Session tokens are stored as SHA-256 hashes; passwords use argon2; login lockout after 5 failures.
- After asynchronous credential hashing/verification, recheck the current password, disabled state,
  authorizing session and role as appropriate; do not yield between the final check and commit.
- Admin password reset only via the CLI `--reset-admin` or the tray menu, never over HTTP.
- Privileged desktop IPC requires the current registered window, its exact main frame and bundled
  status URL. A `file://` URL by itself is never sufficient authority.
- OS services must execute protected runtimes: check Program Files ownership/ACLs and links on
  Windows; use a root-owned copy without ordinary-user write permissions or ACLs on macOS.
- Managed updates accept no renderer paths or URLs. Require trusted release digest/size, reverify
  protected staging, prepare rollback before stopping the host, and relaunch through an unelevated
  broker. Do not use service removal/data migration as an update operation.
- Password generation requires cryptographic randomness. Redact credential fields from live logs
  and historical support exports; never export unexamined non-JSON records.
- Push endpoints are restricted to known push-service hosts (SSRF guard).
- CSP `script-src` is `'self' 'wasm-unsafe-eval'` only (WebAssembly for the voice note encoder; never
  `'unsafe-eval'` or inline scripts). The desktop window grants `media` only for audio from the inbox
  main frame (`inboxPermissionAllowed`), never the camera.
- AI assistant access (MCP: `/mcp`, `mcp/route.ts`) is off by default, answers only direct loopback or the
  tunnel, and accepts only a personal access token (`ezc_pat_…`, SHA-256 hashed, owner rechecked as
  an active admin on every call). `/api` never accepts a token, so a token cannot manage tokens.
  Inbox tools get only `InboxReadPort` (reads) and return media metadata, never links;
  the one exception is `get_message_file` (`mcp/file.ts` `MessageFilePort`, scope `inbox:read`): the content of
  one message's photo (JPEG/PNG/WebP from the bytes, ≤ 1.5 MB, MCP image content) or the text of its PDF/.docx
  (`extractKnowledgeIsolated`, ≤ 10 MB, ≤ 20,000 characters, `text: null` for a scan), only in the token owner's
  inboxes (else "not found"), never a link, never a file Safety rated High or one still awaiting its AI check
  (fail closed, admins too), pending history media downloaded through `ensureMedia`, 30 a minute per token, audit
  `mcp.read_file` {tokenId, messageId, kind, size}, never the name or content. It is not offered to Ask Ezy. AI setup
  tools (scope `ai:setup`, every admin token) go only through `AiSetupPort` (`mcp/ai-setup.ts`): they
  may change the AI instructions, hand-off rules and Business context **text** items, never files,
  the connection, key, model or on/off. Every change keeps a version (`ai_setup_versions`, app saves
  too) and an audit row with token id and reason, and is rate-limited per token. The send tool
  (`send_message`, scope `inbox:send`) exists only for a token with `canSend` (default off; set at
  creation or later only by the token's owner in Settings, `PATCH /api/integrations/tokens/:id`, audit
  `api_token.update` with before/after, never through a token) and goes only through `InboxSendPort` (`mcp/send.ts`), which rechecks
  the scope: text into an **existing** chat, as the token owner, through the
  normal message service; idempotent per token + `requestId`; 10 a minute and 100 a day per token;
  audit `mcp.send` {tokenId, chatJid, messageId}, never the text. `send_image` (same scope and limits)
  sends a JPEG/PNG/WebP (type read from the bytes, ≤ 5 MB) given as base64 or a public https link
  downloaded only through `guardedFetch` (SSRF guard, 10 s, no loopback/private address); a retry with
  the same `requestId` downloads nothing; audit adds `type: 'image'`, never the caption or link. `send_file` does the
  same for a PDF or Word .docx (≤ 5 MB, type read from the bytes, sent as a document named `fileName`; audit
  `type: 'document'`). `/mcp`
  accepts bodies up to 8 MB (`MCP_BODY_LIMIT`), only after the token check in `onRequest`. `send_to_new_number` (scope
  `inbox:send_new`, ticked at creation under "Can send", default off) may start a chat with a number not
  in the inbox only after `WaAdapter.checkNumber` confirms it, through the New chat service (20 checks a day per
  token, then the inbox's shared daily limit, counted before the check; audit `chat.new_number` via `mcp`); its description and every result carry the WhatsApp ban warning.
  Tools log tool name, counts and token id, never arguments, phone numbers or message text.
- MCP sign-in (OAuth, `mcp/oauth.ts`, `mcp/oauth-routes.ts`, `routes/oauth.ts`): apps register at
  `/mcp/oauth/register` (https, loopback http or an app scheme only), an admin approves on the web page
  `/oauth/authorize` through `/api/oauth/*` (session + Origin), PKCE S256 only, one-time 5-minute codes
  kept hashed in memory. The token endpoint issues an ordinary `ezc_pat_` token (`createForApp`: no
  expiry, no send scopes, replaces the app's earlier token). An unchecked request is never redirected;
  same reach as `/mcp` (off 404, LAN 403).
- Inbox access (`inboxes/access.ts`, `inboxes/service.ts`): admins and the AI member see every inbox,
  agents only their `inbox_members` rows (Lite with one inbox: everyone). Every per-chat, media and
  message-id route answers **404** outside the caller's inboxes; the chat list, search, tags, stats and
  MCP tools are filtered; chat events go to `inbox:<id>` socket rooms (rebuilt live on access changes);
  push, assignment and AI hand-off only reach people who may open the chat's inbox. An edition limit
  never widens access: the "one inbox" shortcut also checks the stored rows.
- Limited chat access (design `docs/features/partner-role/design.md`, migration 037): an agent with
  `users.chat_scope = 'chosen'` opens only the chats in `member_chats` (any active inbox; they replace inbox access).
  `scopeFor` returns an empty inbox scope for them **before** the single-inbox shortcut, so `canOpen(inboxId)` is
  false; one chat is checked with `canOpenChat` (`requireChatAccess`, `requireMessageAccess`, assignment, typing).
  Every per-chat, media and message-id route answers 404 outside the chosen chats; the list, search and tags read only
  them; sockets join `chat:<jid>` rooms (and `inbox-status:<id>` for connection state), never `inbox:<id>`, rebuilt
  on `member-chats:changed`; push, `notification:new`, AI hand-offs (group ones too) and unassigned-chat notices go
  only to `usersWhoCanOpenChat`. No chat from a group member (403 `chat_scope_limited`) and no Ask Ezy. "Chosen"
  with no rows means no chats, never all; a promotion to admin clears the choice.
- Host-only extension routes (`/api/ext/<name>/host/…`) answer only a direct loopback peer with a
  loopback `Host` and no `CF-Connecting-IP`; the access gate allowlist matches the decoded path and the
  matched route, never a raw prefix alone.
- New chat (`chats/new-chat.ts`, `/api/inboxes/:id/new-chat[/check]`, MCP `send_to_new_number`): only admins, or
  agents while `new_chat_staff` is on, and only from inboxes they may open (else 404); agents limited to chosen chats,
  the AI and every other role are refused (403). One number per request; counted before `checkNumber` (the admin's
  daily limit per linked phone, shared with MCP; 5 an hour per user); a template-first inbox creates the chat only after
  WhatsApp accepted the template. Audit `chat.new_number` and logs carry ids only, never the number's name or message
  text. The core decides the flow from `WaCapabilities`, never from an inbox type name.
- `/api/client-errors` is public but rate-limited per IP and size-capped.

## UI rules (apps/web)

See `docs/design-system.md` ("Calm Desk"). Primitives are shadcn/ui in
`apps/web/src/components/ui`; app composites in `components/app`. Feature code must not use raw
`<button>`/`<dialog>`/`<select>` or Tailwind palette/hex colours (ESLint enforces); use token classes
(`bg-primary`, `text-muted-foreground`). Every screen must work at 360px without horizontal scroll.
Every route is wrapped in an `ErrorBoundary` — never let a render error become a blank page.
Write for a business owner, not an engineer: few, plain words, and an `InfoTip` for anything technical
(design-system "Writing"). No literal user-facing strings: use `t()` and add every key to `en`, `ms` and `zh-CN` in the same
change (`docs/i18n.md`; ESLint and the catalog tests enforce this). Server API messages stay English.
App-managed cloudflared launches must ignore unrelated default user configuration (`--config=`).
Cloudflare sign-in must run with a private child home; `login` ignores `--origincert`. Store account
credentials only as encrypted settings, redact authorization URLs and API tokens from logs, and never
overwrite DNS or configure a tunnel that the app did not create.
A Quick Tunnel is Running only after URL assignment and edge registration.

Admin shell links and fallback redirects must use absolute `/admin/...` paths. Routing changes must
cover navigation from every admin section and recovery from malformed URLs.

## Working rules (required)

- **Security review for network changes** (owner rule): a change that opens, binds or moves a network
  listener (port, host, socket, tunnel, even a short test listen) gets a security review before its PR:
  interfaces touched, OS firewall prompts, what the LAN or another local program could reach, and the
  security invariants above. Run `/security-review` on the branch and write the result in the PR description.
- **Debug from evidence, not guesses.** Read the server log (`<data>/logs/*.log`) before proposing a cause.
  If the failure isn't in any log, add structured logging (pino child logger with `mod`, fields — not
  string concatenation) first, reproduce, then read it.
- Changes under `packages/wa/src/baileys/**` must be smoke-tested against real WhatsApp before claiming
  they work; otherwise say "untested against real WhatsApp".
- Never use the real app data folder for tests or experiments; always `--data <temp dir>`. Never send
  WhatsApp messages from a real linked number while testing.
- GUI smoke tests use a plain Electron harness with an explicit temporary profile; a packaged
  executable always launches its normal entry even when passed a script. Verify packaged modules
  and preloads from the harness; use `ELECTRON_RUN_AS_NODE=1` for packaged server checks.
- A change that adds a native module or worker (e.g. voice transcription) must be smoke-tested end to
  end in a `--dir` packaged build before release: `ELECTRON_RUN_AS_NODE=1`, a temp data dir and
  `--fake-wa`, exercising the feature itself, not only server start-up.
- After a base PR is squash-merged, replay only your own commits with
  `git rebase --onto origin/main <old-base>` and typecheck even when the rebase is clean. Never chain
  `git add` or `rebase --continue` after edits that may have failed: search for conflict markers first
  (`git grep -nE '^(<{7,8}|>{7,8})( |$)'`: a rename conflict writes 8-character markers;
  `scripts/no-conflict-markers.test.mjs` fails CI on any left in a tracked file, mock folders included).
- Run only the unit tests for files you changed (`npx vitest run <paths>`) plus the typecheck of the
  package you touched. **Don't run e2e or the full suite** unless you are the single, final
  verification step.
- **Good to go needs coverage** (owner rule): a change is ready only when its tests cover at least 90 %
  of the executable lines it adds or changes (`npm run test:coverage` then `npm run coverage:changed`;
  CI enforces both on every PR) and the totals stay above the floors in `vitest.config.ts`. The target
  for every total is 90 %: raise a floor in the same PR that lifts a total past it, never lower one.
  Coverage counts only real assertions on behaviour; a test that only runs code to raise the number is
  not allowed.
- **Contracts are tested against the real server, never only against a fake `fetch`** (owner rule):
  `packages/server/test/web-client-contract.test.ts` checks every `api()`/`fetch('/api…')` call in
  `apps/web/src` (method + path, read with the TypeScript checker) against the real route table; keep
  paths literal, constant or a string-literal union so it can read them. A new kind of client (desktop
  section, edition package) gets the same test or an end-to-end test against `makeTestApp`.
- **Every change that touches a screen gets one round of the mock e2e before it is reported done**
  (owner rule): `apps/web`, the desktop shell (`apps/desktop`: windows, tray, dialogs, status page) or a
  web/desktop contract. One round = `npm run e2e` (browser, fake WhatsApp, mock AI) and, on Windows,
  `npm run e2e:electron-links` (every screen in the real desktop window). The main agent (or the single
  agent working alone) runs it once at the end, after all edits; subagents still never run e2e.
- On Windows prefer PowerShell; write multi-line scripts to a file instead of `node -e "…"`.
- **Bounded decisions with TypeSafe Jev** (owner rule; user-level skill `jev-decision` in `~/.claude/skills`, "Jev", also spelled
  "jav"): for batches of small judgments (classify files or review comments, triage an external issue, pick a
  LEARNINGS section, rubric scores, ambiguous yes/no checks) call Jev instead of long reasoning; about 1 s and
  under 1k tokens a request. Gather evidence first; never for what code, graphify, `rg` or tests settle exactly.
  The key is the Windows user variable `TYPESAFE_API_KEY` (never read or print it). Results are advisory: below
  your threshold, decide from the evidence; if Jev is down, continue without it and say so.
- **Release review** (skill `release-review`, design `docs/superpowers/specs/2026-10-24-release-review-design.md`):
  after the last verification of a feature PR, score it with `node scripts/release-review.mjs <pr>` and log it;
  it scores, logs, comments and labels only. It is also the **final merge check**: run it on the head right before
  a merge the owner asked for; its first line is `MERGE OK` or `NOT READY: <reasons>` (design §3.7). Record workbook stages with the checked commit
  (`build-summary.mjs record` does it) and put the short commit in each Dev Build row. The merge rule
  below is unchanged until the owner approves the design's section 9 in writing.
  **A low score is a to-do list, not a stop** (owner rule): run every check you can for each `✗` item and
  hard stop (e2e + links, Dev Build, packaged `--dir` smoke for critical runtime parts: see LEARNINGS), then
  score again. Hand a PR to the owner only when everything testable is done and it is still `risk:human`
  (real WhatsApp, the real installer, actions that need approval), and list exactly what is left.
- **Dev Build check log.** Read `docs/dev-build-checks.md` before testing a feature in a Dev Build and
  add one row per check (scenario, exact steps, result, what stays untested). AI behaviour checks use
  `e2e/devbuild-ai-check.mjs` and real model calls only with the owner's sign-in and agreement. Code
  changes after a check (e.g. review fixes) mean re-running the affected checks on the final commit.
- **Owner test environments** (owner rule): Dev Builds that the owner tests by hand (real AI sign-in or
  key, Enterprise licence trial) run on the permanent folders outside the repos, `D:\dev\test-env\lite`
  (port 7491) and `D:\dev\test-env\enterprise` (port 7434), each with `start.ps1` and a README; their data
  stays between checks. `npm run e2e`, unit tests and the mock-model checks never use them (they start
  from empty temp data). Never real app data. A Dev Build you hand to the owner on a PC that also runs a live
  install must make irreversible steps against that install impossible (test data, or a build that refuses
  them); a warning in chat is not enough.
- **Run the Dev Build check yourself before saying a feature works.** Unit tests, e2e and a screen
  review are not enough: run the feature end to end in a Dev Build (and with the real outside client
  where one exists, e.g. an MCP client), log it, and only then report it as working. Until then say
  "built and tested, not yet checked in a Dev Build".
- **Complete feature HTML mock before production UI code.** Every feature that requires UI keeps a
  reviewable, interactive HTML mock at `docs/features/<feature>/mock/index.html`, with local assets
  and run instructions, inside the current project repository. Commit this feature folder as the
  durable reference for the next agent; do not leave the canonical mock in an external prototype
  folder or only in an ignored scratch directory. Keep its scope, screen/state checklist and confirmation record in
  `docs/features/<feature>/design.md`; link these from the feature workbook. Do this proactively,
  before implementation, rather than adding screens only when the owner asks where they are.
  Mocks are cumulative interactive app references, not disconnected feature demos. For every
  enhancement, clone the latest owner-confirmed mock from `docs/features/mock-index.json` into
  the new feature folder, preserve its existing app flows, and add the enhancement there. Record
  the source feature/path and exact git revision in `design.md`; never replace the last confirmed
  baseline with an unconfirmed proposal. If no confirmed baseline exists, bootstrap it from the
  current app's actual frontend source, not a hand-recreated shell, and record coverage gaps
  before asking for confirmation. Freeze source hashes; in enhancements list the intentional
  changed/added files and verify that the rest of the reference has not drifted.
  After the owner confirms a complete mock, record the confirmation and update the index so the
  next agent clones that revision. The interactive scope includes the app context, navigation,
  feature entry points and end-to-end simulated feature behaviour; a screenshot or isolated
  popup is not a complete reference. Keep mock data and effects separate from the real app.
  **Retention: keep only the five most recently created feature folders** under `docs/features/`.
  Record creation order/date in the mock index; when adding a sixth, remove the oldest committed
  feature folder and update the index in the same reviewable change. Verify the target belongs to
  `docs/features/` and has no unrelated uncommitted work before cleanup. Older references remain
  available in git history; record each baseline's exact revision/path before removing its folder.
  If the latest confirmed baseline was pruned, recover that revision from git into the new feature
  mock rather than starting over or treating an unconfirmed proposal as approved. The root index
  and workflow README are not feature folders. Cleanup never authorizes automatic merging.
  Inspect related existing features first and record the source screens/components and behaviours
  being reused in `design.md`. Ground the mock in the current app, its real routes, navigation,
  configuration, save/error patterns, permissions and translations; extend existing flows rather
  than inventing a disconnected screen or redesigning unrelated features.
  Cover the whole feature journey: entry points, Settings/configuration, primary screens, dialogs,
  audit/history where relevant, and the important enabled/disabled, unavailable, empty, error and
  long-content states. Use demo data, the existing design system and actual navigation labels;
  verify desktop 1280 px and mobile 360 px. Show the runnable mock and screenshots to the owner
  and record their confirmation before production UI implementation. The confirmed HTML mock is
  the implementation and screen-review reference; material scope/UI changes update that mock
  and need confirmation again. Generated images may supplement it, but never replace the HTML
  reference. Keep the mock and confirmation record with the feature in git, not only in ignored
  scratch folders or chat attachments.
- **Screen review for every UI change.** Before a feature that changes screens is done:
  1. Capture each affected screen at desktop 1280 px and mobile 360 px, in light and dark where relevant,
     and in every state: empty, filled, editing, error and long text.
  2. Run a UI/UX product-designer review against `docs/design-system.md`, the shadcn components and
     usability/accessibility practice. Check hierarchy, spacing, labels, touch targets, focus and
     consistency with neighbouring screens.
  3. Fix the findings with tests: e2e plus `screens.smoke.mjs`. Then re-capture the screens and compare
     before/after pairs: design fixes can introduce new problems.
  4. Refresh `docs/screenshots/`.
  5. Show the desktop and mobile screenshots to the owner.

## Multi-agent rules (orchestrators)

- **Small changes are done directly, not in a subagent** (startup costs 20–40 min; tests compete for CPU).
  Use subagents only for large, independent work. Use the Workflow tool for large multi-part work
  with as many parallel agents as the work allows; agents never run e2e, the full suite, a UI/UX screen
  review or a full screenshot run (`screens.smoke`, mock walkthroughs); the main agent runs the
  consolidated verification and the screen review once, after all dev agents are done.
- Subagents get disjoint file-ownership lists; only the orchestrator commits.
- **Feature workbook.** Every feature branch keeps `docs/workbooks/<branch>.md` (stages Design, Dev,
  Unit tests, E2E, Dev Build, Screen review + a log). Each agent records its stage as it finishes with
  `node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits the workbook with the
  work; the owner's feature summary (`/feature-summary` or plain English; `node scripts/build-summary.mjs`, skill `feature-summary`) reads it
  together with the live PR checks.
- **One consolidated verification at the end** runs `npm run typecheck`, `npm test`, `npm run lint`,
  web build and `npm run e2e` once — nothing else runs e2e.

## Session end (required, owner rule)

Before you end a session or hand work back to the owner:

1. **Reflect.** Add the session's real lessons to `docs/LEARNINGS.md` (see Learnings loop; Enterprise-only lessons
   go to that repo's) and say in one line which rules you added or sharpened, or that there were none.
2. **Score.** For every PR you opened or pushed to in the session, run the release review on its current
   head (`node scripts/release-review.mjs <pr>`; it uses only REST and git, so it runs the same in a cloud
   session) and end your last message with a score summary:
   PR, head commit, score, decision, hard stops, and each `✗ missing` item with who must do it. A PR whose
   last code change has no fresh score is not reported as ready.

## Learnings loop (required)

`docs/LEARNINGS.md` is a compact, topic-grouped list of rules. Before finishing a run that changed code,
add any real, re-usable lesson as one short rule bullet in the matching section, or sharpen an existing
bullet; no dated stories or filler (history stays in git). Lessons specific to EzyChat Enterprise go to that
repo's own `docs/LEARNINGS.md`. If a lesson changes how agents must work,
update the rule in this file. (Claude Code prompts for this with a Stop hook; other agents must do it
themselves.)

## Conventions

Conventional Commits; LF line endings; Prettier formatting; add user-visible changes to
`CHANGELOG.md` under `[Unreleased]`. When a UI change ships, refresh that module's shots in
`docs/screenshots/` (demo data only). Never commit `data/`, `.e2e-data*/`, `wa-auth`, databases or secrets.
Stage the files a change names (`git add <paths>`), never `git add -A` / `git add .`: a branch cut before an
ignore rule landed still tracks local test data.
After repository setup, `main` is protected: use feature branches and reviewable pull requests.
**Anonymous usage stats only** (owner rule, 2026-11-04; replaces "No tracking in Lite"): the app's only usage data
is `packages/server/src/usage/` (design `docs/superpowers/specs/2026-11-04-usage-stats-design.md`): a fixed set of setup milestones
(shared `UsageEvent`: random `usage_install_id`, product, version, OS, mode, event name; nothing else), sent
server-side only to our licence portal relay (`/v1/usage`), which forwards to GA4. The GA keys live only in the
portal, never in the app. On by default; admins switch it off (`usage_stats`, Settings → General and the setup
wizard). Never names, numbers, chats, messages, emails, IPs or keys; no analytics script in the web app (CSP
unchanged); a new field or event is an owner decision plus a portal contract change. Website links may carry
campaign tags (`utm_*`).
**GitHub issues are for external reports only** (owner rule): never open an issue for our own work;
track own follow-ups in `docs/backlog.md` (bugs and next steps), a feature's `design.md`, PR descriptions or workbooks. Treat each issue as an
external report: verify it in the code, then reply (confirm with the fix PR, or ask for the missing
details); a confirmed bug may be fixed and released.
**Merge only when the owner explicitly requests merging that PR.** Never merge automatically or
enable auto-merge. Requests to fix, implement, commit, push or open a PR do not authorize merging;
passing checks and resolved reviews do not authorize it either. Finish the work and report readiness,
then leave the PR open until the owner requests the merge.
**Release once a day** (owner rule): a merge does not start a release. Merged work goes out in one daily
release of both editions (Lite, then Enterprise on that core); release in between only for an important
change (security, data loss, a broken install or update) or when the owner asks "merge … and release".
This is currently a solo-maintainer repository, so a second maintainer's approval is not required;
the owner's explicit merge request is still required.
Never bypass its CI or conversation-resolution requirements for routine changes. Restore a required
approval when another maintainer can review changes.
**Releases** follow `docs/release.md` (EzyChat Lite: release PR, CHANGELOG section as the notes, then tag + publish through `release-approve.yml` (§4, started only when the owner says "release"), permanent download links); EzyChat Enterprise has its own flow in its repo (`docs/releases.md`). After both editions are out, the release day goes on the website release page `/releases` (ossmalaysia/ezychat-website, `src/lib/release-calendar.json` + translations; `docs/release.md` §6); the release is done only when that PR is merged. Before deploying a changed build, bump the root package version, run `npm run version:sync`, sync the
lockfile, and verify that `/api/health` and the UI identify the deployed version. Activate the complete
build with a server restart; never rebuild the distribution directory while the server is serving it.
Before `npm run dist`, confirm no installed app or service runs from `apps/desktop/release`
(`sc qc wa-team-inbox`, `/api/health`); otherwise build with `-- --config.directories.output=<new folder>`.
GitHub Actions in this org must be pinned to full commit SHAs. Private repositories (e.g. the Enterprise repo)
run CI only on the org's self-hosted runners (`runs-on: [self-hosted, Linux, ARM64]`), never GitHub-hosted ones.
