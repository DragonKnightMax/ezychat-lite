<p align="center">
  <img src="apps/web/public/icon-512.png" width="96" alt="EzyChat Lite icon">
</p>

<h1 align="center">EzyChat Lite</h1>

<p align="center">
  One WhatsApp number, one shared inbox for your whole team.<br>
  A desktop app for macOS and Windows that serves a mobile-friendly team inbox from your own computer.
</p>

<p align="center">
  <a href="LICENSE">MIT License</a> ·
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="https://github.com/ossmalaysia/ezychat-lite/issues/new/choose">Issues</a>
</p>

---

> [!WARNING]
> **EzyChat Lite is not affiliated with, endorsed by, or sponsored by WhatsApp or Meta.**
> "WhatsApp" is a trademark of its respective owner.
>
> It connects through [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial**
> WhatsApp Web client library. Unofficial clients are against WhatsApp's Terms of Service and
> **your number can be temporarily or permanently banned**. Use it at your own risk, ideally with a
> number you can afford to lose.
>
> It is built for people answering real conversations. **Do not use it for bulk messaging, spam,
> or automated marketing.**

## Why

We built EzyChat as an internal tool to help businesses manage sales conversations. To make
that work useful to more businesses, we are open-sourcing **EzyChat Lite**: a rewritten,
self-hosted version inspired by [EzyChat](https://ezychat.ai/), with a focus on security,
easy setup, and a simple daily workflow for small teams.

Small teams often share one business WhatsApp number on one phone. Someone has to hold the phone,
replies get missed, and nobody knows who is handling which customer. EzyChat Lite links that
number once and lets everyone on the team answer from their own phone or laptop, with assignment
and internal notes, and with no cloud service in the middle: your messages stay on your computer.

The goal is practical: give businesses a free foundation for managing customer conversations,
with optional **AI agents** on your own AI account (in preview) and a growing **light CRM**
(customer profiles and tags today). See the [roadmap](ROADMAP.md) for what comes next.

## Features

- **Link one number** by scanning a QR code; recent history is imported (configurable number of days).
- **Shared inbox**: everyone sees every chat, with assignment, open / resolved status, unread counts and search.
- **Internal notes** and system events in the timeline, clearly separate from customer-visible messages.
- **Messaging**: text, replies (quotes), images, video, audio and documents in both directions, group chats,
  typing indicators, delivery and read ticks, a send queue that survives short disconnects, and retry for failed sends.
- **Quick replies** with a `/` picker.
- **AI assistant access (MCP)**: connect claude.ai, ChatGPT, Claude Desktop or developer tools to read
  the inbox and refine the AI agent; sending stays off unless an admin allows it.
  See [Connect an AI assistant](#connect-an-ai-assistant-mcp).
- **Installable PWA**, fully responsive down to 360px, with **web push notifications** for new messages
  (sent to the assignee, or to everyone when a chat is unassigned).
- **Access anywhere**: on the same computer, over your LAN, or from anywhere through a Cloudflare
  quick tunnel (no account needed) or your own named tunnel. `cloudflared` is bundled.
- **Admin**: members and roles, WhatsApp connection status and relink, tunnel control, settings,
  audit log and log download.
- **Two run modes**: standalone while the app is open, or a boot-time OS service that runs with
  nobody signed in (Windows service / macOS launchd daemon).
- **Nightly local backups** of the database and WhatsApp session (last 7 kept).
- **Security-minded defaults**: argon2 passwords, hashed sessions, login lockout, Host/Origin checks,
  first-admin setup only from the computer itself.

## Install

Download the latest installer from the
[**GitHub Releases**](https://github.com/ossmalaysia/ezychat-lite/releases) page:

| Platform              | File                                   |
| --------------------- | -------------------------------------- |
| Windows 10/11 (x64)   | `EzyChat-Lite-<version>-win-x64.exe`   |
| macOS (Apple Silicon) | `EzyChat-Lite-<version>-mac-arm64.dmg` |
| macOS (Intel)         | `EzyChat-Lite-<version>-mac-x64.dmg`   |

The **Windows** installer is signed by **Anchor Sprint Pte. Ltd.** (since 0.1.45), so Windows shows a
known publisher. If Windows still shows "Windows protected your PC", click **More info**, check that the
publisher is Anchor Sprint Pte. Ltd., then click **Run anyway**.

The **macOS** builds are not yet notarized by Apple, so your Mac warns you the first time you open
EzyChat Lite. This is expected; the steps below get you past it once.

### macOS: first launch

macOS shows **"EzyChat Lite" Not Opened — Apple could not verify "EzyChat Lite" is free of malware…**
for any app that is not notarized by Apple. It is not a virus warning. Allow it once:

1. Open the `.dmg` and drag **EzyChat Lite** into **Applications** (replace the old copy when updating).
2. Open **EzyChat Lite** from Applications. When the warning appears, click **Done**
   (not _Move to Trash_).
3. Open **System Settings → Privacy & Security** and scroll to the **Security** section at the bottom.
4. Next to _"EzyChat Lite" was blocked to protect your Mac_, click **Open Anyway**, then confirm with
   your password or Touch ID.
5. Click **Open Anyway** (or **Open**) in the last dialog. EzyChat Lite starts.

macOS remembers this until the next update, which needs the same steps once.

**The Open Anyway button is missing?** It appears only for about an hour after a blocked attempt.
Repeat step 2, then go back to Privacy & Security.

**Prefer Terminal?** This does the same in one step (use the exact path of the app):

```bash
xattr -dr com.apple.quarantine "/Applications/EzyChat Lite.app"
```

**Permissions EzyChat Lite may ask for later** (change them any time in System Settings):

| Prompt                              | When                                                  | Choose                                    |
| ----------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Notifications                       | the first new-message alert                           | **Allow**, for new-message alerts         |
| Microphone                          | the first voice note you record                       | **OK** (used only while recording)        |
| Accept incoming network connections | phones on your Wi-Fi/LAN, if the macOS firewall is on | **Allow**, or phones cannot reach the app |

**"EzyChat Lite is damaged and can't be opened"** came from version 0.1.35 on Apple Silicon. Install
0.1.36 or later.

Once EzyChat Lite is signed and notarized with an Apple Developer ID, these steps go away.

Only download installers from this repository's Releases page.

Earlier releases used the **WA Team Inbox** name and `WA-Team-Inbox-…` filenames.
The rebrand keeps the existing data folders and service identity so upgrading preserves your
linked number, team accounts and conversation history. The npm workspaces are published as
`@ezychat/*`, and the Windows executable retains its legacy filename
so installed background services can still start it.

## Quick start

1. **Open EzyChat Lite.** It starts a local server and opens the inbox window. On first run, create
   the admin account (this is only allowed from the computer running the app).
2. **Link your number.** Go to **Admin → WhatsApp**, then on your phone open WhatsApp →
   **Settings → Linked devices → Link a device** and scan the QR code.
3. **Invite your team.** In **Admin → Members**, add each person with a username and a temporary
   password (they change it at first sign-in). Give admins the admin role.
4. **Make it reachable.** In **Admin → Phone access**, use **Temporary link** to get a public
   `https://….trycloudflare.com` URL (it changes on every start), or choose
   **Your domain** for a stable hostname: sign in to Cloudflare, approve your domain, choose an
   address and tunnel name, then select **Create and connect inbox**. The app creates the tunnel and
   DNS record without replacing existing websites. Existing tunnel tokens remain under
   **Advanced: use a tunnel token**. Alternatively, in **Settings**, turn on **Allow access from the
   local network (LAN)** for access on your local network only (plain HTTP, so only on a network you
   trust).
5. **On each phone:** open the URL, sign in, then **Add to Home Screen** (Safari share menu on
   iOS, browser menu on Android) and allow notifications. On iOS, push notifications only work from
   the installed Home Screen app, not from a Safari tab.

## Connect an AI assistant (MCP)

EzyChat Lite has a built-in [MCP](https://modelcontextprotocol.io) server at `/mcp`. Connect
claude.ai, ChatGPT, Claude Desktop or a developer tool, then ask it about your inbox in plain words.

**claude.ai, ChatGPT or Claude Desktop (no token):**

1. In **Admin → Settings → Integrations**, turn on **Let AI assistants read this inbox**.
2. Under **Connect an AI app**, click **Copy address**.
3. In your AI app, add a custom connector and paste the address.
4. EzyChat Lite opens. Sign in and click **Approve**. The app shows under **Connected apps**.

claude.ai and ChatGPT run in the cloud, so turn on **Phone access** (the tunnel) first. Claude
Desktop on the computer that runs EzyChat Lite can use the local address.

**Developer tools** (Claude Code, Gemini CLI, Cursor, scripts): open **For developer tools**,
create an access token and give your tool the address and the token as an `Authorization` header.

**What an assistant can do:**

| Area              | Tools                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read              | `get_stats`, `list_chats`, `get_chat`, `get_messages`, `get_activity`                                                                                    |
| AI agent          | `list_ai_agents`, `get_ai_agent_setup`, `get_ai_context_item`, `try_ai_reply`, `update_ai_setup`, `get_ai_setup_history`, `get_ai_setup_version`         |
| Send (off)        | `send_message` (text), `send_image` (photo + caption), `send_file` (PDF or Word .docx): only for an app or token set to **Can send WhatsApp messages**   |
| New numbers (off) | `send_to_new_number`: only with **Can also message new numbers** as well, up to 20 a day; WhatsApp can ban a number that messages people who did not ask |

- Access is off until an admin turns it on. **Remove** in **Connected apps** disconnects an app.
- Every change through MCP is kept in the audit log.
- Chats that an assistant reads go to the company that runs it (for example Anthropic, OpenAI or
  Google), under the account you connect.
- Sending is for replies that a person checks. Do not use it for bulk messages or marketing.

Step-by-step guides with screenshots are on the EzyChat website:
[connect Claude or ChatGPT](https://ezychat.ai/guides/connect-ai-assistant),
[set up the AI agent](https://ezychat.ai/guides/set-up-ai-agent) and
[WhatsApp automation with Claude](https://ezychat.ai/features/whatsapp-automation-claude).
To compare EzyChat Lite with other inbox tools, see the
[comparison pages](https://ezychat.ai/compare/sleekflow-alternative).

## Run modes

|               | Standalone (default)                                                            | Background service                                                            |
| ------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Runs when     | the desktop app is open (closing the window keeps it in the tray)               | the computer is on, even with nobody signed in                                |
| Data folder   | your user profile                                                               | `C:\ProgramData\wa-team-inbox` / `/Library/Application Support/wa-team-inbox` |
| How to switch | tray → **Status & Service…** → enable / disable service (asks for admin rights) | same                                                                          |

When the service is installed, the desktop app is just a window onto it. The tray menu also offers
**Reset admin password…**, the only way to recover the admin account.

## Updates

The hosting desktop checks GitHub for new published releases and suggests an update.
Use **About EzyChat Lite → Check for updates** or the tray menu to check manually.
Phone and browser clients update with the host and have no update alerts.
Installed Windows and Mac hosts download with progress, verify the installer, then offer
**Restart and update**. After you approve the system prompt, the app closes, updates and reopens;
an installed background service is stopped, updated and restarted automatically.
See [the update guide](docs/updating.md) for installation and background-service steps.

## Development

Requirements: Node.js 22+ and npm 10+.

```bash
npm install
npm run dev        # server with a fake WhatsApp adapter + Vite web UI (no real number needed)
npm test           # Vitest, all workspaces
npm run lint
npm run typecheck
npm run e2e        # Playwright (desktop, Pixel 7 and iPhone 14 viewports)
npm start -w @ezychat/desktop   # run the Electron app
npm run dist -w @ezychat/desktop  # build an installer for the current OS
```

| Path              | Package            | What                                                 |
| ----------------- | ------------------ | ---------------------------------------------------- |
| `packages/shared` | `@ezychat/shared`  | zod schemas and types for REST and socket payloads   |
| `packages/wa`     | `@ezychat/wa`      | `WaAdapter` interface, Baileys adapter, fake adapter |
| `packages/server` | `@ezychat/server`  | Fastify + Socket.IO + SQLite server (owns all state) |
| `apps/web`        | `@ezychat/web`     | React PWA (Vite, Tailwind, shadcn/ui)                |
| `apps/desktop`    | `@ezychat/desktop` | Electron shell, tray, service manager, packaging     |

Read [docs/architecture.md](docs/architecture.md) for how the pieces fit together and
[docs/design-system.md](docs/design-system.md) before touching the UI. Release testing with a real
number follows [docs/manual-test-checklist.md](docs/manual-test-checklist.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions
(Conventional Commits, tests required for behaviour changes) and the PR process, and follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Support

- **Issues:** found a bug or have a feature request?
  [Open an issue](https://github.com/ossmalaysia/ezychat-lite/issues/new/choose) on GitHub.
- **Custom features:** need something built for your team?
  [Contact Anchor Sprint](https://www.anchorsprint.com).

## License

[MIT](LICENSE) © 2026 OSS Malaysia and contributors

---

Built and maintained by [Anchor Sprint](https://www.anchorsprint.com). Need a custom feature?
[Contact us](https://www.anchorsprint.com).
