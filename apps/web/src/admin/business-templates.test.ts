import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  AiAgentPreset,
  AI_AGENT_PRESETS,
  AI_HANDOFF_RULES_CHARACTERS,
  AI_INSTRUCTIONS_CHARACTERS,
  AiContextTextBody,
  type AgentTemplateCatalog,
  type AgentTemplateEntry,
} from '@ezychat/shared';
import en from '@/i18n/locales/en/admin.json';
import ms from '@/i18n/locales/ms/admin.json';
import zh from '@/i18n/locales/zh-CN/admin.json';
import { presetDefaults } from './ai-status';
import {
  BUSINESS_TEMPLATES,
  builtinTemplates,
  businessTemplate as fromTemplate,
  FALLBACK_ICON,
  galleryCategories,
  galleryTemplates,
  TEMPLATE_CATEGORIES,
  TEMPLATE_ICONS,
  templateIcon,
  templateMatches,
} from './business-templates';

/** A `t` that reads one catalog (the keys these templates use carry no interpolation). */
const tFor = (catalog: unknown) =>
  ((key: string) => {
    const value = key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog);
    if (typeof value !== 'string') throw new Error(`missing ${key}`);
    return value;
  }) as unknown as TFunction<'admin'>;

/** The app's own template `id` as Apply fills it. */
const businessTemplate = (id: string, t: TFunction<'admin'>) =>
  fromTemplate(
    builtinTemplates(t).find((tpl) => tpl.id === id)!,
    t,
  );

describe.each([
  ['en', en],
  ['ms', ms],
  ['zh-CN', zh],
])('business templates (%s)', (_lang, catalog) => {
  const t = tFor(catalog);

  it.each(BUSINESS_TEMPLATES.map((tpl) => tpl.id))('%s fits every limit and saves', (id) => {
    const tpl = businessTemplate(id, t);
    expect(tpl.agentName.length).toBeGreaterThan(0);
    expect(tpl.agentName.length).toBeLessThanOrEqual(64);
    expect(tpl.instructions.length).toBeLessThanOrEqual(AI_INSTRUCTIONS_CHARACTERS);
    expect(tpl.handoffRules.length).toBeLessThanOrEqual(AI_HANDOFF_RULES_CHARACTERS);
    // Starts from the tested text of its agent type.
    expect(tpl.instructions.startsWith(presetDefaults(tpl.preset, t).instructions)).toBe(true);
    expect(AiContextTextBody.safeParse(tpl.contextItem).success).toBe(true);
    // Fill-in lines are left blank, so the AI never repeats a placeholder as a fact.
    const lines = tpl.contextItem.text.split('\n').slice(2);
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(line).toMatch(/[:：]$/);
  });

  it('Claims is a group-only Custom agent: its own text only, recording to the Claims tab', () => {
    const tpl = businessTemplate('claims', t);
    expect(tpl.preset).toBe('custom');
    expect(tpl.groupAgent).toBe(true);
    // No sales or FAQ starting text: the role is the claims part alone.
    expect(tpl.instructions).toBe(t('ai.businessTemplates.claims.focus'));
    for (const preset of ['sales', 'faq'] as const) {
      const start = presetDefaults(preset, t).instructions.split('\n')[0]!;
      expect(tpl.instructions).not.toContain(start);
      expect(tpl.instructions).not.toContain(AI_AGENT_PRESETS[preset].instructions.split('\n')[0]);
    }
    // The sheet tab keeps its English name in every language (it must match the spreadsheet).
    expect(tpl.instructions).toMatch(/["“]Claims["”]/);
    expect(tpl.instructions).toContain('✅');
    expect(tpl.handoffRules.split('\n').length).toBeGreaterThanOrEqual(5);
    expect(tpl.contextItem.text.split('\n').length).toBeGreaterThanOrEqual(10);
    // The Business context item it names is the one it adds.
    expect(tpl.instructions).toContain(tpl.contextItem.name);
  });

  it('names no tool in any template text (tools describe themselves)', () => {
    for (const { id } of BUSINESS_TEMPLATES) {
      const tpl = businessTemplate(id, t);
      expect(`${tpl.instructions}\n${tpl.handoffRules}`).not.toMatch(/[a-z]+_[a-z]+_[a-z]+|_row\b/);
    }
  });

  it('has a name for every category, each with at least one template', () => {
    for (const category of TEMPLATE_CATEGORIES) {
      expect(t(`ai.businessTemplates.category.${category}`).length).toBeGreaterThan(0);
      expect(BUSINESS_TEMPLATES.some((tpl) => tpl.category === category)).toBe(true);
    }
  });
});

it('uses one known agent type per template', () => {
  for (const tpl of BUSINESS_TEMPLATES) expect(AiAgentPreset.options).toContain(tpl.preset);
});

it('makes only the Claims template a group agent', () => {
  expect(
    builtinTemplates(tFor(en))
      .filter((tpl) => tpl.groupAgent)
      .map((tpl) => tpl.id),
  ).toEqual(['claims']);
});

