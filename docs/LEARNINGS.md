# Learnings

Rules learned from building and running EzyChat Lite, so agents (and humans) don't repeat mistakes.
This file is a compact summary; the dated incident history lives in git (`git log -p docs/LEARNINGS.md`).

**Adding a lesson:** add one short rule bullet to the matching section (`rule — why`), or sharpen an
existing bullet instead of adding a near-duplicate. A Stop hook (`.claude/hooks/learnings-gate.mjs`)
blocks a code-changing session until this file changes. Promote anything that changes _how_ agents work
into AGENTS.md.

## Working method

- SonarCloud fails the security rating on a literal bidi control character in source (S6389: write `\u202e`, not the
  character; an editor or the agent's file-writing tool may turn the escape into the character, so scan new test
  files for U+200E/F, U+202A–202E, U+2066–2069, U+FEFF before pushing) and on a JSON key containing "password" (S2068,
  even a translation key, or a demo user's `password:` literal in an `e2e/*.mjs` script). Name such keys after what they
  mean (`unlockCodeInMessage`); a capture script creates extra users with `randomBytes` secrets or `DEMO_ADMIN`.
- In a Playwright Test spec, `browser.newContext()` inherits the project's `storageState`: a second person's context
  starts signed in as the saved admin, so `/login` redirects and the sign-in waits until the test times out. Pass
  `storageState: { cookies: [], origins: [] }` for a fresh sign-in.
- A user created or reset over the API answers 403 `Password change required` on every call until
  `POST /api/auth/change-password`: a role check (agent refused a locked file) then "passes" for the wrong reason.
  Assert the error code (`safety_locked`, …) and a positive control (a clean file the agent may download), never the status alone.
- Never name a module constant after a global (`URL`, `Map`, `Set`, `Buffer`): `const URL = /…/` made every
  `new URL()` in that file throw, the `try` swallowed it, and link checks silently answered "safe". A rule that
  fails closed to "nothing found" needs a test with a positive case.
- A scoring rubric gives "not needed" items their full points only where the item guards a risk the change
  cannot have (no screen → no screen review); a bonus that only one tier can earn (the real-part test for
  critical) scores 0 elsewhere, or every small change jumps to 100. Pin the worked examples in tests.
- A UI rubric scored by Jev from a reviewer's evidence keeps any dimension with one medium problem near 3,
  whatever level the reviewer suggests, and each fresh reviewer finds new medium problems, so a Jev average gate
  stalls near 3.6. Fix every medium problem each round, but gate on the review itself (no high problem, every
  reviewer level ≥ 4) with a cap of a few rounds; leftover problems go to the feature's design.md follow-ups.
- Ask for a mock confirmation with the key screenshots in front of the owner (send the image files, one per
  screen and state), not only a folder path: the owner confirms what they saw, and record the confirmation
  in `design.md` only after that reply.

- A bug report with a screenshot of the live app shows real customers: rebuild the case with demo names,
  companies and numbers in tests, docs and commits; grep the branch for the real values before pushing.

- A UI/UX finding comes from the screen, never from the API: Try it returned `business_rule` over HTTP,
  but the page already showed "matches your hand-off rules", so a reported "raw codes" problem was wrong.
  Look at (or read) the rendered page before putting a screen problem in a review.
- An edition feature built in the core still runs in Lite: report "no visible change" apart from "same
  code path", and for a new core migration check before merge that the previous release still opens the
  migrated data dir (downgrade), or say it is untested.
- Dev Build check scripts (`e2e/devbuild-*.mjs`) assume a fresh data dir: run each once per new temp
  folder; a second run on the same data reports false FAILs (duplicate rows, existing chats).
- When the owner confirms a mock but leaves its open questions unanswered, do not block: write the default
  for each in `design.md` as "my call", build to it, and keep each easy to change; list them in the report.
- Console output meant for the owner (and pasted into chat) fits ~80 columns: wider tables wrap and
  become unreadable; put long names on their own lines and keep one short line per item. Lead with
  the decision (ready / needs you) but never hide the evidence: show every checkpoint, even when green.
- Before the owner hand-tests on `D:\dev\test-env\lite`, check that it runs (port 7491, started after the
  branch build) and read the feature's state in its data: that data is an updated install, so a feature
  that starts off after an update is hidden there until an admin turns it on. Its admin is `jazz`; the
  password is only the owner's (reset needs the CLI `--reset-admin` with the server stopped).
  `start.ps1` builds whatever the primary checkout has checked out, often another session's branch: for a
  given commit, detach a spare clean worktree at it (`npm ci` when the lockfile moved) and start a copy of
  the script pointed there. When the branch adds a migration, copy `data/` to a backup folder first: the
  permanent data then has a schema that `main` does not know.
- A project skill (`.claude/skills/<name>/`) is a slash command only in checkouts that contain it:
  on a feature branch it is not live in the owner's main checkout until merged — say so.
- Progress the owner asks about comes from committed records (the feature workbook, the Dev Build
  log), never from an agent's memory of the session: record each stage when it finishes, mark
  stages that do not apply as `skip` with the reason (MCP-only: no design, screen review or UI e2e),
  and show `build-summary.mjs <PR>` in every "done / ready to merge" report, not prose. Stage keys are
  `design|dev|unit|e2e|devbuild|screen`. A plan ledger under `.superpowers/` is git-ignored and deleted
  at the end: copy its rulings and deferred findings into the workbook first.
- Run the Dev Build check yourself, unasked, before calling a feature working: green unit/e2e tests
  with a test client missed whether a real client works end to end (MCP access was nearly reported
  done without Claude Code ever connecting). Check scripts confirm the effect (audit row, empty
  list, a 401), never "nothing left to click": a list counted before it loads reads as success.
  Time-based features (peaks, waits, trends) need Dev Build data spread over days with a planted
  pattern; the demo data is seeded within minutes, so it cannot show the feature working.
- A new test must be seen failing for the right reason: timing thresholds pass on a fast machine
  (test the observable fallback instead), and vitest does not type-check, so a not-yet-exported
  constant yields `undefined`/`NaN` and a vacuous pass — assert the inputs are what you meant.
- Before designing a change, grep `AGENTS.md` for the subsystem's terms (e.g. "profile", "prompt"):
  recent features leave placement rules in the architecture paragraphs, not only in Working rules.
- Before production UI work, commit a complete interactive HTML mock in `docs/features/<feature>/mock/`
  and a screen/state checklist plus owner confirmation in `design.md`; include Settings and entry
  points, not only the final screen. Verify 1280/360 px with worst-case demo data and use the confirmed
  mock as the implementation reference. Inspect related existing features and record their source
  screens/components and reused behaviours in `design.md`; copy actual labels from `i18n/locales/en`
  so the mock stays grounded in the app. Images and ignored scratch files alone are not a durable reference.
- Feature mocks evolve cumulatively: clone the latest owner-confirmed interactive app mock from
  `docs/features/mock-index.json`, preserve existing flows, record the source revision, and advance
  the baseline only after the owner confirms the complete enhancement; an unconfirmed demo is not
  a baseline for the next feature. Fetch and re-read `latestConfirmed` and the folder list on
  `origin/main` before committing a mock: a PR that merged meanwhile can move the baseline and the
  retention target. Rebase by patching your file deltas onto a fresh copy of the new baseline.
  Rebase onto `origin/main` before you write a confirmation's `gitRevision`: a rebase rewrites the
  hash of the mock commit, and the recorded revision must exist on the pushed branch. A branch stacked on
  an open PR rewrites it again when the base merges: update the revision after that last rebase.
  A `gitRevision` in the index is often a branch commit that the squash merge left out of `main`'s history:
  `git fetch origin <sha>` before `git archive <sha> docs/features/<feature>/mock`.
- Mock dialogs fade in: wait about 400 ms after a dialog or sheet appears before its screenshot, or the capture shows
  a faint, half-transparent card that reads like a z-index bug.
- Copy is for a business owner (owner rule, design-system "Writing"): few plain words, the reason and the next action;
  technical terms (AI connection, Business API, auto-block, where files are kept) go behind an `InfoTip`.
- Format only the mock files you changed (`npx prettier --write <paths>`), never a mock's whole `src/`: the
  cloned baseline is frozen by hash (`snapshot.mjs --check`) and Prettier rewrites inherited shadcn files. If it
  happens, restore every file outside your delta list with `git checkout -- <file>` and run the check again.
- Mock seeds that show AI replies: the seeded AI member is off, so the AI service cancels its queued replies
  ("AI reply cancelled"); set the chat's `assigned_to` in the database (an assignment event triggers the same
  cancel) and mark the seeded replies sent. In the cloud container run shot scripts with
  `PW_CHROMIUM` set to the browser binary (`/opt/pw-browsers/chromium-<rev>/chrome-linux64/chrome`; the
  `/opt/pw-browsers/chromium` folder alone fails to launch; no Edge there).
- Mock shot scripts: wait for a locator, never `waitForLoadState('networkidle')` (the Socket.IO connection keeps
  the page busy, so every step burns the 30 s timeout). The setup wizard's step lives in React state: creating the
  first admin through `/api/setup/admin` drops the page straight into the inbox, so walk the account step in the UI
  once per fresh server and vary viewport and colour scheme on that one page.
- Run tests on the Node version CI uses (`setup-node` 22 = the newest 22.x; 22.23.4 on 2026-10-30). On Node 22.22.0
  a worker's `execArgv: ['--import', 'tsx']` does not apply tsx's hooks, so the document parser worker
  (`ai/knowledge-worker.ts`) answers "Cannot read this document": 4 server tests and the `ai-member.spec` file upload
  fail while CI is green. Check `node -v` before calling such a failure the branch's or the machine's. `npm run e2e`
  in the cloud container also needs the Playwright build it expects: link `/opt/pw-browsers/chromium-<wanted>` (and
  `chromium_headless_shell-<wanted>`) to the installed one. To stop a mock runner, find its PID in
  `/proc/*/cmdline`; `pkill -f <its path>` also matches the shell running the command and kills it.
- Bootstrap replicas from actual frontend source and check frozen hashes; allowlist enhancement
  deltas so redesigned existing screens cannot silently become the next reference. Normalize text
  hashes to LF so Git checkout line endings do not look like UI drift.
- Keep only the five newest feature mock folders in the working tree; prune older clean, committed
  folders in the next feature change and retain exact revision/path references so confirmed
  baselines can be recovered from git history without inventing approval.
- Debug from evidence: read the server log (whole files, merged across rotations and sorted by time) and
  the DB before proposing a cause; if the failure isn't logged, add structured logging first, reproduce,
  then read it. Browser errors reach the log through `/api/client-errors` and route `ErrorBoundary`s.
