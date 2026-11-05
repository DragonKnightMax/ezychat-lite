import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  buildInstallBrokerScript,
  buildMacHelperBootstrap,
  buildMacInstallScript,
  buildWindowsInstallScript,
  launchBroker,
  prepareUpdateInstall,
  readUpdateInstallResult,
  updateInstallEligibility,
  WINDOWS_RESTORE_OLD_APP,
  WINDOWS_START_INSTALLER,
  type InstallContext,
  type InstallPlan,
} from './install.js';

const nonce = '72b88eaa-477b-4c2a-927a-2cd315c6a35c';
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

function windowsContext(): InstallContext {
  return {
    platform: 'win32',
    execPath: 'C:\\Program Files\\EzyChat Lite\\WA Team Inbox.exe',
    appBundle: null,
    userDataDir: 'C:\\Users\\Jazz\\AppData\\Roaming\\WA Team Inbox',
    machineDataDir: 'C:\\ProgramData\\wa-team-inbox',
    serviceRunDir: 'C:\\ProgramData\\wa-team-inbox\\run',
    serviceInstalled: true,
    oldPid: 4242,
  };
}

function fixture(platform: 'win32' | 'darwin' = 'win32'): InstallPlan {
  const context: InstallContext =
    platform === 'win32'
      ? windowsContext()
      : {
          platform,
          execPath: '/Applications/EzyChat Lite.app/Contents/MacOS/EzyChat Lite',
          appBundle: '/Applications/EzyChat Lite.app',
          userDataDir: '/Users/jazz/Library/Application Support/WA Team Inbox',
          machineDataDir: '/Library/Application Support/wa-team-inbox',
          serviceRunDir: '/Library/Application Support/wa-team-inbox-runtime',
          serviceInstalled: true,
          oldPid: 4242,
        };
  return {
    context,
    nonce,
    artifact: {
      filePath:
        platform === 'win32'
          ? 'C:\\Users\\Jazz\\Downloads\\verified.exe'
          : '/Users/jazz/Downloads/verified.dmg',
      sha256: 'a'.repeat(64),
      version: '0.1.16',
      assetName:
        platform === 'win32'
          ? 'EzyChat-Lite-0.1.16-win-x64.exe'
          : 'EzyChat-Lite-0.1.16-mac-arm64.dmg',
    },
    stageDir:
      platform === 'win32'
        ? `C:\\ProgramData\\wa-team-inbox-updates\\${nonce}`
        : `/Library/Application Support/wa-team-inbox-updates/${nonce}`,
    controlDir:
      platform === 'win32'
        ? 'C:\\Users\\Jazz\\AppData\\Local\\Temp\\ezychat-control'
        : '/var/folders/test/ezychat-control',
  };
}

