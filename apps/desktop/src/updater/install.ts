import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { exec as sudoExec } from '@vscode/sudo-prompt';
import { activeProduct, escapeRegExp } from '../product.js';
import { shQuote } from '../service/macos.js';
import {
  psQuote,
  windowsRuntimeSecurityHelpers,
  windowsServiceSecurityHelpers,
} from '../service/windows.js';

export interface InstallArtifact {
  filePath: string;
  sha256: string;
  version: string;
  assetName: string;
  size?: number;
}

export interface InstallContext {
  platform: 'win32' | 'darwin';
  execPath: string;
  appBundle: string | null;
  /** Electron profile, not the nested inbox data directory. */
  userDataDir: string;
  machineDataDir: string;
  serviceRunDir: string;
  serviceInstalled: boolean;
  oldPid: number;
}

export interface InstallResult {
  status: 'success' | 'error';
  version: string;
  message: string;
  completedAt: string;
}

export interface InstallPlan {
  artifact: InstallArtifact;
  context: InstallContext;
  stageDir: string;
  controlDir: string;
  nonce: string;
}

interface HelperState {
  phase: 'ready' | 'accepted' | 'cancelled' | 'success' | 'error';
  nonce: string;
  version: string;
  message: string;
  completedAt: string;
}

export interface InstallDependencies {
  /** Injection is for isolated tests; production launchers always use the OS privilege prompt. */
  launchElevated?: (plan: InstallPlan, script: string) => Promise<void>;
  launchBroker?: (plan: InstallPlan, script: string) => Promise<void>;
  stageRoot?: string;
  prepareTimeoutMs?: number;
  commitTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface PrepareUpdateInstallOptions {
  artifact: InstallArtifact;
  context: InstallContext;
  onProgress?: (message: string) => void;
  dependencies?: InstallDependencies;
}

const resultMessage = 'Update installed. Your conversations, accounts and settings are preserved.';

/**
 * Starts the verified NSIS installer. An installer that cannot start (an antivirus block makes Start-Process throw)
 * replaced nothing: the replacement flag is cleared so the helper restarts the old service instead of rolling back.
 * NSIS requires /D last and unquoted, even when the target contains spaces.
 */
export const WINDOWS_START_INSTALLER: readonly string[] = [
  `  $replacementStarted = $true`,
  `  try { $process = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $installDir)) -Wait -PassThru -WindowStyle Hidden }`,
  `  catch { $replacementStarted = $false; $installerBlocked = $true; throw }`,
];

/**
 * Puts the previous app back from the rollback copy. It empties the install folder but never removes the folder
 * itself: another program (an antivirus scan, a shell) may hold it open, and removing it once failed after every
 * file was gone, which left Program Files empty. The copy-back always runs.
 */
export const WINDOWS_RESTORE_OLD_APP = [
  'function Restore-OldApp([string]$InstallDir, [string]$Backup) {',
  '  if (-not (Test-Path -LiteralPath $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir | Out-Null }',
  '  Get-ChildItem -LiteralPath $InstallDir -Force | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Continue }',
  '  Get-ChildItem -LiteralPath $Backup -Force | Copy-Item -Destination $InstallDir -Recurse -Force',
  '}',
].join('\r\n');

/** Advisory UI eligibility. Elevated helper independently enforces ownership/ACLs and service identity. */
/** Current and legacy program names (lower case); the Mac checks accept both bundle names too. */
const windowsExecutables = (): string[] =>
  activeProduct().executableNames.map((name) => `${name}.exe`.toLowerCase());
const macAppBundles = (): string[] => activeProduct().executableNames.map((name) => `${name}.app`);

export function updateInstallEligibility(
  context: InstallContext,
  env: NodeJS.ProcessEnv = process.env,
): { eligible: boolean; reason: string | null } {
  if (context.platform === 'win32') {
    const directory = win32.dirname(context.execPath).toLowerCase();
    const roots = [
      env.ProgramFiles ?? 'C:\\Program Files',
      env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    ];
    if (
      !windowsExecutables().includes(win32.basename(context.execPath).toLowerCase()) ||
      !roots.some((root) => directory.startsWith(win32.resolve(root).toLowerCase() + '\\'))
    )
      return {
        eligible: false,
        reason: `Install ${activeProduct().productName} in Program Files to use automatic updates. Unpacked builds can download the installer.`,
      };
  } else if (
    !context.appBundle ||
    posix.dirname(context.appBundle) !== '/Applications' ||
    !macAppBundles().includes(posix.basename(context.appBundle))
  )
    return {
      eligible: false,
      reason: `Move ${activeProduct().productName} to Applications before installing updates.`,
    };
  return { eligible: true, reason: null };
}

function validatePlan(plan: InstallPlan): void {
  const { artifact, context } = plan;
  if (context.platform !== 'win32' && context.platform !== 'darwin')
    throw new Error('Updates are supported on Windows and macOS');
  const path = context.platform === 'win32' ? win32 : posix;
  for (const value of [
    artifact.filePath,
    context.execPath,
    context.userDataDir,
    context.machineDataDir,
    context.serviceRunDir,
    plan.stageDir,
    plan.controlDir,
  ]) {
    if (!path.isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error('Invalid updater path');
  }
  if (!/^[a-f0-9]{64}$/iu.test(artifact.sha256)) throw new Error('Invalid update checksum');
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(artifact.version))
    throw new Error('Invalid update version');
  const suffix = context.platform === 'win32' ? 'win-x64.exe' : 'mac-(?:x64|arm64)\\.dmg';
  const prefixes = activeProduct().artifactPrefixes.map(escapeRegExp).join('|');
  const version = artifact.version.replace(/[.]/g, '\\.');
  if (!new RegExp(`^(?:${prefixes})-${version}-${suffix}$`, 'u').test(artifact.assetName))
    throw new Error('Wrong installer for this computer');
  if (!Number.isSafeInteger(context.oldPid) || context.oldPid < 1)
    throw new Error('Invalid application process');
  if (!/^[a-f0-9-]{36}$/u.test(plan.nonce)) throw new Error('Invalid updater handoff');
  if (path.basename(plan.stageDir) !== plan.nonce) throw new Error('Invalid updater staging path');
  if (
    context.platform === 'win32' &&
    !windowsExecutables().includes(win32.basename(context.execPath).toLowerCase())
  )
    throw new Error('Unrecognized application executable');
  if (context.platform === 'darwin') {
    if (
      !context.appBundle ||
      !macAppBundles().includes(posix.basename(context.appBundle)) ||
      posix.dirname(context.appBundle) !== '/Applications'
    )
      throw new Error('Install the app in Applications first');
    if (!context.execPath.startsWith(`${context.appBundle}/Contents/MacOS/`))
      throw new Error('Invalid application bundle');
    if (
      context.serviceRunDir !==
        `/Library/Application Support/${activeProduct().appDirName}-runtime` ||
      context.machineDataDir !== `/Library/Application Support/${activeProduct().appDirName}`
    )
      throw new Error('Unrecognized service paths');
  }
}

/** Reads only the durable, bounded manifest. Never use it as installation authority. */
export async function readUpdateInstallResult(profile: string): Promise<InstallResult | null> {
  try {
    const file = join(profile, 'updates', 'install-result.json');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<InstallResult>;
    if (
      (value.status !== 'success' && value.status !== 'error') ||
      typeof value.version !== 'string' ||
      value.version.length > 200 ||
      typeof value.message !== 'string' ||
      value.message.length > 1000 ||
      typeof value.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.completedAt))
    )
      return null;
    return {
      status: value.status,
      version: value.version,
      message: value.message,
      completedAt: value.completedAt,
    };
  } catch {
    return null;
  }
}

