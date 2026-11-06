import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const sourceRevision = '643a724b756a127361ea8ac61037f8dd87c628ff'; // app revision of the first baseline snapshot
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.html', '.json', '.css', '.svg']);
const hash = (path, bytes) =>
  createHash('sha256')
    .update(
      textExtensions.has(extname(path)) ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes,
    )
    .digest('hex');
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(await readFile(join(here, 'reference.json'), 'utf8'));
  const deltas = manifest.allowedDelta ?? [];
  for (const file of manifest.files) {
    if (
      !deltas.includes(file.path) &&
      hash(file.path, await readFile(join(here, file.path))) !== file.sha256
    )
      throw new Error(`Frozen reference drift: ${file.path}`);
    if (
      process.argv.includes('--compare-app') &&
      hash(file.source, await readFile(join(root, file.source))) !== file.sha256
    )
      throw new Error(`App source drift: ${file.source}`);
  }
  // Files inherited from the confirmed baseline mock that this proposal must not change.
  for (const file of manifest.inheritedUnchanged ?? [])
    if (hash(file.path, await readFile(join(here, file.path))) !== file.sha256)
      throw new Error(`Inherited baseline drift: ${file.path}`);
  for (const path of manifest.addedFrontend ?? []) await readFile(join(here, path));
  console.log(
    `Verified ${manifest.files.length - deltas.length} unchanged frontend files; ${deltas.length} intentional deltas (${manifest.proposalChanged?.length ?? 0} in this proposal); ${manifest.inheritedUnchanged?.length ?? 0} inherited baseline files unchanged; ${manifest.addedFrontend?.length ?? 0} added files present.`,
  );
} else {
  const files = [];
  async function snapshot(source, target) {
    const destination = resolve(here, target);
    if (!destination.startsWith(here + sep))
      throw new Error('Snapshot target escaped the mock folder.');
    const bytes = await readFile(join(root, source));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, source), destination);
    files.push({ path: target.replaceAll(sep, '/'), source, sha256: hash(target, bytes) });
  }
  async function walk(source, target) {
    for (const entry of await readdir(join(root, source), { withFileTypes: true })) {
      if (/\.test\.[jt]sx?$/.test(entry.name)) continue;
      if (entry.isDirectory()) await walk(`${source}/${entry.name}`, `${target}/${entry.name}`);
      else await snapshot(`${source}/${entry.name}`, `${target}/${entry.name}`);
    }
  }
  await snapshot('apps/web/index.html', 'index.html');
  await walk('apps/web/src', 'src');
  await walk('apps/web/public', 'public');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(
    join(here, 'reference.json'),
    JSON.stringify(
      {
        sourceRevision,
        appVersion: pkg.version,
        hashNormalization: 'text LF; binary unchanged',
        status: 'owner-confirmation-pending',
        createdAt: '2026-10-14',
        files,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Copied ${files.length} existing frontend files into ${relative(root, here)}.`);
}
