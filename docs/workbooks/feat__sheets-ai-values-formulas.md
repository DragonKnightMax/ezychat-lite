# Workbook: Sheets: AI values and formulas

Branch: `feat/sheets-ai-values-formulas` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | Owner decision 2026-11-05 (no mock round, his words); per-tab switches, design docs/connector-design.md Parts D–E | 0c3ab10 | 2026-11-05 |
| Dev | done | values/formulas switches + create a new sheet (blank or template layout) | 799b314 | 2026-11-05 |
| Unit tests | done | sheets server + web tests, typecheck, lint green (checks ran on 882c185; b8a2e75 only merges two import lines, web tests re-run 20/20) | b8a2e75 | 2026-11-05 |
| E2E | pass | 152 passed, 1 untouched-area flake passed 4/4 alone (checks ran on 882c185; b8a2e75 only merges two import lines, web tests re-run 20/20) | b8a2e75 | 2026-11-05 |
| Dev Build | done | devbuild-claims-check 22/22 (checks ran on 882c185; b8a2e75 only merges two import lines, web tests re-run 20/20) | b8a2e75 | 2026-11-05 |
| Screen review | done | 1280 light/dark, 360, no overflow (checks ran on 882c185; b8a2e75 only merges two import lines, web tests re-run 20/20) | b8a2e75 | 2026-11-05 |

## Log

- 2026-11-05 Design: done — Owner decision 2026-11-05 (no mock round, his words); per-tab switches, design docs/connector-design.md Parts D–E (0c3ab10)
- 2026-11-05 Dev: done — shared SheetTabSetting.aiValues/formulas, service/tools/values/sheets, web switches (0c3ab10)
- 2026-11-05 Unit tests: done — sheets server + web tests; changed lines 100 %; typecheck, lint green (0c3ab10)
- 2026-11-05 Dev Build: done — e2e/devbuild-claims-check.mjs (mock model, fake Google, temp data): 19/19 incl. formulas step (0c3ab10)
- 2026-11-05 Screen review: done — 1280 light/dark, 360, tip; fix: switches below the access choice on mobile (0c3ab10)
- 2026-11-05 E2E: pass — npm run e2e: 152 passed, 1 failed (ask-ezy iphone click timeout, untouched area) that passed alone on re-run (3/3) (28983d8)
- 2026-11-05 Screen review: done — 1280 light/dark, 360, tip; fix: switches below the access choice on mobile; re-captured after the fix (28983d8)
- 2026-11-05 Dev Build: done — e2e/devbuild-claims-check.mjs (mock model, fake Google, temp data): 19/19 incl. formulas step (28983d8)
- 2026-11-05 Dev Build: done — devbuild-claims-check 22/22 incl. formulas (6) and create sheet (7) (799b314)
- 2026-11-05 Screen review: done — settings switches + create dialog (blank, layout) 1280 light/dark, 360 (799b314)
- 2026-11-05 Dev: done — values/formulas switches + create a new sheet (blank or template layout) (799b314)
- 2026-11-05 Unit tests: done — changed lines 99.1 %; typecheck, lint green (799b314)
- 2026-11-05 E2E: pass — npm run e2e: 153 passed (after create a new sheet) (ee40e45)
- 2026-11-05 Dev Build: done — devbuild-claims-check 22/22 re-run after the Sonar fixes (882c185)
- 2026-11-05 Screen review: done — re-captured after fieldset change: 1280 light/dark, 360 unchanged, no overflow (882c185)
- 2026-11-05 Unit tests: done — sheets server + web 183 tests after Sonar fixes; typecheck, lint green (882c185)
- 2026-11-05 E2E: pass — npm run e2e on 882c185 code: 152 passed, 1 failed (group-management agent read-only: browserContext.close timeout, untouched area) passed 4/4 alone (882c185)
- 2026-11-05 Unit tests: done — sheets server + web tests, typecheck, lint green (checks ran on 882c185; b8a2e75 only merges two import lines, web tests re-run 20/20) (b8a2e75)
- 2026-11-05 Dev Build: done — devbuild-claims-check 22/22 (checks ran on 882c185; b8a2e75 only merges two import lines, web tests re-run 20/20) (b8a2e75)
- 2026-11-05 Screen review: done — 1280 light/dark, 360, no overflow (checks ran on 882c185; b8a2e75 only merges two import lines, web tests re-run 20/20) (b8a2e75)
- 2026-11-05 E2E: pass — 152 passed, 1 untouched-area flake passed 4/4 alone (checks ran on 882c185; b8a2e75 only merges two import lines, web tests re-run 20/20) (b8a2e75)
