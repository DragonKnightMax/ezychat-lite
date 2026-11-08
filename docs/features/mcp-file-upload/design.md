# Large files: MCP upload and WhatsApp's own limits

Owner requests (Jazz, 2026-11-08, relayed by the master session `session_01J4pmGkCf1Mvdepudm8WQAd`):

1. "allow larger file size and allow binary or multi part" for the MCP send tools (5 MB base64 or link before);
2. "should use whatsapp file size check not ours": no EzyChat cap on MCP uploads or link downloads;
3. "follow whatsapp" for the message box too: drop the composer's fixed 100 MB cap, in this PR.

## What changes

| Piece                      | Before                        | After                                                                                                 |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| MCP upload endpoint        | none                          | `POST /mcp/uploads`: raw body (`X-File-Name`) or `multipart/form-data` (one `file` part)              |
| `send_image` / `send_file` | `…Url` or `…Base64`, 5 MB     | exactly one of `…Url`, `…Base64`, `uploadId`                                                          |
| `send_video` (new)         | none                          | MP4; `sendAs` video / file; omitted, a video above the number's video limit goes as a file            |
| Size limits (MCP and web)  | 5 MB (MCP), 100 MB (composer) | none of ours: the target number's `WaCapabilities.mediaLimits` (Forward's 413 codes) and free disk    |
| Base64                     | 5 MB                          | what fits the 8 MB `/mcp` body (`MCP_SEND_MAX_BASE64_BYTES`, about 6 MB)                              |
| Link downloads             | buffered, 5 MB, 10 s          | streamed to a private file, up to the chat's number's limit, 60 s idle / 60 min                       |
| Composer upload            | `toBuffer()` (memory), 100 MB | streamed to `<data>/uploads/`, up to the chat's number's limit; progress in the bubble                |
| Through the tunnel         | Cloudflare's own 413 page     | the web refuses > 100 MB before uploading and says where it works; a foreign 413 → `tunnel_too_large` |
| `sendMedia`                | buffer only                   | buffer or `path` (moved in with `MediaStore.adopt`); `asFile: 'auto'`                                 |
| Audit `mcp.send`           | tokenId, chatJid, messageId   | + `type` and `size` (never name, caption or content)                                                  |

WhatsApp's limits (`packages/wa/src/types.ts`): linked phone documents 2 GB, video/image/audio 64 MB (video until
measured); Business API documents 100 MB, video 16 MB, image 5 MB. A connection that reports no limit has none known:
then only the disk bounds a transfer, and WhatsApp's answer decides.

```bash
# raw body
curl -H "Authorization: Bearer $TOKEN" -H "X-File-Name: quote.pdf" --data-binary @quote.pdf https://<host>/mcp/uploads
# multipart
curl -H "Authorization: Bearer $TOKEN" -F file=@demo.mp4 https://<host>/mcp/uploads
```

`POST /mcp/uploads` answers `201 { uploadId, name, type, size, expiresAt }` (shared `McpUploadResponse`). An upload
belongs to the token that made it, is kept 1 hour (`MCP_UPLOAD_TTL_MS`) and can be sent once; while a send uses it, it
is taken out of the store (`take`), so a second send or the expiry sweep cannot touch the file; a refused send gives it
back (`restore`). Its size bound is the largest limit of any inbox the token owner may open; the send then checks the
target chat's own number. Accepted types (read from the bytes): JPEG, PNG, WebP, PDF, Word .docx, MP4 (one table,
`mcp/media-types.ts`). Audio is a backlog item.

## Screens (no full mock: a small change to the composer and the message bubble)

Screenshots at 1280 and 360 px, light, in `screens/` (made by `screens/shots.mjs` against a `--fake-wa` Dev Build with
a fake Business API inbox and a named-tunnel hostname mapped to loopback):

| State                 | Where                                                     | File                                   |
| --------------------- | --------------------------------------------------------- | -------------------------------------- |
| Uploading progress    | pending bubble: `Progress` bar + "21%" above the file     | `01-uploading-{desktop,mobile}.png`    |
| Sent as a file        | existing toast `composer.sentAsFile` (70 MB video, 64 MB) | `02-sent-as-file-{desktop,mobile}.png` |
| Over WhatsApp's limit | error toast naming the number's limit (Business API 5 MB) | `03-over-whatsapp-limit-{…}.png`       |
| Tunnel 100 MB         | error toast: up to 100 MB through the internet address    | `04-tunnel-limit-{desktop,mobile}.png` |

