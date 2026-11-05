import type { AiDocument, AiMemberStatus, AiSettings } from '@ezychat/shared';

/** Only the official ChatGPT sign-in hosts may be opened from the app. */
export function officialLoginUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      ['auth.openai.com', 'chatgpt.com'].includes(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** The saved connection can answer customers right now. */
export function connectionReady(status: AiMemberStatus): boolean {
  return status.settings.mode === 'api'
    ? status.hasApiKey
    : status.connection.state === 'connected';
}

export type AiKnowledgeDraft = Pick<AiSettings, 'displayName' | 'instructions'> & {
  handoffRules: string;
};

/** Business facts to answer from: a context item with text. Instructions alone are not enough. */
export function hasKnowledge(documents: readonly AiDocument[]): boolean {
  return documents.some((doc) => doc.characters > 0);
}

export type AiPill = 'off' | 'on' | 'needsConnection' | 'needsKnowledge';

export function memberPill(status: AiMemberStatus): AiPill {
  if (!connectionReady(status)) return 'needsConnection';
  if (!hasKnowledge(status.documents)) return 'needsKnowledge';
  return status.member && !status.member.disabled ? 'on' : 'off';
}
