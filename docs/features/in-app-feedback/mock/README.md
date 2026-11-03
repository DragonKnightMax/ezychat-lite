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
