# GitHub connector

Status: **go-ahead from the requester 2026-11-10, building** (see "Mock and confirmation").
Created 2026-11-10 (creationOrder 41). Requested by the owner (Frankie, 2026-11-09): a GitHub connector so an AI agent
can answer from GitHub, for the internal team and for customer support. Decisions so far:

- read only in v1, limited to repos the admin allows;
- a **built-in** connector, not a partner MCP entry;
- sign in with a GitHub App through GitHub's device flow;
- the per-agent repo picker in EzyChat;
- "include both sign-in options" (owner 2026-11-10): the GitHub App first, a fine-grained token as the fallback.

The connector list entry is already in `anchorsprint/ezychat-connectors` PR #6. It is `kind: builtin`, `builtinId:
github`, stage beta, and an app without the connector skips it.

## Scope

A core built-in connector, listed in Admin → Connectors under **Other**, built like Google Drive. Its parts:
`connectors/github/`, its own sign-in, per-agent settings, Activity and a row on the agent page.

- **Sign-in, one per install, two ways:**
  - **A. Sign in with GitHub (default).** Anchor Sprint's GitHub App, through GitHub's **device flow**. EzyChat shows
    a code, and the admin enters it at `github.com/login/device`. No callback URL and no client secret are needed.
  - **B. Use a token instead.** The admin pastes a **fine-grained personal access token**, for orgs that block
    third-party apps or admins who prefer it.
- **On GitHub:** which accounts, orgs and repos EzyChat may reach is chosen on GitHub itself. For A, that's the
  App's install screen. For B, it's the token's "Only select repositories".
- **Per AI agent in EzyChat:** the **repositories** it may look in, chosen from what GitHub allows, at most 20.
  Plus two switches, **Issues** and **Pull requests**, both look-ups and on by default once a repo is chosen.
  Nothing else: the connector is use-case agnostic (`docs/connector-design.md`). What to look up and when is in the
  agent's instructions.
- **AI tools** (core names reserved, all read):
  - `github_search_issues`
  - `github_list_issues`
  - `github_read_issue` (reads an issue or a pull request: GitHub's issues API serves both)
  - `github_search_pull_requests`
- **Activity** (who and when) and the chat line "Aina looked up GitHub".

Out of scope for v1:

- creating, commenting on, closing or labelling anything (**create issue is phase 2b**, see Open questions);
- code, files, diffs, commits, review comments, Actions, releases, wikis, Discussions;
- GitHub Enterprise Server and ghe.com;
- webhooks, so nothing is pushed from GitHub.

## Sign-in

### A. GitHub App with the device flow

The App is registered once by Anchor Sprint (owner to do, see "GitHub App registration"). Its client ID ships in
the app and is not a secret. EzyChat stores no client secret and no private key (GitHub requires one key to exist before install; it stays with the owner, see "GitHub App registration").

1. **Connect** → server `POST https://github.com/login/device/code {client_id}`. GitHub answers with `device_code`,
   `user_code`, `verification_uri`, `expires_in` (900 s) and `interval`.
2. The page shows the **code** in big type with **Copy code** and **Open GitHub**, which opens
   `https://github.com/login/device` in the browser. It also shows "Waiting for you on GitHub…" and when the code
   expires. The `device_code` never reaches the web page.
3. The server polls `POST https://github.com/login/oauth/access_token` with `grant_type` set to
   `urn:ietf:params:oauth:grant-type:device_code`, every `interval` seconds:
   - `slow_down` adds 5 s;
   - `access_denied` gives the "you cancelled on GitHub" state;
   - `expired_token` gives "the code expired, try again";
   - Cancel stops polling.
4. **Tokens:** the access token lasts 8 h (`expires_in` 28800). The refresh token lasts 6 months and is
   **single-use** (GitHub Docs, "Refreshing user access tokens", read 2026-11-09). A device-flow token refreshes
   **without the client secret**. The server refreshes when there are less than 5 minutes left or on a 401:
   - it runs one refresh at a time (a mutex), because a second call with the same refresh token would fail;
   - it saves the new pair before it uses the new access token.

   If the refresh is refused, the state becomes **Sign in again**.

