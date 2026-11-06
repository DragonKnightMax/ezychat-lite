# Workbook: Limited chat access (an agent sees only chosen chats)

Branch: `feat/partner-role` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

Design: [docs/features/partner-role/design.md](../features/partner-role/design.md) · Mock: [docs/features/partner-role/mock](../features/partner-role/mock)

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | done | Owner confirmed the limited-agent mock 2026-11-06 (revision 846a09c); answers + no-notification rule recorded in design.md and mock-index | eeb777b | 2026-11-06 |
| Dev | todo |  |  |  |
| Unit tests | todo |  |  |  |
| E2E | todo |  |  |  |
| Dev Build | todo |  |  |  |
| Screen review | todo |  |  |  |

## Log

- 2026-11-06 Design: doing — Design + HTML mock (docs/features/partner-role): 16 states, 64 screenshots desktop/mobile light/dark, 0 page errors; awaiting owner confirmation, no production code (171f3aa)
- 2026-11-06 Design: doing — Owner simplified scope (full history, notes always hidden, no end date): design and mock updated, 64 screenshots retaken, 0 errors; awaiting mock confirmation (62b35f9)
- 2026-11-06 Design: doing — Owner simplified to one agent setting (All chats / Only chosen chats, no new role): design and mock reworked, 10 states, 40 screenshots, 0 errors; awaiting mock confirmation (548f78a)
- 2026-11-06 Design: done — Owner confirmed the limited-agent mock 2026-11-06 (revision 846a09c); answers + no-notification rule recorded in design.md and mock-index (eeb777b)
