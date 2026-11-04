import { z } from 'zod';
import { AiAgentPreset, AI_CONTEXT_NAME_CHARACTERS, AI_HANDOFF_RULES_CHARACTERS } from './ai.js';
import { ConnectorId, versionAtLeast } from './connector-list.js';

/**
 * The AI agent template list (design: docs/features/template-store/design.md). The public repo
 * anchorsprint/ezychat-connectors builds one signed JSON list from its `templates/` folder and
 * publishes it to dl.ezychat.ai/templates/; the server downloads it at start and when an admin opens
 * the template gallery, checks it and keeps a local copy. A list entry only fills editable boxes when
 * an admin clicks Apply: it is data, never code. The app's own templates stay the fallback.
 */

/** List file formats this app can read. */
export const TEMPLATE_LIST_FORMAT = 1;
/** Entry schema versions this app can use. A newer entry is left out. */
export const SUPPORTED_TEMPLATE_SCHEMA_VERSIONS: readonly number[] = [1];
/**
 * Signed before the list bytes (domain separation): the template list shares the connector list's
 * keys, so a signed connector list must never verify as a template list, nor the other way round.
 */
export const TEMPLATE_SIGNING_CONTEXT = 'ezychat-templates-v1\n';

export const TEMPLATE_LANGUAGES = ['en', 'ms', 'zh-CN'] as const;
export type AgentTemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

/** Longest business part: the longest starting text of an agent type plus this stays under 8000. */
export const TEMPLATE_FOCUS_CHARACTERS = 4000;
export const TEMPLATE_CONTEXT_TEXT_CHARACTERS = 20_000;

// Control characters (except tab and newline), bidi controls and the byte-order mark: they can hide
// or reorder text in a box an admin reads before saving. Written as escapes (SonarCloud S6389).
const UNSAFE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/g;

/** Removes control, bidi and byte-order-mark characters; CRLF and CR become LF. */
export function cleanAgentTemplateText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNSAFE_CHARACTERS, '');
}

/**
 * Cleans every string inside a raw list value (entries, categories) before the schema check, so the
 * length limits apply to what is left. The schema itself stays plain JSON Schema for the publisher.
 */
export function cleanAgentTemplateValue(value: unknown): unknown {
  if (typeof value === 'string') return cleanAgentTemplateText(value);
  if (Array.isArray(value)) return value.map(cleanAgentTemplateValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cleanAgentTemplateValue(item)]),
    );
  return value;
}

const text = (max: number, min = 1) => z.string().trim().min(min).max(max);

/** One language's texts of a template. */
export const AgentTemplateText = z.object({
  /** The new agent's name. */
  agentName: text(64),
  /** The card title in the gallery. */
  name: text(60),
  description: text(300),
  /** Extra search words (keep the English words beside translated ones). */
  keywords: text(300, 0).default(''),
  /** The business part of the role; the agent type's starting text goes in front of it. */
  focus: text(TEMPLATE_FOCUS_CHARACTERS),
  handoffRules: text(AI_HANDOFF_RULES_CHARACTERS),
  /** The Business context item the next Save adds (blank fill-in lines). */
  contextName: text(AI_CONTEXT_NAME_CHARACTERS),
  contextText: text(TEMPLATE_CONTEXT_TEXT_CHARACTERS),
});
export type AgentTemplateText = z.infer<typeof AgentTemplateText>;

export const AgentTemplateId = z.string().regex(/^[a-z][a-zA-Z0-9-]{1,48}$/);
export const AgentTemplateCategoryId = z.string().regex(/^[a-z][a-zA-Z0-9-]{1,39}$/);
/** An icon of the app's bundled set; an unknown name shows a neutral icon (no image is downloaded). */
export const AgentTemplateIcon = z.string().regex(/^[a-z0-9-]{1,40}$/);
const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/);

/** One entry, schemaVersion 1. */
export const AgentTemplateEntry = z.object({
  id: AgentTemplateId,
  /** Replaces a template with the same id only when higher (the app's own templates are 1). */
  version: z.number().int().min(1).max(1_000_000),
  schemaVersion: z.literal(1),
  minAppVersion: SemVer,
  editions: z.array(z.enum(['lite', 'enterprise'])).min(1),
  category: AgentTemplateCategoryId,
  icon: AgentTemplateIcon,
  preset: AiAgentPreset,
  /** English is required; a missing language uses the whole English set. */
  texts: z.object({
    en: AgentTemplateText,
    ms: AgentTemplateText.optional(),
    'zh-CN': AgentTemplateText.optional(),
  }),
  /** `answerGroups: true` + `answerDirect: false` = a group agent (switched on a new agent only). */
  defaults: z
    .object({ answerDirect: z.boolean().optional(), answerGroups: z.boolean().optional() })
    .optional(),
  recommendedConnectors: z.array(ConnectorId).max(5).optional(),
});
export type AgentTemplateEntry = z.infer<typeof AgentTemplateEntry>;
export type AgentTemplateEntryInput = z.input<typeof AgentTemplateEntry>;

