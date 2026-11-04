# Manage WhatsApp groups inside EzyChat (group management)

Status: **confirmed by the owner 2026-11-04** (see Confirmation). Implementation on `feat/group-management`. Branch
`docs/group-management` from `main` `c589b88` (0.1.73).

## Owner request (2026-11-04)

"improve group management feature so admin can manage group for personal and WPA in ezychat without switch if it
support, like edit group name, add members, remove member, and others. Do planning and discovery."

- **Personal** = a phone linked by QR (Baileys, core inbox type `linked_phone`).
- **WPA** = the official WhatsApp Business API (Cloud API) inbox, Enterprise type `wa-cloud`.
- **Without switch** = do it in EzyChat instead of on the phone or in Meta's tools, only where the connection supports it.

## What exists today (discovery)

**Core (Lite)**

- Group info panel (`apps/web/src/inbox/GroupPanel.tsx`, side panel ≥ lg, Sheet below): members read from WhatsApp
  (`GET /api/chats/:jid/members` → `groups/service.ts` → `WaAdapter.getGroupInfo`, 5-minute cache per inbox+group,
  invalidated by the adapter's `groupChanged` event), search, Admins filter, member detail (number, WhatsApp ID,
  username, role, About on demand, photo), **Open chat / Message** (creates an empty direct chat, audited
  `chat.start_from_group`), and the AI row (admins switch the agent per group). **Read-only: nothing changes the
  group.**
- Adapter contract (`packages/wa/src/types.ts`): `WaGroupInfo {jid, name, description, createdAt, ownerJid, size,
participants[{jid, phoneJid, lidJid, username, role: superadmin|admin|member}]}`; `WaCapabilities.groups` (takes
  part in groups) plus optional flags added later (`mentions`, `editMessage`, `deleteForEveryone`, `block`, …), each
  optional and read as `=== true` (LEARNINGS: a required flag breaks Enterprise literals).
- Baileys adapter maps `groupMetadata` (`baileys/groups.ts`) and emits `groupChanged` on `groups.update` and
  `group-participants.update`. It does **not** read `announce`, `restrict`, `memberAddMode`, `joinApprovalMode` or
  `inviteCode` today.
- Fake adapter: `setGroupInfo`, `simulateGroupChanged`; dev route `POST /api/dev/fake-group`.
- Patterns to reuse: inbox access 404 outside the caller's inboxes (`inboxes/access.ts`), `requireAdmin`, `audit()`
  rows with ids and field names only, per-user rate limits (reactions 30/min, edits 30/min), offline → 503
  `wa_unavailable`, capability-gated UI (reactions, edit/delete, mentions).

**Enterprise (`anchorsprint/ezychat-enterprise`, read at `3fc2208`)**

- `docs/features/wa-cloud-groups/design.md` (confirmed and built 2026-10-30): Business API groups for Official
  Business Account numbers (`capabilities.groups` true only when Meta allows groups). Admin → Inboxes → **Groups**
  page `/admin/ext/wa-cloud/inboxes/:id/groups`: list, **New group** (name, description), invite link **Copy**, group
  page with members **Remove** and **Delete group**. Routes `/api/ext/wa-cloud/inboxes/:id/groups*` (admins).
- Graph client (`packages/ent-wa-cloud/src/graph.ts`) implements: list groups, create, get info, get invite link,
  remove participant, delete group. **Not implemented:** update subject/description/picture, reset invite link, join
  requests, approval mode.
- Deferred there: **L1** a Group info slot so Enterprise could add "Manage group" inside the chat; reset link, join
  approval, edit UI. This proposal replaces L1 with a capability-driven core feature (below).

## What each connection can do (sources)

**Linked phone: Baileys `7.0.0-rc14`** (pinned in `packages/wa/package.json` as `^7.0.0-rc14`, lockfile `7.0.0-rc14`;
`node_modules/baileys/lib/Socket/groups.d.ts`, `chats.d.ts`):

