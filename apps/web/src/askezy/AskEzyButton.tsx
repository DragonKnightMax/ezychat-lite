import { useTranslation } from 'react-i18next';
import { BotMessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAskEzy, type AskEzyRequest } from './AskEzyContext';
import { useChosenChatsOnly } from '../auth/chat-scope';

/** Opens Ask Ezy. `compact` shows only the icon (phone headers); the label stays for screen readers. */
export function AskEzyButton({
  request,
  compact,
  variant = 'ghost',
  className,
}: {
  request?: AskEzyRequest;
  compact?: boolean;
  variant?: 'ghost' | 'outline';
  className?: string;
}) {
  const { t } = useTranslation('inbox');
  const { openPanel } = useAskEzy();
  // Ask Ezy reads across chats: hidden for an agent limited to chosen chats
  if (useChosenChatsOnly()) return null;
  return (
    <Button
      variant={variant}
      size={compact ? 'icon-touch' : 'touch'}
      className={cn('text-primary', className)}
      onClick={() => openPanel(request)}
      aria-label={compact ? t('askEzy.open') : undefined}
      title={t('askEzy.open')}
      data-testid="ask-ezy-open"
      data-ask-ezy-trigger
    >
      <BotMessageSquare aria-hidden />
      {!compact && t('askEzy.button')}
    </Button>
  );
}
