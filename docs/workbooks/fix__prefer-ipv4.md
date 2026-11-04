# Workbook: Prefer IPv4 for outgoing connections

Branch: `fix/prefer-ipv4` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | skip | One-line runtime setting, no UI | 83d1bf1 | 2026-11-03 |
| Dev | done | preferIpv4() (dns ipv4first) at the start of runCli | 83d1bf1 | 2026-11-03 |
| Unit tests | pass | dns-order.test.ts 2 pass (lookup order; runCli sets it before argument parsing) | 83d1bf1 | 2026-11-03 |
| E2E | skip | No screen or web contract change | 83d1bf1 | 2026-11-03 |
| Dev Build | pass | Packaged --dir: server starts, health 200, bundle has ipv4first. Broken-IPv6 network: owner Mac after release | e14d1dbb | 2026-11-03 |
| Screen review | skip | No UI | 83d1bf1 | 2026-11-03 |

## Log

- 2026-11-03 Dev: done — preferIpv4() (dns ipv4first) at the start of runCli (83d1bf1)
- 2026-11-03 Unit tests: pass — dns-order.test.ts 2 pass (lookup order; runCli sets it before argument parsing) (83d1bf1)
- 2026-11-03 E2E: skip — No screen or web contract change (83d1bf1)
- 2026-11-03 Screen review: skip — No UI (83d1bf1)
- 2026-11-03 Dev Build: skip — The failure needs a network with broken IPv6: owner's Mac, 5 runs of /tmp/ezc-net.js after the release (83d1bf1)
- 2026-11-03 Design: skip — One-line runtime setting, no UI (83d1bf1)
- 2026-11-03 Dev Build: pass — Server starts via runCli on temp data (health 200); Electron 45: verbatim -> ipv4first. Broken-IPv6 network: owner Mac after release (15adb523)
- 2026-11-03 Dev Build: pass — Packaged --dir: server starts, health 200, bundle has ipv4first. Broken-IPv6 network: owner Mac after release (e14d1dbb)
