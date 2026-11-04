# Workbook: feat/pwa-cache

Branch: `feat/pwa-cache` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | Evidence on the live page (97 req, 43 KB, ~660 ms each; colo SJC/FRA; 58 photos; /api/chats x6) + design approved by the owner (combine infra + app cache, phase 1) | 55c1128 | 2026-11-04 |
| Dev | done | Server photo store + versioned URLs + cache headers (bf5d4be2); web PWA caches, instant first screen, one /api/chats load (aa9d3c26); Safety: no cache before the AI check answers (4b6993bc) | 4b6993b | 2026-11-04 |
| Unit tests | pass | server 261 (13 files) + safety/messages 50; web 126; typecheck server+web clean | 4b6993b | 2026-11-04 |
| E2E | done | npm run e2e on 9a8c1b6: 153 passed, 0 failed (27 skips by design); e2e:electron-links in CI (Windows job) | 9a8c1b6 | 2026-11-04 |
| Dev Build | pass | packaged --dir smoke on 9a8c1b6: migration 033, photo route, packaged sw.js (real: row in docs/dev-build-checks.md) | 9a8c1b6 | 2026-11-04 |
| Screen review | pass | No visual change (same screens, faster loading). screens.smoke on 9a8c1b6: 35/37, desktop + mobile; the 2 'fails' are oauth-authorize, whose made-up client_id=smoke gets the expected 409 and the correct 'AI assistant access is off' page (not touched by this PR) | 9a8c1b6 | 2026-11-04 |

## Log

- 2026-11-04 Design: done — Evidence on the live page (97 req, 43 KB, ~660 ms each; colo SJC/FRA; 58 photos; /api/chats x6) + design approved by the owner (combine infra + app cache, phase 1) (55c1128)
- 2026-11-04 Dev: done — Server photo store + versioned URLs + cache headers (bf5d4be2); web PWA caches, instant first screen, one /api/chats load (aa9d3c26); Safety: no cache before the AI check answers (4b6993bc) (4b6993b)
- 2026-11-04 Unit tests: pass — server 261 (13 files) + safety/messages 50; web 126; typecheck server+web clean (4b6993b)
- 2026-11-04 Dev Build: pass — Slow-tunnel simulation (650 ms proxy, 60 chats, real JPEG photos): day-to-day open 2.68 s → 1.04 s to the chat list, 44 → 20 requests, 27 → 0 photo requests (docs/dev-build-checks.md) (2a7693a)
- 2026-11-04 E2E: pass — npm run e2e: 153 passed, 0 failed (27 project skips by design); e2e:electron-links 17/17 screens (0de6037)
- 2026-11-04 E2E: done — npm run e2e on 9a8c1b6: 153 passed, 0 failed (27 skips by design); e2e:electron-links in CI (Windows job) (9a8c1b6)
- 2026-11-04 Dev Build: pass — packaged --dir smoke on 9a8c1b6: migration 033, photo route, packaged sw.js (real: row in docs/dev-build-checks.md) (9a8c1b6)
- 2026-11-04 Screen review: pass — No visual change (same screens, faster loading). screens.smoke on 9a8c1b6: 35/37, desktop + mobile; the 2 'fails' are oauth-authorize, whose made-up client_id=smoke gets the expected 409 and the correct 'AI assistant access is off' page (not touched by this PR) (9a8c1b6)
