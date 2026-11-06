# App updates

The computer hosting EzyChat Lite checks published GitHub releases at startup and every
12 hours while the desktop app is running. **About EzyChat Lite** and the tray menu also
offer **Check for updates**. Phones, browsers and desktop clients attached to an independently
managed server have no update checks, workflow or alerts.

When a newer release exists, the host shows a suggestion with the version, release notes and
a download for its operating system and architecture. Review the update, then download when
ready. A suggestion never installs software, quits the inbox or interrupts a conversation.

Installed Windows and Mac hosts download and verify the matching installer inside the app.
The inbox keeps running during the download. After verification, the app presents
**Restart and update**; nothing is installed until you choose it.

## Install a suggested update

1. Choose **Download** in About or **Status & Service**. The progress bar shows the download;
   you can cancel it while continuing to use your inbox.
2. When it says **downloaded and verified**, choose a quiet time and click **Restart and update**.
3. Approve the Windows administrator or Mac system prompt. Cancelling keeps the current app running.
4. The updater prepares a rollback copy, closes the app and stops any installed background service.
   It replaces the app, refreshes the Mac service's protected runtime, restarts an installed service
   and checks that it reports the new version. Finally it reopens the desktop as the original user.
5. About and **Status & Service** show the installed version and the previous update's result.

Updating briefly disconnects the team's browsers and phones. An installed service is restarted
after the update, including one that was stopped beforehand. A standalone installation stays standalone.
The updater never removes the service, moves the data directory or resets accounts.

If replacement or service startup fails, the helper attempts to restore the previous app/runtime
and restart its service. A failure is shown after relaunch. If recovery also fails, keep the rollback
copy in the machine's `wa-team-inbox-updates` folder and use **Status & Service** to inspect the error.
Recovery is best effort: sudden power loss or disk failure can still require manual repair.
Rollback copies contain app/runtime binaries, not a database snapshot. The updater preserves
the inbox data in place. A future release with incompatible database migrations may require
restoring the server's existing data backup; this update adds no database migration.

## When a manual installer is needed

Automatic installation requires Windows installed under Program Files, or the Mac app directly
in `/Applications`. Development/unpacked builds and other locations offer the GitHub installer.
Releases without GitHub SHA-256 and size metadata also require a manual download.

For a manual Windows service update, stop the service, quit the app from the tray, install in the
same directory, reopen the app and start the service. For a manual Mac service update, remove the
service first, quit the app, replace it in Applications, then enable the service again so its protected
runtime receives the new version. These operations preserve the inbox data.

**Windows 0.1.16 or earlier → 0.1.17 is always manual.** 0.1.17 renames the program to
`Program Files\EzyChat Lite\EzyChat Lite.exe`; older updaters only recognise `WA Team Inbox.exe` and
roll back. Stop the service, install 0.1.17 into `Program Files\EzyChat Lite`, then recreate the
service command from the new app (its generator quotes paths containing spaces) and start the service.
The data folder and WhatsApp link stay in place. From 0.1.17 onwards in-app updates work again.

**Mac 0.1.77 or earlier → 0.1.78 is always manual.** The Mac updater of those versions started its
administrator helper with `nohup`, which macOS stops before it runs when there is no console (the
administrator prompt). The update downloads and asks for the password, then reports that it could not update
and keeps the old version. Download the Mac installer (arm64 or x64) from the latest GitHub release, quit
EzyChat, and drag the new app over the old one in `/Applications`. Data stays in place. From 0.1.78 onwards
in-app updates work again, also with the background service running.

On a Mac, **Status & Service** and **Check for updates** are in the menu bar icon and in the Dock icon's menu
(right-click): macOS hides menu bar icons when the bar is full. If macOS refuses to start the background service,
check that EzyChat is switched on under System Settings → General → Login Items & Extensions → Allow in the
Background. While its server runs, EzyChat keeps the Mac from idle sleep (the display may still sleep; closing
the lid still sleeps the Mac), so customers and AI replies are not left waiting.

Accounts, conversations, settings and WhatsApp credentials remain in the app's data directory;
updating does not reset it. Phone and browser clients receive the new interface from the host.
Check the app and server version in **Status & Service** after updating a background service.

## Release detection and publishing contract

- Source: public `ossmalaysia/ezychat-lite` GitHub Releases API, without credentials.
- Compare strict semantic versions, not publication order or text ordering. Never offer a downgrade.
- Ignore draft releases and tags without a published release.
- During the 0.x preview stage, include published preview releases and label them. Stable 1.x
  builds accept full releases; builds with a prerelease version also accept preview releases.
- Select the exact asset `EzyChat-Lite-<version>-win-x64.exe` or
  `EzyChat-Lite-<version>-mac-<x64|arm64>.dmg`; accept historical `WA-Team-Inbox-…` assets
  from this renamed repository for earlier releases. If it is missing, offer release details and
  explain that a compatible installer is unavailable.
- Release notes are plain text. Download and release URLs must exactly match this repository
  and the selected release; renderer code cannot provide arbitrary URLs.
- Managed installation requires the GitHub asset's `sha256` digest and exact byte size. Downloads
  stream into private staging, restrict every redirect, remove failed partial files and are rehashed
  before installation. The privileged helper verifies its protected copy again.
- The native helper runs outside Electron so the old executable can exit before replacement.
  Update staging sits outside app and inbox data directories. Existing service identity and
  security guards remain in force; elevated code never relaunches the desktop as an administrator.
- Checks have a 15-second timeout, bounded responses/pagination and a 60-second minimum retry
  interval. Respect GitHub rate limits, retain useful previous release details on failure and
  never report an unavailable check as up to date.
- The release workflow packages each native architecture and creates a draft. Publish only after
  all intended installers and package smoke checks are ready. A local build or pushed tag alone
  does not trigger an update suggestion.

Existing app data, service identifiers and the Windows executable name retain their legacy
identity during the EzyChat Lite rename. No database reset or WhatsApp relink is required for
the rebrand. Versions that predate the repository rename may fail their old GitHub update check;
download the first EzyChat Lite upgrade directly from the new Releases page in that case.

Current preview installers are unsigned. Checksum verification establishes the selected GitHub
asset's integrity; it is not a developer code signature. Developer signing/notarization remains
future release work. Windows elevation and macOS installation checks are exercised with isolated
fixtures; real elevated Windows and Mac upgrade smoke tests are required before publishing this flow.

References: [GitHub Releases API](https://docs.github.com/en/rest/releases/releases) and
[Electron updater requirements](https://www.electronjs.org/docs/latest/api/auto-updater).
