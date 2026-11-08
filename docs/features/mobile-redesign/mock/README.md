# Mobile redesign (phone 360–430 px): interactive app proposal

A clone of the owner-confirmed **forward-message** reference (the whole app, revision `2549b7af`, which carries
new-chat, partner-role, scheduled-tasks, google-drive and sql-accounting) with the **mobile-redesign** proposal on top.
Below 768 px wide the inbox gets: a one-row header with the **WhatsApp-number switcher** as the title (bottom sheet
with unread and connection per number), search on demand, **filter chips** (All, Unread, Mine, Unassigned, Groups,
Tag, Resolved), a **New chat** floating button, **swipe** right = Assign to me / left = Resolve with Undo,
**press and hold** a row for every action, and a one-row **chat header with chips** (who handles it, tags with
**+ Tag**, Notes). Desktop is unchanged. Scope, before/after and open questions: [../design.md](../design.md).

```bash
npx tsx --conditions=ezychat-source docs/features/mobile-redesign/mock/run.ts --fake-wa
node docs/features/mobile-redesign/mock/mobile-shots.mjs   # PW_CHROMIUM=<chromium> if needed; fresh mock
```

Open `http://localhost:7489/` on a phone on the same network, or in the browser's device mode at 360 or 390 px, and
sign in as `aisyah` (`demo-pass-123`). Try: the title → switch to **Catering** (the dot shows unread on other
numbers), the chips, **Tag ▾ → VIP**, the search icon, **New chat**, swipe **Nurul Huda** right (Assign to me →
Undo) or a row left (Resolve), press and hold a row, open **Priya Nair** → **Unassigned ▾**, **+ Tag** (type a new
tag, Done), **⋮**. **Groups have tags too** (owner 2026-11-07): open **Kopi Lovers Club** → **+ Tag**, Group info → **Tags**, or
**Tag ▾ → Wholesale** in the list; Customer details has the same **Tags** row. `daniel` sees 2 numbers, `meiling` one (plain "Inbox" title); `?edition=lite` (or Mock view →
Lite in Admin) shows Lite. The living design system reference is `http://localhost:7489/design-system` (no sign-in; Light/Dark at the
top). Swipes change the demo data: restart the runner for a fresh demo. Everything below is the
inherited forward-message README; every inherited flow still works (on desktop unchanged, on a phone through the new
header and sheets).

---

# Forward a message: interactive app proposal

A clone of the owner-confirmed **new-chat** reference (the whole app, revision `e7dc8cfa`, which carries scheduled-tasks,
google-drive and the sql-accounting screens) with the confirmed **partner-role** (limited chat access, `846a09cc`)
files merged in, and the **forward-message** proposal on top: **⋮ → Forward** on a message sends a copy to up to 5
existing chats or groups the user may open, as WhatsApp's "Forwarded", through the normal send queue. Our chat view
shows **Forwarded** / **Forwarded many times** on copies and on customers' forwarded messages. Scope, rules and
decisions: [../design.md](../design.md).

```bash
npx tsx --conditions=ezychat-source docs/features/forward-message/mock/run.ts --fake-wa
node docs/features/forward-message/mock/forward-shots.mjs   # PW_CHROMIUM=<chromium> if needed; fresh mock
```

Open `http://localhost:7489/`, sign in as `aisyah` (`demo-pass-123`), open **Priya Nair**, hover her photo and press
**⋮ → Forward** (on a phone: press and hold the message). Try: search, pick chats in two inboxes, pick 5 (the rest
grey out), **Jason Lim** (Business API, 24-hour window closed: greyed out), the dashed **Mock only** buttons (WhatsApp
offline, Safety locked), Forward → toast → open the other chat to see **Forwarded**. **Jason Lim** and **Nurul Huda**
show customers' forwarded messages; forwarding Nurul's ("Forwarded many times") allows one chat. **The owner's case:** open **Farah Aziz** (Catering) → the event hall video (shown as 70 MB) → Forward to **Priya Nair**
(Online orders, Business API) and **Kopi Apong Staff**: it goes as a file; Mock only adds Slow upload, Upload fails
and Video 120 MB. Sign in as `ravi`
(limited to 3 chosen chats) to see only those. `?edition=lite` shows Lite (one inbox, no inbox chips). Everything
below is the inherited new-chat README; every inherited flow still works.

---

# New chat (message a number that is not in the inbox yet): interactive app proposal

A clone of the owner-confirmed **scheduled-tasks** reference (the whole app, revision `426c2eb7`, which already
carries google-drive and the sql-accounting screens) with the **new-chat** proposal on top: a **New chat** button in the chat list header starts a WhatsApp chat with a phone
number that is not in the inbox yet. A linked phone checks the number is on WhatsApp (with a ban warning) and opens
the chat with the normal composer; a Business API number starts with an approved template, and the chat exists only
once it is sent. Admins can always do it; **Admin → Settings → General → New chats** lets team members do it too
(off by default) and sets **New chats per day, per WhatsApp number** (default 20, 0 = no limit; confirmed
2026-11-06). Scope, rules and decisions: [../design.md](../design.md).

