# Workbook: feat/image-preview

Branch: `feat/image-preview` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | skip | Bug fix with no new screen or flow: no mock needed | 7ce2fab | 2026-11-07 |
| Dev | done | Added: chat shows WhatsApp's thumbnail, real file only when opened; Lite merge keeps refs and thumbs | 3457a9b | 2026-11-07 |
| Unit tests | pass | media-ref, mapping, adapter, messages, MediaView, upgrade, contract and multi-inbox tests | 7ce2fab | 2026-11-07 |
| E2E | pass | npm run e2e 159 passed, 27 skipped; e2e:electron-links 17/17 screens (6653c6b) | 6653c6b | 2026-11-07 |
| Dev Build | pass | Fake WhatsApp copy: 130 thumbnails 105 KB, 0 real image files until opened; opened = real 768x1024 file; real WhatsApp restart check on 9186d35 | 08c8718 | 2026-11-07 |
| Screen review | pass | Demo data, 1280 and 360 px, light and dark: thumbnail, waiting box, real image, spinner, opened photo; no sideways scroll; nothing to fix (d098b11) | d098b11 | 2026-11-07 |

## Log

- 2026-11-07 Dev: done — Download data kept in media_refs; images download when near the view and keep their space (7ce2fab)
- 2026-11-07 Unit tests: pass — media-ref, mapping, adapter, messages, MediaView, upgrade, contract and multi-inbox tests (7ce2fab)
- 2026-11-07 Design: skip — Bug fix with no new screen or flow: no mock needed (7ce2fab)
- 2026-11-07 E2E: pass — npm run e2e: 159 passed, 27 skipped (9186d35) (9186d35)
- 2026-11-07 Dev Build: pass — Real WhatsApp: restart, then 59 imported images downloaded, 0 failed (9186d35) (9186d35)
- 2026-11-07 E2E: pass — npm run e2e 159 passed, 27 skipped; e2e:electron-links 17/17 screens (9186d35) (9186d35)
- 2026-11-07 Dev: done — Added: chat shows WhatsApp's thumbnail, real file only when opened; Lite merge keeps refs and thumbs (3457a9b)
- 2026-11-07 Dev Build: pass — Fake WhatsApp copy: 130 thumbnails 105 KB, 0 real image files until opened; opened = real 768x1024 file; real WhatsApp restart check on 9186d35 (08c8718)
- 2026-11-07 E2E: pass — npm run e2e 159 passed, 27 skipped; e2e:electron-links 17/17 screens (6653c6b) (6653c6b)
- 2026-11-07 Screen review: pass — Demo data, 1280 and 360 px, light and dark: thumbnail, waiting box, real image, spinner, opened photo; no sideways scroll; nothing to fix (d098b11) (d098b11)