| Action                          | Baileys call                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Rename / description            | `groupUpdateSubject(jid, subject)`, `groupUpdateDescription(jid, desc?)` (empty = delete)                      |
| Add / remove / promote / demote | `groupParticipantsUpdate(jid, jids[], 'add'\|'remove'\|'promote'\|'demote')` → per person `{status, jid}`      |
| Add refused by privacy          | `status` `403` with an `add_request` child (invite code + expiry) → send a `groupInviteMessage` to that person |
| Settings                        | `groupSettingUpdate(jid, 'announcement'\|'not_announcement'\|'locked'\|'unlocked')`                            |
| Who may add members             | `groupMemberAddMode(jid, 'admin_add'\|'all_member_add')`                                                       |
| Join approval                   | `groupJoinApprovalMode(jid, 'on'\|'off')`; requests `groupRequestParticipantsList`, `…Update(approve\|reject)` |
| Invite link                     | `groupInviteCode(jid)`, `groupRevokeInvite(jid)` (new code)                                                    |
| Picture                         | `updateProfilePicture(jid, img)`, `removeProfilePicture(jid)`                                                  |
| Disappearing messages           | `groupToggleEphemeral(jid, seconds)`                                                                           |
| Create / leave                  | `groupCreate(subject, jids[])`, `groupLeave(jid)`                                                              |
| Settings read                   | `GroupMetadata.announce`, `restrict`, `memberAddMode`, `joinApprovalMode`, `ephemeralDuration`, `inviteCode`   |

What WhatsApp enforces (not Baileys): every change needs the linked number to be a **group admin** (else
`not-authorized`); the group creator (superadmin) cannot be removed or demoted; adding a person whose privacy is "My
contacts" fails with 403 and needs an invite they accept; other per-person codes seen in the wild are 408 (left
recently), 409 (already in), 401 (blocked/not allowed), 500 (group full); groups hold up to 1,024 members. Mass adds of
strangers are a known **ban trigger** for unofficial clients. The status codes beyond 200/403 come from Baileys'
source and community use, **not verified against real WhatsApp**; slice 1 starts with a live check on a test number.

**WhatsApp Business API (Cloud API) Groups API** (Meta docs, read 2026-11-04; Meta shows no "last updated" date and
no changelog entry for the API version that introduced it):

| Action                                  | Cloud API                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| Create                                  | `POST /<PHONE_ID>/groups` {subject ≤ 128, description ≤ 2048, `join_approval_mode`}; async    |
| Info / list                             | `GET /<GROUP_ID>?fields=…`, `GET /<PHONE_ID>/groups`                                          |
| Rename / description / picture          | `POST /<GROUP_ID>` {subject, description, `profile_picture_file` JPEG square ≥ 192 px ≤ 5 MB} |
| Invite link get / reset                 | `GET` / `POST /<GROUP_ID>/invite_link` (reset kills the old link)                             |
| Add members directly                    | **No**: "cannot manually add participants"; invite link only                                  |
| Remove                                  | `DELETE /<GROUP_ID>/participants` (≤ 8 per call; removed people cannot rejoin by link)        |
| Join requests                           | `GET` / `POST` (approve) / `DELETE` (reject) `/<GROUP_ID>/join_requests`                      |
| Promote / demote admins                 | **Not documented** → unsupported                                                              |
| Announcement / edit-info / add settings | **Not documented** → unsupported; approval mode only at create                                |
| Delete group                            | `DELETE /<GROUP_ID>` (removes everyone, the business too)                                     |
| Leave                                   | Not documented (delete is the only exit)                                                      |

Limits: **8 participants** (business not counted), 10,000 groups per number, 1 Cloud API business per group, Official
Business Account only (not the WhatsApp Business app, Coexistence or Multi-solution numbers), only groups the business
created. Billing per delivered recipient. Errors: 131204 too many participants, 131211 create limit, 131215 not
eligible, 131214 creation paused, 131208 rate limit, 131207 suspended.

Sources: developers.facebook.com/documentation/business-messaging/whatsapp/groups (overview), `/groups/reference`,
`/groups/get-started`, `/groups/groups-messaging/`, `/groups/webhooks`, `/groups/pricing`, `/groups/faq`,
`/groups/error-codes`; Enterprise `docs/features/wa-cloud-groups/design.md` (same docs read 2026-10-30).

