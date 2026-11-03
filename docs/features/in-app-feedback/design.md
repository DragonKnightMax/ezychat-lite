# Send feedback from the app (Lite and Enterprise)

Status: **confirmed** 2026-11-03 (see Confirmation); built in the same branch. Branch `claude/pensive-mayer-ayw25p` from `main` (`1564247`).

## Owner request (2026-11-03)

- "we want to collect feedback from app directly, from ezychat lite and enterprise they can fill in feedback and share
  their comment, or add attachment to it when encouter issue, the comment and bugs report will send to license portal
  (for now), so license portal will have feedback management that know who submit, their IP, country, what they want,
  suggest the fielt want them to submit"

Owner decisions on the proposal (2026-11-03): "1. mandately, 2. anyone, 3. ok, opt in, 4. license portal notify
general@ezychat.ai", i.e.

1. **Email is mandatory** in the form.
2. **Anyone signed in** to the app may send feedback (not only admins).
3. **Recent log: offered, opt-in** (off by default, redacted by the app).
4. **The licence portal emails general@ezychat.ai** about new feedback.

## What exists today

- Account menu → **Request a feature** (`FeatureRequestAction`): opens `ezychat.ai/feedback` (type, message, optional
  email, version; delivered by Web3Forms). No attachments, no sender identity, no IP/country.
- Account menu, Admin **Help & feedback** and About → **Report an issue**: GitHub issues (needs a GitHub account).
- The licence portal (`anchorsprint/anchor-licence-portal`, Cloudflare Worker + D1) knows Enterprise installs and has no
  feedback. Its side of this feature: `docs/features/feedback/` in that repo (mock and design).

## Baseline

- Cloned from the owner-confirmed **group-mentions** mock (`latestConfirmed`, revision
  `f6f0d2b06f53c95c6b31c5994af00ef52cf5def4`; folder unchanged on `main` `1564247`, last change `2e820c94`), the whole app.
  Its screenshots are not copied (git history keeps them).
- Reused, not changed: `ResponsiveDialog` (dialog on desktop, bottom drawer on phones), `SegmentedControl`, `Banner`,
  the mock edition switch (`?edition=lite|enterprise`), the account menu and the Admin **Help & feedback** panel.
- Retention: new feature folder (6th, creation 28); the oldest folder, `ai-direct-chats` (23, confirmed, last revision
  `4cfbe96d`), is pruned in the same change. Its confirmed mock stays in git history.

### Files changed in the clone

| File                                               | Change                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `feedback.ts` (new)                                | Mock `POST /api/feedback` + Mock only routes (portal scenario, what the portal received)      |
| `proposal.ts`                                      | Registers `feedback.ts`                                                                       |
| `run.ts`                                           | Temp folder and banner name                                                                   |
| `src/components/app/FeedbackDialog.tsx` (new)      | The dialog, `openFeedback()`, `FeedbackHost`                                                  |
| `src/mock/FeedbackMockPanel.tsx` (new)             | Mock only box inside the dialog                                                               |
| `src/main.tsx`                                     | Mounts `FeedbackHost`                                                                         |
| `src/auth/UserMenu.tsx`                            | **Send feedback** replaces Request a feature + Report an issue                                |
| `src/components/app/AppCredits.tsx`                | **Send feedback** in Admin → Help & feedback and in About (GitHub link moves into the dialog) |
| `src/components/app/ErrorBoundary.tsx`             | **Report this problem** on the error panel (type Problem, error message filled in)            |
| `src/i18n/locales/{en,ms,zh-CN}/{app,common}.json` | `feedback.*`, `feedbackMock.*`, `account.sendFeedback`, `errorBoundary.report*`               |
| `feedback-shots.mjs` (new)                         | Screenshots and checks                                                                        |

## Behaviour

