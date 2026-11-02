# Edit and delete messages: interactive app proposal

A clone of the owner-confirmed **ai-groups** reference (the whole app, `latestConfirmed` revision `ea63248`,
squash-merged as `80de805`, cloned unchanged at `5709439`) with the **message-edit-delete** proposal on top: edit,
delete for everyone and delete for me on linked-phone chats, and the customer's (or the phone's) edits and deletes
coming in from WhatsApp. Scope, rules and the screen checklist: [../design.md](../design.md).

Every inherited flow still works (groups, connectors, Reports, Google Calendar, reply suggestions, reactions,
inboxes, AI agents). Mock-only control texts are English in all three catalogs; the new user-facing texts have
Malay and Chinese.

From the repository root, after the normal `npm install` (Node 22 or later):

```powershell
# Seeded demo: admin aisyah, agents daniel and meiling (password demo-pass-123).
npx tsx --conditions=ezychat-source docs/features/message-edit-delete/mock/run.ts --fake-wa
```

Open `http://localhost:7487/` (API on `127.0.0.1:7486`; `MOCK_UI_PORT` / `MOCK_API_PORT` change them; run one mock
at a time). The seed takes about a minute. Nothing calls WhatsApp or an AI provider. Edits and deletes are a
stand-in (`edit-delete.ts`, routes `/api/mock/messages/:id`, `/api/mock/message-changes*`): they live in mock
memory and are laid over the stored messages by the web; the stored messages themselves stay unchanged.

## Seed data (Ahmad Zulkifli, inbox Kopi Apong)

| Message                                                    | State                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| Aisyah: "Yes, we open 10am to 4pm on Hari Raya."           | Edited by Aisyah (was 6pm): "Edited", earlier version |
| Ahmad: "Great, 4 Kopi Peng for pickup at 11.30am please."  | Edited by the customer (was 3 at 11am)                |
| Ahmad: "Sorry, wrong chat 🙈"                              | Deleted by the customer; admins can Show original     |
| Daniel: "Pickup is at the Jalan Burma branch."             | Deleted for everyone by Daniel                        |
| Phone: "Pickup is at our Georgetown shop, see you then 👍" | Sent from the phone: admins only may edit or delete   |
| Daniel: "Your order is being prepared now!"                | Recent: Daniel (or an admin) may edit and delete      |

Jason Lim's chat is in **Online orders**, a WhatsApp Business API inbox: no Edit or Delete there.

## Walkthrough

1. Sign in as `aisyah`, open **Ahmad Zulkifli**. Click **Edited** under Aisyah's reply: the earlier version, by whom
   and when. On the customer's deleted message click **Show original (admins)**.
2. Hover Daniel's last message → **⋮** → **Edit**: change the text, **Save** (Ctrl+Enter). The bubble shows the new
   text and "Edited". On a phone (360 px, touch) press and hold the bubble: Edit and Delete sit under Reply.
3. **⋮ → Delete**: **Delete for everyone** (the bubble reads "Aisyah deleted this message") or **Delete for me**
   (hidden for the whole team).
4. Open **Simulate edits and deletes** (Mock only, collapsed at the top of the chat): _Customer edits / deletes their
   last message_, _Phone edits / deletes our last message_. **Clock → 20 minutes later**: Edit is disabled with
   "Only within 15 minutes of sending"; **3 days later**: Delete offers only Delete for me. **Phone offline**: the
   menu is disabled with the reason. **Reset demo** restores the seed.
5. Sign in as `daniel` (agent): no Show original, no actions on Aisyah's or the phone's messages, Edit and Delete for
   everyone on his own, no Delete for me.
6. Open **Jason Lim** (Online orders, Business API): no ⋮ menu.

## Changed for this proposal

Reference: `reference.json` keeps the frozen baseline hashes (`files`; `inheritedUnchanged` now also pins the
ai-groups proposal's files) and lists this proposal under `proposalChanged` / `proposalAdded`.

- Changed (frontend): `src/inbox/MessageBubble.tsx` (overlay, ⋮ menu, Edited, deleted body, dialogs),
  `src/inbox/ReactionPicker.tsx` (touch actions under Reply), `src/inbox/Conversation.tsx` (Mock only panel), and the
  `en`, `ms`, `zh-CN` `inbox.json` catalogs (`editDelete.*`, `mockEditDelete.*`).
- Added (frontend): `src/inbox/MessageActions.tsx` (menu, Edit and Delete dialogs, Edited label, deleted body),
  `src/mock/useMessageChanges.ts` (client of the stand-in routes and the rights rule),
  `src/mock/EditDeleteSimulator.tsx` (Mock only panel).
- Runner: `edit-delete.ts` (added: state, rules, seed, routes), `proposal.ts` (registers it), `run.ts` (ports
  7487/7486, temp-folder name, ready line, `seedEditDelete` after `seedDemo`), every `*-shots.mjs` defaults to port
  7487, `edit-delete-shots.mjs` (added), `reference.json`.

Not shown: the chat list preview after an edit or delete, the AI's handling, the Activity page rows (written as
audit rows `message.edit` / `message.delete` by the stand-in), real WhatsApp timing.

## Checks

```powershell
npx tsc -p docs/features/message-edit-delete/mock/tsconfig.json
node docs/features/message-edit-delete/mock/snapshot.mjs --check
# With the seeded mock running (fresh browser contexts; light and dark, 1280 px and 360 px touch; installed
# Chrome unless PW_CHROMIUM is set). It changes the mock's data: restart the mock afterwards.
node docs/features/message-edit-delete/mock/edit-delete-shots.mjs
```

Do not run `snapshot.mjs` without `--check`: that replaces the reference with the current app.
`groups-shots.mjs`, `connector-list-shots.mjs`, `calendar-shots.mjs`, `reports-shots.mjs`, `phrase-shots.mjs`, `suggest-shots.mjs`,
`business-api-shots.mjs`, `upgrade-shots.mjs`, `send-reaction-shots.mjs`, `reaction-shots.mjs`, `agent-shots.mjs`
and `inbox-shots.mjs` are inherited scripts (pointed at this mock's port).