Design system: the upload progress pattern is added to `docs/design-system.md` → Patterns. Strings in en, ms, zh-CN:
`composer.files.tunnel_limit`, `message.uploading`, `message.uploadErrors.tunnel_too_large`. The tunnel is recognised
from the page's own hostname (`isTunnelHost`: not loopback, private IPv4, IPv6, single-label or `.local`).

## Kept rules

- MCP: token scope `inbox:send`, owner rechecked as an active admin on every call (upload included); idempotency per
  token + `requestId` (a retry is answered from the stored message before any upload, download or limit is touched);
  10 sends a minute and 100 a day per token; reply window, removed-inbox, moved-number and quote refusals of the message
  service; logs `mcp upload` {tokenId, uploadId, type, size, ms}, never names or content.
- Safety: outbound files are not scanned (Safety inspects inbound messages only), as before.

## Security review (owner rule "Security review for network changes")

**Interfaces touched.** No new listener, port, host binding or tunnel change. New route `POST /mcp/uploads` inside the
`/mcp` Fastify scope; `POST /api/chats/:jid/media` now streams. Outbound: link downloads (guarded fetch) with longer
time limits.

**Who can reach it.** `/mcp/uploads` is reached exactly like `/mcp`, by the same `onRequest` hook before any byte of
the body: off → 404; LAN peer → 403 (`isLocalOrTunnel`); foreign Origin → 403; per-IP and failed-token limits; invalid,
expired or revoked token, or an owner no longer an active admin → 401; per-token request limit. A route hook then
refuses a token without `inbox:send` (403). Host allowlist and access gate apply. No cookie is accepted. The composer
route keeps its session, Origin and inbox-access (`chatJidParam` 404) checks before the multipart body is read.

**What the LAN or tunnel can reach.** LAN: nothing new on `/mcp` (403 before the body); the composer for signed-in
users as before. Tunnel: Cloudflare caps request bodies at 100 MB on Free/Pro; the web says so before uploading.

**Body handling.** Only the upload route's child scope removes the JSON and text parsers and passes the raw stream
through; multipart uses `@fastify/multipart`'s streaming `req.file()` / `req.parts()` with per-request limits. The
stream is piped through a byte counter into `<data>/uploads/<random>.bin` (folder 0700, file 0600, `wx`); the counter
stops it above the allowance and the partial file is deleted. The file name is cleaned (last segment, control and bidi
characters removed, 120 characters) and only used as the WhatsApp document name.

**DoS and disk exhaustion.** No per-file cap of our own (owner), so the disk is the bound: a transfer is refused (507
`upload_storage_full`) when it would leave less than 1 GB free, counting the declared sizes of transfers in progress;
one without a declared size may use the room left when it began, and a full disk ends it with 507 (`ENOSPC` mapped).
Abuse limits: 30 MCP uploads an hour per token, 10 waiting per token, 2 transfers at once per token or user and 4 in
total; 60 s without data or 60 min in total ends a transfer (408), because Fastify sets no request timeout. A refused
upload answers with `Connection: close` instead of reading the rest; a client that goes away gets 400
`upload_incomplete`.

**Temp-file cleanup.** Sent: moved into the media store (rename, or copy + delete across disks). Refused: an MCP upload
waits until it expires; a link download or composer upload is deleted at once. Expired: 5-minute sweep and on every
new upload. Server start: the folder is emptied.

**Invariants.** AGENTS.md MCP and Forward paragraphs updated. CSP, cookies, sessions, setup, Host/Origin checks and the
SSRF guard (`guardedFetch`: https only, public addresses checked on the connected address, same-origin redirects)
unchanged.

## Verification

- Server: `mcp-upload.test.ts`, `media-upload.test.ts`, send_image / send_file suites, messages, forward, voice notes,
  multi-inbox, reply window, inbox access, web-client contract (now also reads `apiUpload` calls).
- Web: `file-transfer.test.ts` (no app cap, tunnel host and limit), `Composer.files.test.tsx`, `queries.test.ts`
  (progress, `tunnel_too_large`), `client.test.ts` (`apiUpload`), `MessageBubble.test.tsx` (progress, wording).
- Dev Build checks: `docs/dev-build-checks.md`.
- Untested against real WhatsApp: no `packages/wa/src/baileys/**` change; large sends use Forward's path-based send,
  and the linked-phone 64 MB video limit is still the placeholder until measured.
- Follow-up (backlog): MCP audio / voice notes; more document types for `send_file`.
