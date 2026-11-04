// Builds index.html (the template store preview, cloned from the claims-template preview) from the
// real admin catalogs, so the preview shows exactly the texts the app shows. Run from the repository root:
//   node docs/features/template-store/mock/build-preview.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');
const pick = (lang) => {
  const admin = JSON.parse(
    readFileSync(join(root, `apps/web/src/i18n/locales/${lang}/admin.json`), 'utf8'),
  );
  const bt = admin.ai.businessTemplates;
  const names = Object.fromEntries(
    ['clinic', 'insurance', 'tuition', 'retail', 'claims'].map((id) => [id, bt[id]]),
  );
  return {
    bt: Object.fromEntries(Object.entries(bt).filter(([, v]) => typeof v === 'string')),
    category: bt.category,
    source: bt.source,
    worksWith: bt.worksWith,
    templates: names,
    presets: admin.ai.presets,
    ui: {
      name: admin.ai.agents.nameLabel,
      newAgent: admin.ai.agents.newTitle,
      role: admin.ai.agents.roleLabel,
      handoff: admin.ai.agents.handoffTitle,
      create: admin.ai.agents.create,
      save: admin.ai.agents.save,
      cancel: admin.ai.contextPanel.cancel,
      pick: admin.ai.agents.pickTitle,
      context: admin.ai.page.stepContext,
      direct: admin.aiDirect.title,
      directSwitch: admin.aiDirect.switch,
      groups: admin.aiGroups.title,
      groupsSwitch: admin.aiGroups.switch,
    },
  };
};
const texts = { en: pick('en'), ms: pick('ms'), 'zh-CN': pick('zh-CN') };
const template = readFileSync(join(here, 'preview.template.html'), 'utf8');
const html = template.replace(
  '/*TEXTS*/',
  `const TEXTS = ${JSON.stringify(texts).replaceAll('</', '<\\/')};`,
);
writeFileSync(join(here, 'index.html'), html);
// Keep the generated page in the repository's Prettier style (CI checks every file).
execFileSync('npx', ['prettier', '--write', join(here, 'index.html')], {
  cwd: root,
  stdio: 'ignore',
});
process.stdout.write('index.html written\n');
