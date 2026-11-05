#!/usr/bin/env node
// Writes the app's own AI agent templates (apps/web/src/admin/business-templates-data.ts + the
// catalog texts ai.businessTemplates.<id>.* in en, ms, zh-CN) in the publishing repo's folder format
// (docs/features/template-store/publisher/README.md):
//   <out>/categories.json
//   <out>/<id>/template.json            id, version, category, icon, preset, defaults, sheet, short texts
//   <out>/<id>/<lang>/focus.md          business part of the role
//   <out>/<id>/<lang>/handoff-rules.md
//   <out>/<id>/<lang>/context.md        the Business context item's text
//
// Run from the repository root (tsx reads the TypeScript data module):
//   npm run templates:export -- [<out dir>]   (default docs/features/template-store/publisher/templates)
// The out dir must be inside this repository or the system temp folder.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUSINESS_TEMPLATES,
  TEMPLATE_CATEGORIES,
} from '../apps/web/src/admin/business-templates-data.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LANGUAGES = ['en', 'ms', 'zh-CN'];
/** The first app version that reads the template list. */
export const FIRST_LIST_APP_VERSION = '0.1.75';
export const DEFAULT_OUT = join(ROOT, 'docs/features/template-store/publisher/templates');

/** Resolves `dir` and accepts it only inside the repository or the temp folder. */
export function safeOutDir(dir) {
  const full = resolve(ROOT, dir);
  const inside = (base) => {
    const rel = relative(base, full);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  if (!inside(ROOT) && !inside(resolve(tmpdir())))
    throw new Error(`refusing to write outside the repository or the temp folder: ${full}`);
  return full;
}

const catalog = (lang) =>
  JSON.parse(readFileSync(join(ROOT, `apps/web/src/i18n/locales/${lang}/admin.json`), 'utf8')).ai
    .businessTemplates;

/** The folder contents as { relative path: text }, so tests can compare without writing. */
export function exportFiles() {
  const catalogs = Object.fromEntries(LANGUAGES.map((lang) => [lang, catalog(lang)]));
  const files = {};
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  files['categories.json'] = json(
    TEMPLATE_CATEGORIES.map((id) => ({
      id,
      name: Object.fromEntries(LANGUAGES.map((lang) => [lang, catalogs[lang].category[id]])),
    })),
  );
  for (const tpl of BUSINESS_TEMPLATES) {
    const texts = Object.fromEntries(
      LANGUAGES.map((lang) => {
        const t = catalogs[lang][tpl.id];
        return [
          lang,
          {
            agentName: t.agentName,
            name: t.name,
            description: t.description,
            keywords: t.keywords,
            contextName: t.contextName,
          },
        ];
      }),
    );
    files[`${tpl.id}/template.json`] = json({
      id: tpl.id,
      version: 1,
      schemaVersion: 1,
      minAppVersion: FIRST_LIST_APP_VERSION,
      editions: ['lite', 'enterprise'],
      category: tpl.category,
      icon: tpl.icon,
      preset: tpl.preset,
      ...('defaults' in tpl ? { defaults: tpl.defaults } : {}),
      ...('sheet' in tpl ? { sheet: tpl.sheet } : {}),
      texts,
    });
    for (const lang of LANGUAGES) {
      const t = catalogs[lang][tpl.id];
      files[`${tpl.id}/${lang}/focus.md`] = `${t.focus}\n`;
      files[`${tpl.id}/${lang}/handoff-rules.md`] = `${t.handoffRules}\n`;
      files[`${tpl.id}/${lang}/context.md`] = `${t.contextText}\n`;
    }
  }
  return files;
}

/** Replaces `out` with the exported folder. */
export function writeExport(out) {
  const dir = safeOutDir(out);
  rmSync(dir, { recursive: true, force: true });
  const files = exportFiles();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, count: Object.keys(files).length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { dir, count } = writeExport(process.argv[2] ?? DEFAULT_OUT);
  process.stdout.write(`${count} files written to ${relative(ROOT, dir) || dir}\n`);
}