export async function prepareUpdateInstall(
  options: PrepareUpdateInstallOptions,
): Promise<{ commit(): Promise<void>; cancel(): Promise<void> }> {
  const { context, artifact } = options;
  const deps = options.dependencies ?? {};
  const nonce = randomUUID();
  const stageRoot =
    deps.stageRoot ??
    (context.platform === 'win32'
      ? win32.join(
          process.env.ProgramData ?? 'C:\\ProgramData',
          `${activeProduct().appDirName}-updates`,
        )
      : `/Library/Application Support/${activeProduct().appDirName}-updates`);
  const plan: InstallPlan = {
    context,
    artifact,
    nonce,
    stageDir: (context.platform === 'win32' ? win32 : posix).join(stageRoot, nonce),
    controlDir: await mkdtemp(join(tmpdir(), 'ezychat-update-control-')),
  };
  validatePlan(plan);
  const stat = await lstat(artifact.filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (artifact.size !== undefined && stat.size !== artifact.size)
  )
    throw new Error('The downloaded installer changed. Download it again.');
  // Recheck immediately before requesting privilege; native helper verifies its protected copy again.
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifact.filePath)) hash.update(chunk);
  const digest = hash.digest('hex');
  if (digest !== artifact.sha256.toLowerCase())
    throw new Error('The downloaded installer checksum changed. Download it again.');
  const script =
    context.platform === 'win32' ? buildWindowsInstallScript(plan) : buildMacInstallScript(plan);
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stateFile = (context.platform === 'win32' ? win32 : posix).join(
    plan.stageDir,
    'state.json',
  );
  const state = async (): Promise<HelperState | null> => {
    try {
      const info = await lstat(stateFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return null;
      const value = JSON.parse(await readFile(stateFile, 'utf8')) as HelperState;
      return value.nonce === nonce && value.version === artifact.version ? value : null;
    } catch {
      return null;
    }
  };
  const signal = async (action: 'commit' | 'cancel') => {
    const file = join(plan.controlDir, 'command');
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${action}:${nonce}`, { mode: 0o600 });
    await rename(temporary, file);
  };
  const waitFor = async (phases: HelperState['phase'][], timeout: number) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await state();
      if (value?.phase === 'error')
        throw new Error(value.message || 'The update helper could not prepare the installation.');
      if (value && phases.includes(value.phase)) return value;
      if (value?.phase === 'cancelled') throw new Error('The update installation was cancelled.');
      await sleep(200);
    }
    throw new Error('The update helper did not respond in time. The running app was not replaced.');
  };
  options.onProgress?.('Preparing a safe update. Approve the operating system prompt to continue.');
  try {
    await (deps.launchBroker ?? launchBroker)(plan, buildInstallBrokerScript(plan));
    await (deps.launchElevated ?? launchElevated)(plan, script);
    await waitFor(['ready'], deps.prepareTimeoutMs ?? 180_000);
  } catch (error) {
    await signal('cancel').catch(() => undefined);
    throw error;
  }
  let lifecycle: 'ready' | 'committing' | 'committed' | 'cancelled' = 'ready';
  let pending: Promise<void> | null = null;
  return {
    commit() {
      if (pending) return pending;
      if (lifecycle !== 'ready')
        return Promise.reject(new Error('Update handoff is no longer ready'));
      lifecycle = 'committing';
      pending = (async () => {
        await signal('commit');
        await waitFor(['accepted', 'success'], deps.commitTimeoutMs ?? 15_000);
        lifecycle = 'committed';
      })().catch(async (error: unknown) => {
        lifecycle = 'cancelled';
        await signal('cancel').catch(() => undefined);
        throw error;
      });
      return pending;
    },
    async cancel() {
      if (lifecycle === 'committed' || lifecycle === 'committing')
        throw new Error('Installation has already been handed off');
      if (lifecycle === 'cancelled') return;
      lifecycle = 'cancelled';
      await signal('cancel');
      await waitFor(['cancelled'], 10_000);
    },
  };
}

const windowsPowerShell = (): string =>
  win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

/**
 * Runs a short-lived PowerShell whose `Start-Process` launches the real helper, and resolves once
 * that launcher exits 0. Never spawn a helper itself with `detached: true` — powershell.exe exits
 * before running its script that way — and a non-detached child dies with the app; the
 * `Start-Process` grandchild outlives both.
 */
async function startWindowsProcess(startProcessArgs: string, failure: string): Promise<void> {
  const binary = windowsPowerShell();
  const launch = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${psQuote(binary)} ${startProcessArgs} | Out-Null`;
  const child = spawn(binary, ['-NoProfile', '-NonInteractive', '-Command', launch], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(failure))));
  });
}

