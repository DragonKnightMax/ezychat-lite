# EzyChat editions: engineer guide (Lite + Enterprise)

How the free and paid editions share one core, and how to build features for each.
Design record: `docs/superpowers/specs/2026-10-15-open-core-editions-design.md`.

## 1. The model in one picture

```
            ossmalaysia/ezychat-lite (public, MIT)                 anchorsprint/ezychat-enterprise (private)
 ┌──────────────────────────────────────────────────┐        ┌──────────────────────────────────────────┐
 │ packages/shared  → @ezychat/shared               │        │ packages/ent-server  ServerExtension[]    │
 │ packages/wa      → @ezychat/wa                   │  npm   │ packages/ent-web     WebExtension[]       │
 │ packages/server  → @ezychat/server  (runCli,     │ ─────► │ apps/desktop         runCli(edition:      │
 │                    ServerExtension, guards)      │ pinned │                      'enterprise'),       │
 │ apps/web         → @ezychat/web (createInboxApp, │ exact  │                      createInboxApp(ext), │
 │                    WebExtension, UI components)  │ version│                      own Product identity │
 │ apps/desktop     EzyChat Lite installer          │        │ EzyChat Enterprise installer (phase 5)    │
 └──────────────────────────────────────────────────┘        └──────────────────────────────────────────┘
```

- **Lite is the core.** Every free feature, and every extension point, lives in Lite.
- **Enterprise only adds.** It never patches core code; it plugs features in through three extension
  points (server, web, desktop identity) and depends on the published `@ezychat/*` packages,
  pinned to one exact version. No git submodule, no `file:` dependency.
- **Lite never knows Enterprise exists.** ESLint blocks `@ezychat-enterprise/*` imports in Lite.

## 2. Where does my feature go?

| The feature…                                   | Goes in                     | How                                                                                 |
| ---------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| is free for everyone                           | Lite                        | Normal Lite PR                                                                      |
| is free, but with a bigger limit in Enterprise | Lite                        | Core feature; the limit comes from the edition (extension `init` can set it)        |
| is paid, and its code must stay private        | Enterprise                  | `ServerExtension` + `WebExtension`                                                  |
| needs a hook Lite does not have yet            | Lite first, then Enterprise | Lite PR adding the extension point (with tests) → Lite release → Enterprise uses it |
| was paid and becomes free                      | Lite                        | Move the code into Lite, release, then delete it from Enterprise                    |

## 3. Server extensions (`@ezychat/server`)

```ts
import { requireAdmin, type ServerExtension } from '@ezychat/server';

export const reports: ServerExtension = {
  name: 'reports', // /^[a-z][a-z0-9-]{1,31}$/, not 'lite' or 'core'
  migrationsDir: reportsMigrationsDir(), // NNN_*.sql, tables named ent_*
  init(ctx) {
    // runs after every core service is ready
    ctx.bus.on('message:new', (m) => {
      /* … */
    });
  },
  async routes(api, ctx) {
    // mounted at /api/ext/reports/…
    api.addHook('preHandler', requireAdmin(ctx)); // routes are PUBLIC unless you add a guard
    api.get('/summary', async () => ({/* … */}));
  },
};
```

What the core guarantees:

- Routes live only under `/api/ext/<name>/…`, so they can never replace a core route. The global
  Host allowlist and Origin check still apply.
- Extension migrations run on their own track (table `extension_migrations`), one transaction per
  file, before services start. The core's `PRAGMA user_version` is never touched. Two files with
  the same number stop startup before anything is applied.
- `/api/health` returns `edition` (`lite` or `enterprise`); `app` stays `wa-team-inbox`.
- The product starts with `runCli(process.argv.slice(2), process.env, { edition: 'enterprise', extensions })`.

### AI agent tools (`agentTools`)

An extension can give the Sales Agent extra read tools for one turn (a live reply or Try it). The
tools come from the same `ai` package the core uses (`tool`, `dynamicTool`, `jsonSchema` are
re-exported by `@ezychat/server`).

```ts
import { jsonSchema, tool, ToolHandoverError, type ServerExtension } from '@ezychat/server';

export const stock: ServerExtension = {
  name: 'stock',
  async agentTools(ctx, { agent, chatJid, signal }) {
    if (agent !== 'sales') return null; // null = no tools this turn
    const client = await openClient(signal); // chatJid is null in Try it
    return {
      tools: {
        search_products: tool({
          description: 'Find products and stock levels by name.',
          inputSchema: jsonSchema<{ query: string }>({
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          }),
          async execute({ query }) {
            const res = await client.search(query, signal);
            if (!res.ok) throw new ToolHandoverError('stock system unavailable'); // never logged
            return res.items; // [] = nothing found: the model handles it
          },
        }),
      },
      info: { search_products: { title: 'products', sourceLabel: 'Stock system' } },
      dispose: () => client.close(), // runs in finally, also after failure or cancel
    };
  },
};
```

