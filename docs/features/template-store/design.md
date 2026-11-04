# Template store (AI agent templates without an app release)

Status: **proposal**. Owner request 2026-11-04 (main EzyChat session): "how come the template requires an app release —
implement a remote template repository like our connector store". Branch `feat/template-store` from `main`
(`658dbf3`, 0.1.74). Created 2026-11-04 (creationOrder 32).

## Problem

AI agent templates are compiled in: `apps/web/src/admin/business-templates.ts` (`BUSINESS_TEMPLATES`) plus catalog
texts `ai.businessTemplates.<id>.*` in en/ms/zh-CN. The Claims template (#274) reached users only with release 0.1.74.
The connector gallery already updates without a release: a signed list built by `anchorsprint/ezychat-connectors`, published
to `dl.ezychat.ai/connectors/`, downloaded and checked by the server (`packages/server/src/connectors/list/`).

## Decision summary

| Item                          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where templates are published | **Decided by the owner 2026-11-04** (relayed by the main session: "yes, ok to use connector repo"). A `templates/` folder in the **existing** public repo `anchorsprint/ezychat-connectors`, built by the same CI, signed in the same protected `release` environment with the **same Ed25519 keys**, uploaded to `dl.ezychat.ai/templates/` (`templates-v1.json`, `templates-v1.json.sig`). No new repository, key pair or CDN bucket. |
| Why not a new repo            | One review flow (PRs to one public repo), one release environment holding the private keys, one key-rotation story (the app already carries current + next key). A second repo would mean a second set of secrets and a second key pair compiled into the app, with no gain: both catalogs are public data reviewed by the same people.                                                                                                 |
| Cross-list replay             | The template signature is over `"ezychat-templates-v1\n"` followed by the exact file bytes (domain separation). A signed connector list can never verify as a template list, and a template list never as a connector list (the connector signature has no prefix), even though the keys are shared. The file also carries `catalog: "templates"`.                                                                                      |
| Contract                      | `packages/shared/src/template-list.ts` (zod): `TemplateListFile`, `TemplateEntry` (schemaVersion 1), `TemplateCatalog` (REST). JSON Schema for the publishing repo from `scripts/template-schema.mjs`.                                                                                                                                                                                                                                  |
| Icons                         | **Names, not files.** `icon` is a name from the icon set the app bundles (`TEMPLATE_ICON_NAMES`, lucide); an unknown name shows a neutral icon. No image is downloaded, sanitised or served, so nothing in a template can run in the browser. A new icon name needs an app release; until then the neutral icon shows.                                                                                                                  |
| Categories                    | The list file carries its categories (`id` + texts). The six built-in categories keep their catalog names; a new category from the list adds a chip with the list's name.                                                                                                                                                                                                                                                               |
| Built-in fallback             | Today's compiled templates (18, incl. Claims) stay in the web build as version 1 each. Offline, before the first download, with an old data dir, or when the list fails its checks, the gallery shows exactly today's templates.                                                                                                                                                                                                        |
| Override rule                 | A list entry replaces the built-in template with the same id only when its `version` is **higher**; new ids are added. A list cannot remove a built-in template. Entries that need a newer app (`minAppVersion`) or another edition are not sent to the browser, so the built-in copy stays.                                                                                                                                            |
| Apply                         | Unchanged: a template only fills the editable boxes (name, type, role, hand-over rules) and queues one Business context text item for the next Save, after the admin clicks **Apply** (and confirms if their own text would be replaced). Nothing is applied automatically; nothing in a template runs code or changes a connection, key, model or on/off.                                                                              |
| Group-agent defaults          | `defaults: { answerDirect?, answerGroups? }`. `answerGroups: true, answerDirect: false` is a group agent (today's Claims rule): a new agent is switched on Save, an existing one gets the note. Other combinations are ignored for now (only that one flow exists).                                                                                                                                                                     |

## Contract (schemaVersion 1)

```
TemplateListFile { format: 1, catalog: "templates", generatedAt, sequence ≥ 1, categories[≤ 20], entries[≤ 200] }
TemplateCategory { id, name: { en, ms?, zh-CN? } (≤ 40) }
TemplateEntry {
  id            /^[a-z][a-zA-Z0-9-]{1,48}$/  (camelCase ids of the built-ins stay valid)
  version       integer ≥ 1 (the override rule)
  schemaVersion 1
  minAppVersion x.y.z
  editions      ["lite" | "enterprise"] ≥ 1
  category      category id
  icon          icon name (/^[a-z0-9-]{1,40}$/)
  preset        sales | faq | custom
  texts         { en: TemplateText, ms?: TemplateText, zh-CN?: TemplateText }
  defaults?     { answerDirect?: boolean, answerGroups?: boolean }
  recommendedConnectors? [connector id] ≤ 5
}
TemplateText { agentName ≤ 64, name ≤ 60, description ≤ 300, keywords ≤ 300 (may be empty),
               focus ≤ 4000, handoffRules ≤ 4000, contextName ≤ 120, contextText ≤ 20 000 }
```

- **Locale fallback**: a missing language uses the whole English text set (never a mix of languages in one template).
- `focus` is the business part, as today: the browser puts the agent type's starting text (in the admin's language) in
  front, so a list template gets the same tested sales/FAQ rules as a built-in one. A Custom template's focus is the
  whole role. 4000 + the longest starting text stays under the 8000-character instructions limit (unit test).
- **Text cleaning** (server, after the schema check, before anything is stored in memory or sent): C0/C1 control
  characters except newline and tab, bidi controls (U+202A–202E, U+2066–2069, U+200E/F, U+061C) and U+FEFF are removed,
  CRLF becomes LF. A text that becomes empty where one is required drops the entry.
- One bad entry or an unknown `schemaVersion` drops only that entry; a bad file, signature, format or sequence rejects
  the whole list (the last good copy stays).

## Server (`packages/server/src/templates/`)

- `ctx.services.templateList` (`createTemplateListService`): downloads `templates-v1.json` + `.sig` from
  `https://dl.ezychat.ai/templates/` at start (background, never delays start-up) and on refresh; checks size
  (512 KB list, 1 KB signature), signature with the connector list keys (`CONNECTOR_LIST_PUBLIC_KEYS`) over the
  prefixed bytes, format, sequence (never lower than the saved copy), then entries one by one; keeps the last good
  copy in `<data>/templates/` (the exact checked bytes, written atomically) and re-checks it on start.
- Download hardening: fixed https base URL (no address from a user, so no SSRF surface), 10 s timeout, `redirect:
'error'`, streamed size cap, `cache-control: no-cache`. The download helper is shared with the connector list
  (`connectors/list/download.ts`).
- Dev and tests only: `EZYCHAT_TEMPLATE_LIST_URL` (http allowed) and `EZYCHAT_TEMPLATE_LIST_TEST_KEY` (one extra key)
  are read only with `--mode dev --fake-wa`; fake WhatsApp in any other mode never downloads.
- States as the connector list: `builtin` (nothing saved yet), `loaded`, `offline` (download failed, last good copy),
  `rejected` (a list failed its checks, last good copy).
- Routes (admins, under `/api/ai`, so `ai-routes-access.test.ts` covers them):
  - `GET /api/ai/templates` → `TemplateCatalog { status, categories, templates: [{ entry, connectors: [{id, name}] }] }`
    (only entries this app and edition can use; connector names from the connector list).
  - `POST /api/ai/templates/refresh` → downloads now (at most once per 30 s for the whole server, 10 a minute per
    admin, waits at most 12 s) and answers the catalog. The gallery calls it when it opens.
- Logs: counts, sequence, reason and ms only (`mod: "template-list"`); never template texts or ids.

## Web

- `business-templates.ts` keeps the built-in templates (now `version: 1`, an `icon` **name**, `defaults` for Claims) and
  gains `galleryTemplates(builtins, catalog, language)` (merge by the override rule) on a common `GalleryTemplate`
  shape, so the gallery, search, Apply and the group-agent flow treat both sources the same way.
- `BusinessTemplateCard` reads `GET /api/ai/templates` (cached) and refreshes when the gallery opens. While the request
  is pending or fails, the built-in templates show (i18n fallback); no error is shown for an unreachable list.
- Visible changes (mock `mock/index.html`):
  1. Gallery footer line, muted: "Template library updated 4 Nov 2026" (loaded) / "Showing the templates in this
     version of EzyChat Lite" (builtin) / "Couldn't check for new templates. Showing the last saved list." (offline,
     rejected).
  2. A list template that recommends connectors shows "Works with Google Sheets" under its description.
  3. A category that only the list defines appears as an extra chip.