describe('installation eligibility and trusted input', () => {
  it('accepts installed Windows paths case-insensitively and refuses unpacked/lookalike folders', () => {
    expect(updateInstallEligibility(windowsContext(), {}).eligible).toBe(true);
    for (const execPath of [
      'C:\\Program Files\\EzyChat Lite\\EzyChat Lite.exe',
      'c:\\program files\\ezychat lite\\ezychat lite.exe',
    ])
      expect(updateInstallEligibility({ ...windowsContext(), execPath }, {}).eligible).toBe(true);
    for (const execPath of [
      'D:\\dev\\release\\WA Team Inbox.exe',
      'D:\\dev\\release\\EzyChat Lite.exe',
      'C:\\Program FilesElse\\EzyChat Lite\\WA Team Inbox.exe',
      'C:\\Program Files\\EzyChat Lite\\Unknown.exe',
    ])
      expect(updateInstallEligibility({ ...windowsContext(), execPath }, {}).eligible).toBe(false);
    expect(
      updateInstallEligibility(
        { ...windowsContext(), execPath: 'c:\\program files\\EzyChat Lite\\WA Team Inbox.exe' },
        {},
      ).eligible,
    ).toBe(true);
  });
  it('accepts Applications installs and rejects mounted/development Mac bundles', () => {
    expect(updateInstallEligibility(fixture('darwin').context).eligible).toBe(true);
    for (const appBundle of [
      null,
      '/Volumes/Installer/EzyChat Lite.app',
      '/Users/jazz/Desktop/EzyChat Lite.app',
    ])
      expect(updateInstallEligibility({ ...fixture('darwin').context, appBundle }).eligible).toBe(
        false,
      );
  });
  it('rejects mismatched platform assets, checksums, executable identities and staging escapes', () => {
    const plan = fixture();
    expect(() =>
      buildWindowsInstallScript({
        ...plan,
        artifact: { ...plan.artifact, assetName: 'EzyChat-Lite-0.1.16-mac-arm64.dmg' },
      }),
    ).toThrow('Wrong installer');
    expect(() =>
      buildWindowsInstallScript({ ...plan, artifact: { ...plan.artifact, sha256: 'bad' } }),
    ).toThrow('checksum');
    expect(() =>
      buildWindowsInstallScript({ ...plan, stageDir: 'C:\\ProgramData\\other' }),
    ).toThrow('staging');
    expect(() =>
      buildWindowsInstallScript({
        ...plan,
        context: { ...plan.context, execPath: 'C:\\Program Files\\Bad.exe' },
      }),
    ).toThrow('executable');
    expect(() =>
      buildWindowsInstallScript({
        ...plan,
        context: { ...plan.context, execPath: 'C:\\Program Files\\EzyChat Lite\\EzyChat Lite.exe' },
      }),
    ).not.toThrow();
  });
});

describe('Windows update helper safety', () => {
  it('prepares immutable verified installer and rollback before acknowledgement or service stop', () => {
    const script = buildWindowsInstallScript(fixture());
    expect(script.indexOf('Assert-ProtectedRuntime $appExe')).toBeLessThan(
      script.indexOf('Copy-Item -LiteralPath'),
    );
    expect(script.indexOf('Copy-Item -Destination $backup')).toBeLessThan(
      script.indexOf("Write-State 'ready'"),
    );
    expect(script.indexOf("Write-State 'ready'")).toBeLessThan(
      script.indexOf("Write-State 'accepted'"),
    );
    expect(script.indexOf("Write-State 'accepted'")).toBeLessThan(
      script.indexOf("Stop-Service -Name 'wa-team-inbox'"),
    );
    expect(script).toContain('Check-Hash; Assert-ProtectedRuntime $appExe');
    expect(script).toContain('Unsafe updater staging path');
    expect(script).toContain('$safeStage = $true');
    expect(script).toContain('The installed service belongs to another runtime');
  });
  it('waits for the exact old process and performs silent NSIS into the existing directory', () => {
    const script = buildWindowsInstallScript(fixture());
    expect(script).toContain('ExecutablePath.Equals($appExe');
    expect(script).toContain('$stillOld.CreationDate -ne $oldStarted');
    expect(script).toContain("-ArgumentList @('/S', ('/D=' + $installDir)) -Wait");
    expect(script).not.toContain('/NCRC');
    expect(script).not.toContain('Stop-Process');
    expect(script).not.toContain(' uninstall');
    expect(script).not.toContain('dataMoveCommands');
  });
  it('verifies new runtime version and service health, with guarded old runtime restoration', () => {
    const script = buildWindowsInstallScript(fixture());
    expect(script).toContain('$installedVersion -ne $version');
    expect(script).toContain('$health.version -eq $expectedVersion');
    expect(script).toContain("$health.mode -eq 'service'");
    expect(script).toContain('Unsafe rollback link');
    expect(script).toContain('if (Test-Path -LiteralPath $installDir) {');
    const rollback = script.slice(script.indexOf('if ($replacementStarted -and $backupReady)'));
    expect(rollback.indexOf('if (Test-Path -LiteralPath $installDir)')).toBeLessThan(
      rollback.indexOf('Get-Item -LiteralPath $installDir -Force'),
    );
    // The rollback empties the folder through Restore-OldApp and never removes the folder itself.
    expect(rollback.indexOf('Unsafe rollback link')).toBeLessThan(
      rollback.indexOf('Restore-OldApp $installDir $backup'),
    );
    expect(rollback).not.toContain('Remove-Item -LiteralPath $installDir');
    expect(script).toContain(WINDOWS_RESTORE_OLD_APP);
    expect(script).toContain('Copy-Item -Destination $InstallDir -Recurse -Force');
    // A blocked installer start replaced nothing: no rollback, a clear message instead.
    expect(script).toContain('$installerBlocked = $true; throw');
    expect(script).toContain('blocked from starting, often by antivirus software');
    expect(script).toContain('Start-InboxService $originalVersion');
    expect(script.indexOf("@('old-app', 'private')")).toBeGreaterThan(
      script.indexOf('Start-InboxService $version'),
    );
  });
});