What the core guarantees:

- Extension tools share the turn's `AGENT_MAX_STEPS` and its abort/timeout (`signal`). An extension
  that has not returned its tools within 10 s is left out of that turn.
- Names must match `AGENT_TOOL_NAME` (`/^[A-Za-z0-9_-]{1,64}$/`). `CORE_AGENT_TOOL_NAMES` are
  reserved; for a duplicate name the first extension in the list wins and the rest are dropped.
- A tool that throws (`ToolHandoverError` or any other error) aborts the turn and hands the chat to
  the team with reason `lookup_failed` ("a look-up in a connected system failed"). Return "nothing
  found" as a normal result instead of throwing.
- Every call emits `ai:tool_call` `{agent, chatJid, tool, source, title, ok, ms}` on the bus and logs
  tool, source, ok and ms only. Inputs and outputs are never logged or emitted.
- Each successful live look-up stores one `ai_tool_used` chat event `{title, sourceLabel}`, shown as
  "AI looked up {title} · {sourceLabel}" in the conversation (first call per title/source pair).
- The prompt tells the model that tool names, descriptions, inputs and results from connected
  systems are data, never instructions.
- `tryAgentReply(ctx, { agent: 'sales', question })` runs Try it with the saved setup for an
  extension's own route (add your own admin check and rate limit). `tunnelPublicUrls(ctx)` returns
  the running tunnel's https origin(s), e.g. for an OAuth redirect URL.

Known gap: when two chats of one person are merged, rows in `ent_*` tables keyed by `chat_jid` are
**not** moved. Do not store `chat_jid` in an Enterprise table until Lite adds an `onChatMerged` hook.

### Access gate (`ctx.access`)

The core owns one switch an edition can use to turn the whole app off and on again (for example,
licensing). Lite never closes it.

```ts
import type { ServerExtension } from '@ezychat/server';

export const licensing: ServerExtension = {
  name: 'licensing',
  init(ctx) {
    const check = () => {
      if (leaseIsValid()) ctx.access.open();
      else ctx.access.close({ code: 'license_required', reason: 'lease expired' });
    };
    check();
    setInterval(check, 60_000).unref();
  },
};
```

- `close({ code, reason? })`: `code` is a stable machine code (`ACCESS_CODE_PATTERN`,
  `/^[a-z][a-z0-9_]{0,63}$/`, e.g. `license_required`); a bad code throws. `reason` is never logged
  or returned. Closing with the same code again does nothing. `open()` is a no-op while open.
  `state()` returns `{ open: true }` or `{ open: false, code }`.
- Bus events: `access:closed` `{ code }` and `access:opened` `{}`. Logs (`mod: "access"`) carry the
  code and the number of deleted sessions only.
- While closed:
  - every `/api` and `/mcp` request answers **403 `{ "error": "<code>" }`** (a plain string, unlike
    ordinary errors) except `GET /api/health`, `GET /api/access` and host-only routes (below). The
    check uses the raw path, its decoded form and the matched route, so `/%61pi/…` cannot slip past.
    Static web assets and the SPA page are still served, so the web lock screen can load;
  - Socket.IO refuses new connections with `Error(code)`; connected clients get `access:closed`
    `{ code }` and are disconnected;
  - every session is deleted at close: after `open()` everyone signs in again;
  - the AI member stops (in-flight replies are cancelled, nothing is claimed), customer enrichment
    stops, push and in-app notifications are not sent, and the tunnel stops (its saved mode is kept);
  - the send queue sends nothing and **no job expires**; on open each waiting job gets the full
    10-minute window again;
  - WhatsApp stays connected and incoming messages are still stored.
- On `open()`: the tunnel restarts in its saved mode, the AI member picks up chats whose reply is
  due (within 10 min), and the send queue resumes.
- `GET /api/access` (public, `accessStatusSchema` in `@ezychat/shared`) returns `{ open, code? }`;
  `/api/health` adds `access: 'open' | 'closed'` (missing on older servers: treat as open).

### Look-ups without Business context (`hasAgentLookups`)

