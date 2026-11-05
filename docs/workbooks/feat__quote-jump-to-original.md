# Workbook: feat/quote-jump-to-original

Branch: `feat/quote-jump-to-original` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | skip | Owner asked directly (2026-11-05): tap a quote to jump to its original, like WhatsApp. Small interaction on the existing bubble; no new screen, so no mock (design note in this workbook) | 2599dd5 | 2026-11-05 |
| Dev | done | GET /chats/:jid/messages/:id/locate (found + newer, inbox access via chatJidParam, 404 outside); web useQuoteJump + quote button + scroll/highlight in MessageList | 2599dd5 | 2026-11-05 |
| Unit tests | pass | server messages.test locate; web useQuoteJump, MessageList, MessageBubble quote jump, useSwipeReply gesture; web-client contract + i18n catalogs | 2599dd5 | 2026-11-05 |
| E2E | pass | e2e/quote-jump.spec.ts only (desktop, mobile, iphone: 6/6 passed); full suite left to the main session | 2599dd5 | 2026-11-05 |
| Dev Build | todo | Not yet checked in a Dev Build | 2599dd5 | 2026-11-05 |
| Screen review | todo | Quote is now a button (same look, hover tint); target row tinted bg-primary/10 for 1.6 s; 1280/360 light+dark capture pending | 2599dd5 | 2026-11-05 |

## Log

- 2026-11-05 Design: skip — Owner asked directly (2026-11-05): tap a quote to jump to its original, like WhatsApp. Small interaction on the existing bubble; no new screen, so no mock (design note in this workbook) (2599dd5)
- 2026-11-05 Dev: done — GET /chats/:jid/messages/:id/locate (found + newer, inbox access via chatJidParam, 404 outside); web useQuoteJump + quote button + scroll/highlight in MessageList (2599dd5)

## Design note

Owner request (2026-11-05, in his words): "improve the quote msg, when people quote msg, when click the quote msg it
should try to go back source msg, unless the source msg [no] longer in our record". A small interaction on the existing
bubble, so no feature folder or mock (the five-folder retention rule stays untouched). Owner, same day, on scope:
"this is small task, you can implement, test PR merge and archive sub session" (no mock round).

- The quote inside a bubble is a button (accessible name "Go to the quoted message: <author> <preview>"); keyboard
  Enter/Space works; on touch a long press or swipe that starts on the quote is not a tap (`useSwipeReply.wasGesture`).
- Loaded original: scroll it to the centre (`smooth`, `auto` with prefers-reduced-motion), focus it (`tabIndex=-1`,
  never a tab stop) and tint its row `bg-primary/10` for 1.6 s (colour fade only with motion allowed).
- Not loaded: `GET /api/chats/:jid/messages/:id/locate` → `{found, newer}`, by the stored key (`quoted_id`), never text.
  `found:false` when never stored, stored in another chat, or hidden for the team → toast "The original message isn't
  available". Found → older pages load until it is there, at most ceil((newer+1)/50)+1 pages and never more than 40
  (2,000 messages; beyond that a "too far back" toast). A message deleted for everyone is still stored and is scrolled
  to (it shows as deleted).
- Inbox access: `chatJidParam` answers 404 for a chat outside the caller's inboxes, like every per-chat route.
- 2026-11-05 Dev: done — GET /chats/:jid/messages/:id/locate (found + newer, inbox access via chatJidParam, 404 outside); web useQuoteJump + quote button + scroll/highlight in MessageList (2599dd5)
- 2026-11-05 Unit tests: pass — server messages.test locate; web useQuoteJump, MessageList, MessageBubble quote jump, useSwipeReply gesture; web-client contract + i18n catalogs (2599dd5)
- 2026-11-05 E2E: pass — e2e/quote-jump.spec.ts only (desktop, mobile, iphone: 6/6 passed); full suite left to the main session (2599dd5)
- 2026-11-05 Dev Build: todo — Not yet checked in a Dev Build (2599dd5)
- 2026-11-05 Screen review: todo — Quote is now a button (same look, hover tint); target row tinted bg-primary/10 for 1.6 s; 1280/360 light+dark capture pending (2599dd5)
