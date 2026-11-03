# Workbook: fix/mac-admin-prompt

Branch: `fix/mac-admin-prompt` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | skip | Dependency swap, no UI | d36cefd | 2026-11-03 |
| Dev | done | sudo-prompt 9.2.1 -> @vscode/sudo-prompt 9.3.2 (service + updater) | d36cefd | 2026-11-03 |
| Unit tests | pass | desktop service+updater 68 pass; new test fails on 9.2.1 (exact error reproduced under Electron 45 / Node 24.22) | d36cefd | 2026-11-03 |
| E2E | skip | No screen or web contract change | d36cefd | 2026-11-03 |
| Dev Build | pass | Packaged --dir (Windows, Electron 45): new library loads from app.asar and runs; old one absent. Real Mac prompt: owner | e16922a5 | 2026-11-03 |
| Screen review | skip | No UI | d36cefd | 2026-11-03 |

## Log

- 2026-11-03 Design: skip — Dependency swap, no UI (d36cefd)
- 2026-11-03 Dev: done — sudo-prompt 9.2.1 -> @vscode/sudo-prompt 9.3.2 (service + updater) (d36cefd)
- 2026-11-03 Dev: done — sudo-prompt 9.2.1 -> @vscode/sudo-prompt 9.3.2 (service + updater) (d36cefd)
- 2026-11-03 Unit tests: pass — desktop service+updater 68 pass; new test fails on 9.2.1 (exact error reproduced under Electron 45 / Node 24.22) (d36cefd)
- 2026-11-03 E2E: skip — No screen or web contract change (d36cefd)
- 2026-11-03 Screen review: skip — No UI (d36cefd)
- 2026-11-03 Dev Build: skip — Real Mac admin prompt needs the owner on a Mac (d36cefd)
- 2026-11-03 Dev Build: pass — Packaged --dir (Windows, Electron 45): new library loads from app.asar and runs; old one absent. Real Mac prompt: owner (e16922a5)
