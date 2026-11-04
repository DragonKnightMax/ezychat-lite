# Claims agent template

Status: **proposal** (mock recorded for review). The owner asked for the feature on 2026-11-04 and said to go ahead
with implementation; built on branch `feat/claims-agent-template` from `main` (`c589b88`, 0.1.73). Created
2026-11-04 (creationOrder 30).

## Owner request (2026-11-04)

"create new template which is claim agent, so when people choose this will auto fill in and precreate the basic
knowledge and rules for agent".

## What it is

One more card in the business-template gallery of the AI agent page (Admin → Members → AI agent → **Start from a
business template** → **Browse templates**). It builds on the group-agents feature (0.1.73: several agents per
number, group agent with **Reads every message**, Google Sheets tabs Off / Read / **Add rows**).

| Item                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gallery card          | id `claims`, name "Claims agent", icon ReceiptText, new category **Team and operations** (`operations`; none of Health, Food, Services, Shops or Education fits an internal claims desk). Its type line reads "Custom · For WhatsApp groups".                                                                                                                                                                                                                                                                                                                                   |
| Type                  | Preset **Custom**, not a new `claims` preset. A new preset would change the shared `AiAgentPreset` contract, the server prompt role (`PRESET_ROLES`), the edit prompt, the Enterprise contract and the stored `ai_agents.preset` values, for no behaviour Custom lacks: Custom's role is "your purpose is what the administrator instructions say", and its starting text is blank, so the instructions are the claims text **only** (no sales or FAQ text in front).                                                                                                           |
| Instructions          | Claim format (policy or member number, date, what happened, amount; other details from "Claim rules"); save as a new row in the tab **Claims** (no tool names: the tools describe themselves); fill columns only from the member's message or the receipt/invoice/PDF they sent; reply "Recorded ✅" repeating number, date and amount; ask only for a missing detail and save after the reply; read photos and PDFs; a correction is a new row that replaces the earlier one; stay quiet on non-claim messages; never approve, reject, promise payment or say what is covered. |
| Hand-off rules        | Approval or payment status; disputes or cancelling a claim; a file still unreadable after one retry, looking edited or not matching; sensitive personal information the claim does not need (medical reports, IC numbers, bank details); above the limit or after the deadline in Claim rules; upset member or complaint.                                                                                                                                                                                                                                                       |
| Business context item | "Claim rules", blank fill-in lines (LEARNINGS: a blank line is no fact, so the AI hands over): claim types, details every claim needs, documents to attach, limit per claim, submission deadline, who approves, when approved claims are paid, where to send originals, default language.                                                                                                                                                                                                                                                                                       |
| Group agent defaults  | A **new** agent created from the template gets **Answer in groups** on, then **Answer direct chats** off, right after Create (it holds no chats, so nothing is released). An **existing** agent (Lite's only agent) is never switched automatically: turning direct chats off would hand its open chats back to the team, so the card shows what to switch. A failed switch keeps the saved agent and says what to set by hand.                                                                                                                                                 |
| Next steps            | The template card's note: connect Google Sheets with a tab named Claims set to **Add rows**, then turn on **Reads every message** in each claims group (Group info). After Create a toast repeats the next step.                                                                                                                                                                                                                                                                                                                                                                |
| Languages             | en, ms, zh-CN. The sheet tab name stays **Claims** in every language (it must match the spreadsheet).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Other templates are unchanged (`businessTemplate` still prefixes the type's starting text when there is one).

## Mock and confirmation

- Source baseline: the cumulative `latestConfirmed` mock (`in-app-feedback`, revision `f3eaf7bc`) predates the
  business-template gallery, so, like group-agents, this feature has a **standalone preview** of the changed screens:
  `docs/features/claims-template/mock/index.html` (open the file in a browser; the dashed Mock only bar switches
  screens, language and theme). `build-preview.mjs` rebuilds it from the real catalogs
  (`apps/web/src/i18n/locales/*/admin.json`), so the preview shows exactly the texts the app applies.
- Reused screens and components: `BusinessTemplateCard` (gallery, category chips, cards), the agent page editor
  (`AiMemberPage`: name, Starting point, Role, Hand-over rules), `AgentDirectCard`, `AgentGroupsCard`, `Banner`.
- Screens and states (each desktop 1280 / mobile 360, light and dark): 1 gallery with Team and operations; 2 new agent
  after Apply (Claim rules note, group-agent note); 3 after Create agent (toast, Claim rules item, Direct chats off,
  Groups on); 4 existing Lite agent after Apply (finish-steps note); ms and zh-CN of screen 2. Screenshots in
  `mock/screenshots/`.
- Confirmation: **not yet recorded**. The owner asked for the feature and to go ahead; the preview and the real-app
  screenshots are in the PR for review.
- Owed: the cumulative full-app clone (it must first catch up with the template gallery and the group-agents screens).

## Checks

- Unit: catalog parity and length limits in all three languages, Claims contents (Custom, own text only, Claims tab,
  hand-off rules, Claim rules lines), no tool names in any template, every category used, gallery card and notes,
  agent page create / existing / failed switch / replaced by another template.
- Dev Build with real AI, WhatsApp and Google Sheets (claim posted in a group → row in Claims, reply "Recorded ✅",
  missing detail asked, chit-chat ignored): the owner's check.