export const AgentTemplateCategory = z.object({
  id: AgentTemplateCategoryId,
  name: z.object({ en: text(40), ms: text(40).optional(), 'zh-CN': text(40).optional() }),
});
export type AgentTemplateCategory = z.infer<typeof AgentTemplateCategory>;

/** The list file. Entries are read one by one: a bad or newer entry drops only that entry. */
export const AgentTemplateListFile = z.object({
  format: z.literal(TEMPLATE_LIST_FORMAT),
  catalog: z.literal('templates'),
  generatedAt: z.string().datetime(),
  /** Increases on every publish; the app never accepts a lower one (no roll-back). */
  sequence: z.number().int().min(1),
  categories: z.array(z.unknown()).max(20).default([]),
  entries: z.array(z.unknown()).max(200),
});
export type AgentTemplateListFile = z.infer<typeof AgentTemplateListFile>;

/** The texts of `entry` in `language` (its base language, then the whole English set). */
export function agentTemplateTexts(
  entry: Pick<AgentTemplateEntry, 'texts'>,
  language: string,
): AgentTemplateText {
  const texts = entry.texts;
  if (language === 'ms' || language.startsWith('ms-')) return texts.ms ?? texts.en;
  if (language === 'zh' || language.startsWith('zh')) return texts['zh-CN'] ?? texts.en;
  return texts.en;
}

/** A category name in `language` (same fallback as the texts). */
export function agentTemplateCategoryName(
  category: AgentTemplateCategory,
  language: string,
): string {
  const name = category.name;
  if (language === 'ms' || language.startsWith('ms-')) return name.ms ?? name.en;
  if (language.startsWith('zh')) return name['zh-CN'] ?? name.en;
  return name.en;
}

/** True when this app (version, edition) can use the entry. */
export function agentTemplateFits(
  entry: Pick<AgentTemplateEntry, 'schemaVersion' | 'minAppVersion' | 'editions'>,
  app: { version: string; edition: string },
): boolean {
  if (!SUPPORTED_TEMPLATE_SCHEMA_VERSIONS.includes(entry.schemaVersion)) return false;
  if (!versionAtLeast(app.version, entry.minAppVersion)) return false;
  return entry.editions.includes(app.edition === 'lite' ? 'lite' : 'enterprise');
}

/**
 * Merges the app's own templates with the list's: a list entry replaces the one with the same id
 * only when its version is higher; new ids come after the app's own, in list order.
 */
export function mergeAgentTemplates<B extends { id: string; version: number }, R extends B>(
  builtins: readonly B[],
  remote: readonly R[],
): Array<B | R> {
  const byId = new Map(remote.map((r) => [r.id, r]));
  const merged: Array<B | R> = builtins.map((b) => {
    const r = byId.get(b.id);
    return r && r.version > b.version ? r : b;
  });
  const known = new Set(builtins.map((b) => b.id));
  for (const r of remote) if (!known.has(r.id)) merged.push(r);
  return merged;
}

// ── REST views (admins) ────────────────────────────────────────────────────────────────────

/** Same meaning as the connector list states. */
export const AgentTemplateListState = z.enum(['loaded', 'offline', 'rejected', 'builtin']);
export type AgentTemplateListState = z.infer<typeof AgentTemplateListState>;

export const AgentTemplateListStatus = z.object({
  state: AgentTemplateListState,
  generatedAt: z.string().nullable(),
  sequence: z.number().int().nullable(),
  checkedAt: z.number().int().nullable(),
});
export type AgentTemplateListStatus = z.infer<typeof AgentTemplateListStatus>;

export const AgentCatalogTemplate = z.object({
  entry: AgentTemplateEntry,
  /** The recommended connectors this app's connector list knows, with their names. */
  connectors: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
export type AgentCatalogTemplate = z.infer<typeof AgentCatalogTemplate>;

/** `GET /api/ai/templates`, `POST /api/ai/templates/refresh` (admins). */
export const AgentTemplateCatalog = z.object({
  status: AgentTemplateListStatus,
  categories: z.array(AgentTemplateCategory).default([]),
  /** Only entries this app and edition can use. */
  templates: z.array(AgentCatalogTemplate).default([]),
});
export type AgentTemplateCatalog = z.infer<typeof AgentTemplateCatalog>;
