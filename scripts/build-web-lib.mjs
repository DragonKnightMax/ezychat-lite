#!/usr/bin/env node
// Builds the published @ezychat/web library into apps/web/dist-lib/:
//   index.js (+ chunks/)   ESM from src/index.ts (vite.lib.config.ts; dependencies stay imports)
//   ezychat-web.css        the precompiled Tailwind/theme CSS
//   types/                 .d.ts from tsconfig.lib.json, with the `@/` alias rewritten to relative paths
//   sw.ts, sw-routes.ts    the service worker source, for the consumer's vite-plugin-pwa (injectManifest);
//                          sw.ts imports ./sw-routes, so both ship side by side
//   public/                the app's public files (brand icons, favicon, share card, illustrations) that
//                          the UI loads from the site root; editions copy them into their web build
//                          (exported as "@ezychat/web/public/*")
// Requires @ezychat/shared to be built first (its dist .d.ts back the web declarations).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'apps', 'web');
const outDir = join(webDir, 'dist-lib');
const typesDir = join(outDir, 'types');
const require = createRequire(import.meta.url);

function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: webDir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rmSync(outDir, { recursive: true, force: true });
await build({ root: webDir, configFile: join(webDir, 'vite.lib.config.ts'), logLevel: 'warn' });
run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.lib.json']);

// tsc keeps path aliases verbatim; published declarations must use relative specifiers. It also
// keeps side-effect CSS imports, which mean nothing in a declaration (the CSS ships separately).
function rewriteAliases(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteAliases(full);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    const text = readFileSync(full, 'utf8');
    const next = text
      .replace(/^import\s+(['"])[^'"]+\.css\1;?\r?\n/gm, '')
      .replace(/(['"])@\/([^'"]+)\1/g, (_m, quote, target) => {
        let rel = relative(dirname(full), join(typesDir, target)).replaceAll('\\', '/');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        return `${quote}${rel}${quote}`;
      });
    if (next !== text) writeFileSync(full, next);
  }
}
rewriteAliases(typesDir);

// Library mode inlines every CSS asset as base64. The server CSP allows no `font-src data:`,
// so move the fonts back out into files next to the CSS (the consumer's bundler copies them).
const cssFile = join(outDir, 'ezychat-web.css');
let fonts = 0;
const css = readFileSync(cssFile, 'utf8').replace(
  /url\(\s*(['"]?)data:font\/(woff2?|ttf|otf);base64,([A-Za-z0-9+/=]+)\1\s*\)/g,
  (_m, _q, ext, data) => {
    const bytes = Buffer.from(data, 'base64');
    const name = `font-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${ext}`;
    mkdirSync(join(outDir, 'assets'), { recursive: true });
    writeFileSync(join(outDir, 'assets', name), bytes);
    fonts++;
    return `url(./assets/${name})`;
  },
);
writeFileSync(cssFile, css);
if (/url\(\s*['"]?data:font\//.test(css)) throw new Error('ezychat-web.css still inlines a font');
copyFileSync(join(webDir, 'src', 'sw.ts'), join(outDir, 'sw.ts'));
copyFileSync(join(webDir, 'src', 'sw-routes.ts'), join(outDir, 'sw-routes.ts'));
cpSync(join(webDir, 'public'), join(outDir, 'public'), { recursive: true });
console.log(`built ${relative(root, outDir)} (${fonts} font file(s))`);