An extension that implements `agentTools` should also implement `hasAgentLookups(ctx, { agent })`: a cheap,
synchronous check (no network) that returns true when it would offer at least one look-up now. The core then
does not hand over (or refuse to turn the agent on) only because the Business context is empty, and the
prompt treats look-up results as facts. A throwing check counts as false.

### Send feedback identity (`feedbackAuth`)

`POST /api/feedback` forwards a report to the licence portal (`https://license.anchorsprint.app/v1/feedback`).
Lite sends as product `EZC-LITE` with a random `installRef` (setting `feedback_install_ref`). Another edition says who
it is with `feedbackAuth(ctx)`:

```ts
const ext: ServerExtension = {
  name: 'licence',
  async feedbackAuth(ctx) {
    const licence = readLicence(ctx); // your own code
    if (!licence) return null;
    return {
      product: 'EZC-ENT',
      installId: licence.installId,
      secret: licence.secret,
      company: licence.company, // fills Company in the dialog (GET /api/feedback/defaults)
      portalOrigin: licence.portalOrigin, // optional: https, or http to 127.0.0.1/localhost in dev
    };
  },
};
```

The first extension that returns non-null wins; one that throws counts as null (logged by name only). An edition other
than `lite` with no answer refuses to send (503 `feedback_unavailable`), so its reports are never labelled Lite. An
unsafe `portalOrigin` also answers 503. It runs only when the dialog opens or a report is sent; its values are never
logged.

### Host-only routes (`/api/ext/<name>/host/…`)

By core convention any extension route under `/api/ext/<name>/host/` is **host-only**: it answers
only a direct loopback client (socket peer `127.0.0.1`/`::1`) with a loopback `Host` and no
`CF-Connecting-IP` header, the same rule as first-admin setup. Anything else (the tunnel, LAN
peers, LAN IP or machine-name `Host`) gets 403 before your handler runs. These routes need no
session and keep working while the access gate is closed, so the desktop app on the same computer
can, for example, show and change licence state while the app is locked. They are still public to
every program on that computer: never return secrets, and validate input as usual. The Origin check
for mutating requests still applies (send no Origin, or one equal to `Host`).

```ts
async routes(api, ctx) {
  api.get('/host/status', async () => licenceStatus()); // this computer only, no sign-in
  api.post('/host/activate', async (req) => activate(ActivateBody.parse(req.body)));
  api.get('/plan', { preHandler: requireAdmin(ctx) }, async () => plan()); // gated like core routes
}
```

## 4. Web extensions (`@ezychat/web`)

```tsx
import { Card, CardContent, type WebExtension, useExtensionTranslation } from '@ezychat/web';

export const reportsWeb: WebExtension = {
  name: 'reports',
  routes: [{ path: 'summary', admin: true, element: <SummaryPage /> }], // → /admin/ext/reports/summary
  adminNav: [{ path: 'summary', labelKey: 'ext.reports.nav' }],
  settingsSections: [
    { id: 'reports', titleKey: 'ext.reports.settings', element: <ReportsSettings /> },
  ],
  catalogs: {
    en: { 'ext.reports.nav': 'Reports', 'ext.reports.settings': 'Reports' },
    ms: { 'ext.reports.nav': 'Laporan', 'ext.reports.settings': 'Laporan' },
    'zh-CN': { 'ext.reports.nav': '报告', 'ext.reports.settings': '报告' },
  },
};
// Enterprise web entry: createInboxApp({ extensions: [reportsWeb], productName: 'EzyChat Enterprise' })
```

- User routes mount at `/ext/<name>/…`, admin routes at `/admin/ext/<name>/…` inside the admin shell
  and guard. Every element is wrapped in an `ErrorBoundary`.
- Settings sections appear under Settings → Integrations, below the core sections.
- `agentSections: [{ agent: 'sales', id, element }]` add one compact row each under Business
  context on every AI agent's page (`/admin/members/ai/<id>`; not on the new-agent page); put
  details on the extension's own page. Inside the element, `useAgentSection()` returns the agent
  whose page shows it, `{ agentId, displayName, preset }` (null anywhere else), so a row can name
  that agent and read its own data for it instead of assuming inbox 1's agent.
- An admin route with `section: 'members'` (any core admin section) highlights that nav item and
  names it in the phone header, so an agent sub-page still looks like part of Members.
- `adminNav[].useBadge` is a cheap React hook returning `{ count?, attention?, labelKey? }` or null:
  a count, or an attention dot drawn in the warning tone. An error in it hides the badge, never the
  nav.
