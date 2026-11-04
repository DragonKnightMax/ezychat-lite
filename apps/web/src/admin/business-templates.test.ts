import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  AiAgentPreset,
  AI_AGENT_PRESETS,
  AI_HANDOFF_RULES_CHARACTERS,
  AI_INSTRUCTIONS_CHARACTERS,
  AiContextTextBody,
} from '@ezychat/shared';
import en from '@/i18n/locales/en/admin.json';
import ms from '@/i18n/locales/ms/admin.json';
import zh from '@/i18n/locales/zh-CN/admin.json';
import { presetDefaults } from './ai-status';
import {
  BUSINESS_TEMPLATES,
  businessTemplate,
  isGroupAgentTemplate,
  TEMPLATE_CATEGORIES,
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
    BUSINESS_TEMPLATES.filter((tpl) => isGroupAgentTemplate(tpl.id)).map((tpl) => tpl.id),
  ).toEqual(['claims']);
});
