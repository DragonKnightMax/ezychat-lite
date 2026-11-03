/**
 * PROPOSED (concept-tips): the "?" tips that explain a new concept in plain words, where to get
 * what it needs, and a link to the full guide. Copy lives in `common.json` under `mockTips.<topic>`
 * (en, ms, zh-CN); this file holds only the shape of each tip.
 */
export type TipTopic =
  | 'whatsappLink'
  | 'aiConnection'
  | 'apiKey'
  | 'claudeKey'
  | 'aiModel'
  | 'businessContext'
  | 'instructions'
  | 'handoff'
  | 'tryIt'
  | 'voice'
  | 'tunnel'
  | 'lan'
  | 'mcp'
  | 'accessToken'
  | 'connectors';

export interface TipShape {
  /** Number of "Show steps" lines (`step1`…`stepN`), folded by default; 0 = none. */
  steps: number;
  /** Outside page where the thing is made (opened in the OS browser), label in `action`. */
  action?: string;
  /** EzyChat guide slug on ezychat.ai (shown as "Full guide"). */
  guide?: 'getting-started' | 'set-up-ai-agent' | 'connect-cloudflare' | 'connect-ai-assistant';
}

export const TIPS: Record<TipTopic, TipShape> = {
  whatsappLink: { steps: 0, guide: 'getting-started' },
  aiConnection: { steps: 0, guide: 'set-up-ai-agent' },
  apiKey: { steps: 4, action: 'https://platform.openai.com/api-keys', guide: 'set-up-ai-agent' },
  claudeKey: {
    steps: 4,
    action: 'https://console.anthropic.com/settings/keys',
    guide: 'set-up-ai-agent',
  },
  aiModel: { steps: 0 },
  businessContext: { steps: 0, guide: 'set-up-ai-agent' },
  instructions: { steps: 0, guide: 'set-up-ai-agent' },
  handoff: { steps: 0, guide: 'set-up-ai-agent' },
  tryIt: { steps: 0 },
  voice: { steps: 0 },
  tunnel: { steps: 0, guide: 'connect-cloudflare' },
  lan: { steps: 0 },
  mcp: { steps: 0, guide: 'connect-ai-assistant' },
  accessToken: { steps: 0, guide: 'connect-ai-assistant' },
  connectors: { steps: 0 },
};

const GUIDE_PREFIX: Partial<Record<string, string>> = { ms: '/ms', 'zh-CN': '/zh' };

/**
 * The guide on ezychat.ai in the app's language. The campaign tag lets the website count visits
 * from tips; the app itself sends nothing (no tracking in Lite).
 */
export function guideUrl(slug: string, locale: string, topic: string): string {
  const prefix = GUIDE_PREFIX[locale] ?? '';
  return `https://ezychat.ai${prefix}/guides/${slug}?utm_source=ezychat-lite&utm_medium=app&utm_campaign=tip-${topic}`;
}