- Translation keys must start with `ext.<name>.`; read them with `useExtensionTranslation()`.
- `productName` replaces "EzyChat Lite" everywhere the UI names the app: core catalog strings use
  `{{product}}`, never the literal name (a test enforces it). Only the share-the-app texts keep
  "EzyChat Lite", because they promote the free app.
- Build UI only from the exported shadcn/app components, with token colour classes. The core CSS
  (`@ezychat/web/style.css`) contains only the Tailwind classes Lite uses, so extensions that need
  other utilities run their own Tailwind build.
- `banners: ComponentType[]` render in one slim bar slot at the top of the signed-in shell (inbox
  and admin); each returns `null` when it has nothing to say, and the first non-null one wins.
- `lockScreen: ComponentType<{ code; recheck }>` is shown full page, without sign-in, while the
  server's access gate is closed (`GET /api/access`, or any 403 with the gate code). Return the core
  `PausedScreen` for codes you do not own. The core re-checks every 60 s and reloads once open.
- `createInboxApp({ links })` replaces the About, report-issue, source-code, release-notes,
  feedback and support links (`useAppLinks()`); `null` hides one. Lite's defaults point to GitHub,
  so an edition passes its own.
- Brand files (`icon-192.png`, `favicon.ico`, `apple-touch-icon.png`, `share-app.svg`, …) ship as
  `@ezychat/web/public/*` (`dist-lib/public`); an edition copies them into its web build so the
  EzyChat logo shows.

## 5. Desktop identity (`apps/desktop/src/product.ts`)

Every installer identity value (app ID, data and profile folders, service ID, launchd label, update
feed, installer names) comes from a `Product`. Lite's values are upgrade contracts, frozen in
`LITE_PRODUCT` and pinned by tests. Enterprise defines its own (`EzyChat Enterprise`,
`com.anchorsprint.ezychat.enterprise`, data folder `ezychat-enterprise`, service `ezychat-enterprise`),
so both editions can be installed on one PC. The desktop app only adopts a running server whose
health `app` **and** `edition` match its own.

`defineProduct({ statusSections, updateFeed })` adds the rest an edition needs on the desktop:

- `statusSections: StatusSectionProvider[]` add cards to the desktop status window above App updates.
  A provider returns a plain data model (title, badge, notice, steps, rows, fields, buttons,
  details) and handles button actions in the main process; the window never runs edition HTML or
  script. Link and email buttons open only `https:`/`mailto:` addresses from the main process's own
  copy of the model. Talk to the server through `/api/ext/<name>/host/*` routes.
- `updateFeed: { kind: 'url', url }` reads a JSON manifest (`{ version, notesUrl?, assets: [{ name,
url, sha256, size }] }`) instead of GitHub releases, for editions whose repository is private.

### Starting the desktop shell (`@ezychat/desktop`)

The shell (window, tray, status window, OS service, updater) is published as `@ezychat/desktop`. An
edition's Electron main file sets its product and starts it:

```ts
import { defineProduct, startDesktop } from '@ezychat/desktop';

await startDesktop(
  defineProduct({ edition: 'enterprise', productName: 'EzyChat Enterprise' /* … */ }),
);
```

The package ships the main process, the server host (`dist/server-host.cjs`), the preloads and the status
page (`dist/renderer/`), and finds them in its own folder. The edition's app provides the rest, in the same
layout as Lite (the updater and the OS service rely on it):

| Path in the app                                  | What                                                | Made by                                                                                    |
| ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `dist/server/server.cjs` (+ workers, migrations) | the edition's server bundle                         | the edition's bundle script                                                                |
| `dist/package.json`                              | `{ "version" }`, read by the server and the updater | the edition's bundle script                                                                |
| `resources/web`                                  | the edition's web build                             | electron-builder `extraResources`                                                          |
| `resources/app-icon.png`, `resources/tray/`      | window and tray icons                               | electron-builder `extraResources`                                                          |
| `resources/cloudflared/`, `resources/winsw/`     | pinned binaries                                     | `npx ezychat-fetch-cloudflared --out resources`, `npx ezychat-fetch-winsw --out resources` |

