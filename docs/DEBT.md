# Tech debt register

What tech-debt reviews found, what was fixed, and the rule that stops it coming back. Read it before a
debt review (so a finding is not reported twice) and before adding code in an area listed under **Open**.
Newest first. Bugs and feature ideas stay in `docs/backlog.md`; short rules for every agent stay in
`docs/LEARNINGS.md`.

Each entry: **where**, **what**, **why it matters**, then **fix** (PR) or **next step**, and the
**rule** that prevents a repeat.

## Backlog table (daily tech-debt run)

One row per item; the daily run works it top to bottom. Detail for fixed items is under **Fixed**.

| id | area | finding | severity | size | status | last checked |
| --- | --- | --- | --- | --- | --- | --- |
| L-1 | desktop/updater | Blocked installer (antivirus): result not shown in the app language; same version offered again at once | med | major | recorded-major (needs owner decision on a delay before offering releases) | 2026-11-07 |
| L-2 | e2e | `e2e/devbuild-multi-inbox-check.mjs` fails from step 2 on a fresh `--max-inboxes 3` server | low | small | open | 2026-11-07 |
| L-3 | web i18n | "Hand-off" vs "Hand-over" wording differs; ms/zh `ai.agents.handoffTitle` still English | low | small | open (touches a screen: needs e2e round) | 2026-11-07 |
| L-4 | web | A failed file upload cannot be sent again (Retry does not resend the local file) | med | major | recorded-major (composer tray redesign) | 2026-11-07 |
| L-5 | web | A live event arriving before the first messages fetch is dropped (`upsertMessageInCache`) | med | small | open | 2026-11-07 |
| L-6 | e2e | `e2e/reactions.spec.ts` flaky | low | small | open | 2026-11-07 |
| L-7 | wa | Reactions mapping untested against real WhatsApp | med | major | recorded-major (needs real WhatsApp) | 2026-11-07 |
| L-8 | desktop | `status-sections.ts` TODO(phase 4b): import types from `@ezychat/desktop` once published | low | small | open | 2026-11-07 |
| L-9 | web | Flag emoji show as letters on Windows (needs bundled flag font) | low | small | open | 2026-11-07 |
| L-10 | deps | 10 Dependabot PRs open (#302-#311) and older PRs #201, #237, #240, #249, #273 | low | small | open (not techdebt/ PRs; not merged by this run) | 2026-11-07 |

SonarCloud was not queried and lint/typecheck were not run (docs-only change); re-check next run.

### Run log

- 2026-11-07: no `techdebt/` PRs open; no code fixed; backlog table created from this file, `docs/backlog.md` and a TODO scan.

## Fixed

### 2026-11-07 · AI leak check searched the whole reply for every Internal window

- **Where:** `packages/server/src/ai/leak-check.ts` (`findLeak`), run on every AI reply (`ai/service.ts`,
  `ai/draft-check.ts`).
- **What:** each 40-character window of the Internal texts (up to 10,000 characters per agent) was searched
  for with `reply.includes(…)`: about 10,000 substring scans of the whole reply.
- **Why it matters:** the only measurable CPU cost found in the 2026-11-07 performance review: 11.6 ms per
  4,000-character reply with no leak (the usual case), on every AI reply.
- **Fix:** index each 40-character window of the reply once in a `Set`, then look each Internal window up:
  1.2 ms (about 10×). Trade-off: a short-lived set of about 4,000 strings (≈0.75 MB) per call, collected at
  once. An equivalence test keeps the old algorithm as the reference on 300 generated cases (leaks planted
  with changed case and spacing, three minimum runs).
- **Rule:** a speed-up of a safety check ships with a test that compares it to the plain algorithm on
  generated input, both outcomes exercised.

### 2026-11-01 · Hand-rolled "database at migration N" in tests

- **Where:** `packages/server/src/db/migrate.test.ts` (8 copies), `test/upgrade-from-oldest.test.ts` (3),
  `test/ai-agents-repo.test.ts`, `test/inboxes-foundation.test.ts`, `src/lite-import/checks.ts`
  (`newestCoreMigration`, a second "newest migration" scanner).
- **What:** each test listed `db/migrations` itself, filtered by number, sorted (some by string, some by
  number), ran the SQL and set `user_version` by hand. `migrate.test.ts` also hard-coded `LATEST = 28`, so
  every new migration had to edit it.
- **Why it matters:** 14 copies of the migration runner that could drift from the real one (a string sort
  breaks at migration 1000; a copy that forgets `user_version` tests a database no release ever left), and
  a magic number to bump per migration.
- **Fix:** `migrate(db, upTo?)` stops after migration `upTo`; `latestMigration()` returns the newest
  number. Every copy now calls them; `newestCoreMigration()` delegates. New tests pin the stop/continue
  behaviour and that migrations are numbered 1..N without gaps or duplicates.
- **Rule:** build an old-schema test database with `migrate(db, N)` and compare with `latestMigration()`;
  never list `db/migrations` or set `user_version` by hand in a test.

### 2026-11-01 · Stale backlog entry

- **What:** `docs/backlog.md` still listed the Windows CI time-out in `ai-agents-repo.test.ts`, already
  fixed by #241 (in-memory databases).
- **Rule:** a PR that fixes a backlog item removes it in the same PR (backlog rule: "remove an item when
  its PR merges").

## Open

- **Rust and performance evaluation (2026-11-07, no migration).** Goal checked: speed, safety, memory.
  Measured on Node 22 (macOS arm64), worst-case inputs, TypeScript today: voice-note parse + waveform
  0.007 ms; knowledge search over 500,000 characters 0.3 ms; AI leak check 11.6 ms (fixed above, now 1.2 ms).
  Hashing and crypto already run in OpenSSL; SQLite, argon2 (`@node-rs/argon2`, Rust) and the voice engine are
  already native. A full Rust migration is not worth it: no hot spot, the core libraries (Baileys, Fastify, AI
  SDK, the Enterprise extension API) have no Rust equivalent, and each native module adds per-platform
  builds (Windows x64, Mac x64 and arm64), signing and npm prebuilds for Enterprise.
  - **Memory** is spent outside our code: the running Enterprise app showed about 280 MB main process,
    280 MB server (`utilityProcess`), 200 MB renderer. Next step when memory matters: evaluate running the
    background service on plain Node instead of the Electron binary (`ELECTRON_RUN_AS_NODE`), and
    measure Baileys and the voice model.
  - **Rust candidates, only when a real problem shows** (untrusted input, as a napi-rs addon behind the same
    TypeScript signature, TypeScript fallback when it does not load, the existing tests run against both):
    1. PDF/Word text extraction (`ai/knowledge.ts`, `knowledge-worker.ts`): the one real speed and memory
       win on hostile PDFs; large, and its text would differ from pdf.js.
    2. Voice note Ogg/Opus parser (`voice/audio.ts` `oggOpusDurationSeconds`, `messages/voice-note.ts`):
       small, adversarial tests exist; the cheapest way to prove the Rust toolchain end to end.
    3. ZIP listing and file-type check (`safety/zip.ts`, `safety/rules.ts` `magicOf`).
  - Not candidates: the updater helpers (a bug breaks self-update), `server-host.cts` and the workers (glue),
    regex text helpers (cheap), anything in Enterprise (no CPU-heavy code).
- **Rule:** measure before porting. A Rust (or any rewrite) proposal names the measured cost it removes and
  the test that proves the same answers.

- **Very large modules** (2026-11-01 scan, lines): `packages/server/src/ai/service.ts` 2908,
  `apps/web/src/api/queries.ts` 1244, `apps/web/src/inbox/Composer.tsx` 1213,
  `packages/server/src/messages/service.ts` 1211, `apps/web/src/admin/AiMemberPage.tsx` 1207,
  `packages/server/src/connectors/mcp/service.ts` 1141. Next step: split `ai/service.ts` by concern
  (live turn, drafts/suggestions, Ask Ezy, safety check, phrases) behind the same `AiService` facade, one
  concern per PR, with no behaviour change. Do not grow these files further; put new concerns in their
  own module.
