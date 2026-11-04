import type { TFunction } from 'i18next';
import {
  Baby,
  Bike,
  BookOpen,
  Briefcase,
  Building2,
  Bus,
  CakeSlice,
  CalendarDays,
  Camera,
  Car,
  ChefHat,
  Coffee,
  Dumbbell,
  FileText,
  Fish,
  Flower2,
  Gem,
  GraduationCap,
  Hammer,
  Headset,
  HeartPulse,
  Hotel,
  House,
  Landmark,
  Laptop,
  LayoutTemplate,
  Leaf,
  Music,
  Package,
  Palette,
  PartyPopper,
  PawPrint,
  Pill,
  Plane,
  ReceiptText,
  Scissors,
  ShieldCheck,
  Shirt,
  ShoppingBag,
  Smartphone,
  Smile,
  Sofa,
  Sparkles,
  Stethoscope,
  Store,
  Ticket,
  Truck,
  Users,
  UtensilsCrossed,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  agentTemplateCategoryName,
  agentTemplateTexts,
  mergeAgentTemplates,
  type AgentTemplateCatalog,
  type AgentTemplateText,
  type AiAgentPreset,
  type AiContextTextBody,
} from '@ezychat/shared';
import { presetDefaults } from './ai-status';
import {
  BUILTIN_TEMPLATE_VERSION,
  BUSINESS_TEMPLATES,
  TEMPLATE_CATEGORIES,
  isGroupAgent,
} from './business-templates-data';

export {
  BUSINESS_TEMPLATES,
  TEMPLATE_CATEGORIES,
  type BusinessTemplateId,
  type TemplateCategory,
} from './business-templates-data';

/**
 * Ready-made AI agents for common businesses. A template is the tested starting text of its agent
 * type plus a short business part, its own hand-off rules and one Business context item of
 * fill-in lines (a blank line gives the AI no fact, so it hands the chat over instead of guessing).
 * The app's own templates read their texts from the catalogs (`ai.businessTemplates.<id>.*`); the
 * signed template list (`GET /api/ai/templates`, docs/features/template-store/design.md) adds new
 * ones and replaces one only with a higher version.
 */

/**
 * The icons a template may name (bundled with the app: a list never sends an image). An unknown
 * name shows `FALLBACK_ICON`.
 */
export const TEMPLATE_ICONS: Readonly<Record<string, LucideIcon>> = {
  baby: Baby,
  bike: Bike,
  'book-open': BookOpen,
  briefcase: Briefcase,
  'building-2': Building2,
  bus: Bus,
  'cake-slice': CakeSlice,
  'calendar-days': CalendarDays,
  camera: Camera,
  car: Car,
  'chef-hat': ChefHat,
  coffee: Coffee,
  dumbbell: Dumbbell,
  'file-text': FileText,
  fish: Fish,
  'flower-2': Flower2,
  gem: Gem,
  'graduation-cap': GraduationCap,
  hammer: Hammer,
  headset: Headset,
  'heart-pulse': HeartPulse,
  hotel: Hotel,
  house: House,
  landmark: Landmark,
  laptop: Laptop,
  leaf: Leaf,
  music: Music,
  package: Package,
  palette: Palette,
  'party-popper': PartyPopper,
  'paw-print': PawPrint,
  pill: Pill,
  plane: Plane,
  'receipt-text': ReceiptText,
  scissors: Scissors,
  'shield-check': ShieldCheck,
  shirt: Shirt,
  'shopping-bag': ShoppingBag,
  smartphone: Smartphone,
  smile: Smile,
  sofa: Sofa,
  sparkles: Sparkles,
  stethoscope: Stethoscope,
  store: Store,
  ticket: Ticket,
  truck: Truck,
  users: Users,
  'utensils-crossed': UtensilsCrossed,
  wallet: Wallet,
  wrench: Wrench,
};
export const FALLBACK_ICON: LucideIcon = LayoutTemplate;
export const templateIcon = (name: string): LucideIcon =>
  Object.hasOwn(TEMPLATE_ICONS, name) ? TEMPLATE_ICONS[name]! : FALLBACK_ICON;

