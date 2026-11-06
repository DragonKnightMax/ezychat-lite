# Workbook: feat/mcp-read-message-file

Branch: `feat/mcp-read-message-file` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Updated |
| --- | --- | --- | --- |
| Design | skipped | no UI: one MCP read tool (owner: small task, no mock round) | 2026-11-06 |
| Dev | done | MCP `get_message_file` {messageId}: photo as MCP image content (bytes-typed JPEG/PNG/WebP, ≤ 1.5 MB), PDF/.docx text via extractKnowledgeIsolated (≤ 10 MB, ≤ 20,000 chars, text null for a scan), unsupported types answered with metadata; inbox scope, Safety fail-closed (High, cantInspect, AI check pending), pending history media via ensureMedia, 30/min per token, audit mcp.read_file ids/kind/size only | 2026-11-06 |
| Unit tests | pass | mcp-message-file 14 pass (image, photo-as-document, PDF, DOCX, scan, unsupported, pending download + failure, Safety High, cantInspect ZIP, AI check pending, hidden/deleted/unknown/text, oversize photo/source, truncation, rate limit, other inbox); mcp*/ask-ezy/knowledge 150 pass; new files 100 % lines; server+shared typecheck, lint green | 2026-11-06 |
| E2E | pending | main session runs it (no screen touched) | 2026-11-06 |
| Dev Build | pending | not checked with a real MCP client (Claude Desktop) reading a real photo | 2026-11-06 |
| Screen review | skipped | no UI change | 2026-11-06 |

## Log

- 2026-11-06 Dev + Unit tests: see table. No image downscaling (no image library in the app and no new native module): photos over 1.5 MB answer "too large to return".
