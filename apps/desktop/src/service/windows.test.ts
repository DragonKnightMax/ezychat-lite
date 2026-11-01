import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseScQuery,
  psQuote,
  quoteWinArg,
  windowsInstallScript,
  windowsUninstallPrechecks,
  windowsUninstallScript,
  windowsControlScript,
  windowsResetAdminScript,
  winswXml,
} from './windows.js';

const base = {
  id: 'wa-team-inbox',
  name: 'WA Team Inbox Server',
  exe: 'C:\\Program Files\\WA Team Inbox\\WA Team Inbox.exe',
  args: [
    'C:\\Program Files\\WA Team Inbox\\resources\\app.asar\\dist\\server\\server.cjs',
    '--data',
    'C:\\ProgramData\\wa-team-inbox',
    '--mode',
    'service',
    '--note',
    'a "quoted" & <tag>',
  ],
  env: { ELECTRON_RUN_AS_NODE: '1', WATI_VERSION: '0.1.0' },
  logDir: 'C:\\ProgramData\\wa-team-inbox\\service\\logs',
};

describe('quoteWinArg', () => {
  it('leaves simple args alone', () => {
    expect(quoteWinArg('--data')).toBe('--data');
  });
  it('quotes args with spaces', () => {
    expect(quoteWinArg('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
  });
  it('escapes embedded quotes', () => {
    expect(quoteWinArg('a "b"')).toBe('"a \\"b\\""');
  });
  it('doubles trailing backslashes before closing quote', () => {
    expect(quoteWinArg('C:\\a b\\')).toBe('"C:\\a b\\\\"');
  });
  it('quotes empty string', () => {
    expect(quoteWinArg('')).toBe('""');
  });
});

describe('Windows LocalSystem runtime protection', () => {
  const install = windowsInstallScript({
    ...base,
    winswSource: 'C:\\Program Files\\WA Team Inbox\\resources\\winsw\\WinSW-x64.exe',
    serviceDir: 'C:\\ProgramData\\wa-team-inbox\\service',
    dataDir: 'C:\\ProgramData\\wa-team-inbox',
    moveFrom: 'C:\\Users\\me\\data',
    exists: () => false,
  });

  it('checks the executable, all runtime files and ancestors before moving data or installing', () => {
    const validation = install.indexOf(
      "Assert-ProtectedRuntime 'C:\\Program Files\\WA Team Inbox\\WA Team Inbox.exe'",
    );
    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(install.indexOf('Move-Item -LiteralPath'));
    expect(validation).toBeLessThan(install.indexOf('Copy-Item -LiteralPath'));
    expect(install).toContain("GetFolderPath('ProgramFilesX86')");
    expect(install).toContain('OrdinalIgnoreCase');
    expect(install).toContain('Get-ChildItem -LiteralPath $runtimeDir -Force -Recurse');
    expect(install).toContain('Get-Item -LiteralPath $ancestor -Force');
    expect(install).toContain('ReparsePoint');
    expect(install).toContain('$acl.GetOwner($runtimeSidType).Value');
    expect(install).toContain('$ace.FileSystemRights -band $runtimeWriteRights');
    expect(install).toContain('unpacked and user-folder builds can run in standalone mode');
  });

  it('revalidates before starting or privileged password reset, while stop remains available', () => {
    const start = windowsControlScript({
      id: base.id,
      serviceDir: 'C:\\ProgramData\\wa-team-inbox\\service',
      action: 'start',
    });
    expect(start.indexOf('Assert-ProtectedRuntime')).toBeLessThan(
      start.indexOf("wa-team-inbox.exe' start"),
    );
    expect(start).toContain('Assert-ProtectedRuntime ([string]$serviceConfig.service.executable)');
    expect(
      start.indexOf("Assert-Locked 'C:\\ProgramData\\wa-team-inbox\\service' -Recurse"),
    ).toBeLessThan(start.indexOf('$serviceConfig.Load('));
    const reset = windowsResetAdminScript({
      exe: base.exe,
      entry: base.args[0]!,
      dataDir: 'C:\\ProgramData\\wa-team-inbox',
    });
    expect(reset.indexOf('Assert-ProtectedRuntime')).toBeLessThan(reset.indexOf('--reset-admin'));
    const stop = windowsControlScript({
      id: base.id,
      serviceDir: 'C:\\ProgramData\\wa-team-inbox\\service',
      action: 'stop',
    });
    expect(stop).not.toContain('Assert-ProtectedRuntime');
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects an unpacked runtime in native PowerShell before writing machine data',
    () => {
      const temp = mkdtempSync(join(tmpdir(), 'ezychat-runtime-review-'));
      const dataDir = join(temp, 'machine-data');
      const file = join(temp, 'verify.ps1');
      try {
        writeFileSync(
          file,
          windowsInstallScript({
            ...base,
            exe: join(temp, 'WA Team Inbox.exe'),
            winswSource: join(temp, 'WinSW.exe'),
            serviceDir: join(dataDir, 'service'),
            dataDir,
            moveFrom: join(temp, 'user-data'),
            exists: () => false,
          }),
        );
        let output = '';
        try {
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], {
            windowsHide: true,
            stdio: 'pipe',
            timeout: 15_000,
          });
        } catch (error) {
          output = String((error as { stderr?: unknown }).stderr ?? '');
        }
        expect(output).toContain('Background service requires an installed app in Program Files');
        expect(existsSync(dataDir)).toBe(false);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe('winswXml', () => {
  const xml = winswXml(base);
  it('contains id, name, executable', () => {
    expect(xml).toContain('<id>wa-team-inbox</id>');
    expect(xml).toContain('<name>WA Team Inbox Server</name>');
    expect(xml).toContain(
      '<executable>C:\\Program Files\\WA Team Inbox\\WA Team Inbox.exe</executable>',
    );
  });
  it('contains XML-escaped, command-line quoted arguments', () => {
    expect(xml).toContain(
      '<arguments>&quot;C:\\Program Files\\WA Team Inbox\\resources\\app.asar\\dist\\server\\server.cjs&quot; --data C:\\ProgramData\\wa-team-inbox --mode service --note &quot;a \\&quot;quoted\\&quot; &amp; &lt;tag&gt;&quot;</arguments>',
    );
  });
  it('sets ELECTRON_RUN_AS_NODE env', () => {
    expect(xml).toContain('<env name="ELECTRON_RUN_AS_NODE" value="1"/>');
    expect(xml).toContain('<env name="WATI_VERSION" value="0.1.0"/>');
  });
  it('starts automatically and restarts on failure', () => {
    expect(xml).toContain('<startmode>Automatic</startmode>');
    expect(xml).toContain('<onfailure action="restart" delay="5 sec"/>');
  });
  it('rolls logs by size into logDir', () => {
    expect(xml).toContain('<logpath>C:\\ProgramData\\wa-team-inbox\\service\\logs</logpath>');
    expect(xml).toContain('<log mode="roll-by-size">');
  });
  it('is well-formed (one root, balanced service tag)', () => {
    expect(xml.trim().startsWith('<?xml')).toBe(true);
    expect(xml.match(/<service>/g)?.length).toBe(1);
    expect(xml.trim().endsWith('</service>')).toBe(true);
  });
});

describe('psQuote', () => {
  it('wraps in single quotes and doubles embedded quotes', () => {
    expect(psQuote("C:\\it's")).toBe("'C:\\it''s'");
  });

  it('doubles the typographic single quotes PowerShell also ends a literal at', () => {
    expect(psQuote('C:\\Users\\O\u2019Brien')).toBe("'C:\\Users\\O\u2019\u2019Brien'");
    expect(psQuote('a\u2018b\u201Ac\u201Bd')).toBe("'a\u2018\u2018b\u201A\u201Ac\u201B\u201Bd'");
  });
});

describe('windowsInstallScript', () => {
  const script = windowsInstallScript({
    ...base,
    winswSource: 'C:\\Program Files\\WA Team Inbox\\resources\\winsw\\WinSW-x64.exe',
    serviceDir: 'C:\\ProgramData\\wa-team-inbox\\service',
    dataDir: 'C:\\ProgramData\\wa-team-inbox',
    moveFrom: 'C:\\Users\\me\\AppData\\Roaming\\WA Team Inbox\\data',
    exists: (p: string) => p.endsWith('WA Team Inbox\\data'),
  });
  it('copies winsw as <id>.exe and writes the xml', () => {
    expect(script).toContain(
      "Copy-Item -LiteralPath 'C:\\Program Files\\WA Team Inbox\\resources\\winsw\\WinSW-x64.exe'",
    );
    expect(script).toContain("'C:\\ProgramData\\wa-team-inbox\\service\\wa-team-inbox.exe'");
    expect(script).toContain("'C:\\ProgramData\\wa-team-inbox\\service\\wa-team-inbox.xml'");
    expect(script).toContain('<startmode>Automatic</startmode>');
  });
  it('moves data, restricts ACL to SYSTEM + Administrators, installs and starts', () => {
    const iMove = script.indexOf('Move-Item');
    const iAcl = script.lastIndexOf('icacls');
    const iInstall = script.indexOf("wa-team-inbox.exe' install");
    const iStart = script.indexOf("wa-team-inbox.exe' start");
    expect(iMove).toBeGreaterThan(-1);
    expect(iAcl).toBeGreaterThan(iMove);
    expect(script).toContain('/inheritance:r');
    expect(script).toContain('*S-1-5-18:(OI)(CI)F');
    expect(script).toContain('*S-1-5-32-544:(OI)(CI)F');
    expect(iInstall).toBeGreaterThan(iAcl);
    expect(iStart).toBeGreaterThan(iInstall);
  });
});

describe('windowsUninstallScript', () => {
  it('stops + uninstalls the service, then moves data back and resets ACLs', () => {
    const s = windowsUninstallScript({
      id: 'wa-team-inbox',
      serviceDir: 'C:\\ProgramData\\wa-team-inbox\\service',
      dataDir: 'C:\\ProgramData\\wa-team-inbox',
      moveTo: 'C:\\Users\\me\\data',
    });
    const iStop = s.indexOf(' stop');
    const iUninst = s.indexOf(' uninstall');
    const iMove = s.indexOf('Move-Item');
    expect(iStop).toBeGreaterThan(-1);
    expect(iUninst).toBeGreaterThan(iStop);
    expect(iMove).toBeGreaterThan(iUninst);
    expect(s).toContain('/reset');
  });

  it('refuses before touching the service when the target already holds an app.db', () => {
    const s = windowsUninstallScript({
      id: 'wa-team-inbox',
      serviceDir: 'C:\\ProgramData\\wa-team-inbox\\service',
      dataDir: 'C:\\ProgramData\\wa-team-inbox',
      moveTo: "C:\\Users\\O'Neil\\data",
    });
    const iCheck = s.indexOf("(Join-Path 'C:\\Users\\O''Neil\\data' 'app.db')");
    expect(iCheck).toBeGreaterThan(-1);
    expect(iCheck).toBeLessThan(s.indexOf(' stop'));
    expect(s).toContain('the service was left as it is.');
  });

  it('the prechecks alone change nothing (the elevated dry run of the Dev Build check)', () => {
    const opts = {
      id: 'wa-team-inbox',
      serviceDir: 'C:\\ProgramData\\wa-team-inbox\\service',
      dataDir: 'C:\\ProgramData\\wa-team-inbox',
      moveTo: 'C:\\Users\\me\\data',
    };
    const pre = windowsUninstallPrechecks(opts).join('\r\n');
    for (const write of [' stop', ' uninstall', 'Remove-Item', 'Move-Item', 'icacls', 'New-Item'])
      expect(pre).not.toContain(write);
    expect(pre).toContain('Assert-Locked');
    expect(windowsUninstallScript(opts).startsWith(pre)).toBe(true);
  });

  it('refuses a link at or above the target and the machine folder, again before each write', () => {
    const s = windowsUninstallScript({
      id: 'wa-team-inbox',
      serviceDir: 'C:\\ProgramData\\wa-team-inbox\\service',
      dataDir: 'C:\\ProgramData\\wa-team-inbox',
      moveTo: 'C:\\Users\\me\\data',
      runDir: 'C:\\ProgramData\\wa-team-inbox-run',
    });
    expect(s).toContain('$p = [System.IO.Path]::GetDirectoryName($p)');
    const target = "Assert-NoLinkUp 'C:\\Users\\me\\data'";
    const checks = s.split(target).length - 1;
    expect(checks).toBe(3);
    const iStop = s.indexOf(' stop');
    expect(s.indexOf(target)).toBeLessThan(iStop);
    expect(s.indexOf("Assert-NoLinkUp 'C:\\ProgramData\\wa-team-inbox'")).toBeLessThan(iStop);
    expect(s.indexOf("Assert-NoLinkUp 'C:\\ProgramData\\wa-team-inbox-run'")).toBeLessThan(iStop);
    // Right before the move and right before the ACL reset.
    expect(s.lastIndexOf(target)).toBeLessThan(s.indexOf('icacls'));
    expect(s.indexOf(target, iStop)).toBeLessThan(s.indexOf('Move-Item'));
    // The reset acts on links themselves and its failure is not silent.
    expect(s).toContain('/reset /T /C /L /Q');
    expect(s).toContain('icacls /reset failed');
  });
});

describe('parseScQuery', () => {
  it('detects running', () => {
    expect(parseScQuery(0, 'SERVICE_NAME: x\n        STATE              : 4  RUNNING')).toBe(
      'running',
    );
  });
  it('detects stopped', () => {
    expect(parseScQuery(0, 'STATE              : 1  STOPPED')).toBe('stopped');
  });
  it('detects not installed (1060)', () => {
    expect(parseScQuery(1060, '[SC] EnumQueryServicesStatus:OpenService FAILED 1060')).toBe(
      'not-installed',
    );
  });
});

describe('windowsInstallScript hardening (pre-created ProgramData folder → SYSTEM escalation)', () => {
  const s = windowsInstallScript({
    ...base,
    winswSource: 'C:\\Program Files\\WA Team Inbox\\resources\\winsw\\WinSW-x64.exe',
    serviceDir: 'C:\\ProgramData\\wa-team-inbox\\service',
    dataDir: 'C:\\ProgramData\\wa-team-inbox',
    runDir: 'C:\\ProgramData\\wa-team-inbox\\run',
    moveFrom: 'C:\\Users\\me\\AppData\\Roaming\\WA Team Inbox\\data',
    exists: (p: string) => p.endsWith('WA Team Inbox\\data'),
  });
  const iCopy = s.indexOf('Copy-Item');
  const iInstall = s.indexOf("wa-team-inbox.exe' install");
  it('moves a pre-existing data dir aside when it is a link or not owned by SYSTEM/Administrators', () => {
    const iCheck = s.indexOf('GetOwner(');
    expect(iCheck).toBeGreaterThan(-1);
    expect(s).toContain('ReparsePoint');
    expect(s).toContain('.untrusted-');
    expect(iCheck).toBeLessThan(iCopy);
  });
  it('takes ownership for Administrators and resets child ACLs before copying the wrapper', () => {
    const iOwner = s.indexOf("/setowner '*S-1-5-32-544'");
    expect(iOwner).toBeGreaterThan(-1);
    expect(iOwner).toBeLessThan(iCopy);
    expect(s).toContain('/reset /T /C /Q');
  });
  it('recreates the service dir from scratch (drops planted DLLs) without following links', () => {
    const iRm = s.indexOf('rmdir /s /q');
    expect(iRm).toBeGreaterThan(-1);
    expect(iRm).toBeLessThan(iCopy);
  });
  it('re-applies owner + ACL after the data move and verifies them before install', () => {
    const iMove = s.indexOf('Move-Item -Destination');
    expect(s.lastIndexOf("/setowner '*S-1-5-32-544'")).toBeGreaterThan(iMove);
    const iVerify = s.indexOf('Assert-Locked');
    expect(iVerify).toBeGreaterThan(-1);
    expect(s.lastIndexOf('Assert-Locked')).toBeGreaterThan(iMove);
    expect(s.lastIndexOf('Assert-Locked')).toBeLessThan(iInstall);
  });
  it('lets local users read (not write) the run dir with the port file', () => {
    expect(s).toContain("'*S-1-5-32-545:(OI)(CI)RX'");
  });
});