export async function launchBroker(plan: InstallPlan, script: string): Promise<void> {
  const windows = plan.context.platform === 'win32';
  const file = join(plan.controlDir, windows ? 'broker.ps1' : 'broker.sh');
  await writeFile(file, windows ? '\uFEFF' + script : script, { mode: 0o700 });
  if (windows) {
    // Start the broker before the elevated helper; a failed launch cancels the install.
    await startWindowsProcess(
      `-WindowStyle Hidden -ArgumentList ${psQuote(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${file}"`)}`,
      'The update helper could not start.',
    );
    return;
  }
  const child = spawn('/bin/bash', [file], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

async function launchElevated(plan: InstallPlan, script: string): Promise<void> {
  const windows = plan.context.platform === 'win32';
  const file = join(plan.controlDir, windows ? 'install.ps1' : 'install.sh');
  await writeFile(file, script, { mode: 0o700 });
  if (windows) {
    const digest = createHash('sha256').update(script).digest('hex');
    // Read once, hash once, execute those exact in-memory bytes: no writable-script verification race.
    const bootstrap = `$bytes = [IO.File]::ReadAllBytes(${psQuote(file)}); $hash = [Security.Cryptography.SHA256]::Create(); $actual = [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant(); if ($actual -ne ${psQuote(digest)}) { exit 12 }; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bytes)))`;
    const encoded = Buffer.from(bootstrap, 'utf16le').toString('base64');
    await startWindowsProcess(
      `-Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}'`,
      'Administrator approval was cancelled or could not start.',
    );
  } else {
    // The generated script is embedded in the approved command, then written root-owned outside the app.
    const encoded = Buffer.from(script, 'utf8').toString('base64');
    const bootstrap = buildMacHelperBootstrap(plan, encoded);
    await new Promise<void>((resolve, reject) =>
      sudoExec(
        `/bin/bash -c ${shQuote(bootstrap)}`,
        { name: activeProduct().productName },
        (error) =>
          error
            ? reject(new Error('Administrator approval was cancelled or could not start.'))
            : resolve(),
      ),
    );
  }
}

// Native scripts follow below. They never uninstall a service or move the inbox data directory.

