# Edit and delete messages (linked phone)

Status: **confirmed** 2026-10-28 and implemented (see Confirmation). Branch
`claude/affectionate-heisenberg-tg7h6n` from `main` (`5709439`, 0.1.62).

## Owner request (2026-10-28)

- "check if bailey or whatsapp business api support edit message and delete message?" Baileys does
  (`sendMessage(jid, { text, edit: key })`, `{ delete: key }`, `chatModify` for delete for me; incoming
  `protocolMessage` `MESSAGE_EDIT` / `REVOKE`). The WhatsApp Business (Cloud) API has no documented
  edit or recall of a sent message (unconfirmed against Meta's reference; vendor docs say no).
- "ok plan the edit, delete for all, delete for me, incoming edit and delete for bailey"; the owner
  answered the plan with "look good", which accepts the four proposed defaults below.

## Today

- `packages/wa/src/baileys/mapping.ts` drops every `protocolMessage`: a customer's edit or delete is
  ignored and the inbox keeps showing the original. Nothing in the app edits or deletes a sent message.

## Baseline

- Cloned from the owner-confirmed **ai-groups** mock (`latestConfirmed`: branch revision `ea63248`,
  squash-merged to `main` as `80de805a8fe31d500c2cf7b650c4029ed56d9095`, #199), the whole app, at
  `5709439`. `reference.json` pins the frozen files and the inherited proposals.
- Reused, not changed: the message bubble and its hover buttons (Reply, 🙂), the press-and-hold bar on
  touch (`ReactionPicker`), `ResponsiveDialog` (dialog on desktop, drawer on phones), the WhatsApp
  offline state of reactions (`waSendingBlocked` / `waQueuesMessages`), the Activity/audit rows,
  inbox types (Business API inbox "Online orders").
- Retention: this is the sixth feature folder; the oldest, `ai-phrase-dictionary` (last revision
  `0a7ceddf5e503861ef11c38ff862956090dfc12b`), is pruned in the same change.

## Behaviour

| Rule                | Proposal                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where               | Linked-phone inboxes only (`WaCapabilities.editMessage`, `deleteForEveryone`, `deleteForMe`, optional, absent = off). A WhatsApp Business API inbox shows no Edit or Delete.                    |
| Edit                | Our own text messages and captions, within **15 minutes** of sending (WhatsApp's limit). The customer sees the new text marked "Edited". Not queued: WhatsApp offline → the action waits (503). |
| Delete for everyone | Our own messages, within **2 days** of sending. The customer sees "This message was deleted".                                                                                                   |
| Delete for me       | **Admins only**, any message: hidden for the whole team and deleted on the linked phone (`chatModify`). The customer keeps it. The audit row stays.                                             |
| Who may edit/delete | The teammate who sent it, and admins. Messages sent from the phone or by the AI agent: admins only.                                                                                             |
| Customer deletes    | The bubble shows "<name> deleted this message" to everyone; **admins can Show original** (kept for the team record). Agents never receive the original text.                                    |
| Customer edits      | The bubble shows the new text and "Edited"; the "Edited" label lists the earlier versions with who and when.                                                                                    |
| From the phone      | Edits and deletes made on the linked phone sync the same way ("Deleted from the phone", "Changed by the phone").                                                                                |
| Quotes and previews | A quote of a deleted message reads "This message was deleted"; a quote of an edited one shows the latest text. The chat list preview follows the latest message.                                |
| Pending messages    | A message still waiting in the send queue is cancelled locally, never sent to WhatsApp.                                                                                                         |
| AI                  | The prompt uses the latest text and leaves deleted messages out; a reply drafted while the customer edits or deletes is dropped and drafted again.                                              |
| Notifications       | An edit or delete never notifies and never bumps unread.                                                                                                                                        |
| Groups              | Our own messages as above. Deleting other members' messages as a group admin is **not in this round**.                                                                                          |
| Audit and logs      | `message.edit`, `message.delete` {messageId, chatJid, scope}; never the text.                                                                                                                   |

## Server and contract (implementation outline)

- `packages/wa`: `editText`, `deleteForEveryone`, `deleteForMe` on `WaAdapter`; events `messageEdited`,
  `messageDeleted`; `mapWAProtocol` (`MESSAGE_EDIT` with `editedMessage`, `REVOKE`) in `ingest()` before
  `mapWAMessage`, plus `messages.update` `editedMessage`, deduplicated by target id and edit time;
  history applies changes inside the import window. Fake adapter: `simulateEdit`, `simulateRevoke`.
- Migration 029: `messages.edited_at`, `deleted_at`, `deleted_by`, `deleted_by_user_id`, `hidden_at`;
  table `message_edits` (previous text, at, by, user); `message_changes_pending` for a change that
  arrives before its message. `upgrade-from-oldest.test.ts` seed extended.
- `MessageSchema`: `editedAt`, `deletedAt`, `deletedBy`, `deletedByName`, `editCount` (zod defaults);
  `original` only in the admin-only history route.
- Routes: `PATCH /api/messages/:id` {text}, `DELETE /api/messages/:id?scope=everyone|me`,
  `GET /api/messages/:id/edits` (admins see the deleted original). Inbox access (404), the send checks,
  the capability (409 `not_supported`), the windows (409 `edit_window_closed` / `delete_window_closed`),
  30 a minute per user. Socket `message:updated`.
- Dev: `POST /api/dev/fake-edit`, `POST /api/dev/fake-revoke` (fake WhatsApp only).
- MCP read tools carry the edited/deleted flags; no edit or delete tools.
- Enterprise: core bump only; `ent-wa-cloud` declares no new capability, so everything stays off.

## Screens (mock checklist)

1. Chat with an edited team reply, a customer's edit, the customer's delete, a teammate's delete
   (`01-chat`).
2. "Edited" → earlier versions (`02-edit-history`); Show original as admin (`03-show-original`).
3. ⋮ menu on desktop, Edit / Delete under Reply in the press-and-hold bar on touch (`04-actions`).
4. Edit dialog (desktop dialog, phone drawer) and the edited result (`05-edit-dialog`, `06-edited`).
5. Delete dialog with both choices, result (`07-delete-dialog`, `08-deleted-for-everyone`).
6. After the windows: Edit disabled with "Only within 15 minutes of sending" (`09-windows-closed`),
   only Delete for me left (`10-delete-for-me-only`), the message hidden for the team
   (`11-hidden-for-team`).
7. WhatsApp offline: actions disabled with the reason (`12-offline`, desktop).
8. Agent view: no Show original, no actions on others' messages (`13-agent-view`).
9. Business API inbox: no actions (`14-business-api-none`).
10. Desktop 1280 px and mobile 360 px touch, light and dark; Malay and Chinese texts in the catalogs.

## Not in this round

- Group admins deleting other members' messages.
- Edit or delete through MCP tools.
- Editing media itself (only its caption), editing a template message.
- WhatsApp Business API inboxes (no API support).

## Verification still owed after implementation

- Unit tests ≥ 90 % of changed lines, the real-server contract test, `npm run e2e`.
- Dev Build check, and a **real WhatsApp** smoke with a test number (the change touches
  `packages/wa/src/baileys/**`); until then "untested against real WhatsApp". Confirm the exact
  edit and delete windows on the real app during that smoke.
- Enterprise typecheck, lint and tests on the local core.

## Confirmation

Owner, 2026-10-28, after the mock screenshots (desktop chat, menu after 15 minutes, phone menu, edit and delete
dialogs, dark phone states) and the touch walkthrough question: "implement it". Mock revision
`1460c1c6ccfcff64a199c4db8c78fd748b433f02`, the same mock files as `6be302deb7785daedde3129eff80493ead0ba060` after
the rebase on `main` (2026-11-02). The open question (show Edit greyed out with its reason on phones after
15 minutes) was not answered: the default stands, as mocked (phones drop Edit from the press-and-hold bar once its
window has passed; desktop keeps it disabled with the reason).

## Implementation notes (differences from the outline)

- The new `Message` fields and inbox capabilities are **optional** (absent = not edited / off) rather than zod
  defaults: required output fields would break every `Message` fixture here and in Enterprise.
- Desktop: Delete also stays visible, disabled with "only within 2 days", for a non-admin once the window passed.
- A send that finishes after its teammate deleted it is deleted on WhatsApp too (`onSent` → `deleteSentLate`).
- The chat list preview of a deleted newest message is the server text "This message was deleted" (like
  `[Image]`); a hidden one falls back to the newest visible message.
- WhatsApp's exact windows (15 minutes, about 2 days) come from third-party Baileys docs; they are confirmed in
  the real-WhatsApp smoke before release.