5. **Installed?** `GET /user/installations`:
   - **No installation** gives the **Install EzyChat on GitHub** state, with a button to
     `https://github.com/apps/<slug>/installations/new` and **Check again**.
   - Otherwise the repos come from `GET /user/installations/{id}/repositories` for each installation.
   - The token reaches only repos that **both** the App's installation and the signed-in user can read.
6. Installing on an **organisation** needs an org owner, or a member's request that an owner approves. That
   happens on GitHub, and EzyChat only explains it.

### B. Fine-grained personal access token

1. **Use a token instead** opens a form with four steps and a link to
   `https://github.com/settings/personal-access-tokens/new`:
   - pick the resource owner (account or org) and "Only select repositories";
   - Repository permissions: **Issues: Read-only** and **Pull requests: Read-only** (GitHub adds Metadata);
   - set an expiry;
   - generate and copy.
2. Checked on Save, failing closed:
   - a token that does not start with `github_pat_` is refused, with "Use a fine-grained token". Classic `ghp_`
     tokens can reach every repo the user has, so they are never accepted;
   - `GET /user` must answer 200;
   - the accessible repos must not be empty ("This token can't see any repositories");
   - the expiry is read from GitHub's `github-authentication-token-expiration` response header when present.
3. There is no refresh. Within **7 days of expiry** the page warns. Once expired, the state is **Token expired**,
   and the AI hands over until a new token is pasted.
4. **Write permissions:** EzyChat calls only GET endpoints, so a token with write permissions is still used read
   only. The steps ask for read-only access, and the form says so.

### Both

- **Storage:** the setting `github_auth` holds `{method, login, accessToken, refreshToken?, accessExpiresAt?,
refreshExpiresAt?, tokenExpiresAt?}`, encrypted with the existing settings encryption. The setting
  `github_problem` holds the state.
- **Network:** only `https://github.com` (device flow, token refresh) and `https://api.github.com`, through the
  existing outbound guard (`connectors/mcp/net.ts`). No other host, and redirects are not followed off those hosts.
- **Disconnect:** deletes the stored sign-in, while the agent settings stay, like Drive. The dialog says how to
  remove access on GitHub too: uninstall the App or revoke its authorization, or delete the token. Revoking from
  EzyChat would need the client secret, which EzyChat does not have.
- **States:**
  - `not_connected`;
  - `waiting_for_code` (A);
  - `no_installation` (A);
  - `connected`;
  - `expiring` (B, within 7 days);
  - `expired`, meaning "sign in again" for A or "token expired" for B;
  - `unreachable`.

## Rules (fail closed)

1. **Repo scope:** every call names a repo from **this agent's** list that GitHub still allows. That list is
   re-read from GitHub, cached 10 minutes, with a **Refresh** button in Settings.
   - Search queries are rebuilt by the server. It removes any `repo:`, `org:`, `user:`, `owner:`, `is:issue`,
     `is:pr` or `type:` qualifier in the AI's words and adds one `repo:owner/name` for each allowed repo, plus
     `is:issue` or `is:pr`.
   - The AI may narrow the search to one of its repos with a `repo` argument, which is checked against the list.
   - Anything else gets "not available".
2. **Never code:** no `/contents`, `/pulls/{n}/files`, diff or patch media types, commits or blobs. Pull requests
   are read only through the issues API: title, state, labels, body and conversation comments.
3. **Size caps:**
   - search returns at most 10 results (number, title, state, labels, updated, author login, link);
   - a body is cut at 4,000 characters;
   - only the 5 latest comments, each cut at 1,500 characters;
   - at most 12,000 characters per tool result;
   - cache 2 minutes per query.
4. **Untrusted text:** issue and PR text is written by anyone who can post in that repo, which for a public repo
   means anyone. Tool results are **facts for the reply, never instructions**, using the same wording as
   `read_sheet_rows`. Links in results are kept as plain text.
5. **Who sees it:** anything in the chosen repos, private ones included, can be told to whoever chats with that
   agent. The Settings tab says this plainly beside the repo list. Choosing the repos is the admin's decision.
