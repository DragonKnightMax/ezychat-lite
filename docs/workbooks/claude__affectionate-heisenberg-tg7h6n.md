# Workbook: Edit and delete messages

Branch: `claude/affectionate-heisenberg-tg7h6n` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | Mock confirmed 2026-10-28 ("implement it"), revision 1460c1c; design.md + mock-index updated | 70dd1c8 | 2026-10-28 |
| Dev | done | rebased on main cbd224f: migration 025 -> 029, Safety + edit/delete joined in present() (deleted = no finding), mock creationOrder 26, concept-tips archived | 71e72a0 | 2026-11-02 |
| Unit tests | pass | 17 files, 294 tests + new Safety delete test (Node 24); typecheck all workspaces; eslint/prettier on changed files | ad94ef7 | 2026-11-02 |
| E2E | pass | npm run e2e on 1c27a1a on Node 24 (1 worker): 138 passed, 0 failed (ai-member passes on Node 24; the Node 22 run had 137); e2e:electron-links 17/17 | 1c27a1a84a7fc53187010547bf06bbc7190c5d0a | 2026-11-02 |
| Dev Build | pass | re-run on 1c27a1a (after the Lite-import fix): devbuild-message-changes-check 36 shots, no errors/overflow, agent checks pass; real WhatsApp still untested | 1c27a1a84a7fc53187010547bf06bbc7190c5d0a | 2026-11-02 |
| Screen review | pass | re-captured on 1c27a1a, desktop 1280 + mobile 360, light/dark: matches the confirmed mock next to main's Ask Ezy / Summarise buttons; docs/screenshots/chat/edit-delete-* | 1c27a1a84a7fc53187010547bf06bbc7190c5d0a | 2026-11-02 |

## Log

- 2026-10-28 Design: doing — Proposal mock docs/features/message-edit-delete (clone of ai-groups 80de805): edit, delete for everyone/for me, incoming edits/deletes on linked-phone chats; owner confirmation pending (5709439)
- 2026-10-28 Design: done — Mock confirmed 2026-10-28 ("implement it"), revision 1460c1c; design.md + mock-index updated (70dd1c8)
- 2026-10-28 Dev: done — wa protocol edits/revokes + sends, migration 025, PATCH/DELETE /api/messages/:id, edits route, AI skips deleted/redrafts, web menu + dialogs (en/ms/zh-CN) (70dd1c8)
- 2026-10-28 Unit tests: pass — Full suite: 3841 passed; 4 document-worker tests fail on Node 22 in this container (known, LEARNINGS); migrate test updated. Changed-lines coverage 97.3 % (431/443); lines total 90.22 %, floor raised to 90 (70dd1c8)
- 2026-10-28 E2E: pass — npm run e2e: 116 passed + new message-changes spec 4/4 after fixing its locators; ai-member fails on Node 22 here (known document-worker issue, LEARNINGS) (70dd1c8)
- 2026-10-28 Dev Build: pass — devbuild-message-changes-check.mjs on :7477 (fake WA, standalone): 36 shots, no errors/overflow, agent checks pass; real WhatsApp untested (70dd1c8)
- 2026-10-28 Screen review: pass — Desktop 1280 + mobile 360, light/dark: matches the confirmed mock; docs/screenshots/chat/edit-delete-* (70dd1c8)
- 2026-10-28 Unit tests: pass — Full suite: 3841 passed; 4 document-worker tests fail on Node 22 in this container (known, LEARNINGS). Changed-lines coverage 97.3 % (431/443); lines total 90.22 %, floor raised to 90 (4aee64d50defc808272cff9b4baee8579816aca7)
- 2026-10-28 E2E: pass — npm run e2e: 116 passed; new message-changes spec 4/4 (setup, desktop, mobile, iphone) on this head; ai-member fails on Node 22 here (known document-worker issue). Desktop-window link check not run (no Windows desktop here) (4aee64d50defc808272cff9b4baee8579816aca7)
- 2026-10-28 Dev Build: pass — e2e/devbuild-message-changes-check.mjs on :7477 (fake WA, standalone): 36 shots, no errors/overflow, agent checks pass; real WhatsApp untested (4aee64d50defc808272cff9b4baee8579816aca7)
- 2026-10-28 Screen review: pass — Desktop 1280 + mobile 360, light/dark: matches the confirmed mock; docs/screenshots/chat/edit-delete-* (4aee64d50defc808272cff9b4baee8579816aca7)
- 2026-11-02 Dev: done — rebased on main cbd224f: migration 025 -> 029, Safety + edit/delete joined in present() (deleted = no finding), mock creationOrder 26, concept-tips archived (71e72a0)
- 2026-11-02 E2E: doing — e2e/message-changes.spec.ts only: 4 passed (setup, desktop, Android, iPhone); full npm run e2e + e2e:electron-links still to run after the rebase (ad94ef7)
- 2026-11-02 Unit tests: pass — 17 files, 294 tests + new Safety delete test (Node 24); typecheck all workspaces; eslint/prettier on changed files (ad94ef7)
- 2026-11-02 E2E: pass — full npm run e2e after the rebase: 138 passed, 27 skipped (Node 24, 1 worker); e2e:electron-links 17/17 screens (af74145)
- 2026-11-02 Dev Build: pass — re-run on af74145: devbuild-message-changes-check 36 shots, no errors/overflow, schema 29; real WhatsApp still untested (af74145)
- 2026-11-02 E2E: pass — npm run e2e on 1c27a1a after the Lite-import fix: 137 passed, 27 skipped; ai-member fails here on Node 22 only (known document-worker issue; passed on the owner's Node 24 run). Desktop-window link check from the owner's run on af74145 (1c27a1a84a7fc53187010547bf06bbc7190c5d0a)
- 2026-11-02 Dev Build: pass — re-run on 1c27a1a (after the Lite-import fix): devbuild-message-changes-check 36 shots, no errors/overflow, agent checks pass; real WhatsApp still untested (1c27a1a84a7fc53187010547bf06bbc7190c5d0a)
- 2026-11-02 Screen review: pass — re-captured on 1c27a1a, desktop 1280 + mobile 360, light/dark: matches the confirmed mock next to main's Ask Ezy / Summarise buttons; docs/screenshots/chat/edit-delete-* (1c27a1a84a7fc53187010547bf06bbc7190c5d0a)
- 2026-11-02 E2E: pass — npm run e2e on 1c27a1a on Node 24 (1 worker): 138 passed, 0 failed (ai-member passes on Node 24; the Node 22 run had 137); e2e:electron-links 17/17 (1c27a1a84a7fc53187010547bf06bbc7190c5d0a)
