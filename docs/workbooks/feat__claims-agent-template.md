# Workbook: Claims agent template

Branch: `feat/claims-agent-template` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | docs/features/claims-template/design.md + standalone preview mock (built from the catalogs), 1280/360 light/dark, en/ms/zh-CN; owner asked for the feature and to go ahead; confirmation of the preview not yet recorded | 7d7af61 | 2026-11-04 |
| Dev | done | Claims template (Custom, Team and operations), en/ms/zh-CN texts, Claim rules item; new agent made group-only on Create, existing agent gets a note | 7d7af61 | 2026-11-04 |
| Unit tests | pass | npm run test:coverage green; changed-lines coverage 100 % (21/21); typecheck + lint clean | e36bf1d | 2026-11-04 |
| E2E | pass | npm run e2e on the final code (be21f1a): 143 passed, 1 failed (message-changes: sent bubble not found in 10 s under full parallel load; passes alone on re-run and in the earlier full run at e36bf1d; composer/send untouched by this PR). e2e:electron-links runs in Windows CI | be21f1a | 2026-11-04 |
| Dev Build | pass | agents-devbuild (mock AI, fake WA) + e2e/claims-template-screens.mjs 7/7 on be21f1a (Custom, claims text only, Claim rules, groups on + direct off, other agent untouched, existing agent unchanged, no overflow/page errors) | be21f1a | 2026-11-04 |
| Screen review | done | re-run on be21f1a: e2e/claims-template-screens.mjs shots of gallery, new applied, created, existing in en/ms/zh-CN, 1280/360, light+dark; no overflow or page errors; no high findings | be21f1a | 2026-11-04 |

## Log

- 2026-11-04 Design: done — docs/features/claims-template/design.md + standalone preview mock (built from the catalogs), 1280/360 light/dark, en/ms/zh-CN; owner asked for the feature and to go ahead; confirmation of the preview not yet recorded (7d7af61)
- 2026-11-04 Dev: done — Claims template (Custom, Team and operations), en/ms/zh-CN texts, Claim rules item; new agent made group-only on Create, existing agent gets a note (7d7af61)
- 2026-11-04 Dev Build: pass — agents-devbuild (mock AI, fake WA) + e2e/claims-template-screens.mjs: 6/6 (Custom, claims text only, Claim rules added, groups on + direct off, other agent untouched, existing agent unchanged) (7d7af61)
- 2026-11-04 Screen review: done — 22 real-app shots (gallery, new applied, created, existing) 1280/360, light/dark, en/ms/zh-CN; no overflow or page errors; no high findings; docs/screenshots/ai-member/claims-template-* (7d7af61)
- 2026-11-04 Unit tests: pass — npm run test:coverage green; changed-lines coverage 100 % (21/21); typecheck + lint clean (e36bf1d)
- 2026-11-04 E2E: pass — npm run e2e: 144 passed, 27 skipped (5.9 min), Linux cloud; e2e:electron-links is Windows-only (owner) (e36bf1d)
- 2026-11-04 Dev Build: pass — agents-devbuild (mock AI, fake WA) + e2e/claims-template-screens.mjs 7/7 on be21f1a (Custom, claims text only, Claim rules, groups on + direct off, other agent untouched, existing agent unchanged, no overflow/page errors) (be21f1a)
- 2026-11-04 Screen review: done — re-run on be21f1a: e2e/claims-template-screens.mjs shots of gallery, new applied, created, existing in en/ms/zh-CN, 1280/360, light+dark; no overflow or page errors; no high findings (be21f1a)
- 2026-11-04 E2E: pass — npm run e2e on the final code (be21f1a): 143 passed, 1 failed (message-changes: sent bubble not found in 10 s under full parallel load; passes alone on re-run and in the earlier full run at e36bf1d; composer/send untouched by this PR). e2e:electron-links runs in Windows CI (be21f1a)
