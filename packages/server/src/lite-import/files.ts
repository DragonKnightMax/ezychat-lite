// File helpers for the import: sizes and a copy with progress. Symbolic links are never followed or
// copied (a data folder has none; one planted there must not pull outside files into the copy).
import { copyFileSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Items of a data folder the copy takes (design §4); never logs, backups or the lock. */
export const COPIED_ITEMS = [
  'secret.key',
  'wa-auth',
  'wa-auth-inboxes',
  'media',
  'connectors',
  'models',
] as const;

/** Bytes of the regular files under a path (0 when missing). */
export function pathBytes(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const name of readdirSync(path)) total += pathBytes(join(path, name));
  return total;
}

/** Copies a file or folder tree; `onBytes` gets the size of each copied file. Returns the files copied. */
export function copyTree(src: string, dst: string, onBytes: (n: number) => void): number {
  let st;
  try {
    st = lstatSync(src);
  } catch {
    return 0;
  }
  if (st.isFile()) {
    copyFileSync(src, dst);
    onBytes(st.size);
    return 1;
  }
  if (!st.isDirectory()) return 0;
  mkdirSync(dst, { recursive: true });
  let files = 0;
  for (const name of readdirSync(src)) files += copyTree(join(src, name), join(dst, name), onBytes);
  return files;
}
