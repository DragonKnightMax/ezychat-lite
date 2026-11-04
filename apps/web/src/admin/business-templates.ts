import type { TFunction } from 'i18next';
import {
  CakeSlice,
  Car,
  ChefHat,
  Dumbbell,
  GraduationCap,
  House,
  PawPrint,
  ReceiptText,
  Plane,
  Scissors,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Smile,
  Stethoscope,
  Store,
  UtensilsCrossed,
  Building2,
  type LucideIcon,
} from 'lucide-react';
import type { AiAgentPreset, AiContextTextBody } from '@ezychat/shared';
import { presetDefaults } from './ai-status';

/**
 * Ready-made AI agents for common businesses. A template is the tested starting text of its agent
 * type plus a short business part, its own hand-off rules and one Business context item of
 * fill-in lines (a blank line gives the AI no fact, so it hands the chat over instead of guessing).
 * Texts live in the catalogs (`ai.businessTemplates.<id>.*`), so each language gets its own copy.
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

export const BUSINESS_TEMPLATES = [
  { id: 'clinic', preset: 'faq', category: 'health', icon: Stethoscope },
  { id: 'dental', preset: 'faq', category: 'health', icon: Smile },
  { id: 'salon', preset: 'sales', category: 'health', icon: Scissors },
  { id: 'gym', preset: 'sales', category: 'health', icon: Dumbbell },
  { id: 'vet', preset: 'faq', category: 'health', icon: PawPrint },
  { id: 'restaurant', preset: 'sales', category: 'food', icon: UtensilsCrossed },
  { id: 'bakery', preset: 'sales', category: 'food', icon: CakeSlice },
  { id: 'catering', preset: 'sales', category: 'food', icon: ChefHat },
  { id: 'carWorkshop', preset: 'sales', category: 'services', icon: Car },
  { id: 'homeServices', preset: 'sales', category: 'services', icon: House },
  { id: 'property', preset: 'sales', category: 'services', icon: Building2 },
  { id: 'insurance', preset: 'faq', category: 'services', icon: ShieldCheck },
  { id: 'travel', preset: 'sales', category: 'services', icon: Plane },
  { id: 'onlineShop', preset: 'sales', category: 'shops', icon: ShoppingBag },
  { id: 'retail', preset: 'sales', category: 'shops', icon: Store },
  { id: 'phoneRepair', preset: 'sales', category: 'shops', icon: Smartphone },
  { id: 'tuition', preset: 'sales', category: 'education', icon: GraduationCap },
  // Custom: it records claims only, so it starts from no sales or FAQ text.
  { id: 'claims', preset: 'custom', category: 'operations', icon: ReceiptText },
] as const satisfies ReadonlyArray<{
  id: string;
  preset: AiAgentPreset;
  category: TemplateCategory;
  icon: LucideIcon;
}>;

export type BusinessTemplateId = (typeof BUSINESS_TEMPLATES)[number]['id'];

/**
 * Templates for an agent that works in WhatsApp groups only (Answer in groups on, Answer direct
 * chats off). A new agent made from one is set up that way on Save; an existing agent gets a hint.
 */
const GROUP_AGENT_TEMPLATES: ReadonlySet<BusinessTemplateId> = new Set(['claims']);

export function isGroupAgentTemplate(id: BusinessTemplateId): boolean {
  return GROUP_AGENT_TEMPLATES.has(id);
}

export interface BusinessTemplateTexts {
  preset: AiAgentPreset;
  agentName: string;
  instructions: string;
  handoffRules: string;
  contextItem: AiContextTextBody;
  /** Works in WhatsApp groups only (see `isGroupAgentTemplate`). */
  groupAgent: boolean;
}

export function businessTemplate(
  id: BusinessTemplateId,
  t: TFunction<'admin'>,
): BusinessTemplateTexts {
  const { preset } = BUSINESS_TEMPLATES.find((tpl) => tpl.id === id)!;
  const key = `ai.businessTemplates.${id}` as const;
  // A Custom template has no starting text: its business part is the whole role.
  const start = presetDefaults(preset, t).instructions;
  const focus = t(`${key}.focus`);
  return {
    preset,
    agentName: t(`${key}.agentName`),
    instructions: start ? `${start}\n\n${focus}` : focus,
    handoffRules: t(`${key}.handoffRules`),
    contextItem: { name: t(`${key}.contextName`), text: t(`${key}.contextText`) },
    groupAgent: isGroupAgentTemplate(id),
  };
}

/**
 * True when every word of `query` appears in the template's name, description or search words
 * (the catalogs keep English words beside the translated ones, so either language finds it).
 */
export function templateMatches(
  id: BusinessTemplateId,
  query: string,
  t: TFunction<'admin'>,
): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const key = `ai.businessTemplates.${id}` as const;
  const haystack = [t(`${key}.name`), t(`${key}.description`), t(`${key}.keywords`)]
    .join(' ')
    .toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}
