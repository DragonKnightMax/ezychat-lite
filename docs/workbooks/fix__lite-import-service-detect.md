# Workbook: Lite as a background service: Allow and continue

Branch: `fix/lite-import-service-detect` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | Enterprise mock lite-upgrade round 4 confirmed by the owner 2026-11-01 (ezychat-enterprise ddb8575) | 03d9079 | 2026-11-01 |
| Dev | done | unlock() + IPC wati:lite-import-unlock, Lite service manager on Lite's folders, Remove service prechecks (app.db, links), security review findings fixed | 03d9079 | 2026-11-01 |
| Unit tests | pass | desktop 594 passed; web lite-import + i18n pass; prechecks run in powershell.exe against real junctions | 03d9079 | 2026-11-01 |
| E2E | pass | npm run e2e on the head with the waiting-text fix: 134 passed, 27 skipped | 77f67487 | 2026-11-01 |
| Dev Build | pass | Real Allow on the live Lite service (script) and the owner's whole journey in the Enterprise window: Allow, found, copy, verify, handover, started | 77f67487 | 2026-11-01 |
| Screen review | pass | 24 shots (e2e/lite-protected-screens.mjs, fake bridge): setup step 0 locked + Allow card idle/waiting/declined/failed, 1280+360, light+dark; 0 errors, no overflow; matches mock round 4; fixed the waiting text | 77f67487 | 2026-11-01 |

## Log

- 2026-11-01 Design: done — Enterprise mock lite-upgrade round 4 confirmed by the owner 2026-11-01 (ezychat-enterprise ddb8575) (03d9079)
- 2026-11-01 Dev: done — unlock() + IPC wati:lite-import-unlock, Lite service manager on Lite's folders, Remove service prechecks (app.db, links), security review findings fixed (03d9079)
- 2026-11-01 Unit tests: pass — desktop 594 passed; web lite-import + i18n pass; prechecks run in powershell.exe against real junctions (03d9079)
- 2026-11-01 E2E: pass — npm run e2e 134 passed / 27 skipped; e2e:electron-links passed (both before 03d9079c, which changes only service scripts and detection) (c49cad51)
- 2026-11-01 Dev Build: todo — Needs a Windows test machine with a test Lite service: the owner's PC runs the live Lite service, which Allow removes (03d9079)
- 2026-11-01 Screen review: todo — Mock screenshots reviewed (36, desktop+mobile, light+dark); production screens need the desktop bridge, so capture them in the Dev Build (03d9079)
- 2026-11-01 E2E: pass — npm run e2e on the PR head after the security fixes: 134 passed, 27 skipped (542fbe21)
- 2026-11-01 Dev Build: doing — Dry run on the owner's PC passed (real detection, UAC prompt, elevated prechecks; nothing changed). Real Remove service + import: needs a test PC (d639eb4d)
- 2026-11-01 Dev Build: pass — Real Allow on the owner's live Lite service: removed, data in Lite's user folder (all parts), found 1359 chats / 2 users / no issues. Import not run (owner's live number) (fc86c987)
- 2026-11-01 E2E: pass — npm run e2e on the final head: 134 passed, 27 skipped (a941d13c)
- 2026-11-01 E2E: pass — npm run e2e on the head with the waiting-text fix: 134 passed, 27 skipped (77f67487)
- 2026-11-01 Screen review: pass — 24 shots (e2e/lite-protected-screens.mjs, fake bridge): setup step 0 locked + Allow card idle/waiting/declined/failed, 1280+360, light+dark; 0 errors, no overflow; matches mock round 4; fixed the waiting text (77f67487)
- 2026-11-01 Dev Build: pass — Real Allow on the live Lite service (script) and the owner's whole journey in the Enterprise window: Allow, found, copy, verify, handover, started (77f67487)
