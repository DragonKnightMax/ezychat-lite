# Workbook: GitHub connector

Branch: `claude/github-connector-ezychat-e4de9b` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | docs/features/github/design.md + mock (proposal, creation order 41) | a62e371 | 2026-11-11 |
| Dev | done | server, web, migration 042 (adds only) | a62e371 | 2026-11-11 |
| Unit tests | pass | npm test locally: 461 files, 5620 passed, 1 skipped; fork CI waits for maintainer approval | a62e371 | 2026-11-11 |
| E2E | pass | npm run e2e 159 passed, 27 skipped; e2e:electron-links 17/17 (merge with main) | a62e371 | 2026-11-11 |
| Dev Build | pass | real: GitHub App sign-in, 3 repos, ChatGPT look-up (list + read issue), off-list repo refused; docs/dev-build-checks.md 2026-11-12 | a62e371 | 2026-11-11 |
| Screen review | pass | e2e/github-screens.mjs on the mock Dev Build: 48 shots (1280/360, light/dark), 0 page errors, no horizontal overflow; reviewed | a62e371 | 2026-11-11 |

## Log

- 2026-11-11 E2E: pass — npm run e2e 159 passed, 27 skipped; e2e:electron-links 17/17 (merge with main) (a62e371)
- 2026-11-11 Screen review: pass — e2e/github-screens.mjs on the mock Dev Build: 48 shots (1280/360, light/dark), 0 page errors, no horizontal overflow; reviewed (a62e371)
- 2026-11-11 Dev Build: pass — real: GitHub App sign-in, 3 repos, ChatGPT look-up (list + read issue), off-list repo refused; docs/dev-build-checks.md 2026-11-12 (a62e371)
- 2026-11-11 Design: done — docs/features/github/design.md + mock (proposal, creation order 41) (a62e371)
- 2026-11-11 Dev: done — server, web, migration 042 (adds only) (a62e371)
- 2026-11-11 Unit tests: pass — npm test locally: 461 files, 5620 passed, 1 skipped; fork CI waits for maintainer approval (a62e371)
