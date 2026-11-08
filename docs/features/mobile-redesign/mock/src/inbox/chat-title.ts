import type { TFunction } from 'i18next';
import type { Chat } from '@ezychat/shared';
import { formatPhone } from '../lib/jid';

/** Chat title: its name, else +phone, else a translated placeholder. Never WhatsApp ID digits. */
export function chatTitle(
  chat: Pick<Chat, 'name' | 'phone' | 'type'>,
  t: TFunction<'inbox'>,
): string {
  if (chat.name && chat.name !== chat.phone) return chat.name;
  return (
    formatPhone(chat) ??
    (chat.type === 'group' ? t('chatListItem.group') : t('chatListItem.unknownContact'))
  );
}
