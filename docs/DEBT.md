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
| L-2 | e2e | `e2e/devbuild-multi-inbox-check.mjs` failed from step 2 on a fresh `--max-inboxes 3` server | low | small | closed: no longer reproduces, all 20 steps pass on main 5fc6f2c (2026-11-08) | 2026-11-08 |
| L-3 | web i18n | "Hand-off" vs "Hand-over" wording differs; ms/zh `ai.agents.handoffTitle` still English | low | small | open (touches a screen: needs e2e round) | 2026-11-07 |
| L-4 | web | A failed file upload cannot be sent again (Retry does not resend the local file) | med | major | recorded-major (composer tray redesign) | 2026-11-07 |
| L-5 | web | A live event arriving before the first messages fetch is dropped (`upsertMessageInCache`) | med | small | fixed in #336 (2026-11-07) | 2026-11-08 |
| L-6 | web/e2e | `e2e/reactions.spec.ts` flaky: the 👍 badge showed, then vanished. Cause: a messages load already running when `message:reactions` (or `message:updated`) arrived answered afterwards with the old copy and replaced the patched cache | med | small | fixed in #348 (2026-11-10): both events now reload after a running load, as `message:new` does. The 429 on `--repeat-each` is a repeat artefact (30 reactions a minute per user) | 2026-11-10 |
| L-7 | wa | Reactions mapping untested against real WhatsApp | med | major | recorded-major (needs real WhatsApp) | 2026-11-07 |
| L-8 | desktop | `status-sections.ts` TODO(phase 4b): Enterprise keeps a copy of the status-section types; `@ezychat/desktop` 0.1.80 exports only Model/Context/Provider, not Field/Button/Result/Tone | low | major | recorded-major (extension API: export the remaining types from `apps/desktop/src/index.ts` in Lite, release, then Enterprise deletes its copy) | 2026-11-08 |
| L-9 | web | Flag emoji show as letters on Windows (needs bundled flag font) | low | small | open | 2026-11-07 |
| L-11 | e2e | ESLint warning: `import()` type annotation in `e2e/file-transfer.spec.ts` | low | small | fixed in this PR (2026-11-08) | 2026-11-08 |
| L-12 | web | SonarCloud bugs S1082 (`MediaView.tsx:123,134`): the photo viewer's backdrop and photo had click handlers without a keyboard role; S2699: the "Claude key in the OpenAI field" test asserted nothing | low | small | fixed in #349 (2026-11-10) | 2026-11-10 |
| L-13 | server | SonarCloud: 82 cognitive-complexity findings (S3776), 3 deep nestings in `connectors/mcp/net.ts` (S2004), empty placeholder-adapter methods in `inboxes/types.ts` (S1186) | low | major | recorded-major (split per module with no behaviour change, together with the "Very large modules" item below) | 2026-11-10 |
| L-14 | wa | `MediaCache.fileKey` (`packages/wa/src/baileys/media-cache.ts`) keys a file by `dev:ino:size:ctimeMs` from a plain `statSync`: on Windows the 64-bit file id loses precision as a JS number (or is 0 on some file systems), so two different files of the same size changed in the same millisecond share a key. `media-cache.test.ts` "forgets entries…" failed on Windows CI for #348 (got file 2 for file 1); in the app a forward could re-use another file's upload | med | major | recorded-major (Baileys folder: proposal: `statSync(path, { bigint: true })`, key on `ino`/`ctimeNs` as bigint strings and refuse to cache when `ino` is 0; needs a real-WhatsApp forward check) | 2026-11-10 |
| L-15 | web | On a plain-http LAN page `crypto.randomUUID` does not exist (secure contexts only). `FeedbackHost` (mounted in every signed-in page since 0.1.77) called it on render, so signing in over a LAN address showed a **blank page**; Forward did the same, and `newClientId`'s `Math.random` fallback was not a UUID, so New chat (`z.uuid()`) answered 400 there (also SonarCloud S2245 at `queries.ts:328`) | high | small | fixed in #350 (2026-11-11) | 2026-11-11 |
| L-16 | scripts/CI | SonarCloud vulnerabilities in dev tooling only: S8701/S8705/S8707 (CLI arguments into `spawn`/paths in `scripts/smoke-packaged.mjs`, `e2e/*screens.smoke.mjs`), S6505 (`npm ci` without `--ignore-scripts` in `ci.yml`, `release.yml`), S4036 (`spawn('node')` from PATH in `server-process.ts`, dev-only `WATI_DESKTOP_RUNTIME=node`) | low | small | open (triage: likely accept as safe; `--ignore-scripts` would break the native prebuild installs) | 2026-11-11 |
| L-10 | deps | Dependabot PRs #304, #305, #308 open; older PRs #201, #237, #240, #249, #343 | low | small | open (not techdebt/ PRs; not merged by this run) | 2026-11-11 |


### Run log

- 2026-11-11 (L-15, #350): no Lite `techdebt/` PRs open; Enterprise #108 still waits on its failed SonarCloud check. Lint clean, no TODO/FIXME. Sonar: 0 bugs, 8 vulnerabilities; S2245 led to L-15 (a real LAN bug, found by checking which pages run outside a secure context), the rest is dev tooling (L-16). Fixed with a failing-first test of a `getRandomValues` v4 UUID; web unit tests, lint, typecheck and e2e ran. Dev Build over `http://<LAN IP>` showed `main` blank after sign-in (released since 0.1.77) and the fix working.
- 2026-11-10 (L-6): the full e2e run caught the first reactions test failing with a screenshot: the badge appeared then vanished. Root cause found in `socket.ts` (a running load overwrote the live reaction); fixed with a failing-first unit test for `message:reactions` and `message:updated`. Windows CI then failed once in `media-cache.test.ts` (unrelated): L-14 recorded-major.
- 2026-11-10: no `techdebt/` PRs open in either repo. Sonar: 2 open bugs (both S1082 in `MediaView.tsx`), 162 critical (82 S3776). L-12 fixed: one click handler on the dialog closes it when the backdrop itself was clicked (no handlers on plain elements, no `stopPropagation`), new test pins photo-click / backdrop-click / Esc; the empty test now asserts the Claude key is caught and never sent. L-13 recorded-major. Web unit tests, lint, typecheck and e2e ran.
- 2026-11-09: no Lite `techdebt/` PRs open. Sonar (655 major+ issues, no bugs/vulnerabilities): the `lock.test.ts` stale/garbage-lock tests had no assertion (S2699); they now assert the lock is taken over and released. S1994 in `google-sheets/match.ts:48` checked: false positive. L-6 re-investigated (see table). L-3 is partly stale (ms/zh `handoffTitle` already translated).
- 2026-11-08: no `techdebt/` PRs open. L-11 lint warning fixed (type import in the e2e spec); L-2 closed (does not reproduce); L-5 status corrected; L-8 recorded-major. Lint, typecheck run; SonarCloud has 2143 open issues (e.g. nested ternary `MediaView.tsx:335`, complexity in `lite-import/merge-tables.ts`), not triaged yet.
- 2026-11-07 (2nd run): L-5 fixed: a live message with no cached pages now restarts the first fetch. Web tests, typecheck, lint and e2e (159 passed) ran; SonarCloud not queried.
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
