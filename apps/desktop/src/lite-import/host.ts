// Builds the Lite import's dependencies from the desktop's pieces (main.ts keeps only the window and
// server glue). No electron import: the file system, fetch and the service manager are injected.
import { join } from 'node:path';
import type { LiteImportPlan } from '@ezychat/shared';
import type { Product } from '../product.js';
import type { ServiceState } from '../service/windows.js';
import type { ServerCli } from './cli.js';
import type { LiteImportController, LiteImportDeps } from './controller.js';
import { chooseLiteFolder, liteFolders, litePorts } from './detect.js';

export interface LiteImportHostOptions {
  /** The product whose data is imported (activeProduct().adoptFrom); null turns the import off. */
  adoptFrom: Product | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** OS app-data folder (Electron `appData`). */
  appData: string;
  /** Our data folder. */
  dataDir: string;
  cli: ServerCli;
  /** The adopted product's OS service (status only); null where services are not supported. */
  liteService: { status(): Promise<ServiceState> } | null;
  /** probeServer(port, …, product) !== null */
  probe(port: number, product: Product): Promise<boolean>;
  /** Our server's loopback URL (for GET /api/setup/status). */
  serverUrl(): string;
  fetch: typeof globalThis.fetch;
  fs: {
    mtimeMs(path: string): number | null;
    readText(path: string): string | null;
    exists(path: string): boolean;
    freeBytes(dir: string): Promise<number | null>;
    /** A private temp folder; returns its path. */
    makeTempDir(): Promise<string>;
    writePrivate(file: string, text: string): Promise<void>;
    removeDir(dir: string): Promise<void>;
  };
  /** Our own server: stop for the import (throws when it is not ours to stop) and start again. */
  ownServer: {
    stop(): Promise<void>;
    restart(): Promise<boolean>;
    takeOverPort(port: number): void;
  };
  onChanged?: LiteImportDeps['onChanged'];
  log?: LiteImportDeps['log'];
}

export function liteImportDeps(o: LiteImportHostOptions): LiteImportDeps {
  const product = o.adoptFrom;
  const folders = product
    ? liteFolders(product, { platform: o.platform, env: o.env, appData: o.appData })
    : null;
  const serviceState = async (): Promise<ServiceState> =>
    o.liteService ? o.liteService.status() : 'not-installed';
  // Only a server this import stopped is started again (never a second server next to a service).
  let stopped = false;
  return {
    enabled: !!product,
    ownDataDir: o.dataDir,
    liteServiceState: serviceState,
    findLite: async () =>
      folders &&
      chooseLiteFolder(folders, {
        platform: o.platform,
        serviceInstalled: (await serviceState().catch(() => 'not-installed')) !== 'not-installed',
        fs: { mtimeMs: o.fs.mtimeMs },
      }),
    litePorts: () =>
      product && folders
        ? litePorts(product, folders, {
            platform: o.platform,
            env: o.env,
            readFile: o.fs.readText,
          })
        : [],
    liteAnswers: async (port) => !!product && (await o.probe(port, product)),
    ownHasData: async () => {
      if (!o.fs.exists(join(o.dataDir, 'app.db'))) return false;
      // A new install has an app.db but no account yet: that still takes the copy.
      try {
        const r = await o.fetch(`${o.serverUrl()}/api/setup/status`, {
          signal: AbortSignal.timeout(3000),
        });
        const body = (await r.json()) as { needsSetup?: unknown } | null;
        return body?.needsSetup !== true;
      } catch {
        return true;
      }
    },
    freeBytes: o.fs.freeBytes,
    cli: o.cli,
    writePlan: async (plan: LiteImportPlan) => {
      const dir = await o.fs.makeTempDir();
      const file = join(dir, 'plan.json');
      await o.fs.writePrivate(file, JSON.stringify(plan));
      return { file, dispose: () => o.fs.removeDir(dir) };
    },
    stopOwnServer: async () => {
      await o.ownServer.stop();
      stopped = true;
    },
    startOwnServer: async () => {
      if (!stopped) return true;
      stopped = false;
      return o.ownServer.restart();
    },
    takeOverPort: (port) => o.ownServer.takeOverPort(port),
    onChanged: o.onChanged,
    log: o.log,
  };
}

/** Writes the support file (counts and steps only) into `dir` and reveals it; false on error. */
export function saveSupportFile(
  controller: Pick<LiteImportController, 'supportReport'>,
  o: {
    dir: string;
    now: Date;
    meta: Record<string, string>;
    write(file: string, text: string): void;
    reveal(file: string): void;
    log?(message: string): void;
  },
): boolean {
  try {
    const file = join(
      o.dir,
      `ezychat-import-support-${o.now.toISOString().replace(/[:.]/g, '-')}.txt`,
    );
    o.write(file, controller.supportReport(o.meta));
    o.reveal(file);
    return true;
  } catch (error) {
    o.log?.(`[desktop] could not save the import support file: ${String(error)}`);
    return false;
  }
}