describe('macOS update helper safety', () => {
  it('verifies mounted image identity/version and stages protected bundles before stopping launchd', () => {
    const script = buildMacInstallScript(fixture('darwin'));
    expect(script).toContain('hdiutil verify "$installer" -quiet');
    expect(script).toContain('-readonly -nobrowse -noautoopen');
    expect(script).toContain('CFBundleIdentifier');
    expect(script).toContain('org.ossmalaysia.wateaminbox');
    expect(script).toContain('CFBundleShortVersionString');
    expect(script).toContain('chmod -RN');
    expect(script).toContain('Runtime link escapes the app');
    expect(script).toContain('xattr -dr com.apple.quarantine "$new_main"');
    expect(script.indexOf('ditto --noacl "$app" "$backup_main"')).toBeLessThan(
      script.indexOf("write_state 'ready'"),
    );
    expect(script.indexOf("write_state 'accepted'")).toBeLessThan(
      script.indexOf('stopped=1; if launchctl print'),
    );
  });
  it('updates protected runtime/plist without recreating service or moving its data', () => {
    const script = buildMacInstallScript(fixture('darwin'));
    expect(script).toContain('ditto --noacl "$new_runtime" "$runtime"');
    expect(script).toContain('Set :ProgramArguments:0');
    expect(script).toContain('start_service "$version"');
    expect(script).toContain('cp "$stage/old-service.plist" "$plist"');
    // rollback: bootout returns before launchd has unloaded the job; bootstrap would fail with error 5
    const rollback = script.slice(script.indexOf('recover() {'));
    expect(rollback.indexOf('while launchctl print system/')).toBeGreaterThan(
      rollback.indexOf('launchctl bootout'),
    );
    expect(rollback.indexOf('while launchctl print system/')).toBeLessThan(
      rollback.indexOf('rm -rf "$runtime"'),
    );
    expect(script).toContain('start_service "$original_version"');
    expect(script.indexOf('rm -rf "$backup_main" "$backup_runtime"')).toBeGreaterThan(
      script.indexOf('start_service "$version"'),
    );
    expect(script).not.toContain('moveFrom');
    expect(script).not.toContain('rm -rf "/Library/Application Support/wa-team-inbox"');
  });
  it('starts the root helper without nohup, which exits before running it under the admin prompt', () => {
    // Root under the admin prompt has no console: macOS nohup prints "can't detach from console" and never
    // starts install.sh, so no state.json appears and the app reports a failed update.
    const bootstrap = buildMacHelperBootstrap(fixture('darwin'), 'ZWNobw==');
    expect(bootstrap).not.toContain('nohup');
    expect(bootstrap).toContain(
      '/bin/bash "$stage/install.sh" > "$stage/helper.log" 2>&1 < /dev/null &',
    );
    expect(buildMacInstallScript(fixture('darwin'))).toContain("trap '' HUP");
  });
});

