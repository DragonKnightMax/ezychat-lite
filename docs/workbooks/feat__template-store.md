# Workbook: feat/template-store

Branch: `feat/template-store` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | design.md + mock; owner confirmed 2026-11-04 ("279 go ahead") | 704c4f0 | 2026-11-04 |
| Dev | done | shared contract, server template list (download/verify/store) + /api/ai/templates routes, web gallery from the API with built-in fallback, export/schema/publisher scripts | 658dbf3 | 2026-11-04 |
| Unit tests | pass | CI green on d3d4cc9 (ubuntu, windows, macos); local coverage run: changed lines 100 % (286/286) | d3d4cc9 | 2026-11-04 |
| E2E | pass | npm run e2e on 704c4f0 (after merging main #278/#280): 153 passed, 27 skipped, 0 failed; e2e:electron-links is Windows-only, not run | 704c4f0 | 2026-11-04 |
| Dev Build | pass | real: e2e/template-store-real-check.mjs on 704c4f0: 18/18 PASS against the published dl.ezychat.ai list with production keys (0.1.74: entries hidden, minAppVersion 0.1.75; as 0.1.75: gallery unchanged, Apply+Create, refresh limits, offline keeps copy); local signed-list check e2e/template-store-check.mjs earlier | 704c4f0 | 2026-11-04 |
| Screen review | pass | Re-captured on 704c4f0 with e2e/template-store-check.mjs (15/15 PASS): gallery 1280/360 light/dark, loaded, Events, applied, offline; identical to the committed shots apart from anti-aliasing; no overflow or page errors | 704c4f0 | 2026-11-04 |

## Log

- 2026-11-04 Design: done — docs/features/template-store/design.md; mock (standalone preview, desktop/mobile, light/dark, en/ms/zh-CN) recorded, owner confirmation pending (658dbf3)
- 2026-11-04 Dev: done — shared contract, server template list (download/verify/store) + /api/ai/templates routes, web gallery from the API with built-in fallback, export/schema/publisher scripts (658dbf3)
- 2026-11-04 E2E: pass — npm run e2e (Linux, fake WhatsApp, mock AI): 144 passed, 27 skipped, 0 failed; e2e:electron-links is Windows-only, not run (6116af3)
- 2026-11-04 Dev Build: pass — e2e/template-store-check.mjs: 15/15 PASS (signed list served locally, mock model): download+verify, gallery, Apply+Create, bad signature rejected, offline keeps copy (6116af3)
- 2026-11-04 Screen review: pass — Real app gallery 1280/360 light/dark (loaded, Events, applied, offline) in docs/features/template-store/screenshots; no overflow or page errors; matches the mock (6116af3)
- 2026-11-04 Unit tests: pass — Linux: 403 files / 4746 tests pass with coverage; changed lines 100 % (286/286); typecheck + lint clean; SonarCloud gate passed (c658ad3)
- 2026-11-04 E2E: pass — npm run e2e (Linux, fake WhatsApp, mock AI): 144 passed, 27 skipped, 0 failed; e2e:electron-links is Windows-only, not run (853680b)
- 2026-11-04 Dev Build: pass — e2e/template-store-check.mjs: 15/15 PASS (signed list served locally, mock model): download+verify, gallery, Apply+Create, bad signature rejected, offline keeps copy (853680b)
- 2026-11-04 Screen review: pass — Real app gallery 1280/360 light/dark (loaded, Events, applied, offline) in docs/features/template-store/screenshots; no overflow or page errors; matches the mock (853680b)
- 2026-11-04 Unit tests: pass — Linux: 403 files / 4746 tests pass with coverage; changed lines 100 % (286/286); typecheck + lint clean; SonarCloud gate passed (853680b)
- 2026-11-04 E2E: pass — npm run e2e on d3d4cc9 (after merging main): 144 passed, 27 skipped, 0 failed; e2e:electron-links is Windows-only, not run (d3d4cc9)
- 2026-11-04 Dev Build: pass — e2e/template-store-check.mjs on d3d4cc9: 15/15 PASS (signed list served locally, mock model): download+verify, gallery, Apply+Create, bad signature rejected, offline keeps copy (d3d4cc9)
- 2026-11-04 Screen review: pass — Real app gallery 1280/360 light/dark (loaded, Events, applied, offline) re-captured on d3d4cc9 in docs/features/template-store/screenshots; no overflow or page errors; matches the mock (d3d4cc9)
- 2026-11-04 Unit tests: pass — CI green on d3d4cc9 (ubuntu, windows, macos); local coverage run: changed lines 100 % (286/286) (d3d4cc9)
- 2026-11-04 E2E: pass — npm run e2e on 704c4f0 (after merging main #278/#280): 153 passed, 27 skipped, 0 failed; e2e:electron-links is Windows-only, not run (704c4f0)
- 2026-11-04 Dev Build: pass — real: e2e/template-store-real-check.mjs on 704c4f0: 18/18 PASS against the published dl.ezychat.ai list with production keys (0.1.74: entries hidden, minAppVersion 0.1.75; as 0.1.75: gallery unchanged, Apply+Create, refresh limits, offline keeps copy); local signed-list check e2e/template-store-check.mjs earlier (704c4f0)
- 2026-11-04 Design: done — design.md + mock; owner confirmed 2026-11-04 ("279 go ahead") (704c4f0)
- 2026-11-04 Screen review: pass — Re-captured on 704c4f0 with e2e/template-store-check.mjs (15/15 PASS): gallery 1280/360 light/dark, loaded, Events, applied, offline; identical to the committed shots apart from anti-aliasing; no overflow or page errors (704c4f0)
