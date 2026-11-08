# Backlog (own follow-ups)

Our own open items. GitHub issues are for external reports only (AGENTS.md), so internal bugs and ideas
are listed here until they get a branch. Newest first; remove an item when its PR merges.

## Bugs

- Windows updater after an antivirus block (seen 2026-11-05, Enterprise 0.1.25 → 0.1.26 with McAfee, twice): the
  rollback that emptied Program Files is fixed (`WINDOWS_START_INSTALLER`, `WINDOWS_RESTORE_OLD_APP` in
  `apps/desktop/src/updater/install.ts`). Still to do: show the blocked-installer result in the app's own language
  and do not offer the same version again for some days, and an owner decision on a delay before offering new
  releases (frequent releases are always new, low-reputation installers).
- `e2e/devbuild-multi-inbox-check.mjs` fails from its second step on a fresh `--fake-wa --mode dev --max-inboxes 3`
  server (one inbox, adding Catering answers 409), also with `main`'s copy of the script (found 2026-10-30 in a cloud
  session while verifying PR ossmalaysia/ezychat-lite#229). Find whether the CLI start line or the limit changed.
- **One name for hand-over.** Setup, Settings and the audit say "Hand-off rules"; the agent page says "Hand-over
  rules", and its ms and zh catalogs still show the English words (`ai.agents.handoffTitle`). Pick one word in every
  language (found in the concept-tips screen review, 2026-10-30).
- **Emoji reactions: receive and show done** (branch `feat/emoji-reactions`, 2026-10-23; design
  `docs/features/emoji-reactions/design.md`). Left: (1) a live smoke against real WhatsApp of the Baileys
  mapping (`mapWAReaction`, `mapStoredReactions`: live, change, removal, group, history), still
  **untested against real WhatsApp**; (2) **let the team react** from EzyChat (send a `react` message,
  mock first); (3) optionally show "reacted 👍 to …" in the chat list preview.
