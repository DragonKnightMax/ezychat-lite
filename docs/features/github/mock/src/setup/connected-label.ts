import type { TFunction } from 'i18next';
import type { WaStatus } from '@ezychat/shared';
import { formatJid } from '../lib/jid';

/**
 * "Connected as …" for the linked account. A WhatsApp ID (`@lid`) own JID has no printable number,
 * so fall back to the account name, else the plain "Connected." — never an empty number.
 */
export function connectedAsLabel(me: WaStatus['me'], t: TFunction<'auth'>): string {
  if (!me) return t('setup.wa.connected');
  const number = formatJid(me.jid);
  if (me.name && number) return t('setup.wa.connectedAsNamed', { name: me.name, number });
  if (number || me.name) return t('setup.wa.connectedAs', { number: number || me.name });
  return t('setup.wa.connected');
}
