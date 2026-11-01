// Finds the data of the product this one adopts from (design §5.1): Lite's machine folder (service
// mode) and its per-user folder (standalone), from `adoptFrom` (appDirName / profileDirName), never
// from literals. Pure: no electron import; the file system is injected.
import { posix, win32 } from 'node:path';
import { DEFAULT_PORT, machineDataDir, parseDesktopConfig, servicePortFile } from '../paths.js';
import type { Product } from '../product.js';
import { parsePortFile } from '../startup.js';

export interface LiteFolders {
  /** Service mode: C:\ProgramData\<appDirName>, /Library/Application Support/<appDirName>. */
  machine: string;
  /** Standalone: <appData>/<profileDirName>/data. */
  user: string;
  /** Lite's Electron profile (desktop.json, server-port.json). */
  profile: string;
}

export interface LiteLocation {
  dataDir: string;
  kind: 'machine' | 'user';
  /** Lite's Electron profile folder. */
  profile: string;
}

function pathFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/** Where Lite keeps its data on this OS. `appData` is the OS app-data folder (Electron `appData`). */
export function liteFolders(
  product: Product,
  o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; appData: string },
): LiteFolders {
  const path = pathFor(o.platform);
  const profile = path.join(o.appData, product.profileDirName);
  return {
    machine: machineDataDir(o.platform, o.env, product),
    user: path.join(profile, 'data'),
    profile,
  };
}

export interface DetectFs {
  /** mtime of a file in ms, or null when it does not exist. */
  mtimeMs(path: string): number | null;
}

/**
 * The Lite data folder to import, or null. A folder counts only with an app.db. When both exist, the
 * machine folder wins while Lite's service is installed (that is the folder it runs on), else the one
 * with the newer app.db.
 */
export function chooseLiteFolder(
  folders: LiteFolders,
  o: { platform: NodeJS.Platform; serviceInstalled: boolean; fs: DetectFs },
): LiteLocation | null {
  const path = pathFor(o.platform);
  const machine = o.fs.mtimeMs(path.join(folders.machine, 'app.db'));
  const user = o.fs.mtimeMs(path.join(folders.user, 'app.db'));
  const at = (kind: 'machine' | 'user'): LiteLocation => ({
    dataDir: kind === 'machine' ? folders.machine : folders.user,
    kind,
    profile: folders.profile,
  });
  if (machine === null && user === null) return null;
  if (machine === null) return at('user');
  if (user === null) return at('machine');
  if (o.serviceInstalled) return at('machine');
  return machine > user ? at('machine') : at('user');
}

/**
 * Ports Lite may answer on, most likely first: its desktop.json (the desktop keeps the port the server
 * really uses there), the port files its server host writes (standalone and service), then the
 * product's default. Duplicates removed.
 */
export function litePorts(
  product: Product,
  folders: LiteFolders,
  o: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    readFile: (path: string) => string | null;
  },
): number[] {
  const path = pathFor(o.platform);
  const fallback = product.defaultPort ?? DEFAULT_PORT;
  const desktop = o.readFile(path.join(folders.profile, 'desktop.json'));
  const ports = [
    desktop ? parseDesktopConfig(desktop, fallback).port : null,
    parsePortFile(o.readFile(path.join(folders.profile, 'server-port.json'))),
    parsePortFile(o.readFile(servicePortFile(o.platform, o.env, product))),
    fallback,
  ];
  return [...new Set(ports.filter((p): p is number => p !== null))];
}
