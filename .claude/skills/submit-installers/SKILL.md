---
name: submit-installers
description: Submit released EzyChat installers (Lite and Enterprise; Windows, Mac Apple silicon, Mac Intel) to McAfee's allowlisting form, keep the allowlist record and read McAfee's answers. Use for /submit-installers and whenever the owner asks to submit, report, whitelist or allowlist an installer, "submit to McAfee", "whitelist the latest", "McAfee blocks the installer", "did McAfee answer", also when the words are only "submit the new installers" after a release.
---

# Submit installers to McAfee

An allowlisting covers one exact file (one SHA-256), so every release has new files that need new reports. The script
`scripts/mcafee-submit.mjs` does the work and the owner attaches nothing by hand.

Run this only when the owner asks for it: a report goes to an outside company and cannot be taken back. A release or
a merge alone is not a request.

## Submit

1. Read the record: `docs/antivirus-allowlist.md` in `anchorsprint/ezychat-enterprise` (branch `main`, or
   `docs/antivirus-allowlist` until PR #97 is merged). Leave out a file that already says Submitted or Whitelisted.
2. Make sure `~/.ezychat/mcafee-reporter.json` exists, with `fullName`, `email` and `company`. It stays outside the
   repo, because this repo is public. McAfee answers that email address.
3. Run the script from a checkout with `node_modules`, in the background (about 70 s per file, plus downloads):

   ```powershell
   $env:PATH = "D:\nvm\v24.13.0;$env:PATH"
   node scripts/mcafee-submit.mjs --edition all
   ```

   Options: `--edition lite|enterprise`, `--version 0.1.79` (one edition only), `--only win,mac-arm64,mac-x64`,
   `--dry-run` (everything except clicking Submit).

   On a Mac: `node scripts/mcafee-submit.mjs --edition all --only mac-arm64,mac-x64` (Windows files need Windows
   PowerShell for their signature check, so a Mac run stops at them). A Mac run mounts each `.dmg` read-only and
   checks the app inside (`codesign`, `spctl`, `stapler`): only then does the report say "signed with our
   Developer ID and notarized by Apple" (Lite 0.1.82 and Enterprise 0.1.30 onwards); an older ad-hoc build, or a
   run on Windows, claims no Mac signature.

   Before publishing (owner rule from 2026-11-09: McAfee gets the installers first):
   - Lite: push the tag by hand (`release.yml` then leaves a draft), run `--edition lite --version <x.y.z>` (it finds the
     draft and downloads through the API), then publish that draft (`docs/release.md` §3).
   - Enterprise: run Installers from `main` (`gh workflow run installers.yml --ref main`; no tag, so nothing is
     published), run `--edition enterprise --run <run id>`, then publish the same run in the Enterprise repo with
     `node scripts/publish-release.mjs --run <run id>` (a logged-in wrangler), and put the Windows hold back.

4. Read the output. `SUBMITTED` means that the page said "The form has been submitted." `STOPPED` means that the run
   ended there and later files were not sent: fix the cause and run the same command again. Reports already sent are
   remembered in the work folder and are skipped.
5. Add or update the rows in the record with the date and the SHA-256 values that the script printed, and commit that
   to the Enterprise repo through a PR ([skip ci]). Merge only on the owner's request.
6. Tell the owner which files went out, and that the answer comes by email.

## What the script stops for, and why

| Stop                                           | Why                                                                                     | What to do                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| Download differs from the release hash         | The report must describe the file that users get                                        | Do not submit; tell the owner           |
| Windows signature not valid, or another signer | The report claims a valid signature                                                     | Do not submit; tell the owner           |
| Captcha on the page                            | Only the owner solves a captcha                                                         | Ask the owner                           |
| "Invalid File Extension"                       | The form changed what it accepts (a `.dmg` is always refused, so Mac files go in a ZIP) | Check the form; do not retry blindly    |
| File not attached                              | A report without the file is useless                                                    | Read the screenshots in the work folder |

Limits seen on the form: files up to 230 MB went through, a 407 MB ZIP failed. So each file goes in its own report.
Claude in Chrome cannot attach these files (10 MB limit), which is why the script uses Playwright in a Chrome window.

## Answers

1. Search Outlook with `outlook_email_search`, sender `MB_data_submission@mcafee.com`. The answers go to the address
   in the reporter file. The Gmail connector does not see them.
2. Read which file the answer names. It can name the `.dmg` inside a ZIP, or only the ZIP; we do not know yet. Quote
   the name to the owner. Only a named file becomes **Whitelisted** in the record.
3. For an Enterprise Windows file, follow "After each release" in the record to move the permanent link.

The form says about 2 business days; one answer came within the hour.

## Rules that stay with the owner

- A Windows **Enterprise** file is not "latest" until McAfee whitelists it. The hold and the commands that move the
  link are in the record, section "After each release". Changing a live link needs the owner's request.
- Lite releases on GitHub have no such hold. Do not move a Lite link without the owner's word.
- Never say that a file is whitelisted because the form accepted the report.
