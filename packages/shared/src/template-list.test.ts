import { describe, expect, it } from 'vitest';
import { AI_AGENT_PRESETS, AI_INSTRUCTIONS_CHARACTERS } from './ai.js';
import { SHEET_CELL } from './google-sheets.js';
import {
  AgentTemplateEntry,
  AgentTemplateListFile,
  TEMPLATE_FOCUS_CHARACTERS,
  agentTemplateCategoryName,
  agentTemplateFits,
  agentTemplateTexts,
  cleanAgentTemplateText,
  cleanAgentTemplateValue,
  mergeAgentTemplates,
} from './template-list.js';

const texts = (name: string) => ({
  agentName: `${name} assistant`,
  name,
  description: 'd',
  focus: 'f',
  handoffRules: 'h',
  contextName: 'c',
  contextText: 'Name:',
});
const entry = (extra: Record<string, unknown> = {}) =>
  AgentTemplateEntry.parse({
    id: 'venue',
    version: 2,
    schemaVersion: 1,
    minAppVersion: '0.1.75',
    editions: ['lite'],
    category: 'events',
    icon: 'party-popper',
    preset: 'sales',
    texts: { en: texts('Venue'), ms: texts('Dewan') },
    ...extra,
  });

describe('agent template contract', () => {
  it('fills keywords with an empty string and keeps camelCase ids of the built-ins', () => {
    const parsed = entry({ id: 'carWorkshop' });
    expect(parsed.id).toBe('carWorkshop');
    expect(parsed.texts.en.keywords).toBe('');
  });

  it('falls back to the whole English set for a missing language', () => {
    const parsed = entry();
    expect(agentTemplateTexts(parsed, 'ms').name).toBe('Dewan');
    expect(agentTemplateTexts(parsed, 'ms-MY').name).toBe('Dewan');
    expect(agentTemplateTexts(parsed, 'zh-CN').name).toBe('Venue');
    expect(agentTemplateTexts(parsed, 'zh').name).toBe('Venue');
    expect(agentTemplateTexts(parsed, 'en-GB').name).toBe('Venue');
    const zh = entry({ texts: { en: texts('Venue'), 'zh-CN': texts('场地') } });
    expect(agentTemplateTexts(zh, 'zh-TW').name).toBe('场地');
    expect(agentTemplateTexts(zh, 'ms').name).toBe('Venue');
  });

  it('names a category in the language with English as the fallback', () => {
    const category = { id: 'events', name: { en: 'Events', 'zh-CN': '活动' } };
    expect(agentTemplateCategoryName(category, 'zh-CN')).toBe('活动');
    expect(agentTemplateCategoryName(category, 'ms')).toBe('Events');
    expect(
      agentTemplateCategoryName({ ...category, name: { en: 'Events', ms: 'Acara' } }, 'ms'),
    ).toBe('Acara');
    expect(agentTemplateCategoryName(category, 'en')).toBe('Events');
  });

  it('fits only a known schema, a new enough app and the edition', () => {
    const lite = { version: '0.1.75', edition: 'lite' };
    expect(agentTemplateFits(entry(), lite)).toBe(true);
    expect(agentTemplateFits(entry(), { version: '0.1.74', edition: 'lite' })).toBe(false);
    expect(agentTemplateFits(entry(), { version: '0.1.75', edition: 'enterprise' })).toBe(false);
    expect(agentTemplateFits({ ...entry(), schemaVersion: 2 as 1 }, lite)).toBe(false);
  });

  it('cleans control, bidi and byte-order-mark characters but keeps emoji and Chinese', () => {
    expect(cleanAgentTemplateText('a\u202Eb\u2066c\u0000d\u200Ee\uFEFF\r\nf\rg\th')).toBe(
      'abcde\nf\ng\th',
    );
    expect(cleanAgentTemplateText('Recorded ✅ 已记录 👍🏽')).toBe('Recorded ✅ 已记录 👍🏽');
  });

  it('cleans every string inside a raw value and leaves other values alone', () => {
    expect(
      cleanAgentTemplateValue({ a: ['x\u202Ey', { b: 'z\u0000' }], n: 1, t: true, none: null }),
    ).toEqual({ a: ['xy', { b: 'z' }], n: 1, t: true, none: null });
  });

  it('keeps the business part short enough for every starting text', () => {
    for (const preset of Object.values(AI_AGENT_PRESETS))
      expect(preset.instructions.length + 2 + TEMPLATE_FOCUS_CHARACTERS).toBeLessThanOrEqual(
        AI_INSTRUCTIONS_CHARACTERS,
      );
  });

  it('takes an optional Google Sheets layout, checked like the create route', () => {
    expect(entry().sheet).toBeUndefined();
    const sheet = {
      name: 'Claims',
      tabs: [
        {
          title: 'Claims',
          columns: ['Date', 'Amount'],
          access: 'add',
          formulas: [{ cell: 'C2', formula: '=SUM(B2:B1000)' }],
        },
        { title: 'Notes', columns: ['Note'] },
      ],
    };
    const parsed = entry({ sheet });
    expect(parsed.sheet?.tabs[1]).toEqual({ title: 'Notes', columns: ['Note'], access: 'off' });
    for (const bad of [
      { ...sheet, tabs: [] },
      { ...sheet, tabs: [sheet.tabs[1], sheet.tabs[1]] },
      { ...sheet, tabs: [{ ...sheet.tabs[0], formulas: [{ cell: 'C1', formula: '=1' }] }] },
      { ...sheet, tabs: [{ ...sheet.tabs[0], formulas: [{ cell: 'AA2', formula: '=1' }] }] },
      { ...sheet, tabs: [{ ...sheet.tabs[0], formulas: [{ cell: 'C2', formula: 'SUM(1)' }] }] },
    ])
      expect(() => entry({ sheet: bad })).toThrow();
    expect(SHEET_CELL.test('Z1000')).toBe(true);
    expect(SHEET_CELL.test('A1001')).toBe(false);
  });

  it('a list file needs the templates catalog marker (a connector list never parses)', () => {
    const base = { format: 1, generatedAt: '2026-11-04T10:00:00.000Z', sequence: 1, entries: [] };
    expect(AgentTemplateListFile.safeParse(base).success).toBe(false);
    expect(AgentTemplateListFile.parse({ ...base, catalog: 'templates' }).categories).toEqual([]);
  });
});

describe('mergeAgentTemplates', () => {
  const builtin = [
    { id: 'clinic', version: 1, from: 'app' },
    { id: 'claims', version: 1, from: 'app' },
  ];
  it('replaces a built-in only with a higher version and adds new ids after the built-ins', () => {
    const merged = mergeAgentTemplates(builtin, [
      { id: 'venue', version: 1, from: 'list' },
      { id: 'clinic', version: 1, from: 'list' },
      { id: 'claims', version: 2, from: 'list' },
    ]);
    expect(merged.map((t) => `${t.id}:${t.from}`)).toEqual([
      'clinic:app',
      'claims:list',
      'venue:list',
    ]);
  });
  it('a list cannot remove a built-in template', () => {
    expect(mergeAgentTemplates(builtin, [])).toEqual(builtin);
  });
});
