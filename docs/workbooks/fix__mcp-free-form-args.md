# Workbook: MCP connectors keep free-form map arguments

Branch: `fix/mcp-free-form-args` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | skip | Core bug fix, no UI: no design or mock | 171f3aa | 2026-11-06 |
| Dev | done | boundedInputSchema keeps additionalProperties maps; cleanArgs keeps map keys within MAP_LIMITS, validates values, guards read map paths | 171f3aa | 2026-11-06 |
| Unit tests | pass | rules.test.ts (Notion-like repro, bounds, value schema, __proto__) + connector-mcp-map-guards.test.ts (all 5 guards on map values); connector MCP suites 134 passed; changed lines covered | 171f3aa | 2026-11-06 |
| E2E | skip | Server-only change, no screen; per task no e2e | 171f3aa | 2026-11-06 |
| Dev Build | todo | Not yet checked against a real Notion MCP server | 171f3aa | 2026-11-06 |
| Screen review | skip | No UI change | 171f3aa | 2026-11-06 |

## Log

- 2026-11-06 Design: skip — Core bug fix, no UI: no design or mock (171f3aa)
- 2026-11-06 Dev: done — boundedInputSchema keeps additionalProperties maps; cleanArgs keeps map keys within MAP_LIMITS, validates values, guards read map paths (171f3aa)
- 2026-11-06 Unit tests: pass — rules.test.ts (Notion-like repro, bounds, value schema, __proto__) + connector-mcp-map-guards.test.ts (all 5 guards on map values); connector MCP suites 134 passed; changed lines covered (171f3aa)
- 2026-11-06 E2E: skip — Server-only change, no screen; per task no e2e (171f3aa)
- 2026-11-06 Dev Build: todo — Not yet checked against a real Notion MCP server (171f3aa)
- 2026-11-06 Screen review: skip — No UI change (171f3aa)
