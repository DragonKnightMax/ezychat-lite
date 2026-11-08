# Workbook: Mobile redesign (phone)

Branch: `feat/mobile-redesign` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | doing | Mock + design.md (mobile-redesign) + design-system.md (Mobile patterns, Editions) + /design-system reference page: forward-message clone; phase 1 phone list header, number switcher, chips, tags, FAB, swipe, chat header chips; 54 shots 360/390 px light/dark en/ms/zh-CN + desktop 1280 unchanged; before audit at 360 px; scheduled-tasks pruned; waiting for owner confirmation (PR #328) | 1c4ece9 | 2026-11-07 |
| Dev | todo |  |  |  |
| Unit tests | todo |  |  |  |
| E2E | todo |  |  |  |
| Dev Build | todo |  |  |  |
| Screen review | todo |  |  |  |

## Log

- 2026-11-07 Design: doing — Mock + design.md (mobile-redesign), PR #328, waiting for owner confirmation (1c4ece9)
- 2026-11-07 Design: doing — Added scope: docs/design-system.md Mobile patterns + Editions + fixes, living /design-system page in the mock; 54 shots, 0 problems
- 2026-11-07 Design: doing — Owner: tags on groups too and the same tags on every screen; group tags (stand-in route on the real customer_tags table), Tags row in Customer details and Group info, tag-screens audit table, server/contract scope; 65 shots, 0 problems
- 2026-11-07 Design: doing — Owner answers recorded (rest as proposed; mock confirmation pending until the owner sees group tags); Send from follows the viewed number; 66 shots, 0 problems