export function buildWindowsInstallScript(plan: InstallPlan): string {
  validatePlan(plan);
  const product = activeProduct();
  const SERVICE_ID = product.serviceId;
  const { artifact: a, context: c } = plan;
  const installDir = win32.dirname(c.execPath);
  const stageRoot = win32.dirname(plan.stageDir);
  const serviceDir = win32.join(c.machineDataDir, 'service');
  const wrapper = win32.join(serviceDir, `${SERVICE_ID}.exe`);
  const xml = win32.join(serviceDir, `${SERVICE_ID}.xml`);
  const flag = (value: boolean) => (value ? '$true' : '$false');
  return (
    [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      ...windowsServiceSecurityHelpers,
      ...windowsRuntimeSecurityHelpers(),
      `$stage = ${psQuote(plan.stageDir)}`,
      `$stageRoot = ${psQuote(stageRoot)}`,
      `$installDir = ${psQuote(installDir)}`,
      `$appExe = ${psQuote(c.execPath)}`,
      `$control = ${psQuote(win32.join(plan.controlDir, 'command'))}`,
      `$nonce = ${psQuote(plan.nonce)}`,
      `$version = ${psQuote(a.version)}`,
      `$expectedHash = ${psQuote(a.sha256.toLowerCase())}`,
      `$installedService = ${flag(c.serviceInstalled)}`,
      `$serviceStopped = $false`,
      `$replacementStarted = $false`,
      `$installerBlocked = $false`,
      `$accepted = $false`,
      `$backupReady = $false`,
      `$safeStage = $false`,
      `$private = Join-Path $stage 'private'`,
      `$installer = Join-Path $private 'installer.exe'`,
      `$backup = Join-Path $stage 'old-app'`,
      `function Write-State([string]$phase, [string]$message) {`,
      `  $state = @{ phase = $phase; nonce = $nonce; version = $version; message = $message; accepted = $accepted; completedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress`,
      `  $temporary = Join-Path $stage 'state.tmp'`,
      `  [IO.File]::WriteAllText($temporary, $state, (New-Object Text.UTF8Encoding $false))`,
      `  Move-Item -LiteralPath $temporary -Destination (Join-Path $stage 'state.json') -Force`,
      `}`,
      WINDOWS_RESTORE_OLD_APP,
      `function Check-Hash { if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Installer checksum mismatch' } }`,
      `function Assert-Service {`,
      `  Assert-Locked ${psQuote(serviceDir)} -Recurse`,
      `  $config = New-Object Xml.XmlDocument; $config.XmlResolver = $null; $config.Load(${psQuote(xml)})`,
      `  if ([string]$config.service.id -ne '${SERVICE_ID}' -or -not ([string]$config.service.executable).Equals($appExe, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installed service belongs to another runtime' }`,
      `  $native = Get-CimInstance Win32_Service -Filter "Name='${SERVICE_ID}'"`,
      `  if (-not $native -or $native.PathName.Trim('"') -ne ${psQuote(wrapper)}) { throw 'The installed service wrapper is not owned by this app' }`,
      `}`,
      `function Start-InboxService([string]$expectedVersion) {`,
      `  Assert-ProtectedRuntime $appExe; Assert-Service`,
      `  Start-Service -Name '${SERVICE_ID}'`,
      `  (Get-Service -Name '${SERVICE_ID}').WaitForStatus('Running', [TimeSpan]::FromSeconds(30))`,
      `  $deadline = [DateTime]::UtcNow.AddSeconds(60)`,
      `  while ([DateTime]::UtcNow -lt $deadline) {`,
      `    try {`,
      `      $port = (Get-Content -LiteralPath ${psQuote(win32.join(c.serviceRunDir, 'port.json'))} -Raw | ConvertFrom-Json).port`,
      `      if ($port -ge 1 -and $port -le 65535) {`,
      `        $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/health') -TimeoutSec 2`,
      `        if ($health.app -eq '${product.healthApp}' -and $health.version -eq $expectedVersion -and $health.mode -eq 'service') { return }`,
      `      }`,
      `    } catch { }`,
      `    Start-Sleep -Milliseconds 500`,
      `  }`,
      `  throw 'The replacement service did not become healthy'`,
      `}`,
      `try {`,
      `  $expectedStageRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) '${product.appDirName}-updates'`,
      `  if (-not $stageRoot.Equals($expectedStageRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($stage) -ne $nonce) { throw 'Unsafe updater staging path' }`,
      `  if (-not ${psQuote(c.machineDataDir)}.Equals((Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) '${product.appDirName}'), [StringComparison]::OrdinalIgnoreCase) -or -not ${psQuote(c.serviceRunDir)}.Equals((Join-Path ${psQuote(c.machineDataDir)} 'run'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe service data paths' }`,
      `  if (Test-Path -LiteralPath $stageRoot) { Assert-Locked $stageRoot -readers @('S-1-5-32-545') } else {`,
      `    New-Item -ItemType Directory -Path $stageRoot | Out-Null`,
      `    icacls $stageRoot /setowner '*S-1-5-32-544' /Q | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Cannot secure update staging' }`,
      `    icacls $stageRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Cannot secure update staging' }`,
      `  }`,
      `  if (Test-Path -LiteralPath $stage) { throw 'Updater stage already exists' }`,
      `  New-Item -ItemType Directory -Path $stage | Out-Null`,
      `  Assert-Locked $stage -readers @('S-1-5-32-545')`,
      `  $safeStage = $true`,
      // Only status is public. A raced source path must not expose privileged reads through its failed copy.
      `  New-Item -ItemType Directory -Path $private | Out-Null`,
      `  icacls $private /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Cannot secure private installer copy' }`,
      `  Assert-Locked $private`,
      `  Assert-ProtectedRuntime $appExe`,
      `  $actualService = Get-Service -Name '${SERVICE_ID}' -ErrorAction SilentlyContinue`,
      `  if ([bool]$actualService -ne $installedService) { throw 'Service ownership changed. Check again before updating.' }`,
      `  if ($installedService) { Assert-Service }`,
      `  $oldPid = Get-CimInstance Win32_Process -Filter 'ProcessId=${c.oldPid}'`,
      `  if (-not $oldPid -or -not $oldPid.ExecutablePath.Equals($appExe, [StringComparison]::OrdinalIgnoreCase)) { throw 'The original app process cannot be verified' }`,
      `  $oldStarted = $oldPid.CreationDate`,
      `  $originalVersion = (Get-Content -LiteralPath (Join-Path $installDir 'resources\\app.asar.unpacked\\dist\\package.json') -Raw | ConvertFrom-Json).version`,
      `  $source = Get-Item -LiteralPath ${psQuote(a.filePath)} -Force`,
      `  if ($source.Attributes -band [IO.FileAttributes]::ReparsePoint -or $source.PSIsContainer) { throw 'Unsafe installer source' }`,
      `  Copy-Item -LiteralPath ${psQuote(a.filePath)} -Destination $installer`,
      `  Check-Hash`,
      `  New-Item -ItemType Directory -Path $backup | Out-Null`,
      `  Get-ChildItem -LiteralPath $installDir -Force | Copy-Item -Destination $backup -Recurse -Force`,
      `  $backupReady = $true`,
      `  Write-State 'ready' 'Verified installer and rollback copy are ready.'`,
      `  $decisionDeadline = [DateTime]::UtcNow.AddMinutes(3)`,
      `  $command = ''`,
      `  while ([DateTime]::UtcNow -lt $decisionDeadline) {`,
      `    if (Test-Path -LiteralPath $control) {`,
      `      $item = Get-Item -LiteralPath $control -Force`,
      `      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint -or $item.Length -gt 128) { throw 'Unsafe update command' }`,
      `      $command = [IO.File]::ReadAllText($control)`,
      `      if ($command -eq ('cancel:' + $nonce)) { Write-State 'cancelled' 'Installation cancelled. The running app was not changed.'; exit 0 }`,
      `      if ($command -eq ('commit:' + $nonce)) { break }`,
      `    }`,
      `    Start-Sleep -Milliseconds 200`,
      `  }`,
      `  if ($command -ne ('commit:' + $nonce)) { Write-State 'cancelled' 'Installation timed out. The running app was not changed.'; exit 0 }`,
      `  Check-Hash`,
      `  $accepted = $true; Write-State 'accepted' 'Installation accepted. Waiting for the old app to exit.'`,
      `  if ($installedService) {`,
      `    Assert-Service; Stop-Service -Name '${SERVICE_ID}'; $serviceStopped = $true`,
      `    (Get-Service -Name '${SERVICE_ID}').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))`,
      `  }`,
      `  $exitDeadline = [DateTime]::UtcNow.AddSeconds(90)`,
      `  while ([DateTime]::UtcNow -lt $exitDeadline) {`,
      `    if ((Test-Path -LiteralPath $control) -and [IO.File]::ReadAllText($control) -eq ('cancel:' + $nonce)) { throw 'App shutdown was cancelled' }`,
      `    $stillOld = Get-CimInstance Win32_Process -Filter 'ProcessId=${c.oldPid}'`,
      `    $runtimeProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($appExe, [StringComparison]::OrdinalIgnoreCase) })`,
      `    if ((-not $stillOld -or $stillOld.CreationDate -ne $oldStarted) -and $runtimeProcesses.Count -eq 0) { break }`,
      `    Start-Sleep -Milliseconds 500`,
      `  }`,
      `  if ($runtimeProcesses.Count -ne 0) { throw 'The old app did not shut down. No replacement was attempted.' }`,
      `  Check-Hash; Assert-ProtectedRuntime $appExe`,
      ...WINDOWS_START_INSTALLER,
      `  if ($process.ExitCode -ne 0) { throw 'The installer failed' }`,
      `  Assert-ProtectedRuntime $appExe`,
      `  $installedVersion = (Get-Content -LiteralPath (Join-Path $installDir 'resources\\app.asar.unpacked\\dist\\package.json') -Raw | ConvertFrom-Json).version`,
      `  if ($installedVersion -ne $version) { throw 'The installed app version does not match the verified release' }`,
      `  if ($installedService) { Start-InboxService $version; $serviceStopped = $false }`,
      `  try {`,
      `    foreach ($name in @('old-app', 'private')) {`,
      `      $item = Join-Path $stage $name`,
      `      if (Test-Path -LiteralPath $item) {`,
      `        if ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe cleanup link' }`,
      `        Remove-Item -LiteralPath $item -Recurse -Force`,
      `      }`,
      `    }`,
      `  } catch { ($_ | Out-String) | Out-File -LiteralPath (Join-Path $stage 'cleanup-warning.log') -Encoding utf8 }`,
      `  Write-State 'success' ${psQuote(resultMessage)}`,
      `} catch {`,
      `  $restored = $false`,
      `  if ($safeStage) { ($_ | Out-String) | Out-File -LiteralPath (Join-Path $stage 'helper-error.log') -Encoding utf8 }`,
      `  try {`,
      `    if ($replacementStarted -and $backupReady) {`,
      `      if ($installedService) { Stop-Service -Name '${SERVICE_ID}' -ErrorAction SilentlyContinue }`,
      `      $resolved = [IO.Path]::GetFullPath($installDir)`,
      `      if ($resolved -ne [IO.Path]::GetDirectoryName($appExe) -or -not (Test-Path -LiteralPath $backup)) { throw 'Unsafe rollback target' }`,
      `      if (Test-Path -LiteralPath $installDir) {`,
      `        if ((Get-Item -LiteralPath $installDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe rollback link' }`,
      `      }`,
      `      Restore-OldApp $installDir $backup`,
      `      Assert-ProtectedRuntime $appExe; $restored = $true`,
      `    }`,
      `    if ($accepted -and $installedService) { Start-InboxService $originalVersion }`,
      `  } catch { if ($safeStage) { ($_ | Out-String) | Out-File -LiteralPath (Join-Path $stage 'rollback-error.log') -Encoding utf8 } }`,
      `  if ($safeStage) {`,
      `    $message = if ($installerBlocked) { 'The update installer was blocked from starting, often by antivirus software. Your app was not changed and its service was restarted.' } elseif ($replacementStarted -and -not $restored) { 'Update failed and automatic recovery could not finish. Keep the rollback copy and check Status & Service.' } elseif ($accepted) { 'Update failed. The previous app was retained or restored and its service restart was attempted.' } else { 'The update could not be prepared. Your running app and service were not changed.' }`,
      `    Write-State 'error' $message`,
      `  }`,
      `  exit 1`,
      `}`,
    ].join('\r\n') + '\r\n'
  );
}

