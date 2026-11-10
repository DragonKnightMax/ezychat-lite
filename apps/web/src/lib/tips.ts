import { GITHUB_NEW_TOKEN_URL } from '@ezychat/shared';

/**
 * The "?" tips (`InfoTip`) that explain a new concept in plain words. Copy lives in `common.json`
 * under `tips.<topic>` (`title`, `body`, `step1`…`stepN`, `action`); this file holds each tip's shape.
 * Design: docs/features/concept-tips/design.md.
 */
export const TIP_TOPICS = [
  'whatsappLink',
  'aiConnection',
  'apiKey',
  'claudeKey',
  'aiModel',
  'businessContext',
  'instructions',
  'handoff',
  'tryIt',
  'voice',
  'tunnel',
  'lan',
  'mcp',
  'accessToken',
  'connectors',
  'safetyAi',
  'autoBlock',
  'lockedFiles',
  'driveFiles',
  'reportNumber',
  'sqlApiService',
  'sqlKeys',
  'sqlCustomerCode',
  'usageStats',
  'githubApp',
  'githubToken',
] as const;
export type TipTopic = (typeof TIP_TOPICS)[number];

/** The ezychat.ai guides a tip can link to (each exists in en, ms and zh). */
export type TipGuide =
  'getting-started' | 'set-up-ai-agent' | 'connect-cloudflare' | 'connect-ai-assistant';

export interface TipShape {
  /** Number of "Show steps" lines (`step1`…`stepN`), folded until asked for; 0 = none. */
  steps: number;
  /** Outside page where the thing is made (opened in the OS browser); its label is `action`. */
  action?: string;
  /** ezychat.ai guide shown as "Full guide". */
  guide?: TipGuide;
}

export const TIPS: Readonly<Record<TipTopic, TipShape>> = {
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
  safetyAi: { steps: 0 },
  autoBlock: { steps: 0 },
  lockedFiles: { steps: 0 },
  driveFiles: { steps: 0 },
  reportNumber: { steps: 3 },
  sqlApiService: {
    steps: 4,
    action: 'https://docs.sql.com.my/sqlacc/integration/sql-account-api/on-premise-setup',
  },
  sqlKeys: {
    steps: 4,
    action: 'https://docs.sql.com.my/sqlacc/integration/sql-account-api/setup-configuration',
  },
  sqlCustomerCode: { steps: 0 },
  usageStats: { steps: 3 },
  githubApp: { steps: 0 },
  githubToken: { steps: 0, action: GITHUB_NEW_TOKEN_URL },
};

const GUIDE_PREFIX: Partial<Record<string, string>> = { ms: '/ms', 'zh-CN': '/zh' };

/**
 * The guide on ezychat.ai in the app's language. The campaign tags let the website count visits
 * from tips. The app's only usage data is the anonymous usage stats (server `usage/`, switch in Settings).
 */
export function tipGuideUrl(guide: TipGuide, locale: string, topic: string): string {
  const prefix = GUIDE_PREFIX[locale] ?? '';
  const campaign = encodeURIComponent(`tip-${topic}`);
  return `https://ezychat.ai${prefix}/guides/${guide}?utm_source=ezychat-lite&utm_medium=app&utm_campaign=${campaign}`;
}