```bash
npx tsx --conditions=ezychat-source docs/features/new-chat/mock/run.ts --fake-wa
node docs/features/new-chat/mock/new-chat-shots.mjs   # PW_CHROMIUM=<chromium> if needed; fresh mock
```

Open `http://localhost:7489/`, sign in as `aisyah` (`demo-pass-123`), click **New** next to the Inbox title. Try:
`012-345 6789` style numbers, `12345` (invalid), a number ending in **0** (not on WhatsApp), `012-555 0142` (already a
chat → Open chat), **Send from → Online orders** (Business API: choose a template, fill the variables, Send
template), and the dashed **Mock only** buttons (WhatsApp offline, Daily limit, Template fails). Sign in as `daniel`
for a team member: no button until an admin switches **Team members can start new chats** on and saves.
`?edition=lite` shows Lite (one inbox, no Send from). Everything below is the inherited scheduled-tasks README; every inherited flow still works.

---

# Scheduled tasks for AI agents: interactive app proposal

A clone of the owner-confirmed **google-drive** reference (the whole app, revision `442b6317`, with the confirmed
**sql-accounting** screens merged in) with the **scheduled-tasks** proposal on top: each AI agent page gets a
**Scheduled tasks** card. A task sends one message from the agent at a set time (Every day / Weekdays / Chosen days,
business time zone) to one existing chat or group of its inbox, following a plain-words instruction; it may send
nothing when there is nothing to tell. Scope, guards, tables and routes: [../design.md](../design.md).

```bash
npx tsx --conditions=ezychat-source docs/features/scheduled-tasks/mock/run.ts --fake-wa
node docs/features/scheduled-tasks/mock/scheduled-shots.mjs   # PW_CHROMIUM=<chromium> if needed; fresh mock
```

Open `http://localhost:7489/`, sign in as `aisyah` (`demo-pass-123`), **Admin → Members → Aina** and press **Turn on**
(the seeded agent is off, which shows the paused banner). The **Scheduled tasks** card lists three tasks. Try: Add task
(validation, Send to search, Chosen days, Preview), a task's ⋮ → History / Run now (sends into the real chat; open
**Kopi Apong Staff** to see the **Scheduled · Morning bookings** mark), and the dashed **Mock only** box (AI connected,
WhatsApp connected, Nothing to tell today, 24-hour window closed, Fill to 10 tasks, Reset demo). `?edition=enterprise`
and agent **Sofia** show the empty card. Tasks and history are kept in this browser (localStorage); nothing calls a
model. Everything below is the inherited google-drive README; every inherited flow still works.

---

# Google Drive connector: interactive app proposal

A clone of the owner-confirmed **group-management** reference (the whole app, revision `26116d59`) with the
**google-drive** proposal on top: a built-in connector beside Google Calendar. An AI agent **saves files customers
send** (photos, PDFs, documents) into a Google Drive folder the admin picks, and **answers from Drive files** the admin
picks for it. Scope, scope choice (`drive.file`) and rules: [../design.md](../design.md).

```bash
npx tsx --conditions=ezychat-source docs/features/google-drive/mock/run.ts --fake-wa
node docs/features/google-drive/mock/drive-shots.mjs   # PW_CHROMIUM=<chromium> if needed
```

Open `http://localhost:7489/`, sign in as `aisyah` (`demo-pass-123`), **Admin → Connectors → Google Drive**:
Connect (stand-in Google consent) → Settings → Choose a folder → switch on Save files → Add files → Save; then use
the dashed **Mock only** box to send a photo, a PDF, a question, a Safety-locked file or a 40 MB video and see what
the agent does; Activity lists it; the agent page shows a Google Drive row under Connectors. The Overview's Mock only
buttons switch Google to sign-in expired or unreachable. Nothing calls Google; the state is kept in this browser
(localStorage). Everything below is the inherited group-management README; every inherited flow still works.

---

# Manage WhatsApp groups from Group info: interactive app proposal

A clone of the owner-confirmed **in-app-feedback** reference (the whole app, revision `f3eaf7bc`) with the
**group-management** proposal on top: an EzyChat admin renames a group, edits its description, adds or removes members,
makes or removes group admins, copies or resets the invite link, changes WhatsApp's group settings and approves join
requests from **Group info**, without switching to the phone or Meta's tools. Only what the connection supports is
shown (linked phone vs WhatsApp Business API, a dashed **Mock only** switch in Group info). Scope, capability matrix
and open questions: [../design.md](../design.md).

