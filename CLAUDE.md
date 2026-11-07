# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

All project rules, commands and architecture live in **AGENTS.md** (shared with Codex and other agents) —
edit rules there, not here:

@AGENTS.md

## Claude Code specifics

- A Stop hook (`.claude/hooks/learnings-gate.mjs`, configured in `.claude/settings.json`) blocks finishing a
  code-changing turn until `docs/LEARNINGS.md` has been updated.
- A PostToolUse hook (`.claude/hooks/review-nudge.mjs`) watches every Edit/Write: once the branch changes 8+ files
  or 400+ lines against the default branch (docs and lockfiles not counted), it asks Claude to run `/code-review`
  before committing or opening the PR and to fix or report its findings. Merging still needs the owner's explicit
  request. Thresholds: `REVIEW_NUDGE_FILES`, `REVIEW_NUDGE_LINES`.
- Browser testing with Claude in Chrome: run `list_connected_browsers` first — `127.0.0.1` only works when the
  connected browser is on the same machine as the app.
