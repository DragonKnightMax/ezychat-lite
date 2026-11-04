import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Message } from '@ezychat/shared';
import { api } from '@/api/client';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { setMockWaOffline } from './useSendReaction';

/** Group members of the demo that react (the fake phone delivers their names with the reaction). */
const GROUP_REACTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['👍', '60123110021@s.whatsapp.net', 'Farah Aziz'],
  ['👍', '60126677889@s.whatsapp.net', 'Nurul Huda'],
  [
    '👍',
    '60190000001@s.whatsapp.net',
    'Muhammad Hafiz bin Abdul Rahman Shah (Kopi Apong Butterworth branch)',
  ],
  ['❤️', '60190000002@s.whatsapp.net', 'Priya Nair'],
  ['😂', '60190000003@s.whatsapp.net', 'Tan Wei Jie'],
  ['😮', '60190000004@s.whatsapp.net', 'Jason Lim'],
  ['🙏', '60190000005@s.whatsapp.net', 'Ahmad Zulkifli'],
];

type Target = 'inbound' | 'outbound';
type ActionKey =
  | 'customer'
  | 'change'
  | 'remove'
  | 'phone'
  | 'phoneRemove'
  | 'groupOne'
  | 'groupMany'
  | 'groupClear';

/**
 * Proposed (emoji-reactions): mock-only panel that makes the fake WhatsApp phone deliver
 * reactions (through the dev route `POST /api/dev/fake-reaction`, fake WhatsApp only), so every
 * state of the badges can be seen live: one reaction, a change, a removal, the phone's own
 * reaction and a group with many people and a long name. The real app has no such panel.
 */
export function ReactionSimulator({
  messages,
  isGroup,
}: {
  messages: Message[];
  isGroup: boolean;
}) {
  const { t } = useTranslation('inbox');
  const labelId = useId();
  const [target, setTarget] = useState<Target>('inbound');
  const [busy, setBusy] = useState(false);
  const pick = (fromMe: boolean) =>
    [...messages]
      .reverse()
      .find((m) => m.fromMe === fromMe && m.type !== 'system' && !m.id.startsWith('local-'));
  const message = pick(target === 'outbound');

  const react = async (bodies: Array<Record<string, unknown>>) => {
    if (!message) return;
    setBusy(true);
    try {
      for (const body of bodies)
        await api('/dev/fake-reaction', { body: { messageId: message.id, ...body } });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const actions: Array<{ key: ActionKey; run: () => Promise<void> }> = isGroup
    ? [
        {
          key: 'groupOne',
          run: () =>
            react([{ emoji: '👍', senderJid: GROUP_REACTIONS[0]![1], senderName: 'Farah Aziz' }]),
        },
        {
          key: 'groupMany',
          run: () =>
            react(
              GROUP_REACTIONS.map(([emoji, senderJid, senderName]) => ({
                emoji,
                senderJid,
                senderName,
              })),
            ),
        },
        { key: 'phone', run: () => react([{ emoji: '❤️', fromMe: true }]) },
        {
          key: 'groupClear',
          run: () =>
            react([
              ...GROUP_REACTIONS.map(([, senderJid]) => ({ emoji: '', senderJid })),
              { emoji: '', fromMe: true },
            ]),
        },
      ]
    : [
        { key: 'customer', run: () => react([{ emoji: '👍' }]) },
        { key: 'change', run: () => react([{ emoji: '❤️' }]) },
        { key: 'remove', run: () => react([{ emoji: '' }]) },
        { key: 'phone', run: () => react([{ emoji: '🙏', fromMe: true }]) },
        { key: 'phoneRemove', run: () => react([{ emoji: '', fromMe: true }]) },
      ];

  return (
    <details
      className="mx-3 mt-3 rounded-lg border border-dashed px-3 py-2 text-sm md:mx-4"
      data-testid="mock-reactions"
    >
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 md:pointer-fine:min-h-8">
        <Badge variant="outline">{t('mockReactions.proposed')}</Badge>
        <span className="font-medium">{t('mockReactions.title')}</span>
      </summary>
      <div className="space-y-2 pt-2">
        <p id={labelId} className="text-xs text-muted-foreground">
          {t('mockReactions.target')}
        </p>
        <SegmentedControl<Target>
          size="sm"
          aria-labelledby={labelId}
          value={target}
          onValueChange={setTarget}
          options={[
            { value: 'inbound', label: t('mockReactions.inbound') },
            { value: 'outbound', label: t('mockReactions.outbound') },
          ]}
        />
        {message ? (
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Button
                key={a.key}
                variant="outline"
                size="sm"
                disabled={busy}
                className="min-h-11 md:pointer-fine:min-h-8"
                onClick={() => void a.run()}
              >
                {t(`mockReactions.actions.${a.key}`)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('mockReactions.noTarget')}</p>
        )}
        {/* Proposed (send-reactions): the bar's disabled state while WhatsApp is offline. */}
        <div className="flex flex-wrap gap-2 border-t pt-2">
          {([true, false] as const).map((offline) => (
            <Button
              key={String(offline)}
              variant="outline"
              size="sm"
              disabled={busy}
              className="min-h-11 md:pointer-fine:min-h-8"
              onClick={() =>
                void setMockWaOffline(offline).catch((err: Error) => toast.error(err.message))
              }
            >
              {t(
                offline
                  ? 'mockReactions.actions.phoneOffline'
                  : 'mockReactions.actions.phoneOnline',
              )}
            </Button>
          ))}
        </div>
      </div>
    </details>
  );
}