```bash
npx tsx --conditions=ezychat-source docs/features/group-management/mock/run.ts --fake-wa
node docs/features/group-management/mock/group-admin-shots.mjs   # PW_CHROMIUM=<chromium> if needed; fresh mock
```

Open `http://localhost:7489/`, sign in as `aisyah` (`demo-pass-123`), open **Kopi Lovers Club** → group info. Try:
Edit info, Add member (a number ending in **7** needs an invite, ending in **0** is not on WhatsApp), Invite link →
Reset, Settings (with Recent changes), a member → Make group admin / Remove from group, **Family Day 2026** (your
number is not a group admin), the Mock only box (Business API, WhatsApp offline). Sign in as `daniel` for the agent
(read-only) view. Everything below is the inherited in-app-feedback README; every inherited flow still works, except
that Send feedback now uses the real core route (see `reference.json` → `baselineDriftFixes`).

---

# Send feedback from the app: interactive app proposal

A clone of the owner-confirmed **group-mentions** reference (the whole app, revision `f6f0d2b0`) with the
**in-app-feedback** proposal on top: **Send feedback** in the account menu, Admin → Help & feedback, About and the error
panel opens a form (type, title, details, part of the app, how often / how bad for problems, up to 3 files or a window
screenshot, name, **required** email, company, app details and an opt-in redacted log). The local server forwards it to
the licence portal; here the portal is simulated and the dashed **Mock only** box shows what it recorded (reference,
IP, country, email to general@ezychat.ai) and switches it to unreachable or too many reports. Scope and rules:
[../design.md](../design.md).

```bash
npx tsx --conditions=ezychat-source docs/features/in-app-feedback/mock/run.ts --fake-wa
node docs/features/in-app-feedback/mock/feedback-shots.mjs   # PW_CHROMIUM=<chromium> if needed
```

Open `http://localhost:7489/`, sign in as `aisyah` (`demo-pass-123`); `?edition=enterprise` shows the Enterprise form.
Everything below is the inherited group-mentions README; every inherited flow still works.

---

# Tag group members (@mention): interactive app proposal

A clone of the owner-confirmed **ai-handoff-rules** reference (the whole app, revision `16a126ec`, unchanged on `main`
8bfeef9) with the **group-mentions** proposal on top: in a group chat, typing `@` in the composer opens **Tag a
member**; picking one puts `@Name` in the box, and Send turns each tag into WhatsApp's `@<number>` with the member's
address, so WhatsApp shows a real tag and notifies them. Scope and rules: [../design.md](../design.md). Run it exactly as
below (paths under `group-mentions`), sign in as `aisyah` and open **Kopi Lovers Club**; screenshots:
`node docs/features/group-mentions/mock/mention-shots.mjs` (set `PW_CHROMIUM` to a Chromium binary if Playwright's own
is not installed). The composer sends through the real server route, so the fake WhatsApp receives the mentions.

---

# AI hand-off rules fixes (Closing chats per agent): interactive app proposal

A clone of the owner-confirmed **concept-tips** reference (the whole app, `latestConfirmed` revision `360d3be5`) with
the **ai-handoff-rules** proposal on top: each AI agent page gets a **Closing chats** card with one switch, **Ask if the
question is answered**. Off (the sales default) the agent adds no "Does that answer your question?" line and never
closes a chat; on, it asks and closes only on a clear "yes". Scope and checklist: [../design.md](../design.md).

From the repository root, after the normal `npm install` (Node 22 or later):

```powershell
# Seeded demo: admin aisyah, agents daniel and meiling (password demo-pass-123).
npx tsx --conditions=ezychat-source docs/features/group-mentions/mock/run.ts --fake-wa
```

Open `http://localhost:7489/`, sign in as `aisyah`.

## Walkthrough (this proposal)

1. **Admin → Members → AI agent** (Aina, sales): below Connectors, the **Closing chats** card with **Proposed**. The
   switch is off: "Aina adds no check-in line and never closes a chat. Your team closes chats."
2. The dashed **Mock only** box shows the same two customer messages: "Do you sell H100 GPUs? Where are you based?" →
   an answer with a discovery question and no check-in line; "yes we are in Malaysia" → the conversation goes on
   ("The chat stays open.").
3. Switch it on: the hint explains the resolution question, the first answer ends with "Does that answer your
   question?", and "yes we are in Malaysia" still continues ("A "yes" with new facts keeps the chat open").
4. Reload: the switch stays as you left it (kept per agent in this browser).

```powershell
node docs/features/ai-handoff-rules/mock/snapshot.mjs --check
node docs/features/ai-handoff-rules/mock/resolution-shots.mjs   # PW_CHROMIUM=<chrome> when Chrome is not installed
```

Everything below is the inherited concept-tips README; every inherited flow still works.

---