function macStageGuards(plan: InstallPlan): string[] {
  return [
    `stage=${shQuote(plan.stageDir)}`,
    `stage_root=${shQuote(posix.dirname(plan.stageDir))}`,
    `nonce=${shQuote(plan.nonce)}`,
    `if [ "$stage_root" != '/Library/Application Support/${activeProduct().appDirName}-updates' ] || [ "$(basename "$stage")" != "$nonce" ]; then echo 'Unsafe update stage' >&2; exit 12; fi`,
    `if [ -L "$stage_root" ]; then echo 'Updater staging cannot be a link' >&2; exit 12; fi`,
    `if [ -e "$stage_root" ]; then`,
    `  if [ "$(stat -f %u "$stage_root")" != 0 ] || [ -n "$(find "$stage_root" -maxdepth 0 \\( -perm -020 -o -perm -002 \\) -print)" ]; then echo 'Updater staging is not protected' >&2; exit 12; fi`,
    `  if ls -lde "$stage_root" | grep -Eq '^[[:space:]]*[0-9]+:'; then echo 'Updater staging has an unsafe ACL' >&2; exit 12; fi`,
    `else`,
    `  mkdir "$stage_root"; chown root:wheel "$stage_root"; chmod -N "$stage_root"; chmod 755 "$stage_root"`,
    `fi`,
  ];
}

export function buildMacHelperBootstrap(plan: InstallPlan, scriptBase64: string): string {
  return [
    'set -euo pipefail',
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH',
    ...macStageGuards(plan),
    `if [ -e "$stage" ] || [ -L "$stage" ]; then echo 'Updater stage already exists' >&2; exit 12; fi`,
    `mkdir "$stage"; chown root:wheel "$stage"; chmod -N "$stage"; chmod 755 "$stage"`,
    `printf '%s' ${shQuote(scriptBase64)} | /usr/bin/base64 --decode > "$stage/install.sh"`,
    `chmod 700 "$stage/install.sh"`,
    // No nohup: root under the admin prompt has no console, and macOS nohup then exits with "can't detach
    // from console" without starting the helper. Nothing sends a hangup here; install.sh also ignores HUP.
    `/bin/bash "$stage/install.sh" > "$stage/helper.log" 2>&1 < /dev/null &`,
  ].join('\n');
}

