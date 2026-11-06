# Workbook: Limited chat access (an agent sees only chosen chats)

Branch: `feat/limited-agent-impl` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | Owner-confirmed mock: docs/features/partner-role (PR #314, revision 846a09c) | f3bf2d9 | 2026-11-06 |
| Dev | done | users.chat_scope + member_chats (037), scope in inboxes/access.ts, 404 outside, chat:<jid> rooms, notifications via usersWhoCanOpenChat, assignment, Ask Ezy/member chat refused, Members edit UI, en/ms/zh-CN | f3bf2d9 | 2026-11-06 |
| Unit tests | pass | 5187 pass; only migrate.test gap (needs #317 migration 036); changed-lines coverage 98.8 % (250/253) | 775027e | 2026-11-06 |
| E2E | todo |  |  |  |
| Dev Build | todo |  |  |  |
| Screen review | todo |  |  |  |

## Log

- 2026-11-06 Design: done — Owner-confirmed mock: docs/features/partner-role (PR #314, revision 846a09c) (f3bf2d9)
- 2026-11-06 Dev: done — users.chat_scope + member_chats (037), scope in inboxes/access.ts, 404 outside, chat:<jid> rooms, notifications via usersWhoCanOpenChat, assignment, Ask Ezy/member chat refused, Members edit UI, en/ms/zh-CN (f3bf2d9)
- 2026-11-06 Unit tests: pass — 5187 pass; only migrate.test gap (needs #317 migration 036); changed-lines coverage 98.8 % (250/253) (775027e)
