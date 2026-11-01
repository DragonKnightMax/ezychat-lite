# Tech debt register

What tech-debt reviews found, what was fixed, and the rule that stops it coming back. Read it before a
debt review (so a finding is not reported twice) and before adding code in an area listed under **Open**.
Newest first. Bugs and feature ideas stay in `docs/backlog.md`; short rules for every agent stay in
`docs/LEARNINGS.md`.

Each entry: **where**, **what**, **why it matters**, then **fix** (PR) or **next step**, and the
**rule** that prevents a repeat.

## Fixed

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

- **Very large modules** (2026-11-01 scan, lines): `packages/server/src/ai/service.ts` 2908,
  `apps/web/src/api/queries.ts` 1244, `apps/web/src/inbox/Composer.tsx` 1213,
  `packages/server/src/messages/service.ts` 1211, `apps/web/src/admin/AiMemberPage.tsx` 1207,
  `packages/server/src/connectors/mcp/service.ts` 1141. Next step: split `ai/service.ts` by concern
  (live turn, drafts/suggestions, Ask Ezy, safety check, phrases) behind the same `AiService` facade, one
  concern per PR, with no behaviour change. Do not grow these files further; put new concerns in their
  own module.