- New catalog keys in en, ms, zh-CN: `ai.businessTemplates.source.{loaded,builtin,offline}`, `…worksWith`.

## Publishing repo (owner actions)

Ready-to-apply patch for anchorsprint/ezychat-connectors: `publisher/ezychat-connectors.patch` (`git apply` at the repo
root; adds `templates/`, `scripts/build-templates.mjs`, `schema/template-v1.json`, `.github/workflows/templates.yml`).
This session could not attach that repository, so no draft PR exists there yet.

Proposal files in `publisher/` (this folder): `README.md`, `templates/` (sample generated from today's templates),
`build-templates.mjs` (validate, build, sign), `templates.yml` (workflow proposal). What the owner must do:

1. In `anchorsprint/ezychat-connectors`: add the `templates/` folder (from `npm run templates:export`), the build
   script and the workflow steps; copy `schema/template-v1.json` (from `scripts/template-schema.mjs`).
2. Keys: nothing new. The workflow signs with the existing private key secret of the `release` environment
   (with the `ezychat-templates-v1` prefix).
3. CDN: allow the `templates/` path on `dl.ezychat.ai` (same bucket, same upload credentials as `connectors/`).
4. First publish: sequence 1 with the 18 current templates at version 1 changes nothing in installed apps (equal
   versions keep the built-ins); the next template (or a fix with version 2) appears without a release.

## Security review

See the PR description (owner rule for network changes). Summary: one new outbound https GET to a fixed host; no
listener, port, host binding or firewall prompt; nothing reachable by the LAN or another program changes (two new
admin-only routes behind the session, Host and Origin checks); remote text is signed, size-capped, cleaned and only
fills editable boxes after an admin's click.

## Mock and confirmation

- Source baseline: `claims-template` preview (`docs/features/claims-template/mock`, revision `658dbf3`), which is the
  only reference that contains the template gallery (the cumulative `latestConfirmed` mock predates it). Cloned files:
  `build-preview.mjs`, `preview.template.html`; intentional changes: the source line, the "Works with" line, one list
  template ("Event venue", category "Events" from the list) and the offline/builtin states.
- Screens: gallery loaded (with the list template and the new chip), builtin, offline; desktop 1280 / mobile 360,
  light/dark; en, ms, zh-CN.
- Confirmation: **confirmed 2026-11-04** by the owner (Jazz), relayed from the main session in his own words:
  "279 go ahead", covering the mock and the open questions below. The list is published for real at
  `https://dl.ezychat.ai/templates/templates-v1.json` (sequence 1, 18 entries, 6 categories; publishing repo run
  41818602615, commit `dc242eb`). This preview is a standalone gallery reference, not a cumulative full-app clone, so
  `latestConfirmed` in `mock-index.json` stays on group-management.

## Open questions (answered by the owner, 2026-11-04)

1. Should a list be able to **retire** a built-in template? Owner: no (a list can only add or replace).
2. Show a "New" badge on templates added by the list? Owner: no; the source line says the library was updated.
3. Separate keys for templates? Decided: shared keys (owner, connector repo), with domain separation.