## Capability matrix

✅ supported · ⚠️ supported with a limit · ❌ not possible · — not built

| Action                               | Linked phone (Baileys) | Business API (Meta)        | EzyChat today               | Proposed v1      |
| ------------------------------------ | ---------------------- | -------------------------- | --------------------------- | ---------------- |
| See members, roles, details          | ✅                     | ✅ (no roles/names/photos) | ✅ Group info               | unchanged        |
| Rename                               | ✅ (100 chars)         | ✅ (128)                   | —                           | ✅ both          |
| Description                          | ✅                     | ✅ (2048)                  | — (not even shown)          | ✅ both, shown   |
| Add a member by number               | ⚠️ privacy → invite    | ❌ invite link only        | —                           | ✅ phone         |
| Send a private invite (privacy case) | ✅                     | ❌                         | —                           | ✅ phone         |
| Remove a member                      | ✅                     | ✅ (no rejoin by link)     | Enterprise Groups page only | ✅ both, in chat |
| Make / remove group admin            | ✅                     | ❌                         | —                           | ✅ phone         |
| Invite link: copy                    | ✅                     | ✅                         | Enterprise Groups page only | ✅ both, in chat |
| Invite link: reset                   | ✅                     | ✅                         | —                           | ✅ both          |
| Only admins send messages            | ✅                     | ❌                         | —                           | ✅ phone         |
| Only admins edit info                | ✅                     | ❌                         | —                           | ✅ phone         |
| Who can add members                  | ✅                     | ❌                         | —                           | ✅ phone         |
| Join approval on/off                 | ✅                     | ⚠️ only at create          | —                           | ✅ phone         |
| Approve / reject join requests       | ✅                     | ✅                         | —                           | ✅ both          |
| Group photo                          | ✅                     | ✅ (JPEG rules)            | —                           | later            |
| Disappearing messages                | ✅                     | ❌                         | —                           | later            |
| Create a group                       | ✅                     | ✅ (≤ 8, invite only)      | Enterprise Groups page      | later (core)     |
| Leave group                          | ✅                     | ❌                         | —                           | later            |
| Delete group                         | ❌ (only leave)        | ✅                         | Enterprise Groups page      | stays Enterprise |
| Pin messages                         | ✅                     | ✅ (≤ 3)                   | —                           | later            |

## Proposed scope

