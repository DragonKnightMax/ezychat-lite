import { AiHandoffReason } from '@ezychat/shared';
import { i18n } from '@/i18n';

/** Short, localized reason why the AI handed a chat to the team (chat events and Try it). */
export function handoffReasonLabel(reason: AiHandoffReason): string {
  switch (reason) {
    case 'asked_for_human':
      return i18n.t('inbox:events.handoffReason.asked_for_human');
    case 'missing_facts':
      return i18n.t('inbox:events.handoffReason.missing_facts');
    case 'sensitive':
      return i18n.t('inbox:events.handoffReason.sensitive');
    case 'needs_action':
      return i18n.t('inbox:events.handoffReason.needs_action');
    case 'business_rule':
      return i18n.t('inbox:events.handoffReason.business_rule');
    case 'unsupported_message':
      return i18n.t('inbox:events.handoffReason.unsupported_message');
    case 'ai_unavailable':
      return i18n.t('inbox:events.handoffReason.ai_unavailable');
    default:
      // Reasons added after this reference (e.g. lookup_failed): shown as their code.
      return String(reason);
  }
}

export function isHandoffReason(value: unknown): value is AiHandoffReason {
  return AiHandoffReason.safeParse(value).success;
}
