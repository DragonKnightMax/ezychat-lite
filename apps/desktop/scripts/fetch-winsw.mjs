#!/usr/bin/env node
// Downloads the pinned WinSW release (Windows service wrapper) into <resources>/winsw/WinSW-x64.exe
// and verifies its SHA-256. Usage: node apps/desktop/scripts/fetch-winsw.mjs [--force] [--out <resources dir>]
// Default --out: the repository's resources/. Published as the `ezychat-fetch-winsw` bin of @ezychat/desktop.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RESOURCES, download } from './fetch-common.mjs';

export const WINSW_VERSION = '2.12.0';
const URL_X64 = `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe`;
const SHA256_X64 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da';

/** Reads --force and --out from the arguments; anything else is refused. */
export function parseArgs(argv) {
  let force = false;
  let resources = DEFAULT_RESOURCES;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--out') resources = resolve(argv[++i] ?? '');
    else if (a.startsWith('--out=')) resources = resolve(a.slice('--out='.length));
    else throw new Error(`unknown argument ${a}`);
  }
  return { force, out: join(resources, 'winsw', 'WinSW-x64.exe') };
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

// Real paths: an npm bin is a symlink (node_modules/.bin/ezychat-fetch-winsw) on macOS/Linux.
const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    const { force, out } = parseArgs(process.argv.slice(2));
    if (!force && existsSync(out) && sha(readFileSync(out)) === SHA256_X64) {
      console.log(`WinSW ${WINSW_VERSION}: up to date`);
    } else {
      console.log(`WinSW ${WINSW_VERSION}: downloading WinSW-x64.exe`);
      const buf = await download(URL_X64);
      const digest = sha(buf);
      if (digest !== SHA256_X64)
        throw new Error(`checksum mismatch: got ${digest}, expected ${SHA256_X64}`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(`${out}.download`, buf);
      rmSync(out, { force: true });
      renameSync(`${out}.download`, out);
      console.log(`  -> ${out}`);
    }
  } catch (err) {
    console.error(`fetch-winsw: ${err.message}`);
    process.exit(1);
  }
}