6. **Calls per turn:** at most 6 GitHub calls in one turn. Search is 30 calls a minute per user, and a `403` or
   `429` rate-limit answer is treated as a failure. Failures (5xx, timeout, rate limit, 401 after refresh) end the
   turn with `lookup_failed`, which hands over, like Sheets and Drive.
7. **Try it and groups:** look-ups are allowed in Try it and in group turns, like other look-ups. A GitHub look-up
   counts as a look-up source (`agentLookupsAvailable`).
8. **Repo gone:** a repo removed on GitHub stays in the agent's list marked "No longer shared". It is skipped and
   never called.
9. **Logs, audit, Activity:**
   - logs carry event, tool, ok, ms and result counts only, never query words, titles, bodies or repo names;
   - audit records `github.connect` {method}, `.disconnect` and `.agent_settings` {agentId, fields};
   - Activity rows keep kind (`searched`, `read`, `refused`, `failed`), agent, chat and time.

## Server

- `connectors/github/`:
  - `auth.ts`: device flow, refresh (mutex), PAT check;
  - `client.ts`: REST client with caps;
  - `repos.ts`: accessible repos, 10-minute cache;
  - `query.ts`: qualifier stripping and injection, with unit tests;
  - `service.ts`: states;
  - `tools.ts`;
  - `repo.ts`: SQL only;
  - `fake.ts`: `FakeGitHub` for `--fake-wa` / e2e at `/api/dev/fake-github*`.
- Migration **036**: `github_agent_settings` (agent_id PK, settings JSON) and `github_activity`. `chats/merge.ts`
  moves activity rows.
- Routes `/api/connectors/github/*` (admins only):
  - `GET status`;
  - `POST device` (start) and `GET device/:id` (poll state; never the device code);
  - `POST token`;
  - `POST check` (check installations again);
  - `POST disconnect`;
  - `GET repos?refresh=1`;
  - `GET/PUT agents/:agentId`;
  - `GET activity`.
- Shared contract in `packages/shared/src/github.ts`.
- Lite import: `github_agent_settings` in the merge tables. `github_auth` is **not** imported, so the admin signs
  in again.

## Web

- `admin/connectors/GitHubPage.tsx`, with tabs Overview / Settings / Activity, `?tab=` and `&agent=`. It reuses:
  - the account-card layout and `ConfirmDialog` of the Google pages;
  - `AgentSettings`, the SaveBar and the paused banner of `SheetsSettingsCard.tsx` / `GoogleDrivePage`;
  - the picker list of the Drive file picker.
- Gallery card from the `builtin` entry, category **Other**.
- `AgentConnectorsCard.tsx` row.
- Catalog `connectors.github.*` in en / ms / zh-CN.
- InfoTips `githubApp` ("Why install an app?") and `githubToken` ("Which token?").
- Every screen works at 360 px.

## Screens and states (checklist, all in the mock)

- **Gallery:** GitHub card (Not connected / Connected / Needs attention) under Other.
- **Overview:**
  - About: Search issues, List issues, Read an issue or pull request, Search pull requests, all look-ups.
  - Account card:
    - not connected, with **Sign in with GitHub** and **Use a token instead**;
    - device code dialog (code, Copy, Open GitHub, waiting, expires; cancelled on GitHub; code expired);
    - no installation (Install on GitHub, Check again);
    - connected with the App (login, how many repos are shared, Change repositories on GitHub);
    - token form (steps; refused as classic; not accepted; no repos);
    - connected with a token (expires on, warning within 7 days);
    - sign in again or token expired;
    - unreachable;
    - Disconnect confirm.
  - Your data.
- **Settings:**
  - not connected;
  - agent picker for 2+ agents (inherited);
  - repositories: none chosen; Choose repositories dialog (search, grouped by owner, private/public, at most 20,
    "Don't see a repository?" link to GitHub, Refresh);
  - chosen list with remove;
  - a repo no longer shared;
  - Issues and Pull requests switches;
  - the "who sees it" notice;
  - one line linking to the agent's instructions;
  - Save bar;
  - paused banner.