- When a screen breaks only in the app window, suspect the PWA service-worker cache first (F12,
  Ctrl+Shift+R). The same applies to a mock the owner opens on a reused `localhost` port: an older app's
  `sw.js` keeps serving its build (`/assets/index-*.js` instead of Vite's modules), so the new feature is
  missing. Check `navigator.serviceWorker.controller` in their browser before doubting the mock.
- Before building UI for existing data, check the live data for why the current UI is empty; prefer making
  the data appear over adding UI.
- Re-fetch `main` and re-verify paths and conventions right before planning or executing a plan; plans in
  this repo go stale within hours. A cloud checkout's `origin/main` ref can be days behind its own detached
  HEAD: `git fetch origin main` before `git checkout -b … origin/main`, or the branch starts on an old release.
- Reshape existing data once at startup, before any service runs; runtime code only routes and resolves.
- Evals and tests must assert the business outcome (chat handed to the team, order not lost), not only the
  agent's words.
- When fixing await-in-loop findings, preserve dependent scenario order with explicit awaited calls
  and keep polling deadline-bounded; parallel execution can invalidate assignment checks.
- Mocks cannot prove provider-side behaviour (prompt caching, headers): confirm with one live call on a
  Dev Build (never customer data), then pin the stable value in a unit test.
- A feature that reacts to inbound media must ship with a way to simulate that media on `--fake-wa`
  (`/api/dev/fake-incoming` `media`), or the owner cannot test it end to end on a Dev Build.
- Record protocol facts from the package that really implements them, with the source file; never copy
  tokens from local caches.
- A fake of an outside service must model the effects of our own writes (Google free/busy counts the events
  we add): a fake that ignored them hid a retry bug the unit tests passed; the Dev Build check found it.
- Two feature branches that clone the same mock baseline both prune the oldest folder and collide on merge: keep
  both feature folders, renumber the later one, archive the next oldest, and note in `latestConfirmed` which
  parallel feature's screens the next clone must add.
- A "real" Dev Build check of a signed remote list (connectors, templates) with `--fake-wa`: the server downloads
  nothing unless the `*_LIST_URL` env is set, so set it to the production URL (assert it equals the built-in constant)
  and no test key. Compare the published `minAppVersion` with the branch version first: entries for the next release
  are hidden on the current one, so check both (the build as is, and `WATI_VERSION=<release>`).

## Multi-agent process

- `build-summary.mjs record` takes the short stage keys (`design dev unit e2e devbuild screen`), and release-review
  counts a stage only when the code diff at its `--sha` equals the head's: re-record with `--sha <head>` after a
  docs-only commit, or the stages show as `✗ missing`. The same holds for the commit cited in a
  `docs/dev-build-checks.md` row: cite the commit that already contains a new check script, not the one before it.
- Never rebase, stash or switch branches in a checkout where subagents are still writing files: commit each finished
  agent's files first, and rebase onto a newly merged base only after the last agent has handed back.
- AGENTS.md is the single source of truth (CLAUDE.md imports it); edit rules there.
- Child cloud sessions refuse a merge or CI-gate change that another session relays to them, even when it quotes
  the owner. Brief children to stop at a green PR and report to `@parent`; the main session, which holds the
  owner's own words, merges (or pushes the gate change) and then archives the child.
- Before merging a PR, wait for every check on its current head, SonarCloud included: CI jobs finish before
  SonarCloud reports, and a merge on green jobs alone shipped a quality-gate failure that needed a follow-up PR. Re-read
  the head SHA right before the merge (pass it as `expectedHeadSha`), because a child session may still be pushing.
- Cloud sessions cannot push git tags (the git proxy answers 403 on tag refs) or run `gh release edit`. Release
  from the cloud with **Release (approved)** (`release-approve.yml`, `docs/release.md` §4): after the release PR
  merges and the owner says "release", dispatch it with `version` and `confirm`; it tags, builds and publishes.
- A tag (or any push) made with `GITHUB_TOKEN` starts no `on: push` workflow; only `workflow_dispatch` and
  `repository_dispatch` are allowed from it. A workflow that tags must start the tag's workflows itself
  (`gh workflow run <file> --ref v<version> -f ref=v<version>`, `actions: write`). Workflow inputs reach shells only
  through `env:` after a strict format check (`^[0-9]+\.[0-9]+\.[0-9]+$`), never as `${{ inputs.* }}` in `run:`.
- A job's `environment:` that does not exist yet is created **unprotected** on its first run: never present an
  environment as an approval gate unless its required reviewers are set; put the real gate in the workflow (dispatch
  on `main`, a `confirm` input, strict checks). Agents start `release-approve.yml` only when the owner says "release".
- `/security-review` in a fresh cloud clone fails on `origin/HEAD...`: run `git remote set-head origin main` first.
- Any edit to a workflow makes SonarCloud re-flag its old workflow-level write permissions (S8233, Security C fails
  the gate): when touching a workflow, set `permissions: {}` at the top and give each job only what it needs.
- An edition's AI-agent limit defaults to its `maxInboxes` (`ai/service.ts`: `config.maxAgents ?? maxInboxes`), so
  Enterprise (10 numbers) has had 10 agents since core 0.1.73 without passing `maxAgents`. Before saying an edition
  lacks a feature, read the core default as well as the options the edition passes.
- Order the end checks: independent (security) review first, its fixes, then e2e + workbook record. A fix
  commit after the e2e round changes the PR's own code, so the release review drops the e2e evidence and the
  2–3 minute round runs twice.
- Small changes are done directly. Large multi-part work runs through the Workflow tool with as many
  parallel agents as the work allows, with disjoint file ownership and a time budget; only the
  orchestrator commits; agents don't `npm install` unless they own that package.json.
  A hub file two agents of one wave both need (e.g. `apps/web/src/api/queries.ts`) stays with one owner;
  the other puts its new code in a new file that imports from the hub.
- Never `git stash` in a checkout another agent is editing (to compare with HEAD): it removes their
  uncommitted work until the pop. Compare with `git show HEAD:<file>` or a separate worktree.
- Subagents run only their own unit tests and package typecheck; one consolidated
  typecheck/test/lint/build/e2e run at the end. Prefer few wide waves and one integration pass.
- Agents use temp data dirs (`--data <scratchpad>`), never the real app data folder.
- Tools that fan out per file (e.g. graphify) must be batched, not one agent per file.
- Research on another repo starts with `git fetch` and searches `origin/<default>` (a local checkout can
  be hundreds of commits behind); never report "X does not exist" without naming the ref searched.
- Run Prettier on the files you changed, never on a whole folder: parts of the tree are not
  Prettier-clean on `main`, so a folder run rewrites files another agent or nobody owns.
- Workflow/subagents start in the session's primary checkout: when work lives in another worktree, give
  its absolute path and require `cd <worktree> && …` for every command, plus disjoint file ownership.
- A parallel agent can test against a sibling component another agent has not written yet with
  `vi.mock('<path>', () => ({ … }))` (a factory), so its tests run before the real file lands.
- On this PC (about 31 GB, often < 8 GB free) run at most 2 coding agents at a time and give them
  `vitest --pool=forks --maxWorkers=2`: 5 parallel agents stalled for an hour; waves of 2 finished.
- Never ask each agent for its own UX review or full screenshot run: parallel Chrome runs of 100+ shots
  took 40–60 min per agent on a low-memory PC. Agents build; the main agent reviews and captures once.
- Agents that don't commit can't know the confirmed mock's git revision: after committing, the
  orchestrator replaces their placeholder in `mock-index.json` / `design.md` with the SHA (grep for it).
- Put shared UI pieces and helpers (a badge, a query-refresh helper) in the Interfaces of the first task
  that needs them: parallel agents with disjoint files otherwise each write a private copy.
- A scripted rename to a shared function's name can make a same-named local wrapper call itself
  (`const f = () => f(qc)`); grep the new name in each touched file before typechecking.
- Every response shape that two parallel agents share goes in `packages/shared` before they start: a zod schema
  written only on the web side hid a server/web mismatch (`tools` as a count vs a list of names).
- The Stop hook commits on every stop while subagents write: snapshot commits during parallel work carry `[skip ci]` so CI and its failure notices don't fire on half-written code; SonarCloud still runs on them, so read its issue list only on the integrated head.

## Git, GitHub and CI

- A PR whose CI never starts (no workflow run for the branch) usually has a merge conflict (`mergeable_state: dirty`):
  `pull_request` runs need the merge commit. Merge main, then re-run e2e and the Dev Build check on the new head,
  because release-review counts a stage only at a commit with the head's code diff.
- In a fresh cloud clone `/security-review` fails on `origin/HEAD...`: run `git remote set-head origin main` first, and
  review only your own commits (`git show <sha>`) when the base moved.
- A change for another repository that a cloud session may not attach (add_repo refused) ships as a `git apply`-ready
  patch in the feature folder (`publisher/*.patch`, checked by applying it to an empty repo) plus the owner's steps.
- A test server that serves a payload and its signature in two requests must build them once (per version), never per
  request with a clock in the signed body: a second boundary between the two fetches fails the signature check on CI
  only (`e2e/partner-mcp/server.mjs` signed list).
- `npm ci` in a Linux cloud session marks `apps/desktop/scripts/fetch-*.mjs` executable (mode-only diff): reset them with
  `chmod 644` instead of committing the mode change, and check `git status` before every commit in a fresh checkout.
- A Cloudflare Workers Builds check that fails at "Initializing build environment… Build failed to initialize and was
  timed out" never ran your code: read the build log (Cloudflare connector, Builds API `/builds/builds/<id>/logs`) before
  blaming a binding or token, and retry the build; prove the config with `npx wrangler deploy --dry-run` locally.
- A PR head with no `Test (…)` runs (only SonarCloud) usually means the PR conflicts with `main` (`mergeable_state:
dirty`): GitHub creates no `pull_request` run until the base is merged in. Check the head's runs before scoring or
  merging; fix the conflict, never push an empty commit.
- CI's `Test (windows-latest)` job runs `npm run e2e:electron-links` on every non-docs PR: the release review counts
  that step on the head as the desktop link check, so never ask the owner to run it by hand.
- Two branches that each add a feature mock folder while pruning the same old one conflict as hundreds of
  rename/rename pairs: restore each new folder whole from its own side (`git rm -r --cached`, then
  `git checkout <side> -- docs/features/<name>`), rebuild `mock-index.json` from `main`'s copy plus your entry with the
  next `creationOrder`, and prune the next-oldest folder. Resolving them file by file with `--ours/--theirs` puts some
  files in the wrong folder.
- In a cloud shell, `pkill -f <pattern>` / `kill $(pgrep -f …)` also matches the shell's own command line and kills
  the tool call (exit 144): keep the server's PID from `$!` in a file and kill that. The `[a]gents` bracket trick
  does not help when the same tool call also starts or names that program.
- A rebase conflict in an append-only log (`docs/release-review/*.md`, `docs/dev-build-checks.md`): take
  `main`'s file and insert only the lines the PR itself added (`git show <commit> -- <file>`), in date order.
  Never merge by line text (`main` realigned the table, so old rows came back twice), and never run
  `prettier --write` on `docs/release-review/log.md` (`main` keeps it unformatted; it rewrote 117 lines).
  Two new `dev-build-checks.md` sections joined this way lose the blank line between a table and the next
  paragraph; add it back before prettier, or the paragraph becomes a table row.
- Wait for PR checks with `gh pr checks <n> --watch`, not a hand-written `until … grep pending` loop: one
  ended while two jobs still ran. Right after `gh pr update-branch` the new head has no checks yet and `--watch`
  returns at once: first wait until `gh pr checks` lists checks for the new `headRefOid`. A script that merges PRs in turn must check `isDraft` and print `gh pr merge` errors: a draft PR showed
  `CLEAN` with green checks, the merge failed silently and the loop waited forever. A draft is its author's
  "not ready": ask the owner, never mark it ready yourself. Read each PR's current title, branch and file count
  just before a "merge the docs PRs" merge: another session's `claude/*` PR can grow from a mock into a feature.
- In a cloud session the permission check may refuse any force-push, including `--force-with-lease`. When a stacked
  base PR is squash-merged, merge `origin/main` into the branch instead of `rebase --onto`: it needs no force, and
  `git diff <rebased> HEAD` proves that the trees are the same. Point a confirmation `gitRevision` at main's squash commit.
- Another session may push to the same PR branch while you work on it: force-push a rebase only with
  `--force-with-lease=<branch>:<sha you rebased>`, and when a later plain push is refused, rebase your new
  commits on the remote branch, run its new tests and push again (never force over a commit you did not read).
  Fetch and read the workbook before each long check: the other session may already be running the same one.
- A test that counts "today" in the business time zone (`days: 1`, reports) with rows placed hours before
  `Date.now()` fails when CI runs just after midnight Malaysia time (about 16:00–17:00 UTC). Fix the clock in
  such tests (`vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(<midday +08:00>)`); a red CI run
  on one such test is not a reason to doubt the PR under review.

- Merging main into a branch where two feature mocks were cloned from the same baseline can produce
  rename/rename conflicts: git writes 8-character markers (`<<<<<<<< HEAD:old/path`) into the mock files, and
  nothing in CI type-checks or formats mock folders. Search with `^(<{7,8}|>{7,8})( |$)`; restore a confirmed
  mock from its recorded revision (`git checkout <rev> -- docs/features/<f>/mock`), then `snapshot.mjs --check`.
- Known slow-runner timeouts on CI, also seen on `main`: `ai-agents-repo.test.ts` and `inbox-access.test.ts`
  hooks on Windows, `scripts/review/components.test.mjs` on macOS, and network timeouts in `npm ci`. Check
  the same job on the previous commit and on `main`, comment once, re-run the failed job once when the run
  has finished; a second failure is real.
- SonarCloud's gate fails a PR on script code too: run tools through `resolveTool` (`build-summary.mjs`), never a
  bare `execFileSync('git' | 'gh')` (PATH lookup, Security B), and give every `.sort()` a compare function (Reliability D).
- The release review is the final merge check and reads only GitHub REST and git (cloud sessions block
  GraphQL; review threads come from `pulls/<n>/ccr/review_threads` there): no `GH_PATH` wrapper. GitHub's
  compare lists at most 300 files and has no file pages: take a PR's files from `pulls/<n>/files` pages and a
  commit's own diff from `git diff <merge base> <sha>` (fetch both ids; works in a shallow clone).
- A mutation check on uncommitted code (break a line, watch the test fail) is undone from a backup copy
  or `git stash`, never `git checkout -- <file>`: that restores HEAD and deletes the new code too.
- After pushing a release tag, confirm its run exists (`gh run list --workflow <file> --branch v<version>`):
  GitHub can drop push events (no CI for the merge either). Then start it on the tag,
  `gh workflow run <file> --ref v<version>`; `refs/tags/v…` conditions (publish jobs) still pass.
- A PR with a merge conflict (`mergeable_state: dirty`) gets no `pull_request` CI at all, silently: when a
  push shows only SonarCloud, check the merge state and merge `main` first. Commit before recording a stage or
  writing a Dev Build row: `build-summary.mjs record` stores the current HEAD, and checks recorded on an
  older commit (or "uncommitted") count as ✗ missing in the release review; a Dev Build row counts only with the
  tested commit in backticks in its Build column (a branch name does not), and a later test-only commit (a
  SonarCloud duplication fix, or a change to the capture script itself) voids it too: push and settle SonarCloud
  before the Dev Build check, else re-run it and record with `--sha <head>`. Rebase onto `main` before the checks
  you record: a rebase gives every commit a new id, so the recorded ones stop counting. Merging `main` keeps them:
  evidence holds while the PR's own change to code, pipeline and test files is the same.
- `gh pr checks --watch` can return while required checks are still queued (one check, e.g. SonarCloud,
  already done): wait with `gh run watch <run id>` on the CI run of the head commit, then read every
  required check by name before a merge.
- CI docs-only fast path: `ci.yml` checks right after checkout whether every changed file is `*.md`
  (`git diff --no-renames` against the PR base or the push's `before`) and skips the later steps, never
  the job: a job skipped with `if` or a workflow filtered by `paths-ignore` never reports its required
  check (matrix names stay unexpanded), so the PR waits forever. Any unreadable diff runs the full job.
- A green `Test (*)` check can be the fast path: read the steps (`gh run view <id> --json jobs`). On a PR
  the diff is against the base, so a docs-only last commit still runs everything. CI covers lint,
  typecheck, tests, the coverage gates (Linux) and `e2e:electron-links` (Windows), not the browser e2e.
  A Markdown file a test reads (Lite `CHANGELOG.md`) counts as code.
- A critical dependency update (Electron, argon2, SQLite, fastify, electron-builder) gets its real-part test
  from a packaged build: `npm run dist -w @ezychat/desktop -- --dir --config.directories.output=release-check`,
  `node scripts/smoke-packaged.mjs apps/desktop/release-check`, then the packaged server with
  `ELECTRON_RUN_AS_NODE=1` on temp data, `--fake-wa`, port 7432 and `e2e/marketing-screenshots.mjs 7432`.
- An Electron major bump can bring a newer Node that drops old APIs (Node 23+ has no `util.isObject`): tests on
  the system Node do not see it. Run every macOS/Windows-only path's library once under the new runtime
  (`ELECTRON_RUN_AS_NODE=1 electron -e "require(…)…"`); unmaintained `sudo-prompt` broke every Mac update and
  service change in every release, because no one ran a real Mac update (now `@vscode/sudo-prompt`). A
  platform-only privileged path gets one real run on that OS before its first release.
  Log it as a `real:` Dev Build row. Combine the critical updates into one PR so one smoke covers them.
  A critical `server-host` change gets the same packaged run, with the server started through the packaged
  `app.asar.unpacked/dist/server-host.cjs`. Run `prettier --write docs/dev-build-checks.md` after a new row:
  the table is realigned and the format check fails otherwise. A voice-engine update (`sherpa-onnx-node`)
  needs a real transcript from the packaged server: make speech with Windows `System.Speech` and
  `ffmpeg -c:a libopus` to Ogg/Opus, `POST /api/ai/voice/download` and wait for `model.state` `installed`
  (only then `PATCH /api/ai/voice {transcription:'local'}`), send it with `/api/dev/fake-incoming`
  (`type:'audio'`, `media.base64`) and read `transcriptStatus`/`transcript` from the chat's messages.
  For `screens.smoke.mjs` against that server add `--web-dist resources/web` (else every page is 404) and
  start it on fresh data (the smoke creates the admin once); its `oauth-authorize` FAIL there is the
  expected 409 of AI assistant access being off, not a fault.
- GitHub's compare API (`repos/…/compare/a...b`) lists at most 300 files: a full list is unknown, never
  "these are all the changes". Evidence tied to a commit must also name one of the PR's own commits
  (`compare.commits`), not just any commit in a log.
- Dependabot opens `react` and `react-dom` as separate PRs; each fails every web test alone. `main` requires
  up-to-date branches, so each merge re-runs CI on every other PR: combine the non-critical updates into
  one PR (`npm install -w <workspace> pkg@range`, keep exact pins exact) and close the single PRs after it
  merges. Critical ones (release-review map) stay separate for the owner.
- A Dependabot alert: `npm ls <package>` shows the path. Build-only tools (electron-builder and its
  downloaders) never ship to users; for a runtime path, check that our code reaches the vulnerable
  function before treating it as urgent. Dismissing an alert is a repository setting (owner decides).

- Never put `[skip ci]` on a Lite PR: `main` requires the three `Test (*)` checks, a skipped run never reports
  them and the PR cannot merge (path filters have the same effect). Builds and releases run only on `v*` tags,
  so a doc PR never releases anyway.

- To strip a version from a file name, replace the exact version (`${f/-$version-/-}`, version from
  `package.json`), never a semver pattern: an optional pre-release group (`(-[0-9A-Za-z.]+)?-`) also
  matched `-win-` and turned `EzyChat-Lite-0.1.48-win-x64.exe` into `EzyChat-Lite-x64.exe`.

- `main` requires an up-to-date branch: after one PR merges, the next one waits a full CI round (about 11
  min, Windows the slowest). Merging several PRs, merge the one with the longest CI first and update the
  others once, never push to a PR whose merge is waiting.
- The Lite updater shows the GitHub release body as the notes: `release.yml` writes it from the
  version's `CHANGELOG.md` section (`scripts/release-notes.mjs`) and stops before the build when that
  section is missing. A draft published without it gives an empty update dialog.
- `git add -A` on a branch cut before an ignore rule landed committed `.e2e-data-multi/secret.key` (test
  data) to `main`: stage named paths only and read `git diff --cached --stat` before every commit.
- Every push to a PR branch cancels its running CI (Windows takes ~11 min): while waiting for checks,
  commit docs-only changes (LEARNINGS, workbook) locally and push them with the next code change.
- A fix for an external issue says `Refs #N`, never `Closes`/`Fixes #N`: those close the issue at merge,
  before the release. Close it after the release with a comment that links the release.
- Azure sign-in from this public repository uses GitHub OIDC (`azure/login`, `id-token: write`), never
  a stored client secret. Federated credentials match the subject exactly (no wildcards): use a GitHub
  environment whose rules allow only `v*` tags and `main`. Read the subject format first
  (`gh api repos/<repo>/actions/oidc/customization/sub`): with `use_immutable_subject` it is
  `repo:<owner>@<owner id>/<repo>@<repo id>:environment:release`, not `repo:<owner>/<repo>:…`.
- The `ossmalaysia` organization allows only GitHub-owned actions plus pinned SHAs
  (`gh api orgs/ossmalaysia/actions/permissions/selected-actions`): a workflow with any other action
  fails as `startup_failure` before a job runs. Add the exact pinned SHA (with the owner's approval)
  before merging the workflow, not after the release tag.
- A CI job that fails in `npm ci` with `node-gyp` building `better-sqlite3` (no Python/compiler on the
  runner) means its prebuilt binary download failed, not that the change broke it: check the step
  (install, before any test), then `gh run rerun <id> --failed` before investigating the code.

- Merge a stack in a squash-only repo by retargeting the top PR to `main` and squash-merging it once, then
  close the lower PRs as included. Retargeting does not start CI and `strict` needs an up-to-date branch:
  run `gh pr update-branch` and wait for the required `Test (…)` jobs, never for "any green check".

- CI runs only on pull requests to `main`: a stacked PR shows only SonarCloud. Run the consolidated
  checks locally on the top branch and say so in the PR; real CI runs after the base merges and the
  stack is retargeted.

- Auto mode blocks `gh repo create` (new upload) without the owner's direct instruction: before an
  unattended run, ask the owner to create any new repo or say "create it".

- Exclude frozen feature-mock source copies from application static analysis; otherwise cumulative
  references inflate duplication and re-report old application findings as new code. Keep production,
  tests and tooling in scope and fix their findings before releasing.

- Merge only on the owner's explicit request for that PR; never enable auto-merge. A green quality
  gate can still have open Sonar findings: inspect review comments and findings on the final commit
  before reporting readiness, and leave the PR open until the owner requests merging.
- CI runs `npm run build:core` before `npm test`: otherwise the pack contract test builds every core
  package mid-suite and starves slow Windows runners into timeouts. Do the same locally after adding a
  file to a package (e.g. a migration): a stale `dist/` fails "ships the build output". The owner test env
  (`D:\dev\test-env\lite\start.ps1`) also loads `@ezychat/shared` from `dist/`: after adding a shared export,
  `npm run build:core` first, or the server stops with "does not provide an export named …". A test that is ~0.4 s on `main` and
  times out on a branch is a branch regression (load, not flakiness): compare per-test times first.
- A test that runs every migration on a fresh SQLite file costs ~1 s per test locally and timed out (> 30 s)
  on `windows-latest` (disk sync per migration on a busy runner): build migration-only test databases with
  `new Database(':memory:')` unless the test reopens the file. Bring it to an old schema with `migrate(db, N)` and
  compare with `latestMigration()` (`src/db/migrate.ts`); never list `db/migrations`, sort file names or set
  `user_version` by hand in a test (14 drifting copies were removed, `docs/DEBT.md`).
- Push a Lite API change before the Enterprise commit that uses it: Enterprise CI builds the Lite branch
  as pushed at that moment (`LITE_REF`), so the reverse order fails its typecheck.
- Private repositories (e.g. `anchorsprint/ezychat-enterprise`) run CI only on the org's self-hosted
  runners (`[self-hosted, Linux, ARM64]`), never GitHub-hosted machines.
- Hotfixes for the released version go in a separate worktree from `origin/main` with its own
  `npm install` (`git worktree add ../wm-hotfix -b fix/<bug> origin/main`): `main` uses `@wa-team-inbox/*`
  workspace names until the `@ezychat/*` rename merges, so one `node_modules` cannot serve both branches.
- Branch from a freshly fetched `origin/main`. Stage files explicitly (never `git add -A`); leave the
  plugin-injected CLAUDE.md block out of commits. One path that no longer exists (e.g. a folder whose deletion
  is already staged) makes `git add` stage nothing: chain `git add … && git commit`, never with `;`, and read
  `git show --stat HEAD` after the commit.
- A release PR opened before later merges is rebuilt on a fresh `origin/main` (bump, `version:sync`, lockfile,
  changelog heading), never rebased; copy a single new `dev-build-checks.md` row by hand: `git apply --3way`
  of a table row garbled the whole file. Before a release, check `main`'s own CI and run e2e + links on it.
- A red check on a release (version-only) PR: read `gh run view --log-failed`, compare with `main`'s run
  on the same code, then `gh run rerun <id> --failed`; fix the flaky test in its own PR. After that fix
  merges, rebase and push each red PR: a rerun tests the PR's old merge commit, without the fix. A mac DMG job
  failing with `hdiutil: couldn't eject … Resource busy` is a runner glitch: re-run that job, it adds
  the missing installer to the draft release before you publish.
- `/code-review` with no target reviews the session's checkout, not a feature worktree: pass the
  branch or path (e.g. `/code-review feat/x`) when the work lives in another worktree.
- Never hard-reset a working tree with changes you didn't make; stash or use a worktree.
- Before removing a worktree, delete its `node_modules` junctions with `[IO.Directory]::Delete(path, $false)`
  (Git follows junctions); prefer `npm ci` in new worktrees. Without it, a bare `npx prettier`/`eslint`
  there downloads other versions: for a one-file fix call the main checkout's `node_modules/.bin/<tool>`.
  A junction to another branch's install links `@ezychat/*` to that branch's sources: link only to a
  checkout on the same base, else `tsc` reports the other branch's contract changes as your errors.
- Append-only files (`LEARNINGS.md`, `CHANGELOG.md`, fixtures) conflict on every parallel branch: keep both
  sides, never `--ours`/`--theirs`, then check CHANGELOG headings for duplicates. Before writing a rule, also
  search the open `docs(learnings)` PRs (`gh pr diff <n>`), not only `main`: one may already hold it. Bring a long PR branch
  up to date by merging `main` into it (one resolution, squash-merged later) rather than rebasing every
  commit. After a base PR is squash-merged, replay only your own commits
  (`git rebase --onto origin/main <old base>`); a clean rebase still needs a typecheck (semantic
  conflicts), and never chain `git add`/`rebase --continue` after edits that may have failed — grep for
  conflict markers first.
- After merging `main` into the rename branch, `git grep -l "@wa-team-inbox/" -- apps packages e2e scripts`
  (not `grep -r | head`, which shows ignored release folders first): new files from `main` keep old imports.
- Publish `@ezychat/*` with npm trusted publishing (GitHub OIDC, `id-token: write`), not an `NPM_TOKEN`:
  2FA-bypass tokens lost account/package management in July 2026 and lose direct publishing around
  January 2027. OIDC cannot make a package's first publish: publish each new package once by hand with 2FA,
  then add its trusted publisher (`ossmalaysia/ezychat-lite`, `publish-packages.yml`) and set the repo
  variable `NPM_TRUSTED_PUBLISHING=true`. An OIDC publish answering `PUT 404` for a package that exists means
  its trusted publisher is missing or mistyped: have the owner compare it field by field with a package that
  publishes (workflow is the bare file name, no environment), meanwhile publish that version by hand, then
  rerun `publish-packages` for the next tag (published packages are skipped). A publish that stops halfway on
  `TLOG_CREATE_ENTRY_ERROR` (409, Sigstore says the provenance entry exists) needs only `gh run rerun <id>
--failed`, but first wait until `npm view <pkg>@<version> version` answers for each package already
  published (the skip check uses exactly that; it lags the registry list by up to a minute). A manual publish that answers
  `PUT 404` without the security-key step means the saved npm token is invalid: check `npm whoami` first and
  give the owner `npm login --auth-type=web` before the publish. An unfixed trusted publisher fails again on
  every release and leaves the core half published (Enterprise needs all pins equal): before tagging, ask
  the owner whether it is fixed and have the manual publish folder ready at the new tag. A manual publish ends
  with `PUT 202` "being processed": the version shows up about a minute later. Check the registry document
  (`https://registry.npmjs.org/@ezychat%2f<pkg>` with `Cache-Control: no-cache`), not `npm view`, which can
  answer from a cached 404 or an older version (even `--prefer-online` gave E404 minutes after a publish that
  the registry URL already served); the Enterprise
  pin bump's `npm install` fails the same way (`notarget`) until it runs with `--prefer-online`. Read the
  publish result from the `+ @ezychat/<pkg>@x` lines: grepping
  `gh run view --log` also matches the step's own script source (lines with `[36;1m`), e.g. its "dry run
  only" warning text. A CI publish can lag too: `+ @ezychat/server@x` in the log and still 404 for about
  10 minutes (the other four were there at once). Before the Enterprise pin bump, wait until the **tarball**
  `https://registry.npmjs.org/@ezychat/<pkg>/-/<pkg>-<version>.tgz` answers 200 for all five: the version
  document can list the version while its tarball still answers 404 (Enterprise CI then fails at `npm ci`).
  The Enterprise Windows installer job runs on the owner's PC: a long `gh run watch` in the background is
  stopped under memory pressure, so check the run once (`gh run view <id>`) and again later. Look at the package's Settings page first: `@ezychat/desktop` had no trusted
  publisher at all (only "Select your publisher"). npm's form allows only `npm stage publish` unless
  "Allow npm publish" is ticked; copy every field (label, org, repo, workflow, empty environment, publish
  ticked) from a package that publishes. Then `gh run rerun <publish run> --failed` on the existing tag
  publishes only the missing package and turns the publisher from "Pending validation" to "Valid" (one
  publish is due before the shown deadline); no new tag or manual publish.
  The owner does that first publish in a normal terminal: `npm login` dies in Claude Code's `!` shell (no
  stdin), and each `npm publish -w @ezychat/<pkg> --otp=<code>` needs a fresh authenticator code (shared, wa,
  server, web in that order, from a clean checkout of the release tag after `npm ci && npm run build:core`).
  With a security key, the owner runs `--auth-type=web` in their own terminal (Enter opens the browser, touch
  the key); from an agent shell it still fails with `EOTP`. With an authenticator app, show a 6-digit example
  (`--otp=482917`), not a word placeholder, which npm rejects with E400.
  Ask first whether the npm account has 2FA: publishing needs a code, so set up an authenticator app (and
  keep the recovery codes) before the publish session.
  A new package answers 404 for some minutes after `+ @scope/pkg@x` ("being processed"): trust the `+` line and
  poll the registry before calling it failed.
  The trusted-publisher form only allows `npm stage publish` unless **Allow npm publish** is ticked (staged = each
  version waits for the owner's approval); saving it asks for the owner's 2FA (security key) per package.
  A new trusted publisher stays "Pending validation" until one OIDC publish happens before its deadline
  (about two days): plan the next release tag inside that window, or the connection must be set up again.
- Core packages pin sibling `@ezychat/*` deps to the exact version: after merging a version bump from
  `main`, run `npm run version:sync` before `npm install --package-lock-only`, or npm looks the old
  version up on the registry (404). Different npm versions flip dozens of `"peer": true` lines in the
  lockfile at each release and can drop optional packages (`@napi-rs/canvas` for pdfjs): keep `main`'s
  lockfile and change only the `@ezychat/*` version strings (`docs/release.md` step 1; about 22 lines). Stop the owner test env Dev Build (and every process
  running from `node_modules`) before `npm ci`: a locked `esbuild.exe` makes it fail with EPERM after it
  deleted half of `node_modules`.
- After merging `main` (and before a release), check `CHANGELOG.md` `[Unreleased]` for duplicate
  `###` headings: two branches adding the same section merge cleanly into two copies. A branch rebased
  over a release can carry its entry into the released version's section: before a merge, check that
  `git diff origin/main...HEAD -- CHANGELOG.md` adds lines only under `[Unreleased]`.
- Migration numbers collide across parallel branches: keep `main`'s published numbers, renumber the
  unmerged branch, and test upgrades from both orders.
- Org Actions must be pinned to full SHAs and allowlisted (`gh api orgs/ossmalaysia/actions/permissions`).
  PR CI never runs `release.yml`: for actions used only there, read the breaking changes and update the
  allowlist SHA in the same change.
- CI does not run e2e: a change to routes or landing URLs must run e2e locally and update
  `e2e/responsive.spec.ts` in the same PR.
- A BLOCKED PR with green checks usually has an unresolved review thread: fix, reply, resolve. The
  Codex review lands minutes after each push: check threads before calling a PR ready.
  A clean Codex pass arrives as an issue comment ("Didn't find any major issues"), not a review or
  reaction: watch PR comments too. Its summary comment is edited in place and says "Running" until
  done: wait for its status, not for the comment to exist.
- Right after a push, `gh pr checks --watch` can see no checks yet and exit 1 ("no checks reported"):
  wait on the run instead (`gh run list --branch <b> --limit 1`, then `gh run watch <id>`). In a background
  shell without a terminal `gh run watch` can also return at once: poll `gh run view <id> --json status`, or
  `gh pr checks <pr> --json bucket` until no `pending` is left (never parse the text table: names have spaces).
  Filter with gh's own `--jq`: the owner's PC has no `jq`, and a watcher that pipes to it stays silent.
- `gh pr checks --watch` and `gh run watch` can also return while a check is still pending or a job is
  still queued (seen with macOS CI and a queued self-hosted job), and right after `gh run rerun --failed`
  `gh run watch` still sees the old failed attempt and exits at once: read the final status after the wait,
  or loop until `gh run view <id> --json status` is `completed`, before merging or reporting.
  A required job `cancelled` after about 15 min with no runner and no steps never started (macOS runners
  busy): `gh run rerun <id> --failed`, not a code fault. Push every log-only commit (workbook, Dev Build row,
  review approval) in one push before that wait: each push starts all of CI again.
- Before you start a new run or a rerun, stop every old watcher or retry task: a leftover one can start an old
  run again, and that attempt can still publish. Report a release from the live files (feed, sizes,
  SHA-256), never from a run's conclusion alone.
- SonarCloud's reliability gate fails on `.map(namedFn)` (write `.map((x) => fn(x))`) and on regexes
  over user input with overlapping quantified classes (e.g. `[^@]+\.[^@]+`): keep classes disjoint.
  A migration `UPDATE`/`DELETE` needs a `WHERE` (blocker otherwise): backfills write
  `WHERE col IS NULL`. Before opening a PR, check new scripts against the S4036 and S2068 rules below, and S9382 (each `await`
  written inside a loop body is one issue: a screen script loops over sets that call one `async function captureSet`).
  After merging one PR, the next needs `gh pr update-branch` and fresh checks (main requires up-to-date).
- Solo maintainer: PRs + green CI + resolved conversations, zero required approvals; restore approval when
  another reviewer exists.
- Dependency PRs: check peer and engine ranges and SHA pins; merge only with fresh checks against `main`.
  With many open Dependabot PRs and strict up-to-date `main`, merge their branches into one `chore/deps-*` branch,
  keep exact pins exact, run the full suite + e2e once and merge that PR: one CI round instead of one per PR.
- Before releasing a structural change (renames, packaging, identity), prove the existing-user update:
  seed a temp data dir with the released packaged server, start the new packaged server on the same dir,
  diff an API snapshot (users, chats, messages, AI mode/key, settings), reuse a pre-update session
  cookie, and compare identity strings across all `dist/**` files in both `app.asar`s (e.g. `dist/service/`).
- A `v*` tag makes `release.yml` build a **draft pre-release** whose notes come from the version's
  `CHANGELOG.md` section (so write that section in plain language before tagging, with no internal status
  such as "untested against real WhatsApp" or PR numbers: those go in the PR); nothing reaches users
  until `gh release edit <tag> --draft=false --prerelease=false --latest` — all three
  flags in one call: without `--prerelease=false` GitHub answers 422 "Latest release cannot be draft or
  prerelease" and the release stays a pre-release that the updater ignores.
- Tag a release only after `git fetch` shows the merge commit on `origin/main`; never hide `gh pr merge`
  output and tag in the same command (Lite and Enterprise). A merge that has not landed yet makes the tag
  point at the old commit; cancel that run, wait for `cancelled`, then move the tag.
- Non-app downloads (e.g. voice models) are published under a non-semver tag (`models-…`) as a
  pre-release with `--latest=false`, so the in-app updater (strict semver tags) never offers them.
- When a component gains a router or data hooks, run every test that renders it (`grep -rl "<Name"`).
- Moving UI into a collapsed section (`<details>`, Advanced, "More …"): grep `e2e/` and unit tests for its
  labels and open the section first in each; agents that own the page miss specs owned by other features.
- SonarCloud's security gate fails on running a tool by bare name (S4036, PATH lookup): scripts run
  `gh`/`git` from absolute install paths or an absolute `<TOOL>_PATH` override (`scripts/build-summary.mjs`).
  An e2e check that starts a server never spawns `npx`: run `process.execPath` with `node_modules/tsx/dist/cli.mjs`
  (`e2e/start-multi-inbox.mjs`).
  It also fails on any `http://` literal (S5332): an RFC 3161 timestamp URL (signed replies, published as
  http) gets a `// NOSONAR (javascript:S5332): <reason>` on its line; everything else uses https.
  It treats `process.argv` in `e2e/` scripts as untrusted (SSRF S5144/S8703): parse the port with
  `Number()` and a range check, and `fetch` only addresses the script builds, comparing server-sent
  URLs (metadata, tunnel status) instead of calling them. A script that must follow its own tunnel
  sends every request through one helper with one reasoned `// NOSONAR (jssecurity:S5144)`.
- SonarCloud counts repeated test bodies as duplicated new code (gate ≤ 3 %): write case lists as
  `it.each` tables. A moved or reformatted file is new code too: old copy-paste between files (e.g. the
  fetch scripts' `download()`) then fails the gate, so extract the shared helper in the same change. A new
  test file modelled on a sibling (`mcp-send-file` on `mcp-send-image`) copies its setup: put that setup in one
  helper from the start and move the sibling onto it too, or the helper is the duplicate.
- `file-type` reports `.docx` only when `[Content_Types].xml` names the main part
  (`…wordprocessingml.document.main+xml`, as Word writes it); a bare test ZIP with `word/document.xml` reads
  as `application/zip`. Byte-checked upload tests need that realistic fixture.
  A new test file that copies another file's request helpers fails it too: import them from a shared
  test helper (`packages/server/test/mcp-helpers.ts` for `/mcp` calls). The same for a new dialog
  that repeats another dialog's fields (easy when porting a mock): extract one fields component
  (`admin/SendPermissionFields.tsx`).
- SonarCloud: keep data tables as one-line tuples, catalogs in JSON, avoid `password`/`pwd` in i18n keys;
  write `UPDATE` statements with an explicit `WHERE`.
- Rebasing a branch whose mock commit cloned a folder `main` has since pruned: Git pairs the clone with
  `main`'s own clones as renames (hundreds of rename/rename conflicts; `-X no-renames` and
  `merge.renames=false` do not stop it in a rebase). Resolve that commit by hand: `git rm -r docs/features`,
  `git checkout origin/main -- docs/features`, `git checkout <mock commit> -- docs/features/<feature>`, rebuild
  `mock-index.json` (renumber, prune), continue; then point the index and `design.md` at the rebased mock commit.

## Build, tooling and Windows

- PowerShell does not wait for a GUI-subsystem program (Electron, also with `ELECTRON_RUN_AS_NODE=1`) called with
  `&`, and leaves `$LASTEXITCODE` unset, so its output and exit code are lost: pipe the call (`& $exe … | Write-Output`)
  and test the generated script with the real Electron binary (`windows.test.ts`). A test that sets `$LASTEXITCODE`
  itself makes a local copy; read `$global:LASTEXITCODE`.
- Measuring a slow tunnel locally: put a proxy that delays every request (and the WebSocket upgrade) in front
  of the server; Chrome throttling does not slow the service worker's own fetches. The fake WhatsApp has no
  photos, so give contacts a photo address in a measurement-only preload. Do not use Playwright `context.route`
  for the new code (it turns off the HTTP cache and changes service worker handling), and measure only after the
  service worker controls the page: installing it through a 650 ms proxy took 16–19 s, and opens before that
  showed photo requests that an installed PWA never makes.
- A contract the publishing repo validates through `z.toJSONSchema(…, { io: 'input' })` must stay plain: a
  `.transform()` (and every check piped after it, e.g. lengths) vanishes from the schema. Clean values before
  `safeParse` instead (`cleanAgentTemplateValue`). The root `ajv` is ESLint's v6; ajv 8 is only nested, so repo
  scripts take a validator as a parameter and tests pass one built from the zod contract.
- A generated folder that a test compares byte for byte with its generator goes into `.prettierignore`; Prettier
  rewrites JSON arrays and Markdown and the drift test fails.
- In a Linux cloud session `e2e/screens-common.mjs#launchBrowser` falls back to msedge and fails: run capture scripts
  with `PW_CHROMIUM=/opt/pw-browsers/chromium-<n>/chrome-linux64/chrome`, and restart the server on fresh data after a
  failed run (the script's seed users already exist).
- A random "can't reach" from the server while the browser and curl work: test the app's own runtime
  (`ELECTRON_RUN_AS_NODE=1 <app> script.js` with `fetch`), and `curl -4` / `curl -6` on that computer. A network
  with IPv6 addresses but no IPv6 route made fetch time out (`UND_ERR_CONNECT_TIMEOUT`) at random; `runCli`
  sets `ipv4first` (`dns-order.ts`). Cloudflare turns IPv6 off only on the Enterprise plan, so fix it in the app.

- Desktop-only screens (Lite import, status window) in a Dev Build on a PC with the installed apps: run the
  window from source with `npx electron <apps/desktop> --user-data-dir=<test profile>` plus a `desktop.json`
  port of its own. An unpackaged run does not pin the installed profile, but without its own port it finds
  the installed server's health and becomes a client of that old build. The source-run shell serves the web
  from `<app>/../web/dist` (`webDistDir`): an edition that builds `dist/web` needs a link there, or `/` is 404.
- Right after a service install (data moved back to the machine folder), `/api/health` can stay silent for
  more than 3 s while `sc query` already says RUNNING: probe with a ~15 s timeout before calling it down.
- The service data folder (`C:\ProgramData\wa-team-inbox`, LocalSystem) is unreadable for a normal user: `statSync`
  there throws `EPERM` (Windows) / `EACCES`. Never fold every error into "missing" (`lite-import/detect.ts`
  `mtimeOrDenied`): a locked folder is "found, needs elevation", and the screen must say how to free it, not "not found".
- A new `e2e/*-screens.mjs` script imports `e2e/screens-common.mjs` (argv checks, demo admin, browser, sizes,
  shot helper): copying that setup from an older script made SonarCloud fail on duplication of new code (20 %,
  limit 3 %). A script that shoots the setup wizard needs fresh data on every run: `signInDemoAdmin` creates the
  admin, and `/setup` then no longer shows (a second run times out waiting for it). A desktop-only screen gets
  its bridge from `addInitScript` (`e2e/lite-protected-screens.mjs`). Grep `e2e/` for a shared module before
  copying any script's setup (the rule applies to Dev Build checks too: PASS/FAIL from `devbuild-client.mjs`). In a
  cloud session `launchBrowser` needs `PW_CHROMIUM=/opt/pw-browsers/chromium-*/chrome-linux64/chrome`. A script's
  fetch sends `content-type: application/json` only with a body: the server answers 400 to a bodiless DELETE with it.
  Its API calls go through `cookieSession` (`devbuild-client.mjs`): a raw `fetch(base + path)` fails SonarCloud's
  security rating (S7044/S8476, request forgery from argv input).
- An antivirus "threat blocked" report on our installer: first compare the file's SHA-256 with the release digest
  (`gh api …/releases/tags/<tag>` asset `digest`; Enterprise `latest.json`) and check `Get-AuthenticodeSignature`
  (signer Anchor Sprint Pte. Ltd.). Genuine and signed means a reputation false positive (each release is a new,
  rarely downloaded hash): the fix is the vendor's false-positive form, not a build change. An allowlisting covers
  one hash only: after each Enterprise release, report the new installer when a vendor flags it, and point users
  at `ezychat.ai/guides/install-on-windows#antivirus`. McAfee: a `ti!<hash>` detection is reputation only; report
  it on its "Dispute a Detection & Allowlisting" web form. A 407 MB ZIP of the installer plus its extracted files
  failed although the page names no limit: attach the installer alone (a 173 MB ZIP went through) and put the
  download links and SHA-256 values in Details. The owner attaches it by hand: browser automation uploads 10 MB at
  most and its click on a file input opens no OS dialog; a tab that reports viewport 0x0 or times out on
  screenshots is in a hidden window, so open a new tab. Other vendors: the false-positive contact list in the
  Google Threat Intelligence (VirusTotal) docs.
- `graphify hook install` appends `graphify-out/graph.json merge=graphify` to the tracked `.gitattributes`; here the graph is
  git-ignored, so revert that line or the primary checkout stays dirty and `git pull` stops. Its hooks skip linked
  worktrees, so the primary checkout needs a `post-merge` hook (`graphify update .`) to follow `git pull`.
- A build-time value for the packaged server (e.g. the Google "Desktop app" OAuth client) goes in as an
  esbuild `define` of a global that the code reads with `typeof X === 'undefined'`, from repository secrets
  passed only to the bundle step; the environment still wins, so Dev Builds and forks need no rebuild.
  Prove it on a real bundle by printing counts of the values, never the values. A new value also needs its
  secrets in Enterprise's `installers.yml` and repository (same core bundle), and Enterprise's own copy of
  `scripts/google-oauth-define.mjs` must read it, else Enterprise ships without it; list both repos in the PR's
  owner to-do, and before the release tag check `gh secret list` in both repos (names only).
- Playwright on this PC has no downloaded Chromium: launch `{ channel: 'chrome' }` (installed Chrome).
  A `tsx` run outside npm needs `NODE_OPTIONS=--conditions=ezychat-source`: a `--conditions` flag before
  `tsx/dist/cli.mjs` does not reach the child node, which then loads stale `dist/`.
- In this cloud shell, killing a process by matching `/proc/*/cmdline` (or `pkill -f`) with a pattern that
  appears in your own command line kills the shell itself (exit 144) and drops the rest of the command:
  find the PID first, then kill it in a separate call.
- In a cloud container whose Playwright browser build is older than the package expects, point
  `PLAYWRIGHT_BROWSERS_PATH` at a scratch folder with symlinks named for the expected build (e.g.
  `chromium-1248` → `/opt/pw-browsers/chromium-1243`); otherwise `playwright.config.ts` falls back to the
  `chrome` channel and every e2e fails at launch. The PDF/Word parser worker tests also fail there on clean
  `main`: compare with `main` before blaming a change.
- An app window that Windows marks "not responding" while its server log stays fast is first a PC-load
  question: read `Get-WinEvent` (Application Hang 1002, service timeouts, Kernel-General 12/13 restarts) and the
  WER `ReportArchive` before reading code. On the owner's PC, never run the full suite or e2e beside the live apps
  without asking; run checks one at a time with low workers (`npm run e2e -- --workers=1`, `vitest --maxWorkers=2`).
- Stopping a background `npx tsx …` task on Windows can leave its node child listening: free the port by
  stopping the process that owns it (`Get-NetTCPConnection -LocalPort`), then delete the runner's temp data.

- In a cloud container whose bundled Chromium build differs from the repo's Playwright, run e2e with
  `PLAYWRIGHT_BROWSERS_PATH=<tmp>` holding a `chromium-<wanted build>` symlink to the installed one; never edit
  the Playwright config for it. The document-reader worker (`knowledge-worker.ts`, `--import tsx`) only resolves
  under Node 24: on Node 22 every upload says "Cannot read this document" (4 unit tests, ai-member e2e), not a
  regression of the change under test.
- Stop a background mock or server by its pid (`ps -eo pid,args | grep "[n]ode.*run.ts"`), never
  `pkill -f <pattern>`: the pattern also matches the shell running the command and kills it (exit 144).
- `mcp-ai-setup.test.ts` "get_stats adds new customers…" also failed on clean `main` at 00:40 Malaysia time
  (2026-10-29): a run just after midnight in `ai_timezone` is not evidence against the change; compare with `main`.
- An npm package that reads its data with `node:fs` (e.g. `dictionary-en-gb`) cannot be imported in the browser:
  copy its files into `apps/web/public/<folder>` (Enterprise copies `@ezychat/web/public`, the PWA does not
  precache unknown extensions), fetch them by a literal path, and pin the copy to the package with a hash test.
- After an electron-builder update, check the Windows sign hook with a fake command, not the build log
  (26.18 stopped printing "signing with signtool.exe" but still calls the hook):
  `WIN_SIGN_MODE=command WIN_SIGN_COMMAND="node <script that appends {file} to a list> {file}"` and
  `npx electron-builder --config electron-builder.yml --dir` in `apps/desktop`; expect WinSW, cloudflared
  and the app exe.
- `npm run e2e:electron-links` in a fresh worktree needs `npm run build -w @ezychat/desktop` first (the shell
  loads `apps/desktop/dist/window.js`): without it the window never opens (`firstWindow` timeout, no other error).
  If `node_modules/electron/path.txt` is empty, run `node node_modules/electron/install.js`.
- Never name a source folder `release-*` or `release`: ESLint ignores `**/release-*/**` (installer output)
  and the files are silently not linted. Check a new folder with `npx eslint <file>` (no "File ignored" warning).
- Stopping a background `npx tsx …cli.ts` shell task on Windows leaves the Node server running on its port
  (the next server fails with `EADDRINUSE`, and scripts talk to the old one). After the stop, find the
  owner of the port and stop it only when its command line shows your own temp data folder.
- In a Node script on Windows, never call `process.exit()` while a `fetch` may still be open: Node aborts
  with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and a non-zero code, so a `&&` chain
  stops. Set `process.exitCode` and return instead.
- Insert Markdown with the Edit tool, not `sed -i '<n>a\ …'`: each insert shifts the next line numbers (a
  second insert landed inside another bullet) and `sed` turns `\d`, `\t` in the text into escapes
  (`D:\dev\test-env` became `D:dev<TAB>est-env`).

- `scripts/pack-contract.test.mjs` reuses an existing local `dist/`: after a new migration or shared export
  it fails on the stale build. Rebuild `node scripts/build-package.mjs packages/shared` first, then
  `packages/server` (the server build compiles against shared's `dist`, not `src`).
- A new field in a shared **response** schema gets a `.default()` (empty list, `false`, `null`) or, on a type
  that code builds by hand (`Message`, `InboxCapabilities`), `.optional()` read as "absent = off": a default
  makes the inferred output type require the field and breaks every fixture here and in Enterprise. Never a
  bare required type: Enterprise web tests use fetch doubles of an older server, and a required field made
  the agent page show "Couldn't load". Run the Enterprise suite on `use-local-core.mjs` before a
  contract change ships, then `npm ci` there to restore the npm core. First check port 7434: the owner's
  Enterprise test server loads native modules from that checkout's `node_modules`, so `npm ci` deletes
  the folder and then stops on a locked `.node` file (EPERM). Ask the owner before you stop that server.
- An Enterprise Dev Build (bundled `server.cjs` on a temp folder) uses the LIVE licence portal: the owner
  registers it (real email code, real trial record). To show new core code, stop only that server, rerun
  `use-local-core.mjs` + `build:web` + `bundle:server`, and restart on the SAME data folder: the trial,
  sessions and test agents stay, so nobody registers again.
- Changed-lines coverage counts an untested entry `main()`: put new start-up logic in an exported function
  with injectable I/O (`startArgs` in `server-host.cts`) so `main()` gains one call line, and leave
  unrelated log text alone (each touched line counts).
- Pass extra Vitest flags through the script (`npm run test:coverage -- --pool=forks --maxWorkers=2`), never a
  raw `npx vitest run --coverage`: the script's `--testTimeout=20000` keeps slow tests from false failures.
- A git worktree whose `node_modules` is a junction to the main checkout: delete the junction first
  (`[System.IO.Directory]::Delete(<link>)` removes only the link) before removing the worktree.

- A second Playwright `webServer` that serves the same `apps/web/dist` waits for the first server's
  `/api/health` (that one builds the web) instead of building again in parallel. Specs for it get their
  own project and `testIgnore` in the others. Confirm dialogs are `alertdialog`, not `dialog`.
- A fake that links at once hides a linking step: a flow that must show a QR (a new inbox) needs a fake
  that waits for its scan (`FakeWaAdapter({ awaitScan })`, `POST /api/dev/fake-link`).
- A scripted multi-file edit and its `git commit` go in one `&&` chain (or `set -e`): when an assert in
  the script fails, the next line still commits a partial change. Check `git diff --stat` first.
- Coverage instrumentation makes module loading several times slower: tests that dynamic-import an entry
  module or build a TypeScript program time out at Vitest's 5 s only under coverage. `test:coverage` uses
  `--testTimeout=20000`; parse once in `beforeAll`, import light modules statically, and set
  `reportOnFailure` so a timeout never hides the coverage numbers. A gate must fail closed: a filtered run
  (`--project`) wrote an empty report and the changed-lines check passed; it now refuses an empty report
  and a changed source file missing from it. Prove every gate with a run that must fail.
- `windows-latest` runs web tests about 5 times slower than this PC, and `npm test` keeps Vitest's 5 s limit:
  a test of 1 s or more locally can time out there. A test that renders a whole dialog and types several
  fields gets `describe(name, { timeout: 20_000 }, …)` when it is written; `userEvent.setup({ delay: null })`
  halves the time but alone did not keep a 1 s test under 5 s.

- `codex exec -i <image>` takes several values, so a prompt after it is read as a second image ("No prompt
  provided"): send the prompt on stdin (`codex exec -i icon.png < PROMPT.md`).
- Put Markdown syntax examples in CHANGELOG/docs inside backticks: Prettier rewrites a bare `**name**` or `*x*`
  as emphasis (`_name_`), which turns the sentence into nonsense.

- Owner-run PowerShell scripts: Windows PowerShell 5 with `$ErrorActionPreference = 'Stop'` stops on any native
  stderr line (e.g. npm's normal E404 for a new package). Use `Continue` and check `$LASTEXITCODE`; test the
  read-only parts yourself before handing the script over. The same goes for generated (elevated) service
  scripts: string tests passed while PS 5 rejected `Split-Path -LiteralPath $p -Parent`; run their prechecks in
  `powershell.exe` against temp folders (cut before the first privileged command).

- Stopping a background server task can leave its node child running: before a restart on the same
  `--data`, stop the process whose command line names that folder. Exit 3 can also be Windows PID reuse
  (the lock's pid now belongs to another program); start again once the old server is gone.

- Pass Windows paths (`D:/dev/...`) to Node and other native tools from Git Bash: a POSIX path like
  `/d/dev/...` inside a script string becomes `D:\d\dev\...` and fails with ENOENT.
- Never start a Dev Build on port 7420 on the dev machine: the installed EzyChat Lite service listens
  there, so test traffic could reach real data. Use 749x ports and check `/api/health` reports `mode: dev`.
  Playwright MCP screenshots save only under `.playwright-mcp/` (gitignored).
- Never use the `development` export condition for monorepo-only `src/` entries of published packages:
  Vite/Vitest enable it by default and would resolve consumers to unshipped source. Use `ezychat-source`.
- tsx ignores tsconfig `customConditions`; pass Node `--conditions=ezychat-source` (`.npmrc`
  node-options does it for npm scripts and npx). Each core package keeps its own `vitest.config.ts`
  reusing the root `sourceResolve`, or `npm test -w` resolves `@ezychat/*` to a missing or stale `dist/`.
- A file a published package ships (desktop server host, preloads, status page) is found from the package
  folder (`dirname` of the compiled module), never `app.getAppPath()`: inside another edition that is the
  edition's app, not `node_modules/@ezychat/<pkg>`. Pick paths that are identical for Lite so its layout stays.
- A build that writes into a `dist/` it never cleans ships deleted modules in `npm pack`: clean it first,
  keeping only what another script owns (desktop: `dist/server/`, `dist/package.json`). An `.mjs` bin must
  compare `realpathSync` paths to detect "run directly": npm links bins as symlinks on macOS/Linux.
- Vite library mode inlines CSS assets as base64 and our CSP has no `font-src data:`: extract fonts
  back to files. tsc keeps `@/` aliases and side-effect CSS imports in `.d.ts`: rewrite or strip them.
- Test unpublished `@ezychat/*` versions with `npm install --no-save <tgz>` of a tarball carrying the
  pinned version; never commit a `file:` dependency.
- Extension tables must not store `chat_jid` until a merge hook exists: `mergeChat` moves core tables only.
- A scratch tsx script with top-level `await` outside the repo must be `.mts` (`.ts` there builds as CJS).
- Write code containing backslashes with the Write tool, not Bash heredocs (they mangle `\\`); build
  regexes from template literals with `String.raw`.
- A stopped background shell (e.g. Claude Code's low-memory reap) can leave its `tsx` server child running:
  check the port owner (`Get-NetTCPConnection -LocalPort <port>`) before a restart, else it fails with
  EADDRINUSE; stop the old process by its PID only after you confirm its command line. Before e2e or a
  full suite, list `node.exe` processes whose command line has `mock/run.ts` or the repo path: old mock
  servers survive for days. Run coverage, e2e and electron-links as separate background commands (each
  logs its own exit), so a low-memory reap of one does not lose the others; stop a no-longer-needed Dev
  Build first, by its port owner: stopping the background shell task leaves the `tsx` server child
  running on the port and its data folder (a restart then reads the old log as "ready").
- Run `node -v` before verifying: nvm4w switches Node machine-wide and Node 20 breaks this repo (Vitest
  workers die with exit code 3221225477 before any test runs; jsdom test files fail with "Failed to start forks
  worker … reading 'bind'" while node-environment files pass, so the summary looks like a partial pass; a one-off
  script that loads `better-sqlite3` segfaults, exit 139). Put `D:\nvm\v24.13.0` first on PATH for every command, one-off scripts included,
  instead of changing the global version. A
  missing `better-sqlite3/build/` is not a failure: the module loads from its `prebuilds/`.
- "No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs" on thousands of files means ESLint
  reads untracked repo copies (agent worktrees): ignore them in `eslint.config.js` (`.claude/worktrees/**`).
- In the Bash tool, `\n` or `\t` inside text that a heredoc passes to Python or sed can arrive as a real
  line break or tab (`D:\dev\test-env` → `D:\dev<TAB>est-env`): write text with escapes, regexes or
  Windows paths with the Edit tool and check the result.
- Run `npm run lint` again after the last code change, also for a script added late: e2e scripts that
  touch `document`/`window` inside `page.evaluate` need `/* global document, window -- … */` (Node globals only).
- The context-mode hook blocks `fetch('http…` inside a Bash command: put Dev Build HTTP steps in a script
  file (scratchpad or `e2e/devbuild-*.mjs`) and run that. A new migration adds its tables to the table list in
  `src/db/migrate.test.ts` (`LATEST` follows `latestMigration()`).
- A browser-side worker (e.g. the WebAssembly voice encoder) is packaged-smoke-tested by serving the
  packaged `resources/web` from the packaged server (`--web-dist`, `ELECTRON_RUN_AS_NODE=1`, `--fake-wa`)
  and driving Chrome; build with `--dir --config.directories.output=<scratch>`.
- Teammate-written data keyed by `chat_jid` never `ON DELETE CASCADE` from `chats` (like `notes`): an app
  rollback runs an older `mergeChat` that deletes chat rows without moving new tables.
- Several tables carry SQLite `CHECK` lists (e.g. `chat_events.type`): adding a value needs a table rebuild
  migration, so check `001_init.sql` before designing a new enum value.
- Write files containing regex escapes, `\n`, `\b` or Windows paths with the Write/Edit tools (or
  `String.raw`), never via Bash/Python heredocs (the Bash tool collapses `\\`); a scripted edit that
  must match a literal `\n` goes in a script file built with `chr(92)`. Then grep for U+0008 and broken literals. On Windows,
  Python writes need `PYTHONUTF8=1` and `newline='\n'` (text mode writes CRLF, like PowerShell
  `Set-Content`; `file <path>` shows it). Unicode escapes can still land as the raw invisible character
  (lint `no-irregular-whitespace`): match invisible characters with `\p{Cf}`/`\p{Cc}` classes and
  check suspicious lines with `od -c`.
- Multi-line scripts go in a file (PowerShell breaks `node -e`); prefer PowerShell/Grep/Read over slow Git
  Bash; prefix `git show ref:path` and any argument that starts with `/` (an API path such as `/ai/x`) with
  `MSYS_NO_PATHCONV=1` in Git Bash, or it becomes `C:/Program Files/Git/ai/x`. The user profile path has a
  space ("Jazz Tong"): always quote command substitutions, e.g. `"$(cat graphify-out/.graphify_python)"`.
  The owner name has it too, so `ls -l` columns shift in Git Bash: read sizes with `stat -c %s` or PowerShell
  `Get-ChildItem`, never `awk '{print $5}'` on `ls -l` (it reported a 1.7 MiB bundle as 0.19 MiB).
- Run `prettier --write` only on files you changed (the repo is not Prettier-clean).
- Never rebuild a web dist that any running server serves (blank page, 404 assets): stop, rebuild, start.
  A browser that hit the broken build keeps a service worker serving `index.html` for the new assets
  ("MIME type text/html"), even after the restart: unregister it and clear caches before re-checking.
  Finish browser checks before packaging.
- Delete custom build output folders (`release-*`, `dist-*`) after use; ESLint ignores them, but they
  still waste time and can confuse other tools.
- Before any desktop build, check where running instances execute from (`/api/health`,
  `sc qc wa-team-inbox`); build updates to `--config.directories.output=<new folder>`; services run only
  from a Program Files install.
- Version bumps: `npm pkg set` the root, `npm run version:sync`, edit only workspace entries in the
  lockfile, and verify `/api/health` and the UI show the new version.
- Bundled workers can break where source runs pass: a package whose `exports` lists `require`
  first with a CommonJS file inside `"type": "module"` (simple-yenc) bundles with no exports.
  Resolve such packages to their ESM build in `bundle-server.mjs` and smoke each bundled
  worker with plain node and one real job.
- macOS without a Developer ID: sign ad-hoc (`identity: '-'`), never `identity: null`; an unsealed bundle
  opens as "damaged" on Apple Silicon. Release CI runs `codesign --verify --deep --strict` on every `.app`.
  A correctly ad-hoc-signed app still shows "Not Opened … could not verify … free of malware" (expected,
  not a bug): users click Done, then System Settings → Privacy & Security → Open Anyway. Only a Developer
  ID + notarization removes that prompt. Gatekeeper checks only downloaded (quarantined) apps: a local
  build never shows the prompt, so test macOS releases from the downloaded DMG. Homebrew is no way around
  it: 5.0 removed `--no-quarantine` and disables casks that fail Gatekeeper (from September 2026).
- Packaging: asar-unpack native loaders with their `.node`; pin esbuild's `ws` build; mac builds need an
  explicit `--mac dmg:<arch>` and a native-runner smoke; smoke packaged servers with
  `ELECTRON_RUN_AS_NODE=1` on a temp data dir. A feature that adds a native module or worker is smoked
  end to end in a `--dir` packaged build (e.g. voice: copy the model in, simulate a voice note on
  `--fake-wa`, check the transcript), not just server start-up.
- GUI smoke tests use plain Electron with a temporary profile (packaged apps ignore entry arguments).
- Playwright may lack Chromium: fall back to `channel: 'chrome'` (scripts too). A fake microphone:
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`. Run e2e alone (memory); browser test
  sign-in honours `Retry-After` instead of weakening limits. Click a `SegmentedControl` option by its
  `<label>` (it covers the small radio). Capture drawers and dialogs with viewport screenshots: full-page
  shots stretch fixed elements and hide the drawer's scrolling body.
- Vitest: no globals (call `cleanup()` in `afterEach`, assert on `textContent`); native subprocess tests get
  their own timeout and are re-run with one worker before changing assertions; lazy-locale tests use a
  10 s `waitFor` and 20 s test timeout; fixtures mirror Tailwind preflight (`border-style: solid`).
  Heavy end-to-end unit tests (hundreds of chats) set an explicit timeout: the Windows CI runner is
  several times slower than local runs. The server test project now defaults to 30 s per test and hook
  (`SERVER_TIMEOUTS` in `vitest.config.ts`), because a branch that only adds test files pushed old
  `makeTestApp()` tests past Vitest's 5 s on Windows CI three runs in a row; other projects still set
  `describe(name, { timeout: 30_000 }, …)` when a test builds an app or migrates a data dir, and
  `vi.waitFor` around real async work gets `{ timeout }` (its default gives up after 1 s).
- Radix RadioGroup arrow-key tests: `{ArrowRight>}`, `waitFor`, `{/ArrowRight}`.
- Case-insensitive filesystem: move legacy files before adding same-name shadcn files.
- Windows background scripts: launch via a short-lived `powershell -Command Start-Process …`, wait for its
  exit code, and test the real launcher end to end. Stopping a background shell task does not stop the
  `node`/`tsx` server it started on Windows: stop the server by the PID listening on its port (after
  checking its command line), and confirm a port is free before a re-run, or the re-run tests old code.

- Playwright `getByRole({ name })` matches substrings: when a new control's label contains an existing
  one's ("Open customer details for …" vs "Customer details"), make the old locators `exact: true`.
- Run Prettier on the files you changed only (`npx prettier --write <files>`): pointing it at a folder
  reformats untouched files (shadcn primitives, tests).
- Run the final verification in stages (typecheck, lint, tests per workspace, web build, e2e), not
  one chained command: on this dev machine the chain can be stopped for low memory, losing every result.
  A "stopped for low memory" notice for a background server stops only its shell: the server usually
  keeps running. Check the port (and the process command line) before you report it stopped or delete
  its data folder; stop finished servers of your own to free memory. A suite cut short this way leaves
  a partial coverage report: its threshold errors and 20 s timeouts are not findings (rerun the failed
  files alone); push and read the PR CI run for the full-suite result.
  Web tests time out under load: rerun failures alone and the web suite with `--maxWorkers=2`
  before treating them as real.
- After rebuilding `apps/web/dist`, restart the server (it lists the static files at start) and
  unregister the browser's service worker; otherwise the page goes blank with `text/html` MIME errors.
- nvm4w switches Node machine-wide: check `node -v` (22+) before tests or a server start when
  `better-sqlite3` suddenly fails to load; never switch it back from inside one agent's run.

- Count reports on request only with indexed per-chat look-ups (`messages (chat_jid, timestamp, id)`) for the
  chats in the period, never a window function over the whole history: SQLite runs on the server's only thread,
  so a slow count freezes every inbox. Benchmark with 100k–300k messages and cache the result briefly.
  Bound every per-chat look-up from below too (`timestamp >= <last reply>`), or it still reads the chat's whole
  history; when rewriting a count for speed, fuzz the new query against the old one on random data.
- Stopping a background shell does not stop the node server it started: before a restart, stop the process that
  listens on the port (`Get-NetTCPConnection -LocalPort <p>`), or the next check runs against the old server.
- A screenshot or check script that connects many times must pace itself under the app's rate limits (connect and
  test: 10 a minute per admin); a "Too many attempts" screen is the limit working, not a bug.
- A spec that creates shared state (Lite's single AI agent) changes which branch other specs take: run e2e with one
  worker before reporting, because the order differs from the parallel run, and give each "already exists" branch its
  own assertion that runs on desktop too.
- Lite → Enterprise merge (`lite-import/merge-tables.ts` `TABLE_PLAN`): every new core table must be listed as merged
  or skipped with a reason; the coverage test fails otherwise. A branch with a migration runs
  `lite-import-merge*.test.ts` and `upgrade-from-oldest.test.ts` after every rebase, not only its own files. A failed hand-over after a committed merge restores the
  pre-import backup (`onCommitted` undo) so Lite and Enterprise never both keep one number.
- A read-only better-sqlite3 open of a stopped WAL database still creates `-wal`/`-shm` files: remove them afterwards
  when a folder must stay byte-identical (Lite's data during an import).
- One-shot CLI commands that exit right away log through a synchronous pino destination; the rotating server logger
  opens its file asynchronously and loses the last lines.
- A migration that rebuilds a table other tables reference with ON DELETE CASCADE must copy and restore those rows (`INSERT OR IGNORE`): migrations run with foreign keys on. Tests that rewind `user_version` must also undo the later migrations' columns and indexes.

## Security

- Data a device keeps for one user (saved queries, service worker photo/file caches) is cleared on every way a session
  ends, not only the sign-out button: the `session:revoked` socket event and a 401 from `/api/me` too
  (`startQueryPersistence` `clearCaches`). Test each path.
- A script that writes files to a folder named on the command line resolves it against the repository and refuses
  anything outside it (SonarCloud `jssecurity:S8707` fails the security rating otherwise).
- A third-party browser widget that needs outside scripts (Google's file picker) never goes into the app window: its
  CSP stays `script-src 'self'`. Serve it on its own host-only page with a CSP limited to that vendor, guarded by a
  one-time token, and hand it an access token once (`connectors/google-sheets/picker-page.ts`).
- Stop a Playwright run with its servers: killing only `playwright` leaves the e2e web servers on 7497/7498 holding the
  ports, and the next `npm run e2e` hangs at "WebServer" without a test result. Check `ps` for old `cli.ts --port` processes.
- A destructive elevated step (remove a service, move data) can still be checked on the owner's live PC: keep
  its read-only checks in their own function (`windowsUninstallPrechecks`) and run the real detection, UAC
  prompt and elevated runner with only that part (`e2e/devbuild-lite-unlock.mjs`). With the owner's agreement
  the reversible real half can run on the live install too (`--real`: remove the service, scan), stopping
  before what cannot be undone (the import hands the number over); tell the owner how to undo it. A chat
  warning does not stop a click: a Dev Build window handed to the owner on a PC with a live install ran the
  whole import. Make the irreversible step impossible there (test data, or a build that refuses it) instead.
- A Lite marked moved (`moved.json`) while its service is installed cannot start (exit 4, the service stays
  stopped), and the "Use EzyChat Lite again" screen appears only in standalone mode. Restore order: Remove
  service → open Lite → Use EzyChat Lite again → install the service again. A copy import took Lite's port,
  so the restored Lite saved the next free one (7421): find the real port from the service process's
  listening socket before calling Lite down, and tell the owner to set it back for LAN bookmarks.
- An elevated script that writes into a user-writable folder (data moved back to the profile, then
  `icacls /reset /T`) must refuse first when that folder or any folder above it is a link (junction, symlink),
  and check every "would stop halfway" condition (target already has app.db) before it touches the service.
- A row the API redacts but keeps (a message deleted for everyone keeps its text for admins) needs every
  reader of the raw columns guarded, not only `rowToMessage`: the mention presenter, chat previews, the media
  route and redownload all read `body` / `media_path` directly. Every later `present()` attach step too: a
  Safety finding names the file and text, so a deleted message drops it (check this when merging main).
- A script that writes to a folder named on the command line fails the SonarCloud gate (S8707, path
  traversal): resolve it and accept only the repo or `os.tmpdir()` (`path.relative`, no `..`), and check
  ports. Read a PR's Sonar issues with a script file: `api/issues/search?componentKeys=ossmalaysia_wa-team-inbox&pullRequest=<n>&types=VULNERABILITY` (public, no token).
  Tests of such a guard build paths from `os.tmpdir()`, never `/tmp`: macOS's temp folder is `/var/folders/…`.
- Every `/api/ai` route is admin-only (`ai-routes-access.test.ts` lists them all): an AI route that every
  signed-in user may call lives outside that prefix (`GET /api/reply-suggestions`, `/api/chats/:jid/ai/*`).
- An edition limit (e.g. `maxInboxes`) never widens access by itself: a data dir can hold more rows than
  the current limit (an older run, a dev flag). Shortcuts like "one inbox → everyone sees all" check the
  stored rows too, and rows over the limit are never connected.
- A per-IP limit keys IPv6 by its /64 (`rateLimitKey`): one client owns the whole /64 and can
  rotate addresses in it. Every new IP-keyed limiter uses the key; logs keep the full address.
  Known limits: ISPs that hand out a /56 or /48 still allow rotating between /64s, and people
  sharing one /64 (an office via the tunnel) share one limit.
- Allowlists in request hooks must match the decoded path and the matched route, never only the raw URL
  prefix: `/%61pi/...` routes like `/api/...`.
- Edition cards in privileged windows are plain data; the main process opens link/email buttons from its
  own copy of the card, never from an address the page sends back.

- Treat an AI handover as its own committed notification event: the last inbound message may have
  belonged to the AI. Route to the new human assignee or active human team, and cover connected,
  offline, disabled and AI recipients separately.
- Never skip web push because a user is "online": online counts sockets per user, not per device, so
  a hidden desktop window or a phone app still connected in the background swallowed every phone
  push (the AI even assigns hand-offs to online agents). Push to every subscribed device; only the
  desktop app shows `notification:new`, and it has no push subscription. Log counts per send.

- Code that walks an uploaded file (Ogg pages, packets) keeps fixed memory: aggregate into a bounded
  result as you go, never collect one entry per item, and cap the upload size for that file kind.
- Recheck credentials, sessions, disabled state and roles after any async hash/verify, immediately before
  a synchronous commit.
- Privileged desktop IPC is bound to the registered window, exact main frame and bundled URL.
- Services execute only protected runtimes (Program Files ACLs/links on Windows; root-owned copy without
  ACLs on macOS).
- Updates require trusted SHA-256 and size, private staging, restricted redirects and a rehash before
  handoff; an unelevated broker records results and relaunches.
- Password generation requires Web Crypto. Redact credential fields from live logs (deep scrub of objects,
  arrays and Errors) and sanitise historical exports.
- One-time secrets (new access tokens) never become a react-query query or mutation result: the
  mutation hands them to the showing component's state via a callback and returns metadata only;
  clear that state when the dialog closes. Tests assert the secret is absent from both caches.
- Per-key limiters or caches reachable without a session must expire entries and cap their size.
- An MCP tool that takes a link (e.g. `send_image` `imageUrl`) downloads it only through `guardedFetch` (https,
  public address checked at connect, size and time cap) and checks the file type on the bytes; a large-body tool
  raises `bodyLimit` on its own route only, after the token check in `onRequest`, never the app-wide 1 MB.
- OAuth for MCP: build the issuer and resource from `new URL(...).origin` (no default `:80`/`:443`),
  because MCP clients compare origins exactly; anyone can register an app, so the approval page shows
  the redirect host (not the app's self-chosen name) and never redirects a request it has not checked.
- Real-app OAuth checks run through a Quick Tunnel (claude.ai and ChatGPT reach only public https). An
  agent never types a password on a tunnel host, even a demo one: the owner signs in there, the agent
  clicks Approve and runs the rest. Keep guide screenshots cropped to the dialog (no sidebars) and blur
  token prefixes.
- Audit writes reachable without a session (failed token sign-ins) go through a per-IP-and-reason
  limiter, or anyone can flood `audit_log`.
- Access checks for an endpoint that must stay hidden or limited (off → 404, peer, token, rate limit)
  run in Fastify `onRequest`, before body parsing; in the handler, a bad body answers 400/413 first.
- Every raw `node:http` handler parses the request target inside try/catch and answers 4xx; an uncaught
  throw ends the server process.
- Document parsers run in a worker with time, memory and expansion limits.
- Never trust a media file's self-declared length or size (Ogg granule, headers): count the real
  packets before decoding or uploading, and cap decoded output, because customers send crafted files.
  Test such limits with genuinely oversized input, not by editing the header (that is the attack).
- Guards in front of AI tools fail closed: an argument path that does not resolve refuses the call, and arguments
  are checked against the tool's schema first (extra keys are dropped). A per-chat or per-day limit reserves its
  slot synchronously with the check, before any `await`: the AI SDK runs the tool calls of one step in parallel.
- A signed list that the app downloads is trusted only after the signature over the exact bytes, a sequence that
  never goes down, and the hash of every referenced file pass; one bad file rejects the whole list.
- Two signed lists that share keys sign a domain prefix before the bytes (`ezychat-templates-v1\n` + file): zod
  strips unknown keys, so a validly signed list of one kind can parse as the other and replace it with an empty list.
  Give each list file its own marker field too (`catalog: "templates"`).

## WhatsApp / Baileys

- `WaAdapterEvents` has no "profile photo changed" event: a cache of WhatsApp photos (`avatars/store.ts`) refreshes
  by age (24 h) and keeps the last good photo when a refresh fails. Serve the bytes yourself with a version in the
  URL (`?v=<hash>`, immutable) instead of a 302 to WhatsApp's CDN: over a slow tunnel each redirect was a ~0.7 s
  round trip on every open, and the CDN URL expires anyway.
- Baileys group changes report refusals two ways: `groupParticipantsUpdate` / `groupRequestParticipantsUpdate` return
  per-person `{status: <code>}` (403 + `add_request` = privacy, send the invite), while subject, description, settings
  and invite-code calls throw a Boom whose `data` is the code (401/403 = not a group admin). Map both; fail closed.
- A core route that calls an optional `WaAdapter` method passes through an adapter error whose `err.code` is in the
  feature's shared error list (e.g. `GROUP_ADMIN_ERRORS`), with its natural status: Enterprise adapters (`wa-cloud`)
  signal whole-request refusals that way, and a catch-all 502 hides them.
- Nothing on the connect path may await the network without a bound: `fetchLatestBaileysVersion()` has no timeout,
  and awaiting it in `open()` kept the QR on "connecting" forever. Connect with `waVersion.current()` and refresh in the
  background (`wa-version.ts`); a connect refused for an old version reconnects with the refreshed one.
- A WhatsApp ERROR ack is not proof a message was not sent: in a group it is one ack for the whole message even when
  only some members' devices failed. A later delivered/read receipt overrides it, and a Retry of a message that has a
  WhatsApp id re-sends under that same id (`WaSendOptions.messageId`), never a new one: a new id is a second copy.
- Edits and deletes arrive as a `protocolMessage` (`MESSAGE_EDIT` / `REVOKE`; `normalizeMessageContent`
  unwraps the `editedMessage` wrapper) whose outer key is the author and whose `key.id` is the changed
  message; Baileys also re-emits them as `messages.update`, so read one path only (`baileys/protocol.ts`).
  Our own edit or delete echoes back `fromMe` like the phone's, during `sendMessage`: mark the target before
  sending and skip that echo, and keep the core's apply step idempotent anyway (same text, already deleted).
- Baileys emits the echo of our own send (`messages.upsert`, `fromMe`) before `sendMessage` resolves:
  data only the sender knows (e.g. which teammate sent a reaction) must be added after the send by an
  idempotent step that works whether the echo came first or later (`ReactionRepo.applyOwn`), and the
  fake adapter echoes first so tests hit that order.
- A column a migration backfills (e.g. `chats.wa_jid`) is NULL in rows an older release writes after a
  downgrade, and the migration never runs again: read it with a fallback (`waJidOf`, `COALESCE`) and
  find rows by a key both versions write (`upgrade-from-oldest.test.ts` covers it).
- A chat key is opaque (`<waJid>#<inboxId>` outside inbox 1): read the JID shape (`@lid`, `@g.us`, phone)
  from `chats.wa_jid` / `waJidOf`, and send `waJid`/`waMessageId` to WhatsApp, never the key.
- Data about a person (not a conversation) must not stay keyed by the chat key alone: the same person has
  one chat per inbox. Customer contact fields sync across `linkedChats` (same JID or PN/LID pair, never a
  re-pointed number); per-inbox data such as tags stays per chat so access scoping holds
  (`inbox-access.test.ts` pins it). Run the access tests when widening any write across inboxes.
- The linked account is never a contact, chat or alias (`aliases.learn` ignores own pairs), and in
  groups WhatsApp shows it only by its LID. Anything that names people (mentions, member lists) must
  also check `status.me.jid` and `status.me.lid` (from `sock.user.lid`) and name it from `status.me.name`;
  a tag of the owner otherwise shows as a bare number.

- Keep mention JIDs separate from the original body and resolve names at every presentation path, including inbox/notification previews before truncation; sender names alone do not name tags. Legacy numeric tags must be unambiguous across phone/LID identities, and recycled phone contacts must never supply another person's name.
- A WhatsApp tag is two parts: `@<user part of the JID>` in the text **and** the address in `mentions`
  (`contextInfo.mentionedJid`); text alone shows no tag and notifies nobody. Store the sent tags on the outgoing
  row (`mentioned_jids`) so the queue rebuilds them after a wait or restart and the presenter names them. Gate
  sending on `WaCapabilities.mentions`, never on a type name: Meta's Cloud API documents no mentions field.
- A new capability flag in a shared contract must be optional (`z.boolean().optional()`, read as `=== true`):
  a required field, even with a zod default, breaks every typed literal of the type in Enterprise tests and in
  Lite's own (`InboxCapabilities` in `Groups.test.tsx`, `wa-cloud.test.tsx`). Grep tests that pin the whole
  capabilities object (`toEqual({ qrLink: … })`) and update them in the same change.

- A voice note is Ogg/Opus sent with `ptt: true`; pass `seconds` and `waveform` (64 bytes, 0–100)
  yourself or Baileys needs optional music-metadata/audio-decode (`waveform` is missing from its types
  but is sent). Browsers record WebM or MP4, never Ogg: encode Ogg/Opus with a WebAssembly encoder.
- Identity is pinned to `Browsers.ubuntu('Chrome')`; "Desktop" identities get 428 before any QR. Never
  change it without a live QR check.
- Message timestamps are whole seconds, so a quick reply can tie with the message it answers: logic
  that needs cause-before-effect orders ties by `rowid` (stored order), never by the WhatsApp id.
- Anything that needs the original `WAMessage` (a quote, media re-download) must not rely only on the
  adapter's in-memory cache (2,000 entries, cleared on reconnect): pass a saved copy from the database
  (`WaQuotedRef` → `quotedFromRef`; `key.remoteJid` = the chat the reply goes to), or the feature
  silently degrades after a restart. Re-point cached ones too (`quotedForChat`): a message cached under
  the phone-number address while the reply goes to the LID becomes a "foreign chat" quote.
- Any change under `packages/wa/src/baileys/**` needs a live smoke on a test number; otherwise say
  "untested against real WhatsApp". Fake-adapter tests prove nothing about linking.
- Pairing codes work after the first QR offer; the following 515 "restart required" is normal.
- Don't download history media eagerly; treat transient network errors as non-fatal; reset reconnect
  backoff when the server responds.
- Decide media state by id (`local-` = app upload), never by sender; test inbound and phone-sent messages.
- One person can arrive as a phone-number JID and a LID: chats are keyed by the LID once known
  (`jid_aliases`); duplicates merge only in the startup identity migration, reading
  `wa-auth/lid-mapping-*.json` offline. Never merge on a name or number match.
  Learn live phone/LID pairs (e.g. from group metadata) before looking up a person's chat, so a
  recycled number never resolves to its old owner; key any new chat by the LID, and trust anything found via a number (shown number, chat, About, photo) only while it still routes to the
  same LID, through one shared check rather than one fix per path. A re-pointed number's
  names, About and photo belong to the old owner: never copy them (guard centrally in `syncNames` via `movedAway`: never a source, never a destination), and key per-person caches by the LID (server caches and web query keys alike).
- Anything that re-keys or deletes a chat moves every `chat_jid`-keyed table (check `ON DELETE CASCADE`)
  and in-memory per-chat state in the same transaction. Never run `VACUUM`/backups inside
  `db.transaction`.
- `FakeWaAdapter` ids carry a per-process prefix; when a dev test "does nothing", check de-duplication first.
- Test copies of real data: `db.backup()` snapshot, minimal `wa-auth`, no `secret.key`, `--fake-wa` on
  loopback.

- Group members (`groupMetadata`) carry no names and may hide phone numbers (LID groups): names come
  from contacts and existing chats, never inferred. Read the list on demand with a server cache (an in-flight read that gets invalidated is discarded) that
  `groups.update` / `group-participants.update` invalidate; fetch About and photos one person at a
  time, only when asked for. A LID-only member may already have a chat whose fallback name is its
  number: never show a number as a name. Most About reads come back empty (privacy), which is normal; WhatsApp lookups (About, photo) throw on failure and failures are never cached; only a real "none" (photo 404/401) is. Baileys (rc14) resolves a timed-out query to `undefined` instead of throwing: treat a missing result as a failure.
- Baileys (rc14) delivers one live reaction twice: as a `reactionMessage` in `messages.upsert` and as
  `messages.reaction`. Read one path only (the upsert, which history batches share); history keeps older
  reactions on the reacted message itself (`WebMessageInfo.reactions`).
- Anything WhatsApp attaches to a message by its id (reactions, receipts) can arrive before the message
  or before an own send is renamed from `local-…`: key it by the stored message key, keep it, attach it
  at presentation, and let a newer timestamp win so a late history copy never undoes a live change.
- A chat keyed by a LID often has no name of its own while its `contacts` rows (phone and LID forms,
  `aliases.group`) carry the push and saved names: a screen that names a person must fall back to those
  facts, never only to `chat.whatsappName` (the customer panel showed "No name set" above its own
  "Name on WhatsApp" row).

## AI sales agent

- A connector tool that writes into a customer-visible business system (a sheet row, a calendar event) must store the
  customer's text as data, never as something the other system runs: Google Sheets `append` with
  `valueInputOption=RAW` (USER_ENTERED would run `=HYPERLINK(…)`), and pin it with a test that writes `=…`.
- A Lite → Enterprise import test that fakes "an older Lite" by dropping the newest tables must be extended with every
  new migration's tables, or it fails with "table already exists" (`lite-import-merge.test.ts`).
- A fixed rule in `CORE_RULES` that says the admin's rules "never override" it silently beats the admin: the model
  handed over a consultation request as needs_action against saved "never hand over" rules because the core listed
  "book" as an action. Keep built-in hand-off reasons narrow, state which ones the business rules may rule out
  (only safety/sensitive cannot), and pin repro prompts with a rule-following stand-in model plus a bite proof.
  A change to the prompt layout or the `/api/ai` routes also breaks the pinned tables elsewhere
  (`test/ai-prompt-agents.test.ts` cache-prefix bytes, `test/ai-routes-access.test.ts` route list): run
  `npx vitest run packages/server/test/ai-*` before pushing, not only the files you edited.
- SonarCloud's gate also scans `e2e/` scripts: a CLI argument used as a `spawn` cwd or path is a path-traversal
  vulnerability (security rating C fails the gate) and copied API/check helpers push duplication past 3 %.
  Validate such paths (realpath + the expected package inside) and import the Dev Build helpers from
  `e2e/devbuild-client.mjs` instead of copying them.
- Never append fixed text to a model reply (a check-in line, "closing this chat") without a per-agent switch, and
  never treat a "yes" as a confirmation when it carries new facts: a "yes we are in Malaysia" to another question
  closed a live lead. Resolution guards must check what else the message says, not only how it starts.

- Every path that stops the AI in a chat must also leave a human owner or an unassigned chat: a phone reply
  (`fromMe`, no `sentByUserId`) only paused the AI, the chat stayed assigned to it, and later customer
  messages reached nobody. When you add a stop condition, test the next inbound message too.
- A send-time guard for automatic AI replies (`canSend` in `sendJob`) runs on every queue attempt, including a
  person's Retry: the AI marks the question answered when WhatsApp first takes the reply, so a later ERROR ack
  (e.g. Baileys `smax-invalid (479)` on a fresh encryption session) left an AI reply that no Retry could send.
  Exempt explicit human actions from automatic-reply guards, and test Retry of a failed AI message. The same
  guard lets an AI reply out only while its customer message is unanswered (`eligible`): send first, then set
  `last_replied_message_id`. "Did the team act since?" queries must skip the AI's own messages
  (`sent_by_user_id = AI user`); a phone message (`sent_by_user_id` NULL) counts as the team.
- Core AI rules stay connector-neutral: a connector's "skill" is its tool descriptions and result notes, plus
  server guards in its own module; never a tool or connector name in `CORE_RULES` (one general rule covers tools
  that make a change). Details the AI passes to such a tool must be checked against the customer's own messages
  or the saved contact, so the model cannot invent them. A write tool's "when to call" must name the exact
  trigger: "every customer with a real buying interest" made `add_lead_row` fire on a price question.
- AI text that may reach a customer and is built from chat data (phrase lists, drafts) gets its name filter
  from every customer of the inbox, not only from the chats it read: a model can still write a name it saw
  elsewhere. Read the first real build's output before calling it done (it showed copied note lines).
- Anything a person waits for (completions, Ask Ezy turns of 2–3 tool rounds: 13–23 s on the workhorse, 8–13 s
  on `gpt-6-luna`) needs the connection's fast model, never the saved workhorse: ChatGPT `gpt-6.1-sol` took 3–9 s per structured answer (0 of 10 completions shown in 0.1.58),
  `gpt-6-luna` 1.3–2.2 s. The account's model list (`~/.codex/models_cache.json`) shows each model's purpose
  and reasoning levels; measure options with direct timed calls before choosing.
- Test typing features with person-like timing (120–260 ms a letter, pauses after words, stops inside a word),
  not `fill()` plus a long wait: people type on during a 1.5 s model call, so a design that cancels on every
  key never shows anything. Keep the request while the text extends it and show the part still ahead.
- When a grey-text check "never" sees the overlay, check the check: `className.includes('hidden')` also
  matches `overflow-hidden`. Look at the screenshot before believing a timing table.

- Ready-made Business context (templates) uses blank fill-in lines (`Opening hours:`), never sample
  values or `[your price]` placeholders: the AI repeats a placeholder as a fact, but a blank line is no
  fact, so it hands over. Build template instructions as the type's tested text plus a short business
  part, and test the length limits in every language. A Custom template has no starting text: its business
  part is the whole role (no leading blank lines, no sales/FAQ text). A template that changes how an agent
  works (Claims: groups only) flips switches only on a new agent; an existing agent gets a note, because
  turning direct chats off hands its open chats back. A text naming a sheet tab keeps the tab's real name
  in every language, and its test accepts the language's quotes (zh-CN writes “Claims”).
- An MCP tool that writes text a person reads in a box must say the format: AI assistants hard-wrap long
  text at about 60–80 characters, and the box shows every line break, so rules looked cut short. The
  `update_ai_setup` description and `text` field say "one line per paragraph or list item".

- A choice offered only on create (an agent's Sales / FAQ / Custom type) is out of reach when the edition
  allows one item that cannot be deleted (Lite: one agent, `last_agent`), and for every upgraded install whose
  item was created by a migration. For each create-only field, ask "can this user ever create again?"; if not,
  it must also be editable.

- A key check maps each provider status on its own: a **400** from Anthropic is the account (e.g. "credit
  balance is too low"), not the network, so it must never read "could not reach". Read only the short
  error object of a 400 (type for the log, the message only matched), and before blaming the code send the
  same request with a fake key: a 401 proves the request shape is right.

- Claude 5.5 models think adaptively, and thinking tokens count toward `maxOutputTokens`: with the default
  effort a 2,000-token reply could stop early, parse as malformed and hand the chat over. `ai/claude.ts`
  sends `providerOptions.anthropic.effort = 'low'` (`CLAUDE_EFFORT`); raise it only together with the cap,
  and check a new provider's hidden token use before setting a reply limit.

- A migration that splits one owner into several (one AI member → one agent per inbox) must also move what
  the old owner holds (assigned chats, pending state) to the new owner of each scope, in the same
  transaction; otherwise those chats stay with an agent that never answers them.
- A Dev Build check of prompt wiring needs no real model: a mock provider that answers with what it
  received (`e2e/agents-devbuild.ts`: name, guardrails first, `MARK-…` words per knowledge part) proves
  isolation and order end to end; a data-moving migration is also checked from the installed release
  (`ELECTRON_RUN_AS_NODE=1 "<install>\EzyChat Lite.exe" …\server.cjs --data <temp>`), then the branch on
  the same temp folder (`e2e/devbuild-agents-upgrade-check.mjs`).
- When one thing becomes many (one AI member → one agent per inbox), every extension slot keyed by
  kind (`agentSections` with `agent: 'sales'`) must also get the instance id, and the screen review must
  include an Enterprise Dev Build: its Connectors card named the inbox-1 agent on every agent page, which
  no Lite test or Lite screenshot could show.
- A soft-deleted user (a deleted AI agent) leaves Members and assignee lists, but name lookups for old
  messages (directory, MCP) must still include it, flagged (`aiDeleted`), or its history turns nameless.

- Every behaviour the admin instructions may ask for needs a decision the schema accepts: "do not reply to
  ok/thanks" with no silent action made the model send an empty reply, which failed validation and handed
  the chat over as `ai_unavailable` (~2 % of turns). Never wrap a failure without keeping its kind, original
  class and status for the log, or every cause looks like the same plain `Error`.
- Diagnosing a live hand-off: the installed service's log (`C:\ProgramData\wa-team-inbox\logs`) is
  admin-only. Start from the chat history (MCP `get_chat`: hand-off reason + timestamps; a few seconds
  between claim and `ai_unavailable` = a fast provider error, not a timeout), then ask the owner for
  Admin → Audit → **Download logs** (redacted zip, no admin shell) and read the `AI answer unavailable`
  line (errName, status, finishReason; no message text). Never hand the owner admin-shell commands for it:
  long one-liners wrap and break when pasted, and `*.log` under `C:\ProgramData\wa-team-inbox` matches the
  WinSW wrapper log first (filter `server*.log`).
- Models write Markdown (`**bold**`); WhatsApp bold is `*one asterisk*`, so `**x**` shows stray asterisks to
  customers. Tell the prompt the WhatsApp format and clean the reply before sending; never trust either alone.

- A prompt change made for an edition (e.g. look-up wording) also changes every Lite reply: rerun the full
  Lite suite and a real-model `e2e/devbuild-ai-check.mjs` run on Lite before merge.

- Measure AI speed from the `ai_turn` log line (source live/try, `ms`, `stepMs` per model step, `steps`)
  and `ai_tool_call` ms, never by feel: a look-up turn is two model steps, and the tool itself is usually ms.

- The empty-Business-context rule lives in three places (live reply, `tryAnswer`, `saveMember`) and the
  prompt says "only the supplied business facts": all four must count extension look-ups as a fact source,
  or connector-only agents hand over without calling a tool.

- Rank new AI features from the real inbox, not guesses: MCP `get_stats` hand-off reasons (missing facts =
  look-up connectors, needs action = action connectors), then a read-only subagent classifies recent chats and
  reports only counts and paraphrased situations, never names, numbers, emails or verbatim personal data.
- For AI connectors to outside systems, use the AI SDK MCP client (`createMCPClient` from `@ai-sdk/mcp`:
  HTTP transport, OAuth `authProvider` or headers, redirects refused by default) and pass `client.tools()`
  to the agent turn; do not hand-build HTTP tools. Allow only admin-enabled look-up tools.
- ChatGPT sign-in needs loopback port 1455 (fixed by the OAuth client). Any program can hold it, including a
  Docker container that publishes 1455: find it with `Get-NetTCPConnection -LocalPort 1455` and
  `docker ps --filter publish=1455`. Error copy must name the port, not guess Codex/OpenClaw. The port is
  not configurable (OpenAI accepts only `http://localhost:1455/auth/callback`); when it is busy, continue in
  paste mode (the admin pastes the final address; PKCE makes the code useless to the port holder).
  Docker holds a published port for as long as the container runs, even if the app inside listens only
  during sign-in: never publish 1455 permanently; use paste mode in containers.
- Profile extraction retains a bounded new-message batch during bursts, but drops cancelled batches
  after off/connection changes. Bind each field to a source and recheck staff edits and identity routing
  at the atomic save/audit; latest-only work loses split details and revived work ignores human decisions.

- Anything an outside assistant can change that reaches customers (AI instructions, rules, context)
  is versioned on every save, app saves included, with a baseline of the replaced text, plus an
  audit row naming the token and its reason and a per-token rate limit: the assistant also reads
  customer text, so a crafted message could steer a change. When a feature makes a "read-only"
  promise untrue, fix every place that states it (app copy in all locales, public guides) with it.
  A write tool validates with the app's own limits (service methods trust callers), and any tool
  whose output an assistant must send back whole (replace-all text, restore) returns it in full via
  pages (`offset` / `nextOffset` / `lastPage`, by code point), never silently truncated.
- To compare hand-off rules (`try_ai_reply` with a draft), test with facts the business context
  contains: an unknown item hands off as `missing_facts` before any rule is weighed, so both rule
  sets look the same and the test proves nothing.
- Features that connect outside AI tools are vendor-neutral in name and copy ("AI assistants", MCP),
  never one provider's name; state which clients a given auth method actually supports.
- A new MCP tool must be added to every exact tool-name list in the tests (`mcp.test.ts` and
  `mcp-ai-setup.test.ts`): grep `server/test` for an existing tool name before pushing.
- The server applies a token's scope change on the next call, but MCP clients cache `tools/list` until
  they refresh or reconnect: tell the owner to refresh the connection (same token) after a change.
- MCP analytics are aggregated on the server (`get_stats`, `get_activity`), never left to the model
  paging through `get_messages`; define every derived metric in the tool description (e.g. "new
  conversation = customer message after 12 h of silence") so the client cannot guess its meaning.
- Any paid model call started from the UI is cancellable end to end: the page aborts its request when
  the user closes or replaces it, and the route aborts the provider call when the client disconnects.
- AI SDK on the Responses API (`ai/agent/models.ts`): with `store:false` also `include`
  `reasoning.encrypted_content` (else `item_reference` to unkept reasoning ids → HTTP 404); lift the
  SDK's `system` message into `instructions` (cache layout; the ChatGPT route rejects `system`); set
  `maxRetries: 0` (it retries twice by default); pass only our fixed error messages (HTTP ≥ 400).
- Agent turns: bound the whole turn (all steps), not each model call; and give Try it the same tools
  as live replies (minus chat-bound ones), or it stops testing what customers get.
- A time a model passes to a tool is checked for ISO shape before `Date.parse`: V8 parses loose text
  ("tomorrow at 10") to a number, so a guessed time slips past a NaN check. Book only a time the server
  itself offered in that chat (stored offer + a customer reply after it), never the model's own pick.
- Tests that ingest many messages under frozen fake timers must tick the clock between them: equal
  timestamps reorder by id and can push the message being answered out of the last 20.
- Vitest fake timers do not control `AbortSignal.timeout`: bound a call that a test must time out with a
  `setTimeout` that aborts an `AbortController` (cleared in `finally`).
- Prompt/AI-behaviour changes are proven by mock-provider tests only: report them as "untested against
  a real model" and offer the owner a Dev Build check (fake WhatsApp, demo data, the owner's own key).
  Use `e2e/devbuild-ai-check.mjs` (demo chats belong to people and a hand-off ends the AI's turn, so
  each scenario gets a fresh number) and log every run in `docs/dev-build-checks.md`.
- Ownership follows who handles the chat: a teammate's inbox reply claims an unassigned chat and takes
  over an AI-owned one (the AI then stops); it never takes a chat from another teammate, and phone-app
  replies assign nobody. Pausing the AI without moving the owner left a stale AI chip.
- The model proposes, code decides: guard every action (resolve only after a customer confirmation;
  objections keep the chat open).
- When the AI promises a human follow-up, the code hands the chat to the team. Questions about X stay with
  the AI; requests to do X (order, book, pay, cancel) are handed off and never resolved.
- Prompt caching: instructions stay static; per-call facts (date, time, state) go in the last input block;
  cache keys come from a stable install id + model, never customer data. Only `GUARDRAILS` is a shared
  prefix for a new kind of AI call: `CORE_RULES` holds the agent's decision format and hand-off rules, so a
  call with another output (drafts, rewrites) needs its own fixed rules block instead.
- A human takeover can land mid-generation: abort, invalidate queued replies, and recheck ownership and
  the latest customer message right before sending. Notify automation on live receipt, before media
  downloads.
- Provider and member settings have separate write schemas; reset the model when switching providers and
  validate before saving; keep drafts local while polling.
- ChatGPT OAuth: refresh tokens rotate (reuse stored tokens newer than the failed ones; single-flight is
  not enough); offer a paste-the-callback fallback for tunnel/LAN admins; classify blocked responses
  (403/404/HTML) as a connection state, then stop claiming and release chats silently.
- The ChatGPT sign-in takes text and images but no audio: Codex `input_audio` returns 400 "Audio input
  is not available", `input_file` rejects audio MIME types, and the web dictation endpoints
  (`/backend-api/transcribe`) answer 403 `cf-mitigated: challenge` even with the Codex CLI fingerprint
  (the Codex desktop app's dictation passes only with native device attestation; Hermes abandoned this
  route, OpenClaw's broke) — never fake attestation or work around bot challenges — and the Codex CLI's
  speech engine (`thread/realtime/*`, incl. its transcription mode) refuses ChatGPT login: "requires API
  key auth". Speech-to-text needs an OpenAI API key. Spike a provider capability with one live call first.
- The AI is notified before live media downloads (300 ms debounce once it owns a chat): wait for a
  `pending` customer image (`message:new`, bounded) before calling it unreadable; trust the file's
  bytes, not the declared MIME. Async `fs/promises` reads stall under `vi.advanceTimersByTimeAsync`.
- Fastify routes capture `ctx.services.*` when the app is built. Replace a service in a route test
  inside `makeTestApp`'s `beforeBuild`, never afterwards, or the route keeps the real service (that
  once sent a real OpenAI request with a placeholder key).
- A route that calls an outside service takes its client from an optional `ctx.services.<name>` slot
  (e.g. `aiKeyTest`), set in `makeTestApp`'s `beforeBuild`, so tests never reach the network.
- An API key test treats only a 401 as a bad key: a 403 (restricted key, region block), 429 or
  network failure must still let the admin save. e2e and screenshot scripts answer every model-backed
  route in the browser with `page.route` and demo output (`POST /api/ai/connection/test`,
  `/api/chats/:jid/ai/suggestions` and `/ai/complete`), so a real screen runs without any model call.
- Voice notes are transcribed before the AI decides (bounded wait on `pending`); an untranscribed
  one gets one "please type it" reply, and the code, not the model, hands off a repeat. The
  model's structured output has no `unsupported_message` reason, so the server maps it.
- A server guard that compares a tool's earlier result with "the customer wrote since" must accept any
  earlier offer, not only the newest: real models call the read tool again in the turn that acts
  (check free times, then book), which records a newer offer after the customer's answer. Mock-model
  scripts must include that re-check, and test against real Google/model in the owner test env.
- Prompt layers: safety rules live in the fixed system prompt and state that administrator instructions
  never override them; editable instructions hold role, scope and style only, company facts go in the
  Business context, and hand-offs are structured actions, never text markers (they would reach the
  customer).
- Data shipped inside the app (a built-in fallback list) uses `minAppVersion: '0.0.0'`: unit tests run as
  `0.0.0-test`, so any higher minimum marks the built-in entries "needs update" in tests and Dev Builds.
  In the published list (`ezychat-connectors`), `minAppVersion` is compared with each edition's own version
  (Enterprise 0.1.22 while Lite is 0.1.71): never put a Lite version on an entry for both editions; a
  `builtin` entry keeps `0.1.0`, because an app without that connector skips it anyway.
- Server unit tests may import an `e2e/` helper only as `.mjs` with a `.d.mts` type file: a `.ts` file outside
  `packages/server` breaks its typecheck (TS6059 rootDir).
- Never trust a model to continue "exactly where the text stops": ask for the whole current sentence and cut the
  typed part on the server (`continuationOf`: longest typed end from a word start, case and spaces ignored), so the
  grey text never repeats what was typed and the space after a finished word comes from the model's own sentence.
- Code that assumed "the AI only talks in direct chats" breaks when groups get AI answers: an AI send must not
  claim a group (`claimOnReply`), pause/cancel logic keyed on the chat (`onChat`) must skip groups, and tools that read
  the customer profile need an empty contact in a group. Grep for `type === 'dm'` assumptions before widening a path.

- A per-item helper built on a list helper that filters (`conversation([message])[0]!`) crashes on the filtered
  item: use `flatMap` so the helper keeps the filter. A deleted group message broke every live group AI turn.
- A draft prompt that tells the model to use a value (a group member's name) must put that value in the fact-check
  `sources`, or the number check drops correct drafts ("Kopi88 Ali"). Group prompts send no customer details.
- A connector gives access (which tabs, which tools), the agent's instructions say when and why: never hard-code a use case (leads, claims) into connector code; tool descriptions are built per turn from the allowed tabs and their live first rows.
- A provider mode whose request format is undocumented for a content type (ChatGPT backend and PDFs) gets a text fallback, never a guessed part type.

## Desktop and web UI

- Every round trip counts over a slow tunnel (~0.7 s each): the live connection reloads every query when it joins,
  so a list already on screen waits for that reload (with a short fallback) instead of loading itself; an infinite
  list reloads every loaded page, so persist and restore page 1 only. One open loaded `/api/chats` up to 6 times.
  The PWA caches (`sw-routes.ts`) never store a `no-store` answer, are cleared at sign-out and on a user switch,
  and a media file is cacheable only once WhatsApp Safety's AI check has answered (`safety.cacheable`).
- A list row with a label and action buttons (join requests, approvals): keep a phone number `whitespace-nowrap` and the
  buttons in one `ml-auto shrink-0` group, so a narrow panel moves the whole group below instead of truncating the
  number or putting one button per line (a `min-w-*` on the label did the latter at 360 px).
- Screen-review states the fake WhatsApp cannot produce (offline with a cached panel, another connection type's
  capabilities, a 422 from WhatsApp) come from `page.route` on that one GET/POST in the capture script, with the real
  app rendering them (`e2e/group-management-screens.mjs`); never add a dev-only server switch just for screenshots.
- A dialog whose body holds buttons (show details, add files, remove) uses a plain container, not a `<form>`: shadcn
  `Button` defaults to `type="submit"`, so every toggle sent the report. Send stays an explicit button in the footer.
- A route that takes several files reads `req.parts({ limits: { files: N, fileSize } })`: the app-wide multipart limit
  is 1 file and a second file resets the connection, which the browser reports as "cannot reach the server".
- Show customer PDFs with pdf.js on canvases from bytes we `fetch` (`lib/pdf.ts`), never by serving `application/pdf`
  inline or in an iframe: the media route keeps PDFs as `attachment` + sandbox CSP, Chromium's own viewer is blocked in
  sandboxed frames and missing on phones. Load pdf.js and its worker (`?url`, `worker-src 'self'`) lazily, check
  `%PDF-` before parsing, keep `enableXfa: false`, draw only pages near the screen, and close via the loading task
  (pdf.js 6 has no `PDFDocumentProxy.destroy`). A new computed `fetch` in `apps/web` needs a line in the contract
  test's `REVIEWED` list.
- A page that counts across inboxes (Reports, its Safety section) takes one optional `inbox` query param and the page's
  picker passes the same choice to every section; a section left on "all" next to a one-inbox total misleads.
- A UAC prompt started by the hidden runner (`runElevatedWindows`: `Start-Process -Verb RunAs` from a
  windowless PowerShell) can open behind the app window: the owner saw only "Waiting for Windows". Every
  screen that waits for it says where to look (taskbar shield, Alt+Tab).
- Mock screenshot scripts that need the AI to hold a chat must switch the AI member on first (`GET /api/ai`, then
  `PUT /api/ai` with `{...settings, enabled: true}`; an earlier run can leave it off and the assign answers 400), and
  scope a select to its container (`page.locator('header').getByRole('combobox')`): the chat list's inbox filter is
  the page's first combobox.
- An e2e assignee check on the shared e2e agent proves nothing: it has no AI connection, stays off, and an off AI is
  never offered anyway. Cover assignee filters with `buildDirectory` unit tests and a Dev Build check instead.
- A Radix sheet opened by a tap can get that tap's late `pointerdown` on Android Chromium (e2e project `mobile`)
  and close at once as "outside": mark the opening buttons (`data-ask-ezy-trigger`) and `preventDefault` in
  `onInteractOutside` for them. jsdom does not reproduce it; only the Pixel e2e does.
- The e2e server's data is shared by every spec in the run (another spec saves an AI key): a spec that needs
  "no AI connection" or other global state mocks that route, and `chatItem()` takes a chat id, not a name.
- `userEvent.setup()` installs its own `navigator.clipboard`: in a test, replace the clipboard after setup, or
  the component writes to user-event's stub and a `writeText` mock sees no call.
- A shadcn `Button` with an icon pads through `has-[>svg]:px-*`, which beats a plain `max-sm:px-2`: write the
  override as `max-sm:has-[>svg]:px-2`, then check the screenshot (the class can be present and do nothing).
- Electron shows no right-click menu of its own: any copy/paste/spelling/image action the desktop window needs
  comes from a `context-menu` handler (`apps/desktop/src/context-menu.ts`, a pure template builder with tests).
  Offer image and link items only for inbox URLs / http(s) links, never `blob:` previews or `javascript:`.
- Files dragged or pasted into the page: check `dataTransfer.types` for `Files` (text and link drags must stay
  native), let a clipboard with `text/html` paste as text (Office and browsers add a picture of copied text), and
  keep the page-wide drop guard so a missed drop never opens the file in place of the app.
- e2e files that the page renders as images must be real images (a 1×1 PNG): fake bytes behind an image type
  produce a CSP `connect-src blob:` console error in the built app and fail `pageHealth`.
- A button inside shadcn `CardHeader` stretches to the card width (the header is a grid, so `self-start` does
  nothing): put it in `CardContent` (a flex column) or the `CardAction` slot; check the screenshot, not the code.
- Review a chart with one data point too (a new install's first day): a flex bar fills the whole chart and an
  SVG area becomes a triangle. Cap bar widths and draw a single point as a bar or dot.
- Hover readouts on charts (or any pointer-driven detail) clear only on a `pointerType === 'mouse'` leave: on
  touch a tap fires `pointerleave` right after `pointerdown`, so the tapped value vanishes. Check the 360 px touch
  shot, not only desktop hover.
- Screenshot scripts wait ~400–500 ms after opening a `Dialog`/`Select` and after enabling a filled button: the
  open animation shows the page through the dialog, and `transition-colors` keeps a just-enabled button in the
  grey "disabled" colour. Check `button.disabled` before calling a grey button a bug.
- Word matching on mixed text puts `\p{Script=Han}` before `[\p{L}\p{N}]+` in the alternation: Han is also
  `\p{L}`, so the other order makes `谢谢您` one "word" and any "at least 2 words" rule never fires for Chinese.
- Never render a component that has its own `<form>` (pairing code, extension slots, dialogs with a form)
  inside another form: invalid HTML, React logs a hydration error and the browser drops the inner form.
  Put it after the outer `</form>` and point the footer button at the form with `form={id}`.
  `apps/web/vitest.setup.ts` fails every web test that logs an invalid-nesting error.
- Two ways to do one thing on a screen (sign-in vs access token): name the simple one **Recommended**
  with numbered steps and the apps it is for, and put the expert one behind a closed "For developer
  tools" section; a primary button for the expert way reads as "required" to non-technical owners.
- A `flex` `<li>` loses its list number: keep the `<li>` plain and put the flex box inside it. Check
  numbered steps in a real screenshot, not only in tests.
- A radio card whose label repeats another control's word (a template card showing its type "FAQ")
  makes `getByRole('radio', { name: /FAQ/ })` ambiguous: give such radios an `aria-label` of their own
  name only.
- Measure desktop memory per process with `app.getAppMetrics()` in an Electron harness that forks the real
  `dist/server-host.cjs` + `server.cjs` as a utility process and opens the real `createMainWindow` (temp data
  and profile, `--fake-wa`). Read GPU and renderer separately: the GPU process keeps its memory after the
  window is destroyed, and `--fake-wa` never loads Baileys, so real-WhatsApp numbers are higher.

- Windows has no flag emoji in its font: Chrome on Windows shows 🇲🇾 as the letters "MY" while phones and
  Macs show the flag. Not a parsing bug; fixing it needs a bundled flag font (e.g. a country-flag
  polyfill), not a change to `formatWhatsApp`. Check an emoji report on the reporter's device first.

- Renaming a visible label ("API key" → "OpenAI API key") breaks e2e steps and tests that match the old
  words, including audit-label tests: grep `e2e/` and `*.test.ts*` for the old text in the same change.

- In e2e, scope a sent or received message text to the conversation
  (`getByRole('log', { name: 'Messages' })`): the chat list preview shows the same text, and a plain
  `getByText` fails in strict mode only when the preview updates first (flaky, not every run).

- A shell component that starts calling a new hook from a widely mocked module (`api/queries`) breaks
  every `vi.mock('../api/queries', () => …)` factory that lacks it: grep those mocks and add the hook.
- A permission between two things (member ↔ inbox) is edited from both screens: the member's row and the
  resource's own Add/Edit dialog. Both write the one store, so they never disagree; admins with implied
  access show as badges, never as tick boxes.
- `ResponsiveTable` renders the desktop table and the phone rows at once (one is hidden), and on phones an
  open conversation hides the chat list but keeps it in the page: a Playwright
  `getByTestId(...).first()` can pick the hidden copy and time out. Wait on
  `locator('[data-testid="…"]:visible')` (`getByRole` already skips hidden elements).
- Message text is shown the way WhatsApp shows it (`lib/whatsapp-format.tsx`: marks hidden, React nodes
  only, no classes; the bubble styles the tags). A new place that shows message text uses
  `formatWhatsApp` (bubble) or `plainWhatsApp` (one-line previews), never the raw body.
- The updater jumps to the newest release (GitHub list, or Enterprise `latest.json`), never through the
  versions between: an upgrade step lives in a numbered migration or in permanent start-up code, never
  only in one release.
- The installed (old) app runs the update install, so a fix in that path cannot reach users through it:
  the CHANGELOG line, release notes and the owner's message say "install this version once from the
  download page", with the permanent `latest` links.
- A stored result ("Update installed") names what it is about and shows only while it still is: tie
  it to the version that runs and hide it beside a newer offer, or it reads as a claim about that offer.
- The desktop main log (`desktopLog`, updater events) lives only in memory: to debug an in-app update,
  read `<userData>/updates/downloads/` (a growing `<uuid>.part`, then `<sha256>-<installer>` of the
  manifest size) and the installed exe's version before blaming the network or the feed.
- Feature mocks rot with the code: the confirmed reference stopped compiling after the `@ezychat/*`
  rename. Clone it, fix only mechanically (renames, type drift), record the fixes in
  `reference.json` → `baselineDriftFixes` and refreeze the hashes so `snapshot.mjs --check` stays
  meaningful. A runner that replaces Vite's `resolve` with only an alias drops the `ezychat-source`
  condition and serves stale `dist/` packages (a new field never reached the page): spread the web
  config's `resolve`.
  A mock stand-in route that later ships in the core (`POST /api/feedback`) stops the runner with
  `FST_ERR_DUPLICATED_ROUTE`: start a clone once before editing it, and register stand-ins only when
  `app.hasRoute(…)` is false.
- An outgoing message's id is `local-<clientId>` until WhatsApp accepts it, then the WhatsApp id: an
  API or tool that returns it must say so, and tests must find the row by `client_id`.
- A socket event that arrives while its list is still loading is lost: the load's older answer replaces the
  patched cache, and React Query reuses a running first load instead of restarting it on
  `invalidateQueries`. Wait for the running load to end, then reload (`reloadAfterRunningLoad`). An e2e
  test that fails only in the full run is usually such a race: read its failure screenshot, never just
  rerun it.

- Electron fires `will-frame-navigate` before `will-navigate`; `preventDefault()` in the first cancels the
  second, so a link handler only in `will-navigate` never runs (every `mailto:` button did nothing). Handle
  external links where you block. Browser e2e never runs the desktop window's rules: prove such a change
  with a harness that loads the REAL `createMainWindow` (`npm run e2e:electron-links`) and fails without it.
- A test whose fake answers every request proves nothing about the contract: two obvious bugs (a GET to a
  POST route, a link swallowed by the window) passed every unit test. Test a client against the real
  route table or the real server (`web-client-contract.test.ts`, `makeTestApp`), and check that the new
  test fails when the bug is put back before you trust it. Such a test builds a TypeScript program from the
  source: do it once in `beforeAll` with a 60 s limit. A scan inside each `it` passed alone and timed out
  (over 5 s) in a busy full run (Enterprise's copy, fixed for 0.1.19).

- Owner-facing setup screens: plain words ("key", "sign in with the system", "things the AI can look up"),
  protocol terms (MCP, OAuth, Bearer, 401, tool ids) only behind "Advanced / for your developer"; on phones put
  errors at the field or top of the drawer and keep the drawer actions sticky, never below the fold.
- Format only the files you changed inside a feature mock: `prettier --write` over `mock/src/**`
  rewrites frozen baseline files and breaks `snapshot.mjs --check`.
- Cloning a mock for the next proposal: move the old proposal to `baselineProposal`, add its added files to
  `inheritedUnchanged` and drop only the files this proposal changes. Compare the counts that `--check` prints
  before and after: a drop in inherited files means the check got weaker and still passes.
- The cumulative mock seeds chats in different inbox types (Jason Lim and Priya Nair are in the WhatsApp Business
  API inbox "Online orders"): demo a feature that depends on `WaCapabilities` in a Kopi Apong (linked-phone) chat
  and gate the mock UI by `inboxOfChat(...).type` too, or the screenshots show it where it can never work.
- A mock shot script that saves something (e.g. Save in a dialog) changes the mock's data: run it once
  on a freshly started mock, and restart the mock again before the owner opens it. Restart after a failed
  run too, and send server-side effects (messages) from one viewport only: every browser context starts
  from the mock's localStorage seed while the server keeps what earlier contexts sent.
- A mock shot script ends by writing `mock/screenshots/results.json` (`ranAt`, `passed` shot names, `failed`
  problems; a `--setup` run merges into it): reviewers and the e2e-shots pane read a run's outcome from it
  without running the script again.
- A mock that replaces a screen (Admin → WhatsApp → Inboxes) must carry the old flow into the new one: the
  first multi-inbox mock showed only the new Business API type and dropped the QR-linked phone, and the
  owner caught it. List the replaced screen's flows in `design.md` and show each in the new screen. When
  the mock's own localStorage seed changes, bump its storage key so open browsers get the new seed.

- Audit detail controls sit with the action or in their own layout slot, never inline with the
  summary sentence; compact links preserve list density while retaining 44px touch targets.

- The microphone needs a secure page (https, localhost, the desktop app): a LAN `http://` link has
  none, so say why instead of failing. Create the `AudioContext` before any `await` in the tap
  handler (Safari records silence otherwise); WebAssembly needs CSP `'wasm-unsafe-eval'`.
- Async start and stop (microphone, encoder) must be cancellable: number each attempt and drop what
  resolves after Delete or unmount; give stop a failure path and a timeout that always closes the
  microphone. Keep a recording until its upload succeeds, and give it one clientId for every attempt
  (the server dedups by clientId, so a retry never sends twice).
- Confirmations use the `AlertDialog` primitive (focus trap, Escape, portal), never an inline
  `role="alertdialog"` div; e2e locates it on `page`, not inside the panel.
- A settings row's control slot (`shrink-0`) holds only the control; any text a reused component brings
  along (hints, warnings) goes under the row (`PreferenceRow` `below`, `PushToggle` render prop), or it
  squeezes the description. A bare switch handed to a row keeps a 44 px target (padded `<Label
htmlFor>`, `min-h-11 min-w-11`). Desktop-only text (`window.watiNotifications`) needs a check with
  that bridge injected: the browser Dev Build never shows it.
- In a direct chat, every place that names the customer (quotes, reply bar) uses the header name
  (`chatTitle`: profile → saved → WhatsApp name), never the message's `senderName`; groups name senders.
  Demo data (assigned chats, profile names) catches this; bare e2e fixtures do not.
- A touch gesture (swipe, long-press) never replaces a control: keep a real button for screen readers,
  switch access and keyboards (`pointer-coarse:not-focus-visible:sr-only`, shown when focused).
- Addresses the UI tells people to use (setup commands, URLs) come from the server's running config
  (`ctx.config.port`, tunnel status), never from saved settings, which may apply only after a restart.
- Admin links and fallback redirects use absolute `/admin/...` paths; test every section transition and
  malformed URLs.
- Every screen works at 360px: check dialog bounds and inner clipping (not just page overflow), cap dialog
  height with dynamic viewport units, wrap long titles, and use real 44px hit targets (padded labels).
  After text changes also run `SMOKE_LOCALE=ms node e2e/screens.smoke.mjs` (Malay is longest).
- Shrink dense desktop controls only with `md:pointer-fine:` (mouse), never by breakpoint alone:
  tablets are touch at `md`, and 44px targets must survive there.
- Playwright `getByLabel('Password')` is a case-insensitive substring match that also hits
  aria-labels like "Show password": use `{ exact: true }` for form fields in e2e helpers.
- A child that writes into a parent-owned ref (guards, Esc handlers) registers it in an effect with a
  cleanup; render-time writes outlive the unmount and leave the parent calling a dead closure.
- Prefilled forms keep two baselines: "unsaved changes" compares with what the form opened with,
  the save merges against the stored record (so a prefill is saved but never prompts a discard).
  A WhatsApp chat name can be the phone number: never prefill or show it as a person's name.
- In jsdom `useMediaQuery` is false, so panels render as modal Sheets that hide the page from
  `getByRole`; query background controls with `{ hidden: true }`.
- Bars and rows that share width with columns or side panels (chat header, inbox list rows) size by
  their own width (`@container`), not viewport breakpoints: the desktop inbox list is narrower than a
  phone. Truncation assertions target the element carrying `truncate`, and must
  fail without the fix (a check on its parent passed while the name showed one letter).
- Modal backdrops use the `bg-overlay` token (`rgb(0 0 0 / 0.5)`), never `bg-black/50`: its
  `oklab(0 0 0 / 0.5)` paints fully transparent in current Chrome, so dialogs stop dimming the page
  (bottom drawers hid it because vaul adds its own backdrop). Guarded by `ui/overlay.test.ts`.
- A before/after review of long text shows the changes with one line of context and folds the rest
  ("⋯ 19 unchanged lines"); a full-text diff buries the change below the fold.
- A multi-step task on a page (describe → review → apply) opens in a dialog (a full-height bottom sheet
  at 360 px), not an inline panel that stretches the card; the page keeps its own Save.
- In a crowded row decide which item gives up width: short, meaningless-when-cut chips (tags, counts) are
  `shrink-0` with a `max-w` cap; names and previews (`min-w-0 shrink` + `truncate`) give way first. Re-check
  rows with every badge present (assignee + tags + unread), not just the demo row that looked fine.
- shadcn primitives defeat naive truncation and hit areas: `TabsTrigger` centres its content (truncate
  an inner `min-w-0 truncate` span), `SelectValue` is `display:flex` (add
  `*:data-[slot=select-value]:block … truncate` on the trigger), and `Badge` is `overflow-hidden`
  (a `before:-inset-*` hit area inside it needs `overflow-visible`).
- Every new audit action gets a label in `admin/audit-actions.ts` (en/ms/zh-CN) and a readable
  meta summary in the same change; otherwise the Audit page shows raw keys and JSON.
- Review screenshots taken after animations settle (wait ~500 ms after opening a popover/sheet):
  mid-fade captures make opaque popovers look transparent and send reviews after false bugs.
- Cached lookup lists (tag suggestions) must be invalidated by the live event that can add entries
  (`chat:updated` with tags), or another tab or teammate sees stale options until the cache expires.
- E2E data that other tests or projects could share (tags, names) gets a per-project suffix
  (`projectTag(info)`); `npm run e2e` rebuilds `apps/web/dist`, so stop any Dev Build serving it first.
- E2E that closes one Radix popover and then opens another waits for the first to be gone
  (`toHaveCount(0)`) and its trigger to be focused (`toBeFocused()`) before the next step: Radix hands focus
  back one timer tick after the exit animation, and under load that late focus lands after the next step,
  dismissing the new popover ("focus outside"). Reproduce such races by delaying zero-delay timers in the
  page, not by raising timeouts. `--repeat-each` on reaction tests hits the 30-a-minute reaction limit.
- Review a UI change on the whole page at 1280 and 360 px, top to bottom, not only the changed
  section: background bands, orphaned blocks and spacing between sections only show in context.
- Marketing screenshots come from `e2e/marketing-screenshots.mjs` on a fresh `--mode standalone` server
  (`dev` mode stamps a "Dev Build" badge); save a placeholder AI key so the AI page isn't red "Needs connection".
  It rewrites every module (times change), so commit only the modules whose screens changed and
  `git checkout` the rest. Demo group members never reuse a customer's number: the member's name renames that chat.
  Headless Chromium reports notifications as blocked, so every admin shot shows the "Notifications are
  blocked" box in the sidebar: crop the sidebar for guides, and never take test-env (Dev Build) data for
  them (test names, repeated chats, the badge).
- Playwright `page.clock.pauseAt(new Date())` is flaky under load (page clock runs ahead: "Cannot
  fast-forward to the past"); pause at the page's own `Date.now()` plus a few ms.
- Never pipe a step into `tail`/`head` inside an `&&` chain: the pipe hides its exit code and the chain
  carries on (`build-summary.mjs record` stage keys are `design|dev|unit|e2e|devbuild|screen`).
- `node e2e/screens.smoke.mjs <url> <outDir>` is the fastest "does every screen render?" check. It
  creates the first admin itself, so run it on a fresh server, not one seeded by `marketing-screenshots.mjs`.
- The shadcn `Textarea` uses `field-sizing-content`, which also grows its width with long lines and
  widens grid dialogs: long-form editors use `field-sizing-fixed` with a fixed height, wide dialogs use
  `ResponsiveDialog size="wide"`; test with a document of long lines, not short fixtures.
- Forms derive untouched defaults from queries and keep explicit drafts; background refresh must not
  overwrite edits.
- Resynchronise active queries on every socket connection; route related live events through one refresh
  scheduler; memoise list rows and coalesce pagination.
- On PWA resume, reconnect only a visible, online, active session with no live or opening transport; Socket.IO's `connect()` alone does not bypass pending backoff. Use public lifecycle methods, remove listeners on session cleanup, and retain the stale-inbox warning until connected.
- Browser resume tests install fake timers before Socket.IO captures them and count attempts before restoring the network; native `online` events can reconnect before synthetic foreground events.
- Gate avatar/photo requests on WhatsApp readiness and reset failures per connection generation.
- One theme source (`data-theme`) drives both tokens and dark variants.
- Durable notices (updates) render declaratively; transient toasts can hide the only action.
- Desktop: one main-process gate for service/data operations; probe and self-recover when a background
  service starts late; a desktop window is not the update owner unless it owns the server or service;
  after an exe/path rename, users must re-pin the tray icon (`NotifyIconSettings`).
- A blank white taskbar icon means Windows bound the window's AppUserModelID to a shortcut whose target
  is gone: scan Start Menu `.lnk` files for `System.AppUserModel.ID`. Unpackaged runs use
  `appUserModelId(false)` (`….dev`) so dev runs never claim the installed app's identity.
- Renames keep data folders, profile, service ID and app ID; plan install-path renames as a one-time
  scripted step; regenerate service XML from code, never hand-patch it.
- Update discovery lists releases and compares strict semver (the latest-release endpoint skips previews).
- Before moving upgrade-contract strings (service/updater scripts, paths) behind config, capture the
  generated output with fixed inputs and require it byte-identical after; check a test product's
  output contains no leftover Lite literals.
- Brand assets: check exported icons on light and dark backgrounds at small sizes.

- Avatar initials use letters only (`initials()`): a name without letters (number, WhatsApp ID, emoji)
  shows a person icon, never `+`, `(` or `~`.
- A chat's details open by tapping its header identity (avatar + name + subtitle are one `Button`; the
  name stays the `<h2>`, screen-reader only): Group info for groups, Customer for direct chats.
- Badges inside a `SegmentedControl` option label get `pointer-events-none`, so a click anywhere on
  the option selects it.
- A `setState(updater)` that reads a ref must read it before the call (`const before = ref.current`): the updater
  runs later, after the code that updates the ref. Shifting marks with `ref.current` inside the updater kept stale
  grammar marks in "Fix N". A popover anchored to a word near the screen edge is `fixed` and measured after render,
  then moved left to fit (an `absolute` card inside a narrow composer ran off a 360 px screen).
- A diff turned into fix marks must never give two marks on one range: merge changes that meet or overlap, and
  never widen an insertion across another change (only over unchanged tokens). Two marks on "email" ("your email",
  "email.") applied one after the other added text twice. Test it as a property: applying every mark gives the
  corrected text, and the fixed text gets no new mark. On the client, tie an AI answer to the exact text it was
  asked for and remember applied fixes per draft: the model answers each check afresh and may re-add the same
  insertion ("email." → "email..").
- OAuth sign-in from a page (ChatGPT, Google Calendar) opens `about:blank` synchronously in the click,
  then sets its URL, and keeps a visible "Open the sign-in page" link for a blocked window.
- Marks drawn in a `pointer-events-none` layer over the composer (grey completion, Fix English underlines) are
  invisible to `document.elementsFromPoint`: hit-test them with each span's `getClientRects()` from the
  textarea's own mouse/click events, and draw them with `text-transparent` (not `invisible`, which also hides
  the underline). Give one-letter marks a tint as well; a wavy underline under "i" or "a" is unreadable.
- When the server lifts a uniqueness rule (one agent per inbox), grep the web for client flows that still enforce it (taking the slot from the other holder, "one per …" hints): unit tests written to the old rule keep passing, only a Dev Build screen review shows it.

- Testing a refused file pick: `userEvent.upload` drops files that do not match the input's `accept` before the
  component sees them; use `userEvent.setup({ applyAccept: false })` when the test is about the app's own check.
- A feature that sends anything out of the app builds what it sends on the server (app details, log) and shows the
  user exactly that text before Send (`GET …/defaults`); never trust the browser for diagnostics, and strip ids and
  numbers from a screen path before it leaves.

## Internationalization

- Searchable catalog content (template gallery `keywords`) keeps the English words beside the
  translated ones, so a search works in either language; Malaysian users mix them ("aircond", "gigi").
  Translate large catalog batches with a field-by-field checker (same keys, lines, list items, colons).
- Every string goes through `t()` with keys in `en`, `ms` and `zh-CN`, including prefilled editable
  content such as default AI instructions (catalog `ai.defaults.*`, English pinned to the server's
  canonical constant by a test); cross-namespace keys need `useTranslation(['ns', 'common'])`.
- Switch language only after `activateLocale` resolves; apply static desktop strings once per locale.
- `errorMessage()` shows the translated generic text for generic codes (`forbidden`, `not_found`, …) and
  the server's English text only for `validation`/`conflict`/feature codes: test the text the user sees.
- Shared shell code serves every edition: no product name or edition-wide constant (name, port, folder) in
  catalogs or code; use `{{product}}` and a `Product` field. Check an edition's first installer on a PC that
  also runs Lite (the Enterprise build said "Starting EzyChat Lite…" and could not start on port 7420).
  The first start writes `desktop.json` with the port, so a changed default reaches only new installs.
  The port is never a fixed contract: `server-host` moves to the next free port and the desktop saves it. A
  free-port test listens only where the server will (`serverBindHost`: loopback unless LAN access is on); a
  test listen on `0.0.0.0` made Windows Firewall ask every user for network access (0.1.65). A bind test
  catches `EACCES` (Windows reserved ranges) as well as `EADDRINUSE`. "The server did not start … may be in
  use" shows for every start failure: read the log first.
- Any change that opens, binds or moves a network listener (port, host, socket, tunnel, a test listen)
  gets a security review before the PR: which interfaces it touches, OS firewall prompts, what a LAN or
  other local program could reach, and the security invariants in AGENTS.md. Run `/security-review` on the
  branch and record the answer in the PR description.
- `<Trans>` component tags must be non-void elements (`<a>`, `<b>`).
- Never write the product name into a catalog string: use `{{product}}` (i18next default variable set by
  `createInboxApp({ productName })`). Only the share-the-app texts keep "EzyChat Lite"; a test enforces it.
- Extension keys (`ext.<name>.*`) are not in the typed core catalogs: read them with
  `useExtensionTranslation()`; never cast `t`. Core catalogs keep the `ext` key reserved.
- Date helpers that take `now` must compare against it, not the real clock.
- Desktop main imports only types from `shared` and mirrors tiny runtime helpers with parity tests.
- Links to ezychat.ai use the page for the app language (`/ms/…`, `/zh/…`) and merge only after
  that page is live on the website; installed apps cannot be re-pointed.

## Cloudflare and sharing

- Slow remote access through the tunnel: measure before changing code. In the browser on the tunnel host, read
  `performance.getEntriesByType('resource')` (count, `transferSize`, duration per kind) and `/cdn-cgi/trace`
  (`colo` = where the visitor enters); on the PC read cloudflared's `/metrics` on `127.0.0.1:20241…`
  (`edge_location`, `quic_client_smoothed_rtt`) by port, never its command line (the token). The dashboard's
  "Edge Locations" are the tunnel side only. From Malaysia, TM/Unifi entered at `SJC` and mobile data at `FRA`
  (Cloudflare status: KUL re-routed) while the tunnel was Singapore at 25–50 ms: ~660 ms per request for a 43 KB
  page, so cut round trips, not bytes. No Cloudflare plan chooses the entry point (Enterprise Regional Services
  only moves decryption); ngrok's region pinning (`ap` = Singapore) does, as do Tailscale (needs its `*.ts.net`
  name in the Host allowlist) or an own Malaysian relay.
- Anchor Sprint Workers deploy with Workers Builds, not Actions: `main` runs `wrangler d1 migrations apply
DB --remote && wrangler deploy`, other branches `wrangler versions upload`. A trigger needs an existing
  Worker tag and a build token: upload a placeholder Worker first and reuse the account's build token.
  Put secrets with `wrangler secret put` from a file, never in a tool call.
- After a preview `wrangler versions upload`, `wrangler secret put` fails (latest version not deployed): use
  `wrangler versions secret put`, then check the latest version's bindings through the API.

- App-managed cloudflared ignores user config (`--config=`) and logs in with a private child home;
  credentials stay encrypted.
- A Quick Tunnel is Running only after URL assignment and edge registration.
- Persist app-owned tunnel/DNS IDs first, retry only those, never overwrite foreign DNS or tunnels; fall
  back to the approved zone when zone listing is denied.
- Unknown named-tunnel hosts are allowed only on the validated loopback proxy path, identically for HTTP
  and Socket.IO.
- Restoration and setup share one tracked operation gate; shutdown waits for it.
- Share only the public project URL; treat a cross-realm `AbortError` from native share as a quiet cancel.
- "Phone access is set up" = tunnel running OR a named tunnel saved (`hasTunnelToken` /
  `namedTunnelHostname`); the tunnel status mode returns to `off` when stopped, so it cannot say
  whether a tunnel is configured.
