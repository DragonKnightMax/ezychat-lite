// npm pack contract for the published @ezychat/* core packages: each tarball ships its build
// (dist, migrations, CSS) and never source, tests, local data or secrets. Packages that have not
// been built yet are built first (scripts/build-package.mjs, scripts/build-web-lib.mjs,
// apps/desktop/scripts/build.mjs).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const PACKAGES = [
  {
    name: '@ezychat/shared',
    dir: 'packages/shared',
    built: 'dist/index.js',
    build: ['node', 'scripts/build-package.mjs', 'packages/shared'],
    required: ['dist/index.js', 'dist/index.d.ts', 'dist/desktop-updates.d.ts'],
  },
  {
    name: '@ezychat/wa',
    dir: 'packages/wa',
    built: 'dist/index.js',
    build: ['node', 'scripts/build-package.mjs', 'packages/wa'],
    required: ['dist/index.js', 'dist/index.d.ts', 'dist/fake/fake-adapter.js'],
  },
  {
    name: '@ezychat/server',
    dir: 'packages/server',
    built: 'dist/index.js',
    build: ['node', 'scripts/build-package.mjs', 'packages/server'],
    required: [
      'dist/index.js',
      'dist/index.d.ts',
      'dist/run-cli.js',
      'dist/extensions.d.ts',
      'dist/ai/document-worker.js',
      'dist/voice/transcribe-worker.js',
      // Data imported by the connector list (tsc copies imported JSON).
      'dist/connectors/list/builtin-list.json',
      ...readdirSync(join(root, 'packages/server/src/db/migrations'))
        .filter((f) => f.endsWith('.sql'))
        .map((f) => `dist/db/migrations/${f}`),
    ],
  },
  {
    name: '@ezychat/web',
    dir: 'apps/web',
    built: 'dist-lib/index.js',
    build: ['node', 'scripts/build-web-lib.mjs'],
    required: [
      'dist-lib/index.js',
      'dist-lib/types/index.d.ts',
      'dist-lib/ezychat-web.css',
      'dist-lib/sw.ts',
      'dist-lib/sw-routes.ts',
      'dist-lib/public/icon-192.png',
      'dist-lib/public/icon-512.png',
      'dist-lib/public/badge-96.png',
      'dist-lib/public/favicon.ico',
      'dist-lib/public/apple-touch-icon.png',
      'dist-lib/public/share-app.svg',
    ],
  },
  {
    name: '@ezychat/desktop',
    dir: 'apps/desktop',
    built: 'dist/index.js',
    build: ['node', 'apps/desktop/scripts/build.mjs'],
    required: [
      'dist/index.js',
      'dist/index.d.ts',
      'dist/main.js',
      'dist/server-host.cjs',
      'dist/preload.cjs',
      'dist/inbox-preload.cjs',
      'dist/renderer/status.html',
      'dist/renderer/status.js',
      'dist/renderer/status.css',
      'dist/locales/en.json',
      'scripts/fetch-common.mjs',
      'scripts/fetch-cloudflared.mjs',
      'scripts/fetch-winsw.mjs',
    ],
    // The server bundle belongs to each edition's app, not to the shell package.
    forbidden: [/^dist\/server\//, /^dist\/package\.json$/],
  },
];

/** Paths that must never be published. */
const FORBIDDEN = [
  /^src\//,
  /^test\//,
  /(^|\/)[^/]+\.test\.[^/]+$/,
  /(^|\/)\.env/,
  /(^|\/)data\//,
  /(^|\/)wa-auth\//,
  /(^|\/)secret\.key$/,
  /\.(db|sqlite|log|pem|key|tsbuildinfo|map)$/,
  /(^|\/)node_modules\//,
  /^dist\/(index\.html|sw\.js)$/, // the web app build (apps/web/dist) is not part of the library
];

// Commands are fixed literals; npm is a .cmd shim on Windows, so it runs through the shell.
function run(cmd, args) {
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const r =
    cmd === 'node'
      ? spawnSync(process.execPath, args, options)
      : spawnSync([cmd, ...args].join(' '), { ...options, shell: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
}

describe.each(PACKAGES)('npm pack $name', (pkg) => {
  let files = [];
  let manifest;

  beforeAll(() => {
    if (!existsSync(join(root, pkg.dir, pkg.built))) {
      if (pkg.name === '@ezychat/web' && !existsSync(join(root, 'packages/shared/dist/index.d.ts')))
        run('node', ['scripts/build-package.mjs', 'packages/shared']);
      run(pkg.build[0], pkg.build.slice(1));
    }
    const out = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '-w', pkg.name]);
    const [result] = JSON.parse(out.slice(out.indexOf('[')));
    files = result.files.map((f) => f.path.replaceAll('\\', '/'));
    manifest = JSON.parse(readFileSync(join(root, pkg.dir, 'package.json'), 'utf8'));
  }, 300_000);

  it('ships the build output', () => {
    expect(files).toContain('package.json');
    for (const file of pkg.required) expect(files).toContain(file);
  });

  it('ships no source, tests, local data or secrets', () => {
    const forbidden = [...FORBIDDEN, ...(pkg.forbidden ?? [])];
    const leaked = files.filter((f) => forbidden.some((re) => re.test(f)));
    expect(leaked).toEqual([]);
  });

  it('is publishable and points its exports at shipped files', () => {
    expect(manifest.private).toBeUndefined();
    expect(manifest.license).toBe('MIT');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.repository?.url).toContain('ossmalaysia/ezychat-lite');
    const entry = manifest.exports['.'];
    expect(Object.keys(entry)[0]).toBe('ezychat-source');
    for (const target of [entry.types, entry.default])
      expect(files).toContain(target.replace(/^\.\//, ''));
    for (const target of Object.values(manifest.bin ?? {}))
      expect(files).toContain(target.replace(/^\.\//, ''));
  });

  it('depends on the other core packages at exactly this version', () => {
    const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
    for (const [name, range] of Object.entries(deps))
      if (name.startsWith('@ezychat/')) expect(`${name}@${range}`).toBe(`${name}@${version}`);
  });
});

it('ships the web fonts as files, not inlined into the CSS (the server CSP has no font-src data:)', () => {
  const css = readFileSync(join(root, 'apps/web/dist-lib/ezychat-web.css'), 'utf8');
  expect(css).not.toMatch(/url\(\s*['"]?data:font\//);
  const fonts = [...css.matchAll(/url\(\.\/(assets\/font-[^)]+)\)/g)].map((m) => m[1]);
  expect(fonts.length).toBeGreaterThan(0);
  for (const font of fonts) expect(existsSync(join(root, 'apps/web/dist-lib', font))).toBe(true);
});