export function buildMacInstallScript(plan: InstallPlan): string {
  validatePlan(plan);
  const product = activeProduct();
  const MAC_LABEL = product.launchdLabel;
  const names = product.executableNames;
  const quotedNames = names.map((name) => `'${name}'`).join('|');
  const quotedBundles = names.map((name) => `'${name}.app'`).join('|');
  const runtimeBundles = names.map((name) => `"$runtime_root/${name}.app"`).join('|');
  const namePattern = names.map(escapeRegExp).join('|');
  const { context: c, artifact: a } = plan;
  const app = c.appBundle!;
  const plist = `/Library/LaunchDaemons/${MAC_LABEL}.plist`;
  return (
    [
      '#!/bin/bash',
      'set -Eeuo pipefail',
      'umask 077',
      "trap '' HUP",
      'PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH',
      ...macStageGuards(plan),
      `app=${shQuote(app)}`,
      `app_exe=${shQuote(c.execPath)}`,
      `control=${shQuote(posix.join(plan.controlDir, 'command'))}`,
      `version=${shQuote(a.version)}`,
      `expected_hash=${shQuote(a.sha256.toLowerCase())}`,
      `service_installed=${c.serviceInstalled ? '1' : '0'}`,
      `plist=${shQuote(plist)}`,
      `runtime_root=${shQuote(c.serviceRunDir)}`,
      `runtime=''`,
      `accepted=false; stopped=0; main_replaced=0; runtime_replaced=0; ready_backup=0; mounted=0`,
      `installer="$stage/installer.dmg"; mount="$stage/mount"; backup_main="$stage/old-main.app"; backup_runtime="$stage/old-runtime.app"; new_main="$stage/new-main.app"; new_runtime="$stage/new-runtime.app"`,
      `write_state() {`,
      `  printf '{"phase":"%s","nonce":"%s","version":"%s","message":"%s","accepted":%s,"completedAt":"%s"}' "$1" "$nonce" "$version" "$2" "$accepted" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stage/state.tmp"`,
      `  chmod 644 "$stage/state.tmp"; mv -f "$stage/state.tmp" "$stage/state.json"`,
      `}`,
      `check_hash() { [ "$(shasum -a 256 "$installer" | awk '{print $1}')" = "$expected_hash" ]; }`,
      `protect_tree() { chown -hRP root:wheel "$1"; chmod -RN "$1"; chmod -R go-w "$1"; }`,
      `validate_links() {`,
      `  local base="$1" link target resolved`,
      `  while IFS= read -r link; do`,
      `    target=$(readlink "$link") || return 1`,
      `    case "$target" in /*) echo 'Runtime contains an absolute link' >&2; return 1;; esac`,
      `    if [ -d "$link" ]; then resolved=$(cd "$link" && pwd -P) || return 1; else resolved=$(cd "$(dirname "$link")" && cd "$(dirname "$target")" && pwd -P)/$(basename "$target") || return 1; fi`,
      `    case "$resolved" in "$base"/*) ;; *) echo 'Runtime link escapes the app' >&2; return 1;; esac`,
      `  done < <(find "$base" -type l -print)`,
      `}`,
      `assert_protected() {`,
      `  [ -d "$1" ] && [ ! -L "$1" ] && [ "$(stat -f %u "$1")" = 0 ] || return 1`,
      `  [ -z "$(find "$1" ! -type l \\( ! -user root -o -perm -020 -o -perm -002 \\) -print -quit)" ] || return 1`,
      `  if find "$1" ! -type l -exec ls -lde {} + | grep -E '^[[:space:]]*[0-9]+:' > /dev/null; then echo 'Protected runtime has ACLs' >&2; return 1; fi`,
      `  validate_links "$1"`,
      `}`,
      `assert_plist() {`,
      `  [ -f "$plist" ] && [ ! -L "$plist" ] && [ "$(stat -f %u "$plist")" = 0 ] || return 1`,
      `  [ -z "$(find "$plist" \\( -perm -020 -o -perm -002 \\) -print)" ] || return 1`,
      `  if ls -le "$plist" | grep -Eq '^[[:space:]]*[0-9]+:'; then return 1; fi`,
      `  [ "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist")" = '${MAC_LABEL}' ] || return 1`,
      `  local exe=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist")`,
      `  runtime=$(dirname "$(dirname "$(dirname "$exe")")")`,
      `  case "$runtime" in ${runtimeBundles}) ;; *) echo 'Foreign service runtime' >&2; return 1;; esac`,
      `  assert_protected "$runtime"`,
      `}`,
      `start_service() {`,
      `  assert_plist || return 1`,
      `  launchctl bootstrap system "$plist" || return 1`,
      `  local expected="$1" deadline=$(( $(date +%s) + 60 )) port actual`,
      `  while [ "$(date +%s)" -lt "$deadline" ]; do`,
      `    port=$(/usr/bin/plutil -extract port raw -o - "$runtime_root/port.json" 2>/dev/null || true)`,
      `    case "$port" in ''|*[!0-9]*) ;; *)`,
      `      if [ "$port" -ge 1 ] && [ "$port" -le 65535 ] && /usr/bin/curl --silent --fail --max-time 2 "http://127.0.0.1:$port/api/health" > "$stage/health.json"; then`,
      `        actual=$(/usr/bin/plutil -extract version raw -o - "$stage/health.json" 2>/dev/null || true)`,
      `        if [ "$actual" = "$expected" ] && [ "$(/usr/bin/plutil -extract app raw -o - "$stage/health.json")" = '${product.healthApp}' ] && [ "$(/usr/bin/plutil -extract mode raw -o - "$stage/health.json")" = 'service' ]; then return 0; fi`,
      `      fi;;`,
      `    esac`,
      `    sleep 0.5`,
      `  done`,
      `  return 1`,
      `}`,
      `recover() {`,
      `  trap - ERR; set +e`,
      `  if [ "$mounted" = 1 ]; then hdiutil detach "$mount" -quiet; fi`,
      `  local restored=1`,
      `  if [ "$runtime_replaced" = 1 ]; then`,
      `    launchctl bootout system/${MAC_LABEL} >/dev/null 2>&1`,
      `    if [ -d "$backup_runtime" ] && [ ! -L "$runtime" ]; then rm -rf "$runtime"; mv "$backup_runtime" "$runtime" || restored=0; else restored=0; fi`,
      `    cp "$stage/old-service.plist" "$plist"; chown root:wheel "$plist"; chmod -N "$plist"; chmod 644 "$plist"`,
      `  fi`,
      `  if [ "$main_replaced" = 1 ]; then`,
      `    if [ -d "$backup_main" ] && [ ! -L "$app" ]; then rm -rf "$app"; ditto --noacl "$backup_main" "$app" || restored=0; else restored=0; fi`,
      `  fi`,
      `  if [ "$stopped" = 1 ]; then start_service "$original_version" || restored=0; fi`,
      `  if [ "$restored" = 0 ]; then write_state 'error' 'Update failed and recovery could not finish. Keep the rollback copy and check Status & Service.'; elif [ "$accepted" = true ]; then write_state 'error' 'Update failed. The previous app was retained or restored and its service restart was attempted.'; else write_state 'error' 'The update could not be prepared. Your running app and service were not changed.'; fi`,
      `  exit 1`,
      `}`,
      `trap recover ERR`,
      `if [ -L "$app" ] || [ ! -d "$app" ] || [ ! -f "$app/Contents/Info.plist" ]; then echo 'Unsafe main app path' >&2; false; fi`,
      `if [ -L /Applications ] || [ "$(stat -f %u /Applications)" != 0 ]; then echo 'Applications is not a protected system directory' >&2; false; fi`,
      `original_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")`,
      `if ! /usr/sbin/lsof -a -p ${c.oldPid} -d txt -Fn 2>/dev/null | grep -Fx ${shQuote('n' + c.execPath)} >/dev/null; then echo 'Original app process cannot be verified' >&2; false; fi`,
      `old_started=$(/bin/ps -p ${c.oldPid} -o lstart=)`,
      `if [ "$service_installed" = 1 ]; then`,
      `  assert_plist; assert_protected "$runtime_root"`,
      `  cp "$plist" "$stage/old-service.plist"; chmod 600 "$stage/old-service.plist"`,
      `  ditto --noacl "$runtime" "$backup_runtime"; protect_tree "$backup_runtime"`,
      `elif [ -e "$plist" ] || [ -L "$plist" ]; then echo 'Service ownership changed' >&2; false; fi`,
      `if [ ! -f ${shQuote(a.filePath)} ] || [ -L ${shQuote(a.filePath)} ]; then echo 'Unsafe installer source' >&2; false; fi`,
      `cp ${shQuote(a.filePath)} "$installer"; chmod 600 "$installer"; check_hash`,
      `hdiutil verify "$installer" -quiet`,
      `mkdir "$mount"`,
      `hdiutil attach "$installer" -readonly -nobrowse -noautoopen -mountpoint "$mount" -quiet; mounted=1`,
      `candidates=()`,
      `while IFS= read -r candidate; do candidates+=("$candidate"); done < <(find "$mount" -maxdepth 1 -type d -name '*.app' -print)`,
      `if [ "\${#candidates[@]}" != 1 ]; then echo 'The image must contain exactly one app' >&2; false; fi`,
      `candidate="\${candidates[0]}"`,
      `case "$(basename "$candidate")" in ${quotedBundles}) ;; *) echo 'Unrecognized update app' >&2; false;; esac`,
      `if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate/Contents/Info.plist")" != '${product.appUserModelId}' ] || [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$candidate/Contents/Info.plist")" != "$version" ]; then echo 'Wrong update identity or version' >&2; false; fi`,
      // An unnotarized copy that keeps the quarantine flag is refused by Gatekeeper (the service copy on every start).
      `ditto --noacl "$candidate" "$new_main"; xattr -dr com.apple.quarantine "$new_main" 2>/dev/null || true; validate_links "$new_main"; protect_tree "$new_main"; assert_protected "$new_main"`,
      `new_executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$new_main/Contents/Info.plist")`,
      `case "$new_executable" in ${quotedNames}) ;; *) echo 'Unrecognized update executable' >&2; false;; esac`,
      `if [ ! -f "$new_main/Contents/MacOS/$new_executable" ] || [ -L "$new_main/Contents/MacOS/$new_executable" ]; then false; fi`,
      `hdiutil detach "$mount" -quiet; mounted=0`,
      `ditto --noacl "$app" "$backup_main"; validate_links "$backup_main"; protect_tree "$backup_main"; ready_backup=1`,
      `if [ "$service_installed" = 1 ]; then ditto --noacl "$new_main" "$new_runtime"; protect_tree "$new_runtime"; assert_protected "$new_runtime"; fi`,
      `write_state 'ready' 'Verified installer and rollback copies are ready.'`,
      `deadline=$(( $(date +%s) + 180 )); command=''`,
      `while [ "$(date +%s)" -lt "$deadline" ]; do`,
      `  if [ -f "$control" ] && [ ! -L "$control" ] && [ "$(stat -f %z "$control")" -le 128 ]; then`,
      `    command=$(cat "$control")`,
      `    if [ "$command" = "cancel:$nonce" ]; then write_state 'cancelled' 'Installation cancelled. The running app was not changed.'; exit 0; fi`,
      `    if [ "$command" = "commit:$nonce" ]; then break; fi`,
      `  fi`,
      `  sleep 0.2`,
      `done`,
      `if [ "$command" != "commit:$nonce" ]; then write_state 'cancelled' 'Installation timed out. The running app was not changed.'; exit 0; fi`,
      `check_hash; accepted=true; write_state 'accepted' 'Installation accepted. Waiting for the old app to exit.'`,
      `if [ "$service_installed" = 1 ]; then assert_plist; stopped=1; if launchctl print system/${MAC_LABEL} >/dev/null 2>&1; then launchctl bootout system/${MAC_LABEL}; fi; fi`,
      `deadline=$(( $(date +%s) + 90 ))`,
      `while [ "$(date +%s)" -lt "$deadline" ]; do`,
      `  if [ -f "$control" ] && [ "$(cat "$control")" = "cancel:$nonce" ]; then false; fi`,
      `  current_started=$(/bin/ps -p ${c.oldPid} -o lstart= 2>/dev/null || true)`,
      `  remaining=$(/usr/bin/pgrep -f '^/Library/Application Support/${product.appDirName}-runtime/(${namePattern})\\.app/Contents/MacOS/(${namePattern})( |$)' || true)`,
      `  if [ "$current_started" != "$old_started" ] && [ -z "$remaining" ]; then break; fi`,
      `  sleep 0.5`,
      `done`,
      `if [ "$current_started" = "$old_started" ] || [ -n "$remaining" ]; then echo 'The old app did not shut down' >&2; false; fi`,
      `check_hash; assert_protected "$new_main"`,
      `if [ -L "$app" ]; then false; fi`,
      // Complete protected backups exist before any replacement, and data is untouched.
      `main_replaced=1; rm -rf "$app"; ditto --noacl "$new_main" "$app"; protect_tree "$app"`,
      `if [ "$service_installed" = 1 ]; then`,
      `  assert_protected "$runtime_root"; runtime_replaced=1`,
      `  rm -rf "$runtime"; ditto --noacl "$new_runtime" "$runtime"; protect_tree "$runtime"; assert_protected "$runtime"`,
      `  /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $runtime/Contents/MacOS/$new_executable" "$plist"`,
      `  chown root:wheel "$plist"; chmod -N "$plist"; chmod 644 "$plist"`,
      `  start_service "$version"; stopped=0`,
      `fi`,
      `trap - ERR`,
      // Every cleanup target is a fixed child of the previously verified private stage.
      `rm -rf "$backup_main" "$backup_runtime" "$new_main" "$new_runtime" "$mount" || echo 'Could not remove all update staging copies' >&2`,
      `rm -f "$installer" "$stage/old-service.plist" "$stage/health.json" || echo 'Could not remove all update staging files' >&2`,
      `write_state 'success' ${shQuote(resultMessage)}`,
    ].join('\n') + '\n'
  );
}