it('bundles every icon a built-in template names; an unknown name gets the neutral icon', () => {
  for (const tpl of BUSINESS_TEMPLATES) expect(Object.hasOwn(TEMPLATE_ICONS, tpl.icon)).toBe(true);
  expect(templateIcon('party-popper')).toBe(TEMPLATE_ICONS['party-popper']);
  expect(templateIcon('rocket-ship')).toBe(FALLBACK_ICON);
  expect(templateIcon('constructor')).toBe(FALLBACK_ICON);
});

describe('templates from the signed list', () => {
  const t = tFor(en);
  const listText = (name: string) => ({
    agentName: `${name} assistant`,
    name,
    description: `Answers for a ${name}.`,
    keywords: 'dewan hall',
    focus: `BUSINESS\nYou answer for a ${name}.`,
    handoffRules: '- The customer is upset',
    contextName: `${name} details`,
    contextText: 'Name:',
  });
  const entry = (id: string, extra: Partial<AgentTemplateEntry> = {}): AgentTemplateEntry => ({
    id,
    version: 2,
    schemaVersion: 1,
    minAppVersion: '0.1.0',
    editions: ['lite'],
    category: 'events',
    icon: 'party-popper',
    preset: 'sales',
    texts: { en: listText('Event venue'), ms: listText('Dewan acara') },
    ...extra,
  });
  const catalog = (entries: AgentTemplateEntry[]): AgentTemplateCatalog => ({
    status: { state: 'loaded', generatedAt: '2026-11-04T10:00:00.000Z', sequence: 3, checkedAt: 1 },
    categories: [
      { id: 'events', name: { en: 'Events', ms: 'Acara' } },
      { id: 'unused', name: { en: 'Unused' } },
      { id: 'health', name: { en: 'Never shown: the app names its own' } },
    ],
    templates: entries.map((e) => ({
      entry: e,
      connectors: [{ id: 'google-sheets', name: 'Google Sheets' }],
    })),
  });

  it('shows the app templates while there is no list', () => {
    const shown = galleryTemplates(t, 'en', undefined);
    expect(shown.map((tpl) => tpl.id)).toEqual(BUSINESS_TEMPLATES.map((tpl) => tpl.id));
    expect(shown.every((tpl) => tpl.source === 'app' && tpl.version === 1)).toBe(true);
  });

  it('adds new list templates in the admin language and replaces only higher versions', () => {
    const shown = galleryTemplates(
      t,
      'ms',
      catalog([
        entry('venue'),
        entry('clinic', { version: 1 }),
        entry('claims', {
          version: 2,
          preset: 'custom',
          defaults: { answerGroups: true, answerDirect: false },
        }),
      ]),
    );
    expect(shown).toHaveLength(BUSINESS_TEMPLATES.length + 1);
    expect(shown.find((tpl) => tpl.id === 'clinic')!.source).toBe('app');
    const claims = shown.find((tpl) => tpl.id === 'claims')!;
    expect(claims).toMatchObject({ source: 'list', version: 2, groupAgent: true });
    const venue = shown.at(-1)!;
    expect(venue).toMatchObject({ id: 'venue', source: 'list', connectors: ['Google Sheets'] });
    expect(venue.texts.name).toBe('Dewan acara');
    expect(venue.icon).toBe(TEMPLATE_ICONS['party-popper']);
    // Missing language: the whole English set.
    expect(galleryTemplates(t, 'zh-CN', catalog([entry('venue')])).at(-1)!.texts.name).toBe(
      'Event venue',
    );
  });

  it('Apply puts the agent type starting text in front of a list template too', () => {
    const venue = galleryTemplates(t, 'en', catalog([entry('venue')])).at(-1)!;
    const texts = fromTemplate(venue, t);
    expect(texts.instructions.startsWith(presetDefaults('sales', t).instructions)).toBe(true);
    expect(texts.instructions.endsWith('You answer for a Event venue.')).toBe(true);
    expect(texts.contextItem).toEqual({ name: 'Event venue details', text: 'Name:' });
    expect(texts.groupAgent).toBe(false);
  });

  it('adds a chip only for a list category a shown template uses', () => {
    const list = catalog([entry('venue')]);
    const shown = galleryTemplates(t, 'ms', list);
    const chips = galleryCategories(t, 'ms', list, shown);
    expect(chips.map((c) => c.id)).toEqual([...TEMPLATE_CATEGORIES, 'events']);
    expect(chips.at(-1)!.label).toBe('Acara');
    expect(chips[0]!.label).toBe(t('ai.businessTemplates.category.health'));
    expect(galleryCategories(t, 'en', undefined, builtinTemplates(t)).map((c) => c.id)).toEqual([
      ...TEMPLATE_CATEGORIES,
    ]);
  });

  it('searches the name, description and keywords of a list template', () => {
    const venue = galleryTemplates(t, 'en', catalog([entry('venue')])).at(-1)!;
    expect(templateMatches(venue, 'HALL venue')).toBe(true);
    expect(templateMatches(venue, '  ')).toBe(true);
    expect(templateMatches(venue, 'clinic')).toBe(false);
  });
});
