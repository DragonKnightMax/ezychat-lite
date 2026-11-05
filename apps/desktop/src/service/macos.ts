// macOS LaunchDaemon builders. Pure string builders — no electron import (unit tested).
import { posix } from 'node:path';
import { dataMoveCommands } from './data-move.js';
import type { ServiceState } from './windows.js';

export interface LaunchdOptions {
  label: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  logDir: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** POSIX shell single-quoted literal. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function plistPath(label: string): string {
  return `/Library/LaunchDaemons/${label}.plist`;
}

export function launchdPlist(o: LaunchdOptions): string {
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  const args = [o.program, ...o.args].map((a) => `    ${s(a)}`).join('\n');
  const env = Object.entries(o.env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    ${s(v)}`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${s(o.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    env,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // Restart after a crash only: server-host turns the exits that a restart cannot fix (bad arguments,
    // data folder locked, moved to Enterprise) into 0, so launchd does not retry them forever.
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    // stdout repeats the server's own daily-rotated logs/server.log; launchd never rotates this file.
    '  <key>StandardOutPath</key>',
    '  <string>/dev/null</string>',
    '  <key>StandardErrorPath</key>',
    `  ${s(posix.join(o.logDir, 'service.err.log'))}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface MacInstallOptions extends LaunchdOptions {
  dataDir: string;
  moveFrom: string;
  exists?: ((p: string) => boolean) | null;
  /**
   * Copy the app bundle `from` (e.g. /Applications/X.app, owned and writable by the user who
   * dragged it there) to the root-owned `to` and run the daemon from there, so the user (or
   * malware running as them) cannot swap app.asar / the binary and get it executed as root.
   * `program`/`args`/`env` must already point into `to` (see remapRuntimePaths).
   */
  runtime?: { from: string; to: string };
}

/** Rewrites paths under the app bundle `from` to the same paths under `to`. */
export function remapRuntimePaths(
  cmd: { exe: string; args: string[]; env: Record<string, string> },
  from: string,
  to: string,
): { exe: string; args: string[]; env: Record<string, string> } {
  const base = from.replace(/\/+$/, '');
  const map = (v: string) =>
    v === base || v.startsWith(`${base}/`) ? to + v.slice(base.length) : v;
  return {
    exe: map(cmd.exe),
    args: cmd.args.map(map),
    env: Object.fromEntries(Object.entries(cmd.env).map(([k, v]) => [k, map(v)])),
  };
}

function runtimeCopyLines(r: { from: string; to: string }): string[] {
  const parent = posix.dirname(r.to);
  const to = shQuote(r.to);
  return [
    // /Library/Application Support is root-owned, so nobody else can pre-create this folder
    `mkdir -p ${shQuote(parent)}`,
    `chown root:wheel ${shQuote(parent)}`,
    `chmod -N ${shQuote(parent)}`,
    `chmod 755 ${shQuote(parent)}`,
    `rm -rf ${to}`,
    // Source ACLs can grant ordinary users write access even after chown/chmod: never copy them.
    `ditto --noacl ${shQuote(r.from)} ${to}`,
    // A downloaded app carries the quarantine flag; on this unnotarized copy Gatekeeper refuses every
    // launchd start ("cannot be opened" over and over). The user already opened and approved the app.
    `xattr -dr com.apple.quarantine ${to} 2>/dev/null || true`,
    `chown -R root:wheel ${to}`,
    `chmod -RN ${to}`,
    `chmod -R go-w ${to}`,
    `if [ "$(stat -f %Su ${to})" != root ]; then echo "runtime copy is not root-owned" >&2; exit 4; fi`,
  ];
}

/** sh script (run as root): move data, lock down data dir, write plist, bootstrap the daemon. */
export function macInstallScript(o: MacInstallOptions): string {
  const plist = plistPath(o.label);
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    ...dataMoveCommands('darwin', o.moveFrom, o.dataDir, o.exists === undefined ? null : o.exists),
    `mkdir -p ${shQuote(o.dataDir)} ${shQuote(o.logDir)}`,
    `chown -R root:wheel ${shQuote(o.dataDir)}`,
    `chmod 700 ${shQuote(o.dataDir)}`,
    ...(o.runtime ? runtimeCopyLines(o.runtime) : []),
    `cat > ${shQuote(plist)} <<'WATI_PLIST_EOF'`,
    launchdPlist(o).trimEnd(),
    'WATI_PLIST_EOF',
    `chown root:wheel ${shQuote(plist)}`,
    `chmod 644 ${shQuote(plist)}`,
    `launchctl bootout system/${o.label} 2>/dev/null || true`,
    `launchctl bootstrap system ${shQuote(plist)}`,
    `echo 'Service installed and started.'`,
    '',
  ].join('\n');
}

export interface MacUninstallOptions {
  label: string;
  dataDir: string;
  moveTo: string;
  /** local user who owns the moved-back data */
  owner: string;
  /** root-owned runtime copy (and port file) folder to remove */
  runtimeDir?: string;
}

export function macUninstallScript(o: MacUninstallOptions): string {
  const plist = plistPath(o.label);
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    // Refuse before touching the daemon: a move into a folder that holds an app.db stops halfway.
    `if [ -d ${shQuote(o.dataDir)} ] && [ -e ${shQuote(posix.join(o.moveTo, 'app.db'))} ]; then echo "Target already contains app.db; the service was left as it is." >&2; exit 3; fi`,
    // The target is in the user's home: a symlink there (or above it) would send the move as root
    // elsewhere. Checked before the daemon is touched, and again right before each privileged write.
    `assert_no_link_up() { local p="$1"; while [ "$p" != "/" ] && [ -n "$p" ]; do if [ -L "$p" ]; then echo "Unexpected link: $p" >&2; exit 3; fi; p=$(dirname "$p"); done; }`,
    `assert_no_link_up ${shQuote(o.moveTo)}`,
    `assert_no_link_up ${shQuote(o.dataDir)}`,
    `launchctl bootout system/${o.label} 2>/dev/null || true`,
    `rm -f ${shQuote(plist)}`,
    ...(o.runtimeDir ? [`rm -rf ${shQuote(o.runtimeDir)}`] : []),
    `assert_no_link_up ${shQuote(o.moveTo)}`,
    ...dataMoveCommands('darwin', o.dataDir, o.moveTo, null),
    `if [ -d ${shQuote(o.moveTo)} ]; then assert_no_link_up ${shQuote(o.moveTo)}; chown -R ${shQuote(o.owner)} ${shQuote(o.moveTo)}; fi`,
    `echo 'Service removed.'`,
    '',
  ].join('\n');
}

/**
 * sh script (run as root): the service data folder (with its logs) is root-only, so Finder cannot open it.
 * Copy the logs into a new mktemp folder, give it to the user and print its path. Root writes only into
 * the folder mktemp just created, never into one the user could have prepared or linked.
 */
export function macCopyLogsScript(o: {
  logDir: string;
  tempPrefix: string;
  owner: string;
}): string {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    `out=$(mktemp -d ${shQuote(`/private/tmp/${o.tempPrefix}.XXXXXX`)})`,
    `if [ -d ${shQuote(o.logDir)} ]; then ditto --noacl ${shQuote(o.logDir)} "$out"; fi`,
    `chown -R ${shQuote(o.owner)} "$out"`,
    'chmod 700 "$out"',
    'echo "$out"',
    '',
  ].join('\n');
}

export function macControlScript(o: { label: string; action: 'start' | 'stop' }): string {
  const plist = plistPath(o.label);
  const body =
    o.action === 'start'
      ? [
          `if launchctl print system/${o.label} >/dev/null 2>&1; then`,
          `  launchctl kickstart -k system/${o.label}`,
          'else',
          `  launchctl bootstrap system ${shQuote(plist)}`,
          'fi',
        ]
      : [`launchctl bootout system/${o.label} 2>/dev/null || true`];
  return ['#!/bin/bash', 'set -euo pipefail', ...body, ''].join('\n');
}

export function macResetAdminScript(o: { exe: string; entry: string; dataDir: string }): string {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    `ELECTRON_RUN_AS_NODE=1 ${shQuote(o.exe)} ${shQuote(o.entry)} --data ${shQuote(o.dataDir)} --reset-admin`,
    '',
  ].join('\n');
}

/** Interprets `launchctl print system/<label>` (exit code + output) plus whether the plist exists. */
export function parseLaunchctlPrint(
  exitCode: number,
  output: string,
  plistExists: boolean,
): ServiceState {
  if (exitCode === 0) return /state\s*=\s*running/.test(output) ? 'running' : 'stopped';
  return plistExists ? 'stopped' : 'not-installed';
}