**v1 (this mock):** Group info gains a **Manage** bar for EzyChat admins: **Edit info** (name + description), **Add
member** (linked phone only), **Invite link** (copy, reset), **Settings** (WhatsApp's group settings + Recent changes),
**join requests** (approve/reject), and per member **Make group admin / Remove as admin** (phone only) and **Remove
from group**. The description is shown under the group name. All of it is gated by capabilities, never by inbox type.

**Later:** group photo, disappearing messages, create group from the core (one flow for both connections; Enterprise
keeps its Groups page until then), leave group, pin, a system line in the chat for each change, an MCP tool (admin
token, separate scope) for rename/description only.

**Never:** bulk add, CSV import, adding by name, auto-adding numbers from chats, "add everyone from another group".

## Permission model

- **EzyChat admins only** (`requireAdmin`) change a group; agents with access to the inbox see Group info read-only with
  one line "Only EzyChat admins can change this group." (open question Q1: allow agents?). The AI never manages groups.
- Every route answers **404** outside the caller's inboxes (removed inbox: 409 `inbox_removed`), like other per-chat routes.
- The linked number must be a **WhatsApp group admin**: otherwise the bar is replaced by a warning ("Your WhatsApp
  number is not an admin of this group…") and the server answers 409 `not_group_admin` before calling WhatsApp.
- Group creator (superadmin): no remove/demote buttons, server 409 `cannot_change_owner`.
- **Audit** (`audit()`): `group.rename`, `group.description`, `group.member_add`, `group.member_invite`,
  `group.member_remove`, `group.admin_promote`, `group.admin_demote`, `group.invite_reset`, `group.setting`,
  `group.join_request`. Meta: `{chatJid, inboxId, memberJid?, setting?, value?(booleans/enum only), result}`; **never
  the new name, description text, or message text**; the member is referenced by JID, not by name. Logs: action,
  counts, ms, result code only.
- **Recent changes** in Settings reads these audit rows (who, what, when, member's name resolved at read time). Changes
  made on the phone are not listed (WhatsApp sends them as group notifications; the later "system line" slice covers it).

## Safety guards

- **No bulk:** one number per Add; the API takes exactly one `phone`.
- **Rate limits** (per inbox, counted on success): adds + invites **20 a day** and **6 an hour**; remove/promote/demote
  30 a minute per user; rename/description/settings/reset 10 a minute per user. Over → 429 `too_many_adds` / `rate_limited`.
- **Ban-risk wording** on Add member: "Add only people who know your business. Adding many strangers can get your
  number banned by WhatsApp." (the same tone as `send_to_new_number`).
- `checkNumber` before add (linked phone): not on WhatsApp → 422 `not_on_whatsapp` without touching the group.
- **Privacy refusal → invite:** the add result 403 shows "Couldn't add this person … Send invite" (explicit click, not
  automatic); the invite is a WhatsApp group-invite message to that person, counted by the add limit.
- **Confirm dialogs** for Remove from group, Remove as admin and Reset link (destructive buttons red, Cancel default).
- **Offline:** buttons disabled with "WhatsApp is offline. Changes are paused…"; server 503 `wa_unavailable`; never queued.
- **Business API full** (8 members): "This group is full" and approvals disabled.
- **Capabilities, never type names:** the UI shows only actions in `caps`; the server re-checks and answers 409
  `not_supported`.

## Lite vs Enterprise split

- **Lite (core):** shared zod contract, `WaAdapter` optional group methods + `WaCapabilities.groupAdmin`, server
  service/routes/audit/rate limits, Group info UI, Baileys implementation, fake adapter, tests. Works for linked phones.
- **Enterprise:** `wa-cloud` adapter implements the subset Meta supports (rename/description via `POST /<GROUP_ID>`,
  remove, invite link get/reset, join requests) and declares it in `capabilities.groupAdmin`. No Enterprise UI change
  is needed for in-chat management; the Groups page stays for list/create/delete. Its Remove keeps working; later it may
  call the core routes. L1 (slot) is no longer needed.

## API / contract sketch (`packages/shared/src/groups.ts`)

```ts
export const GroupAdminCaps = z.object({
  editInfo: z.boolean(), // subject + description
  addMembers: z.boolean(),
  inviteOnly: z.boolean(), // people join only by link (Business API)
  removeMembers: z.boolean(),
  admins: z.boolean(), // promote / demote
  inviteLink: z.boolean(),
  resetInviteLink: z.boolean(),
  settings: z.array(z.enum(['announce', 'locked', 'memberAdd', 'approval'])),
  joinRequests: z.boolean(),
  maxMembers: z.number().int().positive().nullable(), // besides the business; null = WhatsApp's own
  nameMax: z.number().int().positive(),
});
export const GroupSettings = z.object({
  announce: z.boolean(),
  locked: z.boolean(),
  memberAdd: z.enum(['admins', 'all']),
  approval: z.boolean(),
});
// GET /api/chats/:jid/group (any user with inbox access): caps for this inbox, my role, settings, link (admins only),
// join requests (admins only), recent changes (admins only).
export const GroupAdminResponse = z.object({
  caps: GroupAdminCaps,
  myRole: z.enum(['superadmin', 'admin', 'member']),
  settings: GroupSettings.partial(),
  inviteLink: z.string().url().nullable(),
  requests: z.array(
    z.object({
      jid: z.string(),
      phone: z.string().nullable(),
      name: z.string().nullable(),
      at: z.number(),
    }),
  ),
  changes: z.array(
    z.object({
      at: z.number(),
      byUserId: z.number(),
      action: z.string(),
      memberJid: z.string().nullable(),
    }),
  ),
});
export const EditGroupBody = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(2048).optional(),
});
export const AddGroupMemberBody = z.object({ phone: z.string().regex(/^\d{8,15}$/) });
export const AddGroupMemberResponse = z.object({
  result: z.enum(['added', 'invite_needed']),
  memberJid: z.string(),
});
```

Routes (admins unless noted; all `chatJidParam` + inbox access 404):

| Route                                               | Body / result                           |
| --------------------------------------------------- | --------------------------------------- |
| `GET /api/chats/:jid/group` (any user)              | `GroupAdminResponse` (link etc. admins) |
| `PATCH /api/chats/:jid/group`                       | `EditGroupBody`                         |
| `POST /api/chats/:jid/group/members`                | `AddGroupMemberBody` → result           |
| `POST /api/chats/:jid/group/members/:member/invite` | sends the invite                        |
| `DELETE /api/chats/:jid/group/members/:member`      | remove                                  |
| `PUT /api/chats/:jid/group/members/:member/role`    | `{admin: boolean}`                      |
| `POST /api/chats/:jid/group/invite-link/reset`      | `{inviteLink}`                          |
| `PUT /api/chats/:jid/group/settings`                | `GroupSettings.partial()`               |
| `POST /api/chats/:jid/group/requests/:member`       | `{approve: boolean}`                    |

Errors: 409 `not_group_admin`, `not_supported`, `already_member`, `cannot_change_owner`, `group_full`; 422
`not_on_whatsapp`; 429 `too_many_adds` / `rate_limited`; 503 `wa_unavailable`. Contract test: the new calls join
`web-client-contract.test.ts`.

## Adapter interface additions (`packages/wa/src/types.ts`)

```ts
export interface WaGroupAdminCapabilities {
  /* = GroupAdminCaps without nameMax/maxMembers duplication */
}
export interface WaCapabilities {
  /* … */ groupAdmin?: WaGroupAdminCapabilities;
} // optional, absent = read-only
export interface WaGroupInfo {
  /* … */ settings?: Partial<GroupSettings>;
} // Baileys: announce/restrict/memberAddMode/joinApprovalMode
export type WaParticipantResult = {
  jid: string;
  status: 'ok' | 'invite_needed' | 'already' | 'not_allowed' | 'full' | 'failed';
  invite?: { code: string; expiresAt: number };
};
interface WaAdapter {
  setGroupSubject?(groupJid: string, subject: string): Promise<void>;
  setGroupDescription?(groupJid: string, description: string | null): Promise<void>;
  updateGroupMembers?(
    groupJid: string,
    jids: [string],
    action: 'add' | 'remove' | 'promote' | 'demote',
  ): Promise<WaParticipantResult[]>;
  sendGroupInvite?(
    groupJid: string,
    toJid: string,
    invite: { code: string; expiresAt: number },
  ): Promise<void>;
  getGroupInviteLink?(groupJid: string): Promise<string>;
  resetGroupInviteLink?(groupJid: string): Promise<string>;
  setGroupSettings?(groupJid: string, s: Partial<GroupSettings>): Promise<void>;
  listGroupJoinRequests?(groupJid: string): Promise<Array<{ jid: string; at: number }>>;
  decideGroupJoinRequest?(groupJid: string, jid: string, approve: boolean): Promise<void>;
}
```

All optional, so Enterprise and older adapters compile; `LINKED_PHONE_CAPABILITIES` gains `groupAdmin` (everything,
`maxMembers: null`, `nameMax: 100`). `jids` is a one-element tuple by type: bulk is impossible by construction. Every
method throws `WaUnavailableError` offline and emits nothing itself; WhatsApp's own `groups.update` /
`group-participants.update` invalidate the Group info cache as today.

## Data / migration impact

- **No new table.** Recent changes come from `audit_log` (action prefix `group.`, `meta.chatJid`); one index on the
  audit chat key if the query is slow (migration only if needed).
- Rate-limit counters in memory (like reactions) plus the daily add count read from audit rows so a restart cannot
  reset the 20-a-day limit.
- `upgrade-from-oldest.test.ts` unaffected (no schema change). Chat keys stay opaque (`waJidOf` for WhatsApp calls).

## Test plan

- **Unit (server):** service with `FakeWaAdapter` (new fake methods recording calls and scripted per-person results):
  each action, not a group admin, owner protected, offline 503, capability off → 409 `not_supported`, privacy →
  invite, not on WhatsApp, rate limits (hour/day, counted on success, survive restart via audit), inbox access 404 for
  an agent outside the inbox, agent → 403, audit meta never contains the name/description text.
- **Adapter:** Baileys mapping of `groupMetadata` settings and participant result codes (unit, with recorded node
  shapes); the fake `fake-api` inbox type (`--mode dev --fake-wa`) declares the Business API subset to test gating.
- **Contract:** `web-client-contract.test.ts` covers the new `api()` calls.
- **Web:** GroupPanel/GroupAdmin component tests (admin, agent, not group admin, offline, Business API caps, dialogs).
- **E2E:** one Playwright spec on fake WhatsApp (rename, add → invite, remove with confirm, settings), mobile 360.
- **Live:** `packages/wa/src/baileys/**` changes smoke-tested on a test number (rename, add contact, add non-contact →
  403 → invite, promote/demote, settings, link reset, approvals). Business API: one check on a real OBA number in
  Enterprise. Until then: "untested against real WhatsApp".
- Coverage ≥ 90 % of changed lines.

## Effort estimate (agent-days, including tests and review)

| Slice                                                                                         | Estimate  |
| --------------------------------------------------------------------------------------------- | --------- |
| 1. Contract + adapter interface + fake + Baileys (rename, description, members, roles, link)  | 2–3       |
| 2. Server service, routes, audit, rate limits, contract test                                  | 2         |
| 3. Group info UI (bar, dialogs, member actions, i18n, screen review)                          | 2–3       |
| 4. Settings + join requests (Baileys + UI)                                                    | 1–2       |
| 5. Privacy refusal → invite (Baileys invite message) + live smoke on a test number            | 1         |
| 6. Enterprise `wa-cloud`: rename/description, link reset, join requests, caps; OBA live check | 2         |
| **Total**                                                                                     | **10–13** |

## Risks

- Baileys result codes and the invite-message flow are reverse-engineered; WhatsApp may change them (live smoke each
  release; fail closed to "failed").
- Ban risk from adds on an unofficial client: mitigated by one-at-a-time, low limits, wording; not eliminated.
- A linked number that is not a group admin (common in customer groups) sees only the warning: the value of the
  feature depends on the business owning its groups.
- Business API: groups the business did not create are invisible; 8-member cap; no admins/settings.
- Changes made on the phone are not in Recent changes until the "system line" slice.

## Open questions for the owner

1. **Who may manage groups:** EzyChat admins only (proposed), or also agents with access to that inbox?
2. **Privacy refusal:** show "Send invite" for the admin to click (proposed), or send the invite automatically?
3. **Add limit:** 20 a day and 6 an hour per WhatsApp number (proposed) — stricter or looser?
4. **v1 scope:** include group settings and join requests in v1 (proposed), or ship rename/description/members/admins
   /link first and add settings later?
5. **Business API:** move Enterprise's in-chat management to these core actions (proposed) and keep its Groups page for
   list/create/delete — or keep everything on the Enterprise page?
6. **Recent changes:** list only changes made in EzyChat (proposed v1), or also show phone-made changes once the
   system-line slice lands?
7. **Edition:** all of this in Lite for linked phones (proposed, it is a core WhatsApp feature), or Enterprise-only?

## Competitor check (brief, 2026-11-04)

- **Periskope** (phone-linked by QR): full group management in a shared inbox: add by number or link, bulk remove up
  to 200, bulk promote/demote, custom invites; the number must be a group admin (docs.periskope.app/features/member-management).
- **Wati** (Cloud API, OBA, Business plan): create groups from the Team Inbox (≤ 7 external contacts), invite link sent
  automatically, remove, delete (support.wati.io articles 15957723, 16390325).
- **Whapi.Cloud** (unofficial API): create with participants, direct add, invite, admin-only mode (tutorial only).
- EzyChat's angle: the same Group info for both connections, only what the connection supports, with ban-safe limits
  and no bulk adds (unlike Periskope).

## Mock

`docs/features/group-management/mock/` (README there): full app clone of the confirmed **in-app-feedback** reference,
revision `f3eaf7bcf7792fb4e058103b9bd9f93e9fcc4ed6` (`mock-index.json` `latestConfirmed`). Source screens reused:
`apps/web/src/inbox/GroupPanel.tsx` (panel, member detail, Message confirm), `GroupAiRow.tsx` (card style), the
message edit/delete confirm dialogs (destructive AlertDialog), `SegmentedControl`, `Banner`, actual labels from
`i18n/locales/en/inbox.json` (`groupInfo.*`).

Changed: `src/inbox/GroupPanel.tsx` (description, Manage bar, member actions, Mock only box), `src/i18n/locales/{en,ms,
zh-CN}/inbox.json` (`mockGroupAdmin.*`). Added: `src/inbox/GroupAdmin.tsx`, `src/mock/groupAdmin.ts`, runner
`group-admin.ts` (routes `/api/mock/group-admin*`, changes the fake phone's group so the real members route shows each
change), `group-admin-shots.mjs`. Baseline drift fixed: the mock's `POST /api/feedback` stand-in collided with the real
route shipped since; it now registers only when the core has none. Known gap, not fixed: the inherited `snapshot.mjs
--check` already fails on `AppCredits.tsx` (also on main).

Coverage gaps (inherited, not added in this round): the message-edit-delete screens, the WhatsApp Safety screens and the
group-agents preview are still owed to the cumulative reference (see the index notes); the mock has no Business API inbox
seeded, so the Business API case is shown through the Mock only switch in Group info.

Retention: the sixth feature folder, so `message-edit-delete` (confirmed, creationOrder 26) is pruned in this change;
recover it from `d16b815`.

Screen/state checklist (desktop 1280 / mobile 360 touch, light / dark; `group-admin-shots.mjs`, 68 shots, 0 page
errors, 0 horizontal overflow):

| #   | State                                              |
| --- | -------------------------------------------------- |
| 01  | Admin bar with description and 2 join requests     |
| 02  | Edit info dialog (name counter, long description)  |
| 03  | Add member with the ban-risk note                  |
| 04  | Add refused by privacy → Send invite               |
| 05  | Invite sent                                        |
| 06  | Not on WhatsApp error                              |
| 07  | Member detail: Make group admin, Remove from group |
| 08  | Remove confirm                                     |
| 09  | Invite link (copy, reset)                          |
| 10  | Reset link confirm                                 |
| 11  | Group settings + Recent changes                    |
| 12  | Number not a group admin (warning, no actions)     |
| 13  | WhatsApp offline (actions disabled)                |
| 14  | Business API: invite only, n of 8, no Add member   |
| 15  | Business API settings: none, with Recent changes   |
| 16  | Business API member: Remove only, no admin actions |
| 17  | Agent: read-only line                              |

## Confirmation

Confirmed by the owner (Jazz) on 2026-11-04, in his own words in the main EzyChat session: "go with your suggestion,
run multiple subagent to implement independent part, only merge to main and archive it, we will release daily."
"Your suggestion" = the proposed answer to every open question, so the answers are:

1. Only EzyChat admins manage groups; agents get the read-only view.
2. Privacy refusal → a "Send invite" button (never automatic).
3. Add limit 20 a day and 6 an hour per WhatsApp number.
4. Group settings and join requests are in v1.
5. Business API in-chat management uses these core actions; the Enterprise Groups page keeps list/create/delete.
6. Recent changes lists only EzyChat-made changes in v1.
7. Ships in Lite (core); Enterprise implements Meta's subset in `wa-cloud`.

The mock at this revision is the implementation and screen-review reference. No app release or tag for this change:
Lite ships it in the daily release.
