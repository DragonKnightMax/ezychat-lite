import { describe, expect, it } from 'vitest';
import {
  launchdPlist,
  macInstallScript,
  macCopyLogsScript,
  macUninstallScript,
  parseLaunchctlPrint,
  remapRuntimePaths,
  shQuote,
} from './macos.js';

const opts = {
  label: 'org.ossmalaysia.wateaminbox.server',
  program: '/Applications/WA Team Inbox.app/Contents/MacOS/WA Team Inbox',
  args: [
    '/Applications/WA Team Inbox.app/Contents/Resources/app.asar/dist/server/server.cjs',
    '--data',
    '/Library/Application Support/wa-team-inbox',
    '--x',
    'a&b<c>',
  ],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  logDir: '/Library/Application Support/wa-team-inbox/logs',
};

describe('launchdPlist', () => {
  const xml = launchdPlist(opts);
  it('is a plist document', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<!DOCTYPE plist');
    expect(xml.trim().endsWith('</plist>')).toBe(true);
  });
  it('has label, RunAtLoad and restarts after a crash only', () => {
    expect(xml).toMatch(
      /<key>Label<\/key>\s*<string>org\.ossmalaysia\.wateaminbox\.server<\/string>/,
    );
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    );
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });
  it('has ProgramArguments array: program first, then escaped args', () => {
    const m = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    expect(m).not.toBeNull();
    const items = [...m![1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) => x[1]);
    expect(items).toEqual([
      opts.program,
      opts.args[0],
      '--data',
      '/Library/Application Support/wa-team-inbox',
      '--x',
      'a&amp;b&lt;c&gt;',
    ]);
  });
  it('has env dict and log paths', () => {
    expect(xml).toMatch(
      /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/,
    );
    expect(xml).toContain('<key>StandardOutPath</key>');
    expect(xml).toContain('<key>StandardOutPath</key>\n  <string>/dev/null</string>');
    expect(xml).toContain('<key>StandardErrorPath</key>');
  });
  it('balances dict/array tags', () => {
    expect(xml.match(/<dict>/g)?.length).toBe(xml.match(/<\/dict>/g)?.length);
    expect(xml.match(/<array>/g)?.length).toBe(xml.match(/<\/array>/g)?.length);
  });
});

describe('shQuote', () => {
  it('single-quotes and escapes embedded single quotes', () => {
    expect(shQuote("it's here")).toBe("'it'\\''s here'");
  });
});

describe('macInstallScript', () => {
  const s = macInstallScript({
    ...opts,
    dataDir: '/Library/Application Support/wa-team-inbox',
    moveFrom: '/Users/me/Library/Application Support/WA Team Inbox/data',
    exists: (p: string) => p.endsWith('WA Team Inbox/data'),
  });
  it('writes plist with root ownership and 644, chmod 700 data, bootstraps', () => {
    expect(s).toContain("'/Library/LaunchDaemons/org.ossmalaysia.wateaminbox.server.plist'");
    expect(s).toContain('chown root:wheel');
    expect(s).toContain('chmod 644');
    expect(s).toContain('chmod 700');
    expect(s).toContain('launchctl bootstrap system');
    expect(s.indexOf('launchctl bootstrap')).toBeGreaterThan(s.indexOf('chmod 700'));
  });
  it('moves data before bootstrapping', () => {
    expect(s.indexOf('cp -a')).toBeGreaterThan(-1);
    expect(s.indexOf('cp -a')).toBeLessThan(s.indexOf('launchctl bootstrap'));
  });
});

describe('macUninstallScript', () => {
  it('boots out, removes plist, moves data back and chowns to user', () => {
    const s = macUninstallScript({
      label: opts.label,
      dataDir: '/Library/Application Support/wa-team-inbox',
      moveTo: '/Users/me/data',
      owner: 'me',
    });
    expect(s.indexOf('launchctl bootout')).toBeLessThan(s.indexOf('cp -a'));
    // The app.db check runs before the daemon is touched (a half move would strand the data).
    const iCheck = s.indexOf("[ -e '/Users/me/data/app.db' ]; then echo");
    expect(iCheck).toBeGreaterThan(-1);
    expect(iCheck).toBeLessThan(s.indexOf('launchctl bootout'));
    // And no symlink at or above the target or the machine folder (root would follow it), checked
    // before the daemon is touched and again right before the move and the chown.
    expect(s).toContain('if [ -L "$p" ]; then echo "Unexpected link');
    const target = "assert_no_link_up '/Users/me/data'";
    expect(s.split(target).length - 1).toBe(3);
    const iBootout = s.indexOf('launchctl bootout');
    expect(s.indexOf(target)).toBeGreaterThan(iCheck);
    expect(s.indexOf(target)).toBeLessThan(iBootout);
    expect(
      s.indexOf("assert_no_link_up '/Library/Application Support/wa-team-inbox'"),
    ).toBeLessThan(iBootout);
    expect(s.indexOf(target, iBootout)).toBeLessThan(s.indexOf('cp -a'));
    expect(s.lastIndexOf(target)).toBeLessThan(s.indexOf('chown -R'));
    expect(s).toContain("rm -f '/Library/LaunchDaemons/org.ossmalaysia.wateaminbox.server.plist'");
    expect(s).toContain("chown -R 'me'");
  });
});

