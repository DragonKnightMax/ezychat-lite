// A data folder moved to EzyChat Enterprise (design: Lite → Enterprise §5.6). The import writes
// `<data>/moved.json` and renames the WhatsApp folders to `*.moved`, so this folder can never answer
// the same number again; the server refuses to start on it (exit 4) unless --ignore-moved.
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MovedMarker } from '@ezychat/shared';

export const MOVED_FILE = 'moved.json';
export const MOVED_SUFFIX = '.moved';
/** Inbox 1's WhatsApp folder. */
export const AUTH_DIR = 'wa-auth';
/** Parent of the other inboxes' WhatsApp folders (`wa-auth-inboxes/<id>`). */
export const AUTH_INBOXES_DIR = 'wa-auth-inboxes';

export function movedMarkerPath(dataDir: string): string {
  return join(dataDir, MOVED_FILE);
}

/** True when the folder carries the marker (even a damaged one: it still blocks the start). */
export function isMoved(dataDir: string): boolean {
  return existsSync(movedMarkerPath(dataDir));
}

/** The marker, or null when it is missing or unreadable. */
export function readMovedMarker(dataDir: string): MovedMarker | null {
  try {
    return MovedMarker.parse(JSON.parse(readFileSync(movedMarkerPath(dataDir), 'utf8')));
  } catch {
    return null;
  }
}

export function writeMovedMarker(dataDir: string, marker: MovedMarker): void {
  writeFileSync(movedMarkerPath(dataDir), `${JSON.stringify(MovedMarker.parse(marker))}\n`, {
    flag: 'wx',
  });
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The WhatsApp folders a hand-over renames, relative to the data folder (live names). */
export function authFolders(dataDir: string): string[] {
  const out: string[] = [];
  if (isDir(join(dataDir, AUTH_DIR))) out.push(AUTH_DIR);
  const inboxes = join(dataDir, AUTH_INBOXES_DIR);
  if (isDir(inboxes)) {
    for (const name of readdirSync(inboxes).sort()) {
      if (name.endsWith(MOVED_SUFFIX)) continue;
      if (isDir(join(inboxes, name))) out.push(`${AUTH_INBOXES_DIR}/${name}`);
    }
  }
  return out;
}

/** The moved WhatsApp folders (`wa-auth.moved`, `wa-auth-inboxes/<id>.moved`), live names. */
function movedFolders(dataDir: string): string[] {
  const out: string[] = [];
  if (isDir(join(dataDir, AUTH_DIR + MOVED_SUFFIX))) out.push(AUTH_DIR);
  const inboxes = join(dataDir, AUTH_INBOXES_DIR);
  if (isDir(inboxes)) {
    for (const name of readdirSync(inboxes).sort()) {
      if (!name.endsWith(MOVED_SUFFIX)) continue;
      if (isDir(join(inboxes, name)))
        out.push(`${AUTH_INBOXES_DIR}/${name.slice(0, -MOVED_SUFFIX.length)}`);
    }
  }
  return out;
}

export interface RestoreResult {
  /** The marker was there and is removed. */
  markerRemoved: boolean;
  /** Folders renamed back (live names). */
  restored: string[];
  /** Moved folders left as they are because a live folder of that name exists again. */
  kept: string[];
}

/**
 * "Use Lite again": renames every `*.moved` WhatsApp folder back and removes the marker last, so a
 * failure part-way leaves the folder still marked (the server keeps refusing it).
 */
export function restoreMoved(dataDir: string): RestoreResult {
  const restored: string[] = [];
  const kept: string[] = [];
  for (const rel of movedFolders(dataDir)) {
    const live = join(dataDir, rel);
    if (existsSync(live)) {
      kept.push(rel);
      continue;
    }
    renameSync(live + MOVED_SUFFIX, live);
    restored.push(rel);
  }
  const markerRemoved = isMoved(dataDir);
  if (markerRemoved) rmSync(movedMarkerPath(dataDir), { force: true });
  return { markerRemoved, restored, kept };
}
