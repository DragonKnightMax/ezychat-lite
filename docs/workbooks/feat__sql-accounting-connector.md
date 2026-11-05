# Workbook: feat/sql-accounting-connector

Branch: `feat/sql-accounting-connector` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Updated |
| --- | --- | --- | --- |
| Design | done | Owner confirmed 2026-11-05 ("3. Yes,can u research it"); open questions researched and recorded in design.md | 2026-11-05 |
| Dev | done | Server (connectors/sql-account, migration 035, routes, fake API in the official collection's shapes), web page (5 tabs, 8 objects incl. Customer invoices (amount owed)), background phone index from branches, Lite-import merge | 2026-11-05 |
| Unit tests | pass | Full suite 5005 passed (419 files); changed-lines coverage 97.2 % (1013/1042); SonarCloud gate passed, 0 new issues | 2026-11-05 |
| E2E | todo | Main session runs the mock e2e round (owner rule: not in this session) | 2026-11-05 |
| Dev Build | partial | Dev server with --fake-wa + fake SQL Account: connect (unreachable then ok), settings, customers (linked/phone/several/none), activity; untested against a real SQL Account API (no test company) | 2026-11-05 |
| Screen review | partial | Real page at 1280/360, light/dark: matches the confirmed mock, 0 page errors, 0 overflow; full UI/UX review round left to the main session | 2026-11-05 |

## Log

- 2026-11-05 Design: waiting — Research (eStream docs-sqlacc 2954faf), design.md and mock cloned from group-management 26116d59; per-object Off / Read / Read + create access per AI agent (owner request mid-design); mock 56 screenshots, 0 page errors, 0 overflow; waiting for the owner's confirmation
- 2026-11-05 Design: done — owner confirmed; research answers recorded (licence RM 1,000/company/yr via reseller, no SQL Cloud claim, phone on customer/branch, no outstanding field yet)
- 2026-11-05 Dev: done — server (connectors/sql-account, migration 035, routes) and web (SqlAccountPage, Settings, Customers)
- 2026-11-05 Unit tests: pass — server 48 tests, web connectors suite 151 tests
- 2026-11-05 Dev Build: partial — fake SQL Account only; untested against a real SQL Account API
- 2026-11-05 Screen review: partial — screenshots of every tab at 1280/360 light/dark, no overflow
- 2026-11-05 Dev: done — official Postman collection applied (api.sql.my, customerinvoice amount owed, phones on sdsbranch)
- 2026-11-05 Unit tests: pass — full suite 5005, changed lines 97.2 %, Sonar clean
- 2026-11-05 Dev: migration renumbered 034 → 035 (Google Drive PR #288 takes 034 and merges first); the "no gap" migration test stays red until #288 is on main and merged in here
- 2026-11-05 Dev: merged main after Google Drive (#288, migration 034): both connectors side by side in turn-tools, catalog, gallery, detail page, agent card, Lite import (drop list has Drive and SQL tables) and i18n; mock retention pruned group-agents (sixth folder). Typecheck clean; migrate, upgrade-from-oldest, lite-import, connector-list, SQL, Drive, web connectors and i18n tests pass (316)