- **Activity:** empty, searched, read, refused (repo not chosen), failed.
- **Agent page → Connectors:**
  - "No repositories chosen";
  - "Issues and pull requests in N repositories";
  - "Issues in N repositories";
  - "Pull requests in N repositories";
  - Off.
- **Mock-only simulator:**
  - a question about an issue, answered;
  - a pull request status;
  - a repo not chosen, refused;
  - an issue whose text tries to give the AI orders, treated as data;
  - paused, handed over.

## GitHub App registration (owner to do, once)

anchorsprint org → Settings → Developer settings → GitHub Apps → **New GitHub App**. This needs an org owner or an
app manager, and nothing is reviewed by GitHub (GitHub Docs, "Registering a GitHub App").

| Field                                          | Value                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| Name                                           | **EzyChat by Anchor Sprint** (Q1)                                           |
| Homepage URL                                   | `https://ezychat.ai`                                                        |
| Callback URL                                   | empty (device flow)                                                         |
| Expire user authorization tokens               | on                                                                          |
| Request user authorization during installation | off                                                                         |
| Enable Device Flow                             | **on**                                                                      |
| Webhook → Active                               | **off**                                                                     |
| Repository permissions                         | Issues: Read-only, Pull requests: Read-only (Metadata: Read-only automatic) |
| Account / organization permissions             | none                                                                        |
| Where can it be installed                      | **Any account**                                                             |

**Registered 2026-11-10** by the owner's account in the anchorsprint org. The settings above were read back from
the saved App: Device Flow on, webhook off, and only `issues=read`, `metadata=read`, `pull_requests=read`.

| Item      | Value                                                                |
| --------- | -------------------------------------------------------------------- |
| App ID    | `5687515`                                                            |
| Client ID | `Iv23lifY4jMBIsreENXj` (public, ships in the app)                    |
| Slug      | `ezychat-by-anchor-sprint`                                           |
| Install   | `https://github.com/apps/ezychat-by-anchor-sprint/installations/new` |

**Private key, correction.** GitHub answered "You must generate a private key in order to install your GitHub App".
So one key must **exist** before anyone can install it. EzyChat never uses or ships it, because the device flow and
the user tokens need only the Client ID.

The owner generates it once (App → Credentials → Key pairs → New key) and stores the downloaded `.pem` in the company
password manager. It is never committed, never put in the app, and never sent to anyone. A client secret is still
not generated.

## Reused from the app

| Part                                          | Source                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| Encrypted settings, state and problem keys    | `connectors/google-account.ts` (pattern), `settings` encryption |
| Outbound host guard                           | `connectors/mcp/net.ts`                                         |
| Tool wrapper, `ai:tool_call`, `lookup_failed` | `connectors/google-sheets/tools.ts`, `ai/agent/turn-tools.ts`   |
| Untrusted-result wording                      | `read_sheet_rows` result notes                                  |
| Per-agent settings JSON + audit               | `connectors/google-drive/repo.ts`, `service.ts`                 |
| Pages, cards, SaveBar, picker list, Activity  | `admin/connectors/*` (Drive, Sheets)                            |

## Owner decisions (my calls, easy to change)

1. Two sign-ins: App with the device flow by default, fine-grained token as the fallback. Classic tokens are
   refused.