describe('unprivileged outcome/relaunch broker', () => {
  it('keeps profile result writes and app reopening out of elevated helpers', () => {
    const windows = fixture();
    const broker = buildInstallBrokerScript(windows);
    expect(broker).toContain('install-result.json');
    expect(broker).toContain('if ($state.accepted)');
    expect(broker).toContain('Start-Process -FilePath');
    expect(broker).toContain('$oldApp.WaitForExit(120000)');
    expect(buildWindowsInstallScript(windows)).not.toContain('install-result.json');
    const mac = fixture('darwin');
    expect(buildInstallBrokerScript(mac)).toContain('/usr/bin/open');
    expect(buildInstallBrokerScript(mac)).toContain('"$current_started" != "$old_started"');
    expect(buildInstallBrokerScript(mac)).toContain('plutil -convert json');
    expect(buildMacInstallScript(mac)).not.toContain('install-result.json');
  });
  it('rejects malformed, huge and absent durable result manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezychat-install-result-'));
    directories.push(dir);
    await mkdir(join(dir, 'updates'));
    const file = join(dir, 'updates', 'install-result.json');
    expect(await readUpdateInstallResult(dir)).toBeNull();
    await writeFile(
      file,
      JSON.stringify({
        status: 'success',
        version: '0.1.16',
        message: 'Done',
        completedAt: new Date().toISOString(),
      }),
    );
    expect((await readUpdateInstallResult(dir))?.status).toBe('success');
    await writeFile(
      file,
      JSON.stringify({
        status: 'success',
        version: '0.1.16',
        message: 'Done',
        completedAt: 'invalid',
      }),
    );
    expect(await readUpdateInstallResult(dir)).toBeNull();
    await writeFile(file, 'x'.repeat(5000));
    expect(await readUpdateInstallResult(dir)).toBeNull();
  });
});

describe('portable shell syntax', () => {
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
  it.skipIf(!existsSync(bash))(
    'parses Mac helper and broker without executing native operations',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ezychat-install-shell-parser-'));
      directories.push(dir);
      for (const [name, script] of [
        ['install', buildMacInstallScript(fixture('darwin'))],
        ['broker', buildInstallBrokerScript(fixture('darwin'))],
      ]) {
        const source = join(dir, `${name}.sh`);
        await writeFile(source, script);
        expect(() =>
          execFileSync(bash, ['-n', source.replace(/\\/g, '/')], {
            windowsHide: true,
            stdio: 'pipe',
            timeout: 15_000,
          }),
        ).not.toThrow();
      }
    },
    40_000,
  );
});

describe.skipIf(process.platform !== 'darwin')('isolated native macOS broker', () => {
  it('writes a durable error manifest without reopening an app', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezychat-install-mac-broker-'));
    directories.push(dir);
    const plan = fixture('darwin');
    plan.stageDir = join(dir, nonce);
    plan.controlDir = join(dir, 'control');
    plan.context.userDataDir = join(dir, "Team's profile é");
    await mkdir(plan.stageDir);
    await mkdir(plan.controlDir);
    const completedAt = new Date().toISOString();
    await writeFile(
      join(plan.stageDir, 'state.json'),
      JSON.stringify({
        phase: 'error',
        nonce,
        version: plan.artifact.version,
        message: 'Previous version retained.',
        accepted: false,
        completedAt,
      }),
    );
    const broker = join(dir, 'broker.sh');
    await writeFile(broker, buildInstallBrokerScript(plan));
    execFileSync('/bin/bash', [broker], {
      stdio: 'pipe',
      timeout: 15_000,
    });
    expect(await readUpdateInstallResult(plan.context.userDataDir)).toEqual({
      status: 'error',
      version: plan.artifact.version,
      message: 'Previous version retained.',
      completedAt,
    });
  }, 20_000);
});

