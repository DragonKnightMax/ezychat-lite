# Faster remote access: fewer round trips (Phase 1, app cache)

Owner request (2026-11-04): remote access through the tunnel lags; cache data on the phone with the PWA, with
reasonable expiry; test first. Approved approach: "combine infra update, app cache"; "use subagent, start phase 1".

## Evidence (measured 2026-11-04 on the owner's live Enterprise, inbox.anchorsprint.app)

- First screen: **97 requests, 43 KB in total**. App files come from the PWA precache (4 ms). Every server request
  costs **~660 ms** (`/api/health` 0.4 KB: 652–686 ms), the server itself answers in 1–2 ms.
- Cause of the 660 ms: the browser enters Cloudflare at `colo=SJC` (TM/Unifi) or `FRA` (mobile data); the tunnel
  itself is Singapore, 25–50 ms (cloudflared metrics). Routing is outside the app (Phase 2: Tailscale or a pinned
  Singapore ingress).
- Round trips that the app can remove:
  - **58 contact photos per open**, ~1 s each: `GET /api/chats/:jid/avatar?connection=<revision>` answers `302` to
    WhatsApp's CDN (or `204`), `private, max-age=300`. `connection` changes on every WhatsApp (re)connect, so the
    browser cache is lost; the server's URL cache lives 5 min (`http/profile-images.ts`), then asks WhatsApp again
    (avg 0.4 s, max 26 s in the live log).
  - **`GET /api/chats` 6 times on one open** (avg 1.3 s each).
  - The PWA service worker (`apps/web/src/sw.ts`) precaches app files only: no photo, media or API data is kept.

## Goals

1. Photos: on a repeat open, **no network request** for an unchanged photo.
2. The inbox shows the last known chat list, inboxes and the signed-in user **at once**, then refreshes.
3. One `GET /api/chats` per list view on open (no duplicates).
4. Media (`/api/media/:id`) kept on the phone for 30 days, within a size cap.

## Non-goals

Tunnel/ingress changes (Phase 2), new screens or settings, offline sending, caching message history pages.

## Anti-goals

- A cached photo or file shown to a person who may no longer open that chat after a sign-out or a user switch.
- Caching a file WhatsApp Safety locked (`safety === 'flagged'` answers `no-store`; it must stay uncached).
- Stale data that never refreshes (every cached view refreshes from the server right after it shows).

## Design

### Server (owner: subagent "server")

- **Photo store** `packages/server/src/avatars/` (new): the server downloads each WhatsApp profile photo itself (only
  https URLs on WhatsApp's own hosts, as today), keeps the bytes under `<data>/avatars/` and a row per key (chat key,
  or group+member) with `hash` (sha256 of the bytes, short), `fetched_at`, `has_photo` (migration). Refresh when
  older than **24 h** on the next request (bounded and coalesced as today), and drop a key on WhatsApp's
  picture-changed event when the adapter reports one. A failed lookup keeps the last good photo.
- `GET /api/chats/:jid/avatar` and the group member avatar route **serve the bytes** (`image/jpeg`, `ETag: "<hash>"`,
  `If-None-Match` → `304`) instead of redirecting. Headers: with `?v=<hash>` that matches → `private,
  max-age=31536000, immutable`; without → `private, max-age=86400`. No photo → `204` with `private, max-age=86400`
  (a known "no photo" is cached for a day); a failed lookup → `204` + `no-store` (as today). Access checks unchanged.
- The chat list (`rowToChat` / `ChatRepo`) gives `avatarUrl` with `?v=<hash>` when the store has a photo, so the
  URL changes only when the photo changes. Contract unchanged (`avatarUrl` is a string).
- `GET /api/media/:id`: normal files `private, max-age=2592000, immutable` (media ids are immutable); flagged files
  stay `no-store`.

### Web (owner: subagent "web")

- `ChatAvatar`: stop appending `connection=<revision>`; use `avatarUrl` as given.
- **Service worker** (`sw.ts`, add `workbox-routing`, `workbox-strategies`, `workbox-expiration`,
  `workbox-cacheable-response`): avatars `CacheFirst` (cache `ezy-avatars-v1`, 1,000 entries, 7 days, status 200
  only); media `CacheFirst` (cache `ezy-media-v1`, 300 entries, 30 days, 200 only); **never store a response whose
  `cache-control` contains `no-store`** (plugin). API JSON is not cached by the service worker.
- **Clear on sign-out and user switch:** on logout, and on sign-in when the user id differs from the last one, the
  page posts `{type:'clear-user-caches'}` to the service worker, which deletes `ezy-avatars-*` and `ezy-media-*`; the
  page also clears the persisted queries below. Every other end of a session clears too: `session:revoked` on the
  socket, and `/api/me` answering 401 (a disabled user or an expired session), once per user who leaves.
- **Decision (final review I-1):** the saved first screen still shows before `/api/me` answers. Waiting for it
  would cost one round trip (~660 ms from the owner's phone), the main gain of this work. Cost if wrong: a revoked or
  disabled user can see the list they already saw, at most 1 day old, for one round trip; the first 401 then removes
  the saved copy, the photos and the files from the device.
- **Instant first screen:** persist a small set of React Query results per user in `localStorage` (official
  `@tanstack/react-query-persist-client` + sync storage persister, or an equivalent small persister): the first
  page of the chat list, inboxes, `me`, settings. On open they render at once and refetch immediately; max age 1 day;
  key includes the user id; cleared on logout.
- **Duplicate `/api/chats` loads:** find why one open loads the list 6 times (query keys, mounts, socket
  invalidations, focus refetch) and make it one.

## Tests

Server: store (fetch, hash, refresh after 24 h, keep last good on failure, picture-changed drops), routes (200
bytes + ETag, 304, `v` immutable, 204 day cache, failure no-store, access 404 unchanged), media headers (normal vs
flagged). Web: ChatAvatar URL, SW routing rules and the no-store plugin (unit), clear on logout/user switch,
persisted queries render before the network and are keyed by user, one `/api/chats` per open. Then a measurement on
a Dev Build behind a slow network (Playwright, ~650 ms latency) and on the owner's live page after release: request
count and time to first chat list, before vs after.

## Security review (before the PR)

No listener changes. Review: what the PWA caches stay readable on a shared phone after sign-out (cleared), photo
bytes stored on the PC (same data dir as media), SSRF on photo download (WhatsApp hosts only, https, size cap).
