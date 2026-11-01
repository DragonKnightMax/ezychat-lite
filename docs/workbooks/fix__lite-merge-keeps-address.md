# Workbook: Lite merge keeps the own address

Branch: `fix/lite-merge-keeps-address` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | Small change agreed in chat (Fix 1): merge keeps Lite's app-managed own address when the target has none; hand-over releases it in Lite | 8d62f29 | 2026-11-01 |
| Dev | done | merge-address.ts (move + release), merge-tables/merge/run/handover wiring, review screen shows the address under What comes over | 8d62f29 | 2026-11-01 |
| Unit tests | pass | lite-import-address (new), run, merge, merge-coverage, cli, LiteImportPage: all pass; changed-line coverage >= 90% | 8d62f29 | 2026-11-01 |
| E2E | pass | npm run e2e: 134 passed, 27 skipped; e2e:electron-links: 17/17 screens | 1b72a09f | 2026-11-01 |
| Dev Build | todo |  |  |  |
| Screen review | todo |  |  |  |

## Log

- 2026-11-01 Design: done — Small change agreed in chat (Fix 1): merge keeps Lite's app-managed own address when the target has none; hand-over releases it in Lite (8d62f29)
- 2026-11-01 Dev: done — merge-address.ts (move + release), merge-tables/merge/run/handover wiring, review screen shows the address under What comes over (8d62f29)
- 2026-11-01 Unit tests: pass — lite-import-address (new), run, merge, merge-coverage, cli, LiteImportPage: all pass; changed-line coverage >= 90% (8d62f29)
- 2026-11-01 E2E: pass — npm run e2e: 134 passed, 27 skipped; e2e:electron-links: 17/17 screens (1b72a09f)