- **A failed file upload cannot be sent again** (code review of PR #196, 2026-10-28; older than that PR): the
  failed bubble keeps the caption, but Retry does not resend a local upload and the tray is already empty.
  Keep failed files (with caption and quote) in the composer tray, or let Retry upload the kept `File`.
- **Desktop drag-out not checked in the real window** (PR #196): drag an image or document from a chat to the
  desktop or a folder in the installed app (Electron `DownloadURL` drag; no `will-download` handler, so the
  default save path or dialog applies). Hand check in the next test release.
- **Flag emoji show as letters on Windows** (2026-10-22): Chrome on Windows shows 🇲🇾 as "MY" (Windows has
  no flag glyphs). Fix with a bundled country-flag font (polyfill) for the web app.

- **A live event right after the conversation loads can be lost** (seen in the message-changes e2e on mobile,
  2026-10-28; older than that change): `upsertMessageInCache` drops an event that arrives before the first
  messages fetch has answered, and that fetch carries the older snapshot, so the bubble stays stale until the next
  refetch. Fix idea: keep early events per chat and apply them on top of the first page.

## Ideas and next steps

- **MCP `send_audio` / voice note** (2026-11-08, from `feat/mcp-file-upload`): uploads take JPEG/PNG/WebP/PDF/.docx/MP4
  only. An audio tool would need the Ogg/Opus checks of `messages/voice-note.ts` for a voice note, or a plain audio
  file type list; and more document types for `send_file` (xlsx, pptx) if the owner wants them.

- **Real-model check of the hand-off rules fixes** (PR #230, merged 2026-10-30): after the next release, run
  `try_ai_reply` on the Anchor Sprint agent (v87) with "Hi Anchor Sprint, I'd like to book a free consultation (from
  your homepage)." (expect action `answer` with a discovery question, no hand-off) and "What is the difference
  between Claude Team Standard and Premium seat?" (expect no check-in line). Needs the owner's AI sign-in; log the
  result in `docs/dev-build-checks.md`.
- **Idle AI chats** (2026-10-30, from PR #230): with "Ask if the question is answered" off (the default), an AI agent
  keeps a chat open and assigned to itself until a hand-off or a teammate acts, so answered chats pile up in the
  open list. Proposal: resolve a chat the AI holds after N days (e.g. 3) without a customer message, silently (no
  message to the customer; a new message reopens it as today), per-agent setting, audited. Mock first.

- **Waiting after AI hand-off in the inbox** (2026-10-30, from the hand-off rules fix): the count lives only in
  Reports and MCP `get_stats`; the push now says "<name> is waiting for a teammate". Add an inbox filter or badge
  for these chats (mock first, `docs/features/<feature>/mock`).

- **Ask Ezy: model choice** (owner, 2026-10-30, follow-up of 0.1.64): Ask Ezy answers on the connection's fast
  model. Add "Model for Ask Ezy" in Settings → AI (Fast default / same as the AI agent / a model of the
  connection), reusing the reply-suggestions model setting and route pattern.
- **Ask Ezy: follow-ups** listed in `docs/features/ask-ezy/design.md` (after round 9), plus a hand-off answer that
  shows real hand-off counts, not only the rules. (Screenshots: `docs/screenshots/ask-ezy/`, #222.)
- **AI reactions** (owner, 2026-10-30): let the AI add an emoji reaction where the connection supports reactions
  (linked phone), and reply with the emoji where it does not; needs a `reactions` capability on `WaAdapter`.
  The first use, a 👍 when a customer only thanks after the AI resolved the chat, is on `fix/ai-thanks-after-resolve`.
- **Booking reminders** (2026-10-26, owner asked how; not in the first Google Calendar round): part of the
  Google Calendar connector, per agent: on/off, 1 day / 3 h / 1 h before, editable text; only bookings EzyChat
  made, re-read the event before sending (deleted → none, moved → new time), one per booking, not 10 pm–8 am;
  Business API inboxes need an approved template. Later a general "skills" layer can reuse the scheduled send.
- **Google app verification** (2026-10-26): project `ezychat-prod` is in production with verified branding;
  data access (sensitive `calendar.events.owned`) needs the demo video and submission in the Verification Center.
  Until then users see Google's unverified-app screen (100-user cap). Release bundles carry the client since this PR.
- **Connector gallery: Enterprise custom connector tile** (2026-10-26): Enterprise registers its custom MCP
  connector page for the core gallery tile (web extension `connectorLinks`) and drops its own Connectors nav item.
- **Docs-only CI fast path** (2026-10-24): `main` requires the three `Test (*)` checks, so a doc PR cannot
  use `[skip ci]`. Add a first step in `ci.yml` that detects a change of `*.md` files only and reports the
  test jobs as passed without installing or testing.
- **Desktop memory** (measured 2026-10-24 on 0.1.51, temp data, fake WhatsApp, private MB): server ~230,
  shell without a window ~105, window open adds ~85 (renderer) and GPU grows from 60 to 130–260 and keeps
  it after the window closes. Next: (1) `app.disableHardwareAcceleration()` (GPU 205 → 21 in the probe;
  screen check for scrolling), (2) destroy the window on close instead of hiding it (renderer ~70–90 MB;
  reopen took 180–300 ms; tray and notifications must still work). Re-measure with real WhatsApp.

- **One affiliate download link** `https://ezychat.ai/download?ref=<code>` (website repo): detects
  Windows / Mac Apple silicon / Mac Intel and starts the newest published installer, buttons for the
  others. Waiting for the owner: skip or keep the download form for this link.
- **Enterprise 0.1.5 on core 0.1.48**: pins to 0.1.48; the connectors test double needs
  `GET /api/ai/agents` and `GET /api/ai/agents/1`; the Connectors card should read `useAgentSection()`
  to name the agent of the page; create `D:\dev\test-env\enterprise` (copy the earlier trial data).
- **AI agents follow-ups**: see `docs/features/custom-agents/design.md` → Follow-ups (copy items between
  agents, conflict warning, Try it as a short chat, and more).
- **Claude provider follow-ups**: test a saved Claude key from the page; wording for a Claude refusal.

## Final merge check follow-ups (release review)

- `scripts/build-summary.mjs` (feature summary) still reads PRs through GraphQL, which cloud sessions block:
  move it to the same REST + CCR routes as `scripts/release-review.mjs`.
- CI does not run the browser e2e (`npm run e2e`); the e2e points still come from a workbook stage. Running the
  e2e in CI would let the release review read it from the head like the link check (needs the owner's call:
  CI minutes, flaky-test policy).