In `electron-builder.yml`, unpack what the OS service runs: `**/node_modules/@ezychat/desktop/dist/server-host.cjs`,
`dist/server/**`, `dist/package.json` and the native packages (copy Lite's `asarUnpack` list). Keep
`npmRebuild: false`: the native modules are Node-API prebuilds.

## 6. Packages and the core update flow

| Package                                             | Built output                                            | Inside the Lite repo |
| --------------------------------------------------- | ------------------------------------------------------- | -------------------- |
| `@ezychat/shared`, `@ezychat/wa`, `@ezychat/server` | `dist/` (JS + `.d.ts`; server ships its SQL migrations) | resolved to `src/`   |
| `@ezychat/web`                                      | `dist-lib/` (ESM + types + one precompiled CSS)         | resolved to `src/`   |
| `@ezychat/desktop`                                  | `dist/` (main process JS + `.d.ts`, `renderer/`) + bins | resolved to `src/`   |

Inside Lite, imports resolve to source through the **`ezychat-source`** export condition (not
`development`: Vite and Vitest enable that by default, which would break Enterprise because the
tarballs ship no `src/`). A plain `node`/`tsx` run outside npm needs `--conditions=ezychat-source`.

Release flow:

1. Lite release tag `v0.1.37` → `.github/workflows/publish-packages.yml` publishes `@ezychat/*@0.1.37`
   (npm trusted publishing, no token; dry run until the repo variable `NPM_TRUSTED_PUBLISHING` is `true`). `scripts/pack-contract.test.mjs` pins what each
   tarball contains. A package that is not on npm yet (first `@ezychat/desktop` release) is skipped with a
   warning: the owner publishes its first version by hand (`npm publish -w @ezychat/desktop --access public`,
   security key) and then adds the trusted publisher for it on npmjs.com.
2. Dependabot opens one grouped `ezychat-core` PR in Enterprise bumping every pin together.
3. Enterprise CI (Anchor Sprint self-hosted Linux ARM64 runners only; private code never runs on GitHub-hosted machines) runs lint, typecheck, tests and builds → merge → Enterprise release.

## 7. Daily development

| Task                                        | Command                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Build the publishable core                  | `npm run build:core` (Lite)                                                              |
| Make local tarballs                         | `npm run pack:core` (Lite → `.core-packs/`)                                              |
| Use an unreleased core change in Enterprise | `node scripts/use-local-core.mjs` (Enterprise; packs Lite and installs with `--no-save`) |
| Run the Enterprise server                   | `npm run dev:server` (port 7434, fake WhatsApp, `./data/dev`)                            |
| Run the Enterprise web app                  | `npm run dev:web` (Vite 5174, proxies `/api` to 7434)                                    |

Never commit tarballs, `file:` dependencies, or a lockfile that points to local paths.

## 8. Rules (both repos)

1. Free features go to Lite. Enterprise only adds paid features through extension points.
2. Enterprise imports only each package's public `index` exports; ESLint rejects deep imports.
   Anything not exported is internal and may change in any Lite release.
3. A missing hook is a Lite PR with tests, released before Enterprise uses it.
4. Never change Lite's upgrade contracts (data folders, profile, service ID, app ID, health `app`).
5. Enterprise tables are `ent_*` and use the extension migration track.
6. Keep `npm run pack:core` working: Enterprise uses it to try an unreleased core change.
7. Both repos: feature branches and PRs; merge only when the owner asks.

### Limits (`maxInboxes`)

The first edition limit. `runCli(argv, env, { edition, extensions, maxInboxes })` (also
`startServer`/`createContext`) sets how many WhatsApp numbers (inboxes) an install may link: Lite passes
nothing (1), Enterprise passes its number. `POST /api/inboxes` answers 409 `inbox_limit` above it; a lower
limit never deletes an inbox, it only skips connecting the rows above it. The web reads it from
`GET /api/inboxes` (`maxInboxes`, `canAdd`), never from `/api/health`. A licence can later set it from an
extension's `init(ctx)`.

## 9. Status and next phases

| Phase                                                                             | Status                                                    |
| --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1 Server extension API                                                            | Done                                                      |
| 2 Web extension API                                                               | Done                                                      |
| 3 Desktop product config                                                          | Done                                                      |
| 3b Publishable `@ezychat/*` packages + publish job                                | Done (published with npm trusted publishing since 0.1.39) |
| 4 Enterprise scaffold (`enterprise-hello` server + web extension, CI, Dependabot) | Done, except the desktop installer                        |
| 4b Publish the desktop shell (`@ezychat/desktop`, `startDesktop(product)`)        | Built; first publish by hand with the next Lite release   |
| 5 Enterprise release channel (signing, public installer bucket, update feed)      | Needs owner decisions                                     |
| 6 Licensing                                                                       | Needs design + mock confirmation                          |
| 7 First paid feature                                                              | Owner picks                                               |