2. Read only in v1. Issues and Pull requests are both on once a repo is chosen.
3. At most 20 repos per agent; 10 search results; 5 latest comments; the character caps in Rules 3.
4. Allowed in groups and Try it (look-ups).
5. Beta in the connector list while it is new (PR #6 already sets `stage: beta`).
6. No import of the sign-in between installs.

## Open questions for the owner

- **Q1 App name. Decided (owner, 2026-11-10): "EzyChat by Anchor Sprint"** (24 characters). The expected slug is
  `ezychat-by-anchor-sprint`, which the mock already uses. Whether the name is free on GitHub is only known when the
  App is created; if it is taken, the owner picks another and the slug changes with it.
- **Q2 Create issue. Decided (owner, 2026-11-10): "no create issues first".**
  - v1 is read only. The App is registered with **Issues: Read-only** and **Pull requests: Read-only**.
  - Create issue stays phase 2b: `github_create_issue`, which only creates, asks the customer to confirm first,
    and is limited to 1 per chat and 20 a day.
  - Accepted cost: when 2b adds **Issues: Read and write** to the App, every install must approve the change on
    GitHub. Until an admin approves, the token stays read only and the create tool is not offered. Token sign-ins
    need a new token with the write permission.
- **Q3 Enterprise. Decided (owner, 2026-11-10): "release on ezychat-lite first".**
  - Lite only for the first release; Enterprise follows later as its own decision.
  - The code stays in core (like Drive and SQL Account), but the gallery card, the Settings and the AI tools are
    offered only in the Lite edition until then. The server checks the edition and does not register the tools.
  - PR #6's entry keeps `editions: [lite]`. When Enterprise ships it, change the entry to `[lite, enterprise]`
    and remove the edition check.
- **Q4 Spike, run 2026-11-10** with the real App, the owner's account and an install on anchorsprint ("Only select
  repositories", 3 private repos). The script lived in a temporary folder and is not part of the app.

  | Check                                        | Result                                                                                                                                                                                                                                                                                                |
  | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Device flow with the Client ID only          | **Works.** Token `bearer`, `expires_in` 28800 (8 h), refresh token given (`refresh_token_expires_in` 15638400, about 6 months).                                                                                                                                                                       |
  | Installed repos                              | `GET /user/installations` gives 1 installation with permissions `issues`, `metadata` and `pull_requests` all `read`. `GET /user/installations/{id}/repositories` lists exactly the 3 chosen repos.                                                                                                    |
  | `GET /search/issues` with `repo:` qualifiers | **Works** for `is:issue` and `is:pr`, and every result is in an allowed repo. Search rate limit is 30 a minute (`x-ratelimit-remaining` 29 → 28).                                                                                                                                                     |
  | **Public repo outside the install**          | **Reachable.** `GET /repos/cli/cli/issues` gives 200, and a `repo:cli/cli` search answers. A user token reads any public repo, so **Rule 1 (the server builds every query and checks every repo against the agent's list) is the only thing that keeps the AI to its repos**. It must be unit-tested. |
  | Code                                         | `GET /repos/{repo}/contents/` gives **403** (no Contents permission), as intended.                                                                                                                                                                                                                    |
  | Refresh without the client secret            | **Works.** It returns a new 8 h token and a new refresh token.                                                                                                                                                                                                                                        |
  | Old access token after a refresh             | **401 at once.** Calls in flight with the old token fail, so the client retries a 401 once with the newest token, and the refresh mutex (Sign-in A.4) prevents a second refresh.                                                                                                                      |
  | Reusing the old refresh token                | Refused (`incorrect_client_credentials`), so it is **single-use**. Save the new pair before using it.                                                                                                                                                                                                 |
  | `GET /user/repos` with a fine-grained token  | **Not checked yet**: it needs a token the owner makes. Checked when the token path (B) is built, against the fake first, then once with a real token.                                                                                                                                                 |

## Mock and confirmation

Mock: `docs/features/github/mock/`, run from the README at the top of `mock/README.md`. It is a clone of the latest
confirmed mock in the index, **forward-message** (confirmed 2026-11-07, revision `2549b7af`), copied from `main`
`12a5df01`. That mock already holds Google Drive and SQL Account.

The first draft of this mock (2026-11-10, on the older google-drive baseline) was rebuilt on forward-message before
the PR. The GitHub files and edits were replayed unchanged. Intentional changes are listed in `mock/reference.json`
→ `proposalChanges`. Screenshots are in `mock/screenshots/` (`github-shots.mjs`).

Retention: with this folder the index tracks five feature folders (new-chat 37, forward-message 38, mobile-redesign
39, mcp-file-upload 40, github 41), so nothing is pruned. `template-store` and `cloud-auth-storage` are not in the index,
and template-store holds the template publisher the app uses.

Confirmation:

- **Requester (Frankie), 2026-11-10:** after the screenshots, the four decisions (Q1–Q3 and the Lite-first
  release) and the spike, he wrote "Open PR and build".
- **Repository owner (Jazz):** not yet asked. `latestConfirmed` in the mock index stays on forward-message until he
  confirms.