/** Runs as the original user; only it writes the profile manifest and launches the new UI. */
export function buildInstallBrokerScript(plan: InstallPlan): string {
  validatePlan(plan);
  const profile = plan.context.userDataDir;
  const status = (plan.context.platform === 'win32' ? win32 : posix).join(
    plan.stageDir,
    'state.json',
  );
  if (plan.context.platform === 'win32')
    return (
      [
        "$ErrorActionPreference = 'Stop'",
        `$nonce = ${psQuote(plan.nonce)}`,
        `$oldApp = Get-Process -Id ${plan.context.oldPid} -ErrorAction SilentlyContinue`,
        `$deadline = [DateTime]::UtcNow.AddMinutes(30)`,
        `while ([DateTime]::UtcNow -lt $deadline) {`,
        `  try {`,
        `    $state = Get-Content -LiteralPath ${psQuote(status)} -Raw | ConvertFrom-Json`,
        `    if ($state.nonce -eq $nonce -and $state.version -eq ${psQuote(plan.artifact.version)}) {`,
        `      if ($state.phase -eq 'cancelled') { exit 0 }`,
        `      if ($state.phase -in @('success', 'error')) {`,
        `        $dir = ${psQuote(win32.join(profile, 'updates'))}; New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
        `        $result = @{ status = $state.phase; version = $state.version; message = $state.message; completedAt = $state.completedAt } | ConvertTo-Json -Compress`,
        `        [IO.File]::WriteAllText((Join-Path $dir 'install-result.tmp'), $result, (New-Object Text.UTF8Encoding $false))`,
        `        Move-Item -LiteralPath (Join-Path $dir 'install-result.tmp') -Destination (Join-Path $dir 'install-result.json') -Force`,
        `        if ($state.phase -eq 'success' -and (Test-Path -LiteralPath ${psQuote(plan.artifact.filePath)} -PathType Leaf)) {`,
        `          $artifact = Get-Item -LiteralPath ${psQuote(plan.artifact.filePath)} -Force`,
        `          if (-not ($artifact.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-Item -LiteralPath ${psQuote(plan.artifact.filePath)} -Force -ErrorAction SilentlyContinue }`,
        `        }`,
        `        if ($state.accepted) {`,
        // An accepted helper may fail before Electron sees the acknowledgement and exits.
        // Wait before relaunching, or the new process loses its single-instance lock and disappears.
        `          if (-not $oldApp -or $oldApp.WaitForExit(120000)) { Start-Process -FilePath ${psQuote(plan.context.execPath)} -WindowStyle Hidden }`,
        `        }`,
        `        exit 0`,
        `      }`,
        `    }`,
        `  } catch { }`,
        `  if ((Test-Path -LiteralPath ${psQuote(win32.join(plan.controlDir, 'command'))}) -and [IO.File]::ReadAllText(${psQuote(win32.join(plan.controlDir, 'command'))}) -eq ('cancel:' + $nonce)) { exit 0 }`,
        `  Start-Sleep -Milliseconds 300`,
        `}`,
      ].join('\r\n') + '\r\n'
    );
  return (
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH',
      `state=${shQuote(status)}; deadline=$(( $(date +%s) + 1800 ))`,
      `old_started=$(/bin/ps -p ${plan.context.oldPid} -o lstart= 2>/dev/null || true)`,
      `while [ "$(date +%s)" -lt "$deadline" ]; do`,
      `  if [ -f "$state" ] && [ ! -L "$state" ]; then`,
      `    nonce=$(/usr/bin/plutil -extract nonce raw -o - "$state" 2>/dev/null || true)`,
      `    phase=$(/usr/bin/plutil -extract phase raw -o - "$state" 2>/dev/null || true)`,
      `    if [ "$nonce" = ${shQuote(plan.nonce)} ]; then`,
      `      if [ "$phase" = cancelled ]; then exit 0; fi`,
      `      if [ "$phase" = success ] || [ "$phase" = error ]; then`,
      `        dir=${shQuote(posix.join(profile, 'updates'))}; mkdir -p "$dir"`,
      `        cp "$state" "$dir/install-result.tmp"`,
      `        /usr/bin/plutil -replace status -string "$phase" "$dir/install-result.tmp"`,
      `        /usr/bin/plutil -convert json -o "$dir/install-result.ready" "$dir/install-result.tmp"`,
      `        chmod 600 "$dir/install-result.ready"; mv -f "$dir/install-result.ready" "$dir/install-result.json"`,
      `        if [ "$phase" = success ] && [ -f ${shQuote(plan.artifact.filePath)} ] && [ ! -L ${shQuote(plan.artifact.filePath)} ]; then rm -f -- ${shQuote(plan.artifact.filePath)} || true; fi`,
      `        accepted=$(/usr/bin/plutil -extract accepted raw -o - "$state" 2>/dev/null || true)`,
      `        if [ "$accepted" = true ]; then`,
      `          exit_deadline=$(( $(date +%s) + 120 ))`,
      `          current_started=$(/bin/ps -p ${plan.context.oldPid} -o lstart= 2>/dev/null || true)`,
      `          while [ -n "$old_started" ] && [ "$current_started" = "$old_started" ] && [ "$(date +%s)" -lt "$exit_deadline" ]; do`,
      `            sleep 0.3; current_started=$(/bin/ps -p ${plan.context.oldPid} -o lstart= 2>/dev/null || true)`,
      `          done`,
      `          if [ -z "$old_started" ] || [ "$current_started" != "$old_started" ]; then /usr/bin/open ${shQuote(plan.context.appBundle!)}; fi`,
      `        fi`,
      `        exit 0`,
      `      fi`,
      `    fi`,
      `  fi`,
      `  if [ -f ${shQuote(posix.join(plan.controlDir, 'command'))} ] && [ "$(cat ${shQuote(posix.join(plan.controlDir, 'command'))})" = ${shQuote('cancel:' + plan.nonce)} ]; then exit 0; fi`,
      `  sleep 0.3`,
      `done`,
    ].join('\n') + '\n'
  );
}
