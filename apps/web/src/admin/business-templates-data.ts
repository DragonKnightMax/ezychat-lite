import type { AiAgentPreset, SheetLayoutInput } from '@ezychat/shared';

/**
 * The templates built into this app (plain data, no React: `scripts/export-templates.mjs` reads it to
 * write the publishing repo's `templates/` folder). Texts live in the catalogs
 * (`ai.businessTemplates.<id>.*`). Each is version 1: a template of the signed template list
 * replaces one only with a higher version (docs/features/template-store/design.md).
 */
export const TEMPLATE_CATEGORIES = [
  'health',
  'food',
  'services',
  'shops',
  'education',
  'operations',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** `answerGroups` on and `answerDirect` off: an agent that works in WhatsApp groups only. */
export interface TemplateDefaults {
  answerDirect?: boolean;
  answerGroups?: boolean;
}
export const GROUP_AGENT_DEFAULTS = { answerGroups: true, answerDirect: false } as const;

/**
 * The Claims template's Google Sheets layout ("Create from Claims layout" on the Google Sheets
 * page): one tab the agent adds claims to, with EzyChat's own columns where they help.
 */
export const CLAIMS_SHEET_LAYOUT: SheetLayoutInput = {
  name: 'Claims',
  tabs: [
    {
      title: 'Claims',
      columns: [
        'Date',
        'Name',
        'WhatsApp',
        'Group',
        'Policy no',
        'Amount',
        'What happened',
        'Source',
      ],
      access: 'add',
    },
  ],
};

export const BUSINESS_TEMPLATES = [
  { id: 'clinic', preset: 'faq', category: 'health', icon: 'stethoscope' },
  { id: 'dental', preset: 'faq', category: 'health', icon: 'smile' },
  { id: 'salon', preset: 'sales', category: 'health', icon: 'scissors' },
  { id: 'gym', preset: 'sales', category: 'health', icon: 'dumbbell' },
  { id: 'vet', preset: 'faq', category: 'health', icon: 'paw-print' },
  { id: 'restaurant', preset: 'sales', category: 'food', icon: 'utensils-crossed' },
  { id: 'bakery', preset: 'sales', category: 'food', icon: 'cake-slice' },
  { id: 'catering', preset: 'sales', category: 'food', icon: 'chef-hat' },
  { id: 'carWorkshop', preset: 'sales', category: 'services', icon: 'car' },
  { id: 'homeServices', preset: 'sales', category: 'services', icon: 'house' },
  { id: 'property', preset: 'sales', category: 'services', icon: 'building-2' },
  { id: 'insurance', preset: 'faq', category: 'services', icon: 'shield-check' },
  { id: 'travel', preset: 'sales', category: 'services', icon: 'plane' },
  { id: 'onlineShop', preset: 'sales', category: 'shops', icon: 'shopping-bag' },
  { id: 'retail', preset: 'sales', category: 'shops', icon: 'store' },
  { id: 'phoneRepair', preset: 'sales', category: 'shops', icon: 'smartphone' },
  { id: 'tuition', preset: 'sales', category: 'education', icon: 'graduation-cap' },
  // Custom: it records claims only, so it starts from no sales or FAQ text. Works in groups only.
  {
    id: 'claims',
    preset: 'custom',
    category: 'operations',
    icon: 'receipt-text',
    defaults: GROUP_AGENT_DEFAULTS,
    sheet: CLAIMS_SHEET_LAYOUT,
  },
] as const satisfies ReadonlyArray<{
  id: string;
  preset: AiAgentPreset;
  category: TemplateCategory;
  icon: string;
  defaults?: TemplateDefaults;
  sheet?: SheetLayoutInput;
}>;

export type BusinessTemplateId = (typeof BUSINESS_TEMPLATES)[number]['id'];

/** The version of every built-in template (a list template replaces one only when higher). */
export const BUILTIN_TEMPLATE_VERSION = 1;

/** True for the group-only defaults (switched on a new agent; an existing one gets a note). */
export function isGroupAgent(defaults: TemplateDefaults | undefined): boolean {
  return defaults?.answerGroups === true && defaults.answerDirect === false;
}
