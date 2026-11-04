import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentTemplateEntry,
  AgentTemplateListFile,
  TEMPLATE_SIGNING_CONTEXT,
} from '@ezychat/shared';
import { DEFAULT_OUT, exportFiles, safeOutDir, writeExport } from './export-templates.mjs';
import { SCHEMA_ID, schemaText, templateSchema } from './template-schema.mjs';
import {
  SIGNING_CONTEXT,
  assemble,
  build,
  safePath,
} from '../docs/features/template-store/publisher/build-templates.mjs';
import en from '../apps/web/src/i18n/locales/en/admin.json' with { type: 'json' };

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-store-'));
  dirs.push(dir);
  return dir;
};

/** Exports the app templates and the schema into a temp folder. */
function workspace() {
  const dir = temp();
  writeExport(join(dir, 'templates'));
  writeFileSync(join(dir, 'template-v1.json'), schemaText());
  return dir;
}

/**
 * The publisher checks entries with ajv and the JSON Schema; this repository has no ajv 8 at its
 * root, so the tests check with the zod contract the schema is generated from.
 */
const zodValidate = (entry) => {
  const parsed = AgentTemplateEntry.safeParse(entry);
  return parsed.success ? [] : parsed.error.issues.map((i) => `/${i.path.join('/')} ${i.message}`);
};

const buildIn = (dir, extra = {}) =>
  build({
    validate: zodValidate,
    templates: join(dir, 'templates'),
    schema: join(dir, 'template-v1.json'),
    out: join(dir, 'dist'),
    sequence: 1,
    generatedAt: '2026-11-04T10:00:00.000Z',
    signingKey: null,
    ...extra,
  });

describe('template export and publisher build', () => {
  it('the schema is the contract entry, with the length limits', () => {
    const schema = templateSchema();
    expect(schema.$id).toBe(SCHEMA_ID);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.texts.properties.en.properties.focus.maxLength).toBe(4000);
  });

  it('builds a signed list the app accepts, with every built-in template unchanged', async () => {
    const dir = workspace();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(await buildIn(dir, { signingKey: pem })).toEqual({
      entries: 18,
      categories: 6,
      signed: true,
    });

    const bytes = readFileSync(join(dir, 'dist/templates-v1.json'));
    const sig = Buffer.from(
      readFileSync(join(dir, 'dist/templates-v1.json.sig'), 'utf8').trim(),
      'base64',
    );
    // The publisher and the app sign over the same prefix.
    expect(SIGNING_CONTEXT).toBe(TEMPLATE_SIGNING_CONTEXT);
    const signed = Buffer.concat([Buffer.from(TEMPLATE_SIGNING_CONTEXT), bytes]);
    expect(verify(null, signed, publicKey, sig)).toBe(true);
    expect(verify(null, bytes, publicKey, sig)).toBe(false);

    const file = AgentTemplateListFile.parse(JSON.parse(bytes.toString('utf8')));
    expect(file).toMatchObject({ catalog: 'templates', sequence: 1 });
    const entries = file.entries.map((e) => AgentTemplateEntry.parse(e));
    const claims = entries.find((e) => e.id === 'claims');
    expect(claims).toMatchObject({
      version: 1,
      preset: 'custom',
      icon: 'receipt-text',
      defaults: { answerGroups: true, answerDirect: false },
    });
    expect(claims.texts.en.focus).toBe(en.ai.businessTemplates.claims.focus);
    expect(claims.texts.en.contextText).toBe(en.ai.businessTemplates.claims.contextText);
    expect(Object.keys(claims.texts)).toEqual(['en', 'ms', 'zh-CN']);
  });

  it('refuses a folder with a wrong id, an unknown category, a missing file or a too long text', async () => {
    const dir = workspace();
    const tpl = (id) => join(dir, 'templates', id, 'template.json');
    const edit = (id, change) => {
      const meta = JSON.parse(readFileSync(tpl(id), 'utf8'));
      writeFileSync(tpl(id), JSON.stringify(change(meta)));
    };
    edit('clinic', (m) => ({ ...m, id: 'klinik' }));
    edit('dental', (m) => ({ ...m, category: 'teeth' }));
    rmSync(join(dir, 'templates/gym/ms/focus.md'));
    writeFileSync(join(dir, 'templates/vet/en/focus.md'), 'x'.repeat(4001));
    edit('salon', (m) => ({ ...m, texts: { ms: m.texts.ms } }));
    rmSync(join(dir, 'templates/bakery/zh-CN'), { recursive: true });
    edit('retail', (m) => ({ ...m, icon: 'Not An Icon' }));
    const message = await buildIn(dir).then(
      () => '',
      (err) => err.message,
    );
    expect(message).toContain('klinik');
    expect(message).toContain('must match the folder');
    expect(message).toContain('category "teeth" is not in categories.json');
    expect(message).toContain('gym: missing ms/focus.md');
    expect(message).toMatch(/vet: \/texts\/en\/focus .*4000/);
    expect(message).toContain('salon: English texts are required');
    expect(message).toContain('bakery: zh-CN needs both texts');
    expect(message).toMatch(/retail: \/icon /);
    expect(readdirSync(dir)).not.toContain('dist');
  });

  it('refuses a bad sequence and duplicate or bad categories', async () => {
    const dir = workspace();
    await expect(buildIn(dir, { sequence: 0 })).rejects.toThrow(/sequence/);
    const path = join(dir, 'templates/categories.json');
    const categories = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify([...categories, categories[0], { id: 'Bad id' }]));
    expect(assemble(join(dir, 'templates')).problems).toEqual([
      'categories.json: health twice',
      'categories.json: bad category "Bad id"',
    ]);
  });

  it('writes and reads only inside the repository or the temp folder', () => {
    expect(() => safeOutDir('/etc/ezychat')).toThrow(/refusing/);
    // A path that climbs out of the working folder is still fine inside the temp folder.
    expect(() => safePath('../outside', join(tmpdir(), 'x'))).not.toThrow();
    expect(() => safePath('/etc/passwd', process.cwd())).toThrow(/refusing/);
  });

  it('the sample folder for the publishing repo matches the app templates (run npm run templates:export)', () => {
    const files = exportFiles();
    const list = (dir, base = dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? list(join(dir, d.name), base) : [relative(base, join(dir, d.name))],
      );
    const committed = list(DEFAULT_OUT).map((p) => p.split('\\').join('/'));
    expect(committed.sort()).toEqual(Object.keys(files).sort());
    for (const [path, text] of Object.entries(files))
      expect(readFileSync(join(DEFAULT_OUT, path), 'utf8'), path).toBe(text);
  });
});