| Rule            | Proposal                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry points    | Account menu **Send feedback**; Admin sidebar **Help & feedback → Send feedback**; About; the error panel's **Report this problem** (Problem, error message in Details). Not on the sign-in page (keeps GitHub).                                                                                    |
| Who             | Every signed-in user (admin or agent). One dialog per window; closing it keeps the draft until it is sent.                                                                                                                                                                                          |
| Type            | Required: Problem / Idea / Question / Other. Title and Details placeholders follow the type.                                                                                                                                                                                                        |
| Title, details  | Required: title 3–120 characters, details 10–5,000 (counter).                                                                                                                                                                                                                                       |
| Part of the app | Pre-selected from the screen (inbox, AI agent, WhatsApp link, Connectors, Reports, Settings, Install and updates, Something else); changeable.                                                                                                                                                      |
| Problem only    | How often (Every time / Sometimes / Once) and How bad (Stops my work / Slows me down / Minor), both optional.                                                                                                                                                                                       |
| Attachments     | Up to 3 files, 10 MB each (25 MB together): PNG, JPEG, WebP, PDF, TXT/LOG, MP4; the server reads the real type from the bytes. **Screenshot of this window** in the desktop app (Electron `capturePage`; browsers hide it).                                                                         |
| Contact         | Name (from the user's display name), **Email required** (remembered on this device), Company (Lite optional; Enterprise filled from the licence), "The EzyChat team may email me about this" (on).                                                                                                  |
| App details     | "Include app details" (on): edition, version, Windows/macOS and version, desktop app or browser, standalone or service, language, time zone, current screen, WhatsApp connected, AI connection mode. **See what is sent** lists them. Never messages, customer data, phone numbers, keys or tokens. |
| Log             | "Attach recent activity log" (**off**, owner decision 3): the last 200 lines of the server log, redacted by the server with the support-export redaction plus phone numbers, emails and message text; **See the log** shows exactly that text. ≤ 64 KB.                                             |
| Privacy line    | "Your feedback goes to Anchor Sprint, the maker of {{product}}. We also record your internet address (IP) and country … Nothing is sent until you press Send."                                                                                                                                      |
| Lite only       | "Prefer GitHub? Report an issue there" (GitHub link moved from the menu). Hidden in Enterprise (`useAppLinks().issues` = `null`).                                                                                                                                                                   |
| Sent            | "Thank you!", reference (e.g. FB-0043), "We will reply to {{email}}" (or "you asked us not to email you"); **Send another** / **Done**.                                                                                                                                                             |
| Errors          | Inline field errors + "Fix the marked fields". Portal unreachable / offline: "We could not reach the EzyChat team … your text is kept". 429: "try again in 30 minutes". Nothing is lost; Send retries with the same `clientReportId` (idempotent).                                                  |

## How it is sent

```
browser ──POST /api/feedback (multipart, session + Origin)──▶ local EzyChat server
          ──POST https://license.anchorsprint.app/v1/feedback (multipart)──▶ licence portal (D1 + R2)
                                                                        └─▶ email to general@ezychat.ai
```

- **Server route** `POST /api/feedback` (`requireUser`, 5 an hour and 20 a day per user): validates with a zod schema in
  `packages/shared` (`FeedbackReport`), builds the app details **on the server** (never trusts the browser for them),
  adds the redacted log only when asked, and forwards. The app-wide multipart limit is 1 file, so the route reads parts
  with its own `limits: { files: 3, fileSize: 10 MB }` (found in the mock). 30 s timeout, no retries; maps portal
  answers to `{ reference }`, 400, 413, 415, 429 (`retryAfterSeconds`), 502 `feedback_unreachable`.
- **Portal URL**: Lite uses the constant `https://license.anchorsprint.app/v1/feedback`; `EZYCHAT_FEEDBACK_URL` is read
  only with `--mode dev --fake-wa` (Dev Builds point at a local portal or a fake). Tests never call the portal (fake
  `fetch` in unit tests, a fake portal in e2e).
- **Lite identity**: product `EZC-LITE`, `installRef` = a random id stored in settings on first send (only for the
  portal's rate limits; never linked to anything else and sent only with feedback).
- **Enterprise**: a new optional `ServerExtension.feedbackAuth(ctx)` returns `{ product: 'EZC-ENT', installId, secret }`
  from the licence; the portal links the report to the install and the company. `WebExtension` needs nothing new
  (company prefill comes from `GET /api/feedback/defaults`).
- **"No tracking in Lite"** holds: nothing is sent unless the user presses Send, the dialog lists what is sent, and the
  website privacy policy gets one paragraph (ossmalaysia/ezychat-website) about in-app feedback, IP and country.
- **Security review** (owner rule): no listener changes; a new outbound https call to one fixed host, no redirects
  followed, response size capped. Logs carry type, area, file count, sizes, ms and the reference only: never the text,
  email, name or log content. The redacted-log builder gets unit tests with real log lines.

## Portal contract (summary; full contract in the portal's `docs/features/feedback/design.md`)

`POST /v1/feedback`, multipart: part `report` (JSON: `product`, `clientReportId`, `installRef` | `installId`+`secret`,
`type`, `title`, `details`, `area`, `frequency?`, `impact?`, `name`, `email`, `company?`, `contactOk`, `diagnostics?`,
`log?`) and 0–3 `file` parts. 201 `{ reference }`; 400 `invalid`, 401 `bad_install`, 403 `product_closed`, 413
`too_large`, 415 `file_type`, 429 `rate_limited { retryAfterSeconds }`. The portal records IP (`CF-Connecting-IP`) and
country/region/city (`request.cf`), stores files in R2, and emails the addresses in its Feedback settings (default
general@ezychat.ai) for **every** new report (owner decision 4).

## Work plan (after confirmation)

1. **Portal** (anchor-licence-portal): migration, R2 bucket, `/v1/feedback`, staff `/api/feedback*`, Feedback pages,
   notification, purge cron. Released first so the apps have somewhere to send.
2. **Lite**: shared schema, server route + forwarder + log redaction, dialog and entry points, `feedbackAuth` extension
   point, tests (unit, web-client contract, e2e with a fake portal), CHANGELOG, screenshots.
3. **Enterprise**: implement `feedbackAuth` from `ent-licence`; Dev Build check against a local portal.
4. **Website**: privacy policy paragraph (BM/中文 too); keep the website feedback form for people without the app.

## Screens and states (screenshots in `mock/screenshots/`, desktop 1280 and mobile 360, light and dark)

| #   | State                                                    |
| --- | -------------------------------------------------------- |
| 01  | Account menu with **Send feedback**                      |
| 02  | Empty form (Problem)                                     |
| 03  | Marked mistakes (email required)                         |
| 04  | Problem filled: how often, impact, 2 files, contact      |
| 05  | App details and the log shown                            |
| 06  | Portal unreachable                                       |
| 07  | Too many reports (429)                                   |
| 08  | Sent, with what the portal recorded (Mock only box)      |
| 09  | Idea (no problem-only questions)                         |
| 10  | Enterprise: company from the licence, no GitHub link     |
| 11  | Admin → Help & feedback → Send feedback (desktop)        |
| 12  | Opened from Reports: part of the app = Reports (desktop) |

Not covered by screenshots: the error panel's **Report this problem** (needs a render crash; wired in
`ErrorBoundary.tsx`), file type / size refusals (inline message, see `feedback.files.*`).

## Run the mock

From the repository root after `npm install` (Node 22+):

```bash
npx tsx --conditions=ezychat-source docs/features/in-app-feedback/mock/run.ts --fake-wa
```

Open `http://localhost:7489/`, sign in as `aisyah` / `demo-pass-123`, open the account menu (avatar) → **Send feedback**.
`?edition=enterprise` shows the Enterprise form. Screenshots: `node docs/features/in-app-feedback/mock/feedback-shots.mjs`
(`PW_CHROMIUM=<chromium>` when Playwright's own browser is not installed).

## Open questions for the owner

1. Replace **Request a feature** (website) and **Report an issue** (GitHub) in the menu with the one **Send feedback**
   item (proposed), or keep them beside it?
2. Should Lite users see their past reports and the team's status later ("My feedback")? Proposed: not in v1.

## Confirmation

- 2026-11-03, owner (Jazz Tong), after viewing the screenshots (menu, empty form, filled problem, app details and log,
  sent, phone, Enterprise; portal list, detail, email, settings, phone): "ok build until it work then pr and merge
  verify than archive it after all done". Mock revision `f3eaf7bc`.
- Open questions, taken as proposed in the mock (the owner did not change them): Send feedback replaces Request a
  feature and Report an issue (GitHub link inside the dialog, Lite only); no "My feedback" list in v1.
- Change after confirmation: the area codes follow the portal contract (`ai_agent`, `whatsapp_link`, `install_update`
  instead of the mock's `ai`, `whatsapp`, `install`); labels unchanged.