describe('parseLaunchctlPrint', () => {
  it('running', () => {
    expect(parseLaunchctlPrint(0, 'system/x = {\n\tstate = running\n', true)).toBe('running');
  });
  it('loaded but not running', () => {
    expect(parseLaunchctlPrint(0, 'state = not running', true)).toBe('stopped');
  });
  it('not loaded but plist present → stopped', () => {
    expect(parseLaunchctlPrint(113, 'Could not find service', true)).toBe('stopped');
  });
  it('not loaded and no plist → not-installed', () => {
    expect(parseLaunchctlPrint(113, 'Could not find service', false)).toBe('not-installed');
  });
});

describe('macOS root daemon never runs user-writable code', () => {
  const bundle = '/Applications/WA Team Inbox.app';
  const dest = '/Library/Application Support/wa-team-inbox-runtime/WA Team Inbox.app';
  it('remapRuntimePaths points program, args and env into the root-owned copy', () => {
    const r = remapRuntimePaths(
      {
        exe: `${bundle}/Contents/MacOS/WA Team Inbox`,
        args: [
          `${bundle}/Contents/Resources/app.asar/dist/server-host.cjs`,
          '--data',
          '/Library/Application Support/wa-team-inbox',
        ],
        env: { WATI_CLOUDFLARED: `${bundle}/Contents/Resources/cloudflared/cloudflared`, X: '1' },
      },
      bundle,
      dest,
    );
    expect(r.exe).toBe(`${dest}/Contents/MacOS/WA Team Inbox`);
    expect(r.args[0]).toBe(`${dest}/Contents/Resources/app.asar/dist/server-host.cjs`);
    expect(r.args[2]).toBe('/Library/Application Support/wa-team-inbox');
    expect(r.env.WATI_CLOUDFLARED).toBe(`${dest}/Contents/Resources/cloudflared/cloudflared`);
    expect(r.env.X).toBe('1');
  });
  it('does not remap look-alike prefixes', () => {
    const r = remapRuntimePaths({ exe: `${bundle}x/y`, args: [], env: {} }, bundle, dest);
    expect(r.exe).toBe(`${bundle}x/y`);
  });
  it('install script copies the bundle root-owned and not group/world writable before bootstrapping', () => {
    const s = macInstallScript({
      ...opts,
      program: `${dest}/Contents/MacOS/WA Team Inbox`,
      dataDir: '/Library/Application Support/wa-team-inbox',
      moveFrom: '/Users/me/data',
      exists: null,
      runtime: { from: bundle, to: dest },
    });
    const iDitto = s.indexOf(`ditto --noacl '${bundle}' '${dest}'`);
    expect(iDitto).toBeGreaterThan(-1);
    expect(s).toContain(`chown -R root:wheel '${dest}'`);
    expect(s).toContain(`chmod -N '/Library/Application Support/wa-team-inbox-runtime'`);
    expect(s).toContain(`chmod -RN '${dest}'`);
    expect(s.indexOf(`chmod -RN '${dest}'`)).toBeGreaterThan(iDitto);
    expect(s.indexOf(`chmod -RN '${dest}'`)).toBeLessThan(s.indexOf(`chmod -R go-w '${dest}'`));
    expect(s).toContain(`chmod -R go-w '${dest}'`);
    expect(s.indexOf('launchctl bootstrap')).toBeGreaterThan(s.indexOf(`chmod -R go-w '${dest}'`));
    // previous copy is removed first
    expect(s.indexOf(`rm -rf '${dest}'`)).toBeLessThan(iDitto);
  });
  it('clears the quarantine flag of the runtime copy, or Gatekeeper refuses every launchd start', () => {
    const s = macInstallScript({
      ...opts,
      dataDir: '/Library/Application Support/wa-team-inbox',
      moveFrom: '/Users/me/data',
      exists: null,
      runtime: { from: bundle, to: dest },
    });
    const strip = s.indexOf(`xattr -dr com.apple.quarantine '${dest}'`);
    expect(strip).toBeGreaterThan(s.indexOf(`ditto --noacl '${bundle}' '${dest}'`));
    expect(strip).toBeLessThan(s.indexOf('launchctl bootstrap'));
  });
  it('uninstall removes the runtime copy', () => {
    const s = macUninstallScript({
      label: opts.label,
      dataDir: '/Library/Application Support/wa-team-inbox',
      moveTo: '/Users/me/data',
      owner: 'me',
      runtimeDir: '/Library/Application Support/wa-team-inbox-runtime',
    });
    expect(s).toContain("rm -rf '/Library/Application Support/wa-team-inbox-runtime'");
  });
});

describe('macCopyLogsScript', () => {
  const s = macCopyLogsScript({
    logDir: '/Library/Application Support/wa-team-inbox/logs',
    tempPrefix: 'wa-team-inbox-logs',
    owner: 'me',
  });
  it('copies the root-only logs into a fresh folder the user owns and prints it', () => {
    expect(s).toContain("out=$(mktemp -d '/private/tmp/wa-team-inbox-logs.XXXXXX')");
    expect(s).toContain(`ditto --noacl '/Library/Application Support/wa-team-inbox/logs' "$out"`);
    expect(s).toContain(`chown -R 'me' "$out"`);
    expect(s.trim().endsWith('echo "$out"')).toBe(true);
  });
  it('never writes as root into a folder the user could have prepared', () => {
    expect(s).not.toMatch(/\$TMPDIR|\/Users\//);
  });
});