describe.skipIf(process.platform !== 'win32')('isolated native PowerShell and handshake', () => {
  const runPowerShell = async (dir: string, body: string): Promise<string> => {
    const file = join(dir, `run-${Math.random().toString(36).slice(2)}.ps1`);
    await writeFile(file, `$ErrorActionPreference = 'Stop'\r\n${body}\r\n`);
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
  };

  // An antivirus that blocks the installer (seen with McAfee) makes Start-Process throw before anything was
  // replaced: the helper must not roll back (that emptied Program Files) but only restart the old service.
  it('treats an installer that cannot start as nothing replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezychat-blocked-installer-'));
    directories.push(dir);
    const out = await runPowerShell(
      dir,
      [
        `$installer = '${join(dir, 'missing', 'installer.exe').replace(/'/g, "''")}'`,
        `$installDir = '${join(dir, 'app').replace(/'/g, "''")}'`,
        '$replacementStarted = $false; $installerBlocked = $false',
        'try {',
        ...WINDOWS_START_INSTALLER,
        '} catch { }',
        'Write-Output "started=$replacementStarted blocked=$installerBlocked"',
      ].join('\r\n'),
    );
    expect(out.trim()).toBe('started=False blocked=True');
  }, 40_000);

  // The rollback once deleted every file and then failed on the folder itself (held open by another program),
  // leaving Program Files empty. Restoring must keep the folder and always copy the previous app back.
  it('restores the previous app while another program holds the install folder open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezychat-rollback-'));
    directories.push(dir);
    const installDir = join(dir, 'app');
    const backup = join(dir, 'old-app');
    await mkdir(join(installDir, 'resources'), { recursive: true });
    await mkdir(join(backup, 'resources'), { recursive: true });
    await writeFile(join(installDir, 'half-new.txt'), 'partial new version');
    await writeFile(join(installDir, 'resources', 'app.asar'), 'new');
    await writeFile(join(backup, 'App.exe'), 'old app');
    await writeFile(join(backup, 'resources', 'app.asar'), 'old');
    // A process whose current folder is the install folder keeps the folder itself from being deleted.
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 25'], {
      cwd: installDir,
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await runPowerShell(
        dir,
        [
          WINDOWS_RESTORE_OLD_APP,
          `Restore-OldApp '${installDir.replace(/'/g, "''")}' '${backup.replace(/'/g, "''")}'`,
        ].join('\r\n'),
      );
      expect(await readFile(join(installDir, 'App.exe'), 'utf8')).toBe('old app');
      expect(await readFile(join(installDir, 'resources', 'app.asar'), 'utf8')).toBe('old');
      expect(existsSync(join(installDir, 'half-new.txt'))).toBe(false);
    } finally {
      const exited = new Promise((resolve) => holder.once('exit', resolve));
      holder.kill();
      await exited;
    }
  }, 60_000);

  it('parses Windows helper/broker without running service or installer operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezychat-install-parser-'));
    directories.push(dir);
    for (const [name, script] of [
      ['install', buildWindowsInstallScript(fixture())],
      ['broker', buildInstallBrokerScript(fixture())],
    ]) {
      const source = join(dir, `${name}.ps1`);
      await writeFile(source, script);
      const parser = join(dir, 'parse.ps1');
      await writeFile(
        parser,
        `$tokens = $null; $errors = $null; [Management.Automation.Language.Parser]::ParseFile('${source.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }`,
      );
      expect(() =>
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', parser], {
          stdio: 'pipe',
          windowsHide: true,
          timeout: 15_000,
        }),
      ).not.toThrow();
    }
  }, 40_000);

  /** A plan whose staged install already ended in `error`, so its broker writes the manifest and exits. */
  async function erroredBrokerPlan(prefix: string, controlName: string, profileName: string) {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    directories.push(dir);
    const plan = fixture();
    plan.stageDir = join(dir, nonce);
    plan.controlDir = join(dir, controlName);
    plan.context.userDataDir = join(dir, profileName);
    await mkdir(plan.stageDir);
    await mkdir(plan.controlDir);
    await writeFile(
      join(plan.stageDir, 'state.json'),
      JSON.stringify({
        phase: 'error',
        nonce,
        version: plan.artifact.version,
        message: 'Previous version retained.',
        accepted: false,
        completedAt: new Date().toISOString(),
      }),
    );
    return { dir, plan };
  }

  it('writes a durable error manifest from the unprivileged broker without launching an app', async () => {
    const { dir, plan } = await erroredBrokerPlan(
      'ezychat-install-broker-',
      'control',
      "Team's profile é",
    );
    const broker = join(dir, 'broker.ps1');
    await writeFile(broker, '\uFEFF' + buildInstallBrokerScript(plan));
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', broker], {
      stdio: 'pipe',
      windowsHide: true,
      timeout: 15_000,
    });
    expect(await readUpdateInstallResult(plan.context.userDataDir)).toMatchObject({
      status: 'error',
      version: plan.artifact.version,
      message: 'Previous version retained.',
    });
  }, 20_000);

  it('launches a broker that actually runs (not a detached powershell that exits at once)', async () => {
    const { plan } = await erroredBrokerPlan(
      'ezychat-install-launch-',
      "Team's control dir",
      'profile',
    );
    await launchBroker(plan, buildInstallBrokerScript(plan));
    const deadline = Date.now() + 20_000;
    let result = await readUpdateInstallResult(plan.context.userDataDir);
    while (!result && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      result = await readUpdateInstallResult(plan.context.userDataDir);
    }
    expect(result).toMatchObject({ status: 'error', version: plan.artifact.version });
  }, 30_000);

  async function prepared(phase: 'ready' | 'error' = 'ready') {
    const dir = await mkdtemp(join(tmpdir(), 'ezychat-install-handshake-'));
    directories.push(dir);
    const installer = join(dir, 'fake.exe');
    await writeFile(installer, 'isolated installer fixture');
    let plan: InstallPlan | undefined;
    const launch = vi.fn(async (value: InstallPlan) => {
      plan = value;
      await mkdir(value.stageDir, { recursive: true });
      await writeFile(
        win32.join(value.stageDir, 'state.json'),
        JSON.stringify({
          phase,
          nonce: value.nonce,
          version: value.artifact.version,
          message: 'preflight failed',
        }),
      );
    });
    const broker = vi.fn(async () => undefined);
    const sleep = async () => {
      if (!plan) return;
      let command: string;
      try {
        command = await readFile(join(plan.controlDir, 'command'), 'utf8');
      } catch {
        return;
      }
      const next = command.startsWith('commit:') ? 'accepted' : 'cancelled';
      await writeFile(
        win32.join(plan.stageDir, 'state.json'),
        JSON.stringify({ phase: next, nonce: plan.nonce, version: plan.artifact.version }),
      );
    };
    const options = {
      artifact: {
        filePath: installer,
        assetName: 'EzyChat-Lite-0.1.16-win-x64.exe',
        version: '0.1.16',
        sha256: createHash('sha256').update('isolated installer fixture').digest('hex'),
      },
      context: windowsContext(),
      dependencies: {
        stageRoot: join(dir, 'protected-staging-fixture'),
        launchElevated: launch,
        launchBroker: broker,
        sleep,
      },
    };
    return { options, launch, broker, getPlan: () => plan! };
  }

  it('does not commit until explicit handoff and coalesces duplicate commits', async () => {
    const f = await prepared();
    const install = await prepareUpdateInstall(f.options);
    expect(f.launch).toHaveBeenCalledOnce();
    await expect(readFile(join(f.getPlan().controlDir, 'command'))).rejects.toThrow();
    const first = install.commit();
    const second = install.commit();
    expect(first).toBe(second);
    await first;
    await expect(install.cancel()).rejects.toThrow('already');
    await rm(f.getPlan().controlDir, { recursive: true, force: true });
  });

  it('cancels acknowledged preparation without installing and makes cancellation idempotent', async () => {
    const f = await prepared();
    const install = await prepareUpdateInstall(f.options);
    await install.cancel();
    await install.cancel();
    expect(await readFile(join(f.getPlan().controlDir, 'command'), 'utf8')).toBe(
      `cancel:${f.getPlan().nonce}`,
    );
    await expect(install.commit()).rejects.toThrow('no longer ready');
    await rm(f.getPlan().controlDir, { recursive: true, force: true });
  });

  it('fails preflight without committing or altering the app', async () => {
    const f = await prepared('error');
    await expect(prepareUpdateInstall(f.options)).rejects.toThrow('preflight failed');
    expect(await readFile(join(f.getPlan().controlDir, 'command'), 'utf8')).toBe(
      `cancel:${f.getPlan().nonce}`,
    );
    await rm(f.getPlan().controlDir, { recursive: true, force: true });
  });

  it('refuses a changed installer before any privilege prompt or broker launch', async () => {
    const f = await prepared();
    await writeFile(f.options.artifact.filePath, 'changed');
    await expect(prepareUpdateInstall(f.options)).rejects.toThrow('checksum changed');
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.broker).not.toHaveBeenCalled();
  });
});
