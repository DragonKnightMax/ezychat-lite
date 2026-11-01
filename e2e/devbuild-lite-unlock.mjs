#!/usr/bin/env node
// Dev Build check: the Lite → Enterprise "Allow and continue" step on a PC where EzyChat Lite runs as the
// Windows background service. Runs the REAL desktop code (detection, LiteImportController, the Lite service
// manager, the elevated runner and its UAC prompt). It never imports (never calls start()).
//
//   npx tsx --conditions=ezychat-source e2e/devbuild-lite-unlock.mjs          DRY RUN (default)
//   npx tsx --conditions=ezychat-source e2e/devbuild-lite-unlock.mjs --real   REAL "Remove service"
//
// Dry run: the elevated script is only the read-only prechecks (windowsUninstallPrechecks); nothing changes.
// Expected: scan → "protected"; Yes → "DRY RUN: prechecks passed", state stays "protected"; No → "declined".
// --real: Lite's own "Remove service" runs (service removed, data moved to Lite's user folder), then the real
// `--lite-summary` (needs `npm run bundle:server -w @ezychat/desktop`). Expected: Yes → "found" or "blocked"
// with Lite's counts. Undo: in EzyChat Lite, Status & Service… → install the background service again.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerCli } from '../apps/desktop/src/lite-import/cli.ts';
import { LiteImportController } from '../apps/desktop/src/lite-import/controller.ts';
import { mtimeOrDenied, liteFolders } from '../apps/desktop/src/lite-import/detect.ts';
import { liteImportDeps, liteServiceFolders } from '../apps/desktop/src/lite-import/host.ts';
import { serviceRunDir } from '../apps/desktop/src/paths.ts';
import { LITE_PRODUCT } from '../apps/desktop/src/product.ts';
import { createServiceManager, runElevatedWindows } from '../apps/desktop/src/service/index.ts';
import { windowsUninstallPrechecks } from '../apps/desktop/src/service/windows.ts';

if (process.platform !== 'win32')
  throw new Error('Windows only (the service and UAC prompt are Windows)');
const env = process.env;
const appData = env.APPDATA;
if (!appData) throw new Error('APPDATA is not set');

const product = LITE_PRODUCT;
const folders = liteServiceFolders(product, { platform: 'win32', env, appData });
const real = createServiceManager('win32', {
  execPath: process.execPath,
  serverHost: 'unused',
  serverEntry: 'unused',
  webDist: 'unused',
  cloudflaredBinary: null,
  cloudflaredDir: 'unused',
  winswExe: 'unused',
  port: 7420,
  version: '0.0.0',
  product,
  ...folders,
});
// Only status() of the real manager is used; uninstall() is replaced by the elevated prechecks.
const dryRunService = {
  status: () => real.status(),
  uninstall: async () => {
    const script = [
      ...windowsUninstallPrechecks({
        id: product.serviceId,
        serviceDir: `${folders.machineDataDir}\\service`,
        dataDir: folders.machineDataDir,
        moveTo: folders.userDataDir,
        runDir: serviceRunDir('win32', env, product),
      }),
      `Write-Output 'DRY RUN: prechecks passed, nothing changed.'`,
    ].join('\r\n');
    console.log(`  elevated output: ${(await runElevatedWindows(`${script}\r\n`)).trim()}`);
  },
};

const realRun = process.argv.includes('--real');
const entry = fileURLToPath(new URL('../apps/desktop/dist/server/server.cjs', import.meta.url));
if (realRun && !existsSync(entry))
  throw new Error(
    `--real reads Lite's summary with ${entry}: run npm run bundle:server -w @ezychat/desktop`,
  );

const scratch = mkdtempSync(join(tmpdir(), 'lite-unlock-check-'));
const refuse = async () => {
  throw new Error('not used in this check (it never imports)');
};
const deps = liteImportDeps({
  adoptFrom: product,
  platform: 'win32',
  env,
  appData,
  dataDir: join(scratch, 'enterprise-data'),
  cli: realRun
    ? createServerCli({ entry, runtime: 'node', execPath: process.execPath })
    : { run: refuse },
  // --real: Lite's own manager, built with Lite's folders (liteServiceFolders), as main.ts does.
  liteService: realRun ? real : dryRunService,
  probe: async () => false,
  serverUrl: () => 'http://127.0.0.1:1',
  fetch: globalThis.fetch,
  fs: {
    mtimeMs: (p) => mtimeOrDenied(statSync, p),
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    exists: existsSync,
    freeBytes: async () => null,
    makeTempDir: refuse,
    writePrivate: refuse,
    removeDir: refuse,
  },
  ownServer: { stop: refuse, restart: refuse, takeOverPort: () => {} },
  log: (fields) => console.log(`  log: ${JSON.stringify(fields)}`),
});
const controller = new LiteImportController(deps);
const show = (label, s) =>
  console.log(`${label}: phase=${s.phase} liteService=${s.liteService} unlock=${s.unlock}`);

try {
  const f = liteFolders(product, { platform: 'win32', env, appData });
  console.log(`Lite machine folder: ${f.machine}\nLite user folder:    ${f.user}`);
  console.log(`Lite service:        ${await real.status()}`);
  const scanned = await controller.scan();
  show('1. scan', scanned);
  if (scanned.phase !== 'protected') {
    console.log('Not protected: nothing to try (is Lite running as a service on this PC?).');
  } else {
    console.log(
      realRun
        ? '2. Allow (REAL): Windows asks now. Yes removes Lite’s service and moves its data to Lite’s folder.'
        : '2. Allow: Windows asks now. Choose Yes or No (dry run: nothing changes either way).',
    );
    const after = await controller.unlock();
    show('   result', after);
    // Counts only: the summary also holds the number and names.
    if (after.lite)
      console.log(
        `   Lite summary: ${after.lite.chats} chats, ${after.lite.users.length} users, ${after.lite.totalBytes} bytes; issues: ${after.issues.join(', ') || 'none'}`,
      );
    if (!realRun) show('3. scan again', await controller.scan());
    console.log(
      `   Lite service after: ${await real.status()}${realRun ? '' : ' (must be unchanged)'}`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
