#!/usr/bin/env node
// Downloads the pinned cloudflared release into resources/cloudflared/<platform>-<arch>/ and
// verifies its SHA-256. <platform>-<arch> uses Node's names (win32-x64, darwin-x64,
// darwin-arm64, linux-x64) so the server's resolver and electron-builder's ${arch} agree.
//
// Usage: node apps/desktop/scripts/fetch-cloudflared.mjs [--target win32-x64] [--target ...] [--current]
//          [--force] [--out <resources dir>]
//   default targets: win32-x64, darwin-x64, darwin-arm64; default --out: the repository's resources/.
//   Published as the `ezychat-fetch-cloudflared` bin of @ezychat/desktop.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_RESOURCES, download } from './fetch-common.mjs';

export const CLOUDFLARED_VERSION = '2026.9.3';

const BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

/** asset + sha256 published by GitHub for release CLOUDFLARED_VERSION */
const TARGETS = {
  'win32-x64': {
    asset: 'cloudflared-windows-amd64.exe',
    sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2',
    bin: 'cloudflared.exe',
    archive: false,
  },
  'darwin-x64': {
    asset: 'cloudflared-darwin-amd64.tgz',
    sha256: 'd1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977',
    bin: 'cloudflared',
    archive: true,
  },
  'darwin-arm64': {
    asset: 'cloudflared-darwin-arm64.tgz',
    sha256: '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095',
    bin: 'cloudflared',
    archive: true,
  },
  'linux-x64': {
    asset: 'cloudflared-linux-amd64',
    sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2',
    bin: 'cloudflared',
    archive: false,
  },
};
const DEFAULT_TARGETS = ['win32-x64', 'darwin-x64', 'darwin-arm64'];

/** Extracts one regular file (by basename) from an uncompressed ustar/GNU tar buffer. */
export function extractFromTar(tar, wantedBase) {
  let off = 0;
  let longName = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (s, e) => header.subarray(s, e).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix && header.subarray(257, 262).toString() === 'ustar') name = `${prefix}/${name}`;
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
    } else {
      const full = longName ?? name;
      longName = null;
      if ((type === '0' || type === '\0') && full.split('/').pop() === wantedBase)
        return Buffer.from(data);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wantedBase} not found in archive`);
}

export function parseArgs(argv) {
  const targets = [];
  let force = false;
  let resources = DEFAULT_RESOURCES;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--out') resources = resolve(argv[++i] ?? '');
    else if (a.startsWith('--out=')) resources = resolve(a.slice('--out='.length));
    else if (a === '--current') targets.push(`${process.platform}-${process.arch}`);
    else if (a === '--target') targets.push(argv[++i]);
    else if (a.startsWith('--target=')) targets.push(a.slice('--target='.length));
    else if (a === '--all') targets.push(...Object.keys(TARGETS));
    else throw new Error(`unknown argument ${a}`);
  }
  return { targets: targets.length ? [...new Set(targets)] : DEFAULT_TARGETS, force, resources };
}

async function fetchTarget(target, force, resources) {
  const t = TARGETS[target];
  if (!t)
    throw new Error(`unsupported target ${target} (known: ${Object.keys(TARGETS).join(', ')})`);
  const dir = join(resources, 'cloudflared', target);
  const out = join(dir, t.bin);
  const stamp = join(dir, 'cloudflared.version');
  if (
    !force &&
    existsSync(out) &&
    existsSync(stamp) &&
    readFileSync(stamp, 'utf8').trim() === CLOUDFLARED_VERSION
  ) {
    console.log(`cloudflared ${CLOUDFLARED_VERSION} ${target}: up to date`);
    return;
  }
  console.log(`cloudflared ${CLOUDFLARED_VERSION} ${target}: downloading ${t.asset}`);
  const buf = await download(`${BASE}/${t.asset}`);
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== t.sha256)
    throw new Error(`checksum mismatch for ${t.asset}: got ${digest}, expected ${t.sha256}`);
  const bin = t.archive ? extractFromTar(gunzipSync(buf), 'cloudflared') : buf;
  mkdirSync(dir, { recursive: true });
  const tmp = `${out}.download`;
  writeFileSync(tmp, bin);
  if (process.platform !== 'win32' || !t.bin.endsWith('.exe')) chmodSync(tmp, 0o755);
  rmSync(out, { force: true });
  renameSync(tmp, out);
  writeFileSync(stamp, `${CLOUDFLARED_VERSION}\n`);
  console.log(`  -> ${out} (${(bin.length / 1024 / 1024).toFixed(1)} MB)`);
}

// Real paths: an npm bin is a symlink (node_modules/.bin/ezychat-fetch-cloudflared) on macOS/Linux.
const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    const { targets, force, resources } = parseArgs(process.argv.slice(2));
    for (const target of targets) await fetchTarget(target, force, resources);
  } catch (err) {
    console.error(`fetch-cloudflared: ${err.message}`);
    process.exit(1);
  }
}
