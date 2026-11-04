# Workbook: Group management

Branch: `feat/group-management` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | pass | Confirmed by the owner 2026-11-04 (#276); mock docs/features/group-management/mock is the reference. | 80284fa | 2026-11-04 |
| Dev | pass | Contract, Baileys (untested against real WhatsApp), server routes, web UI; main 26116d5 merged in. | c17222f | 2026-11-04 |
| Unit tests | pass | npm run test:coverage: 4818 passed; changed lines 96.9 % (746/770); totals above floors. | 07f9a2c | 2026-11-04 |
| E2E | pass | npm run e2e on 00f808a (after the partner-list flake fix): 153 passed, 27 skipped; group-management.spec.ts on desktop, mobile, iphone. | 00f808a | 2026-11-04 |
| Dev Build | pass | Fake-WhatsApp Dev Build, 17 states end to end on 00f808a (docs/dev-build-checks.md). Untested against real WhatsApp: owner live check on a test number. | 00f808a | 2026-11-04 |
| Screen review | pass | 17 states x desktop 1280 / mobile 360 x light / dark vs the confirmed mock (e2e/group-management-screens.mjs on 00f808a): 0 page errors, 0 overflow; fixed join-request numbers cut off and Recent changes dates wrapping; docs/screenshots/chat/group-admin-*. | 00f808a | 2026-11-04 |

## Log

- 2026-11-04 Design: pass — Confirmed by the owner 2026-11-04 (#276); mock docs/features/group-management/mock is the reference. (80284fa)
- 2026-11-04 Dev: doing — Contract: shared zod (groups.ts), WaCapabilities.groupAdmin + optional WaAdapter group methods, FakeWaAdapter + /api/dev/fake-group extensions. (80284fa)
- 2026-11-04 Dev: doing — Contract + fake (3afc6b7); Baileys group management (bf342ab, untested against real WhatsApp); server and web in progress. (bf342ab)
- 2026-11-04 Dev: pass — Contract, Baileys (untested against real WhatsApp), server routes, web UI; main 26116d5 merged in. (c17222f)
- 2026-11-04 E2E: pass — npm run e2e: 153 passed, 27 skipped (group-management.spec.ts on desktop, mobile, iphone). (91847d1)
- 2026-11-04 Unit tests: pass — npm run test:coverage: 4818 passed; changed lines 96.9 % (746/770); totals above floors. (07f9a2c)
- 2026-11-04 Screen review: pass — 17 states x desktop 1280 / mobile 360 x light / dark vs the confirmed mock (e2e/group-management-screens.mjs): 0 page errors, 0 overflow; fixed join-request numbers cut off in the side panel and Recent changes dates wrapping; docs/screenshots/chat/group-admin-*. (07f9a2c)
- 2026-11-04 Dev Build: pass — Fake-WhatsApp Dev Build, 17 states end to end (docs/dev-build-checks.md 2026-11-04 row). Untested against real WhatsApp: owner live check on a test number. (07f9a2c)
- 2026-11-04 E2E: pass — npm run e2e re-run after the screen-review fix: 153 passed, 27 skipped (group-management.spec.ts on desktop, mobile, iphone); capture script re-run 68 shots, 0 errors. (cdda86a)
- 2026-11-04 Screen review: pass — 17 states x desktop 1280 / mobile 360 x light / dark vs the confirmed mock (e2e/group-management-screens.mjs, re-run on d23f26b): 0 page errors, 0 overflow; fixed join-request numbers cut off and Recent changes dates wrapping; docs/screenshots/chat/group-admin-*. (d23f26b)
- 2026-11-04 Dev Build: pass — Fake-WhatsApp Dev Build, 17 states end to end, re-run on d23f26b (docs/dev-build-checks.md). Untested against real WhatsApp: owner live check on a test number. (d23f26b)
- 2026-11-04 E2E: pass — npm run e2e on 00f808a (after the partner-list flake fix): 153 passed, 27 skipped; group-management.spec.ts on desktop, mobile, iphone. (00f808a)
- 2026-11-04 Screen review: pass — 17 states x desktop 1280 / mobile 360 x light / dark vs the confirmed mock (e2e/group-management-screens.mjs on 00f808a): 0 page errors, 0 overflow; fixed join-request numbers cut off and Recent changes dates wrapping; docs/screenshots/chat/group-admin-*. (00f808a)
- 2026-11-04 Dev Build: pass — Fake-WhatsApp Dev Build, 17 states end to end on 00f808a (docs/dev-build-checks.md). Untested against real WhatsApp: owner live check on a test number. (00f808a)