/** One template as the gallery shows it, in the admin's language, from either source. */
export interface GalleryTemplate {
  id: string;
  version: number;
  /** `app`: built into this version; `list`: from the signed template list. */
  source: 'app' | 'list';
  preset: AiAgentPreset;
  category: string;
  icon: LucideIcon;
  texts: AgentTemplateText;
  /** Works in WhatsApp groups only (switched on a new agent; an existing one gets a note). */
  groupAgent: boolean;
  /** Names of the connectors the template recommends (list templates only). */
  connectors: string[];
}

/** The app's own templates, texts from the catalogs. */
export function builtinTemplates(t: TFunction<'admin'>): GalleryTemplate[] {
  return BUSINESS_TEMPLATES.map((tpl) => {
    const key = `ai.businessTemplates.${tpl.id}` as const;
    return {
      id: tpl.id,
      version: BUILTIN_TEMPLATE_VERSION,
      source: 'app',
      preset: tpl.preset,
      category: tpl.category,
      icon: templateIcon(tpl.icon),
      texts: {
        agentName: t(`${key}.agentName`),
        name: t(`${key}.name`),
        description: t(`${key}.description`),
        keywords: t(`${key}.keywords`),
        focus: t(`${key}.focus`),
        handoffRules: t(`${key}.handoffRules`),
        contextName: t(`${key}.contextName`),
        contextText: t(`${key}.contextText`),
      },
      groupAgent: isGroupAgent('defaults' in tpl ? tpl.defaults : undefined),
      connectors: [],
    };
  });
}

/**
 * The gallery: the app's own templates, each replaced by a list template with the same id only when
 * the list's version is higher, then the list's new templates. Without a list (loading, offline,
 * an error) the app's own templates show.
 */
export function galleryTemplates(
  t: TFunction<'admin'>,
  language: string,
  catalog: AgentTemplateCatalog | undefined,
): GalleryTemplate[] {
  const listed: GalleryTemplate[] = (catalog?.templates ?? []).map(({ entry, connectors }) => ({
    id: entry.id,
    version: entry.version,
    source: 'list',
    preset: entry.preset,
    category: entry.category,
    icon: templateIcon(entry.icon),
    texts: agentTemplateTexts(entry, language),
    groupAgent: isGroupAgent(entry.defaults),
    connectors: connectors.map((c) => c.name),
  }));
  return mergeAgentTemplates(builtinTemplates(t), listed);
}

/**
 * The category chips: the app's own (catalog names), then categories only the list defines and a
 * shown template uses (the list's name for them).
 */
export function galleryCategories(
  t: TFunction<'admin'>,
  language: string,
  catalog: AgentTemplateCatalog | undefined,
  templates: readonly GalleryTemplate[],
): Array<{ id: string; label: string }> {
  const own = new Set<string>(TEMPLATE_CATEGORIES);
  const used = new Set(templates.map((tpl) => tpl.category));
  return [
    ...TEMPLATE_CATEGORIES.map((id) => ({ id, label: t(`ai.businessTemplates.category.${id}`) })),
    ...(catalog?.categories ?? [])
      .filter((c) => !own.has(c.id) && used.has(c.id))
      .map((c) => ({ id: c.id, label: agentTemplateCategoryName(c, language) })),
  ];
}

export interface BusinessTemplateTexts {
  preset: AiAgentPreset;
  agentName: string;
  instructions: string;
  handoffRules: string;
  contextItem: AiContextTextBody;
  /** Works in WhatsApp groups only. */
  groupAgent: boolean;
}

/** What Apply puts in the editor: the agent type's starting text, then the business part. */
export function businessTemplate(
  tpl: GalleryTemplate,
  t: TFunction<'admin'>,
): BusinessTemplateTexts {
  // A Custom template has no starting text: its business part is the whole role.
  const start = presetDefaults(tpl.preset, t).instructions;
  const focus = tpl.texts.focus;
  return {
    preset: tpl.preset,
    agentName: tpl.texts.agentName,
    instructions: start ? `${start}\n\n${focus}` : focus,
    handoffRules: tpl.texts.handoffRules,
    contextItem: { name: tpl.texts.contextName, text: tpl.texts.contextText },
    groupAgent: tpl.groupAgent,
  };
}

/**
 * True when every word of `query` appears in the template's name, description or search words
 * (the catalogs keep English words beside the translated ones, so either language finds it).
 */
export function templateMatches(tpl: GalleryTemplate, query: string): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [tpl.texts.name, tpl.texts.description, tpl.texts.keywords]
    .join(' ')
    .toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}
