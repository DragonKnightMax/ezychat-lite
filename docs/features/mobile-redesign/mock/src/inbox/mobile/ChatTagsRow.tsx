// Proposed (mobile-redesign): the Tags row of Customer details and Group info, phone and desktop.
// Same chips as the list row and the chat header, and the same editor (ChatTagsSheet: a bottom
// sheet on phones, a dialog on desktop), so a tag looks and edits the same on every screen.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Tag } from 'lucide-react';
import type { Chat } from '@ezychat/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useChatTags } from '../../mock/groupTags';
import { ChatTagsSheet } from './TagSheet';

export function ChatTagsRow({
  chat,
  className,
}: Readonly<{ chat: Pick<Chat, 'jid' | 'type' | 'tags'>; className?: string }>) {
  const { t } = useTranslation('inbox');
  const tags = useChatTags(chat);
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('space-y-1.5', className)} data-testid="chat-tags-row">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{t('mobile.tags.chatTitle')}</p>
        <Button
          variant="ghost"
          size="sm"
          className="pointer-coarse:min-h-11 -mr-2 text-primary"
          onClick={() => setOpen(true)}
          data-testid="chat-tags-edit"
        >
          {tags.length ? <Pencil aria-hidden /> : <Plus aria-hidden />}
          {tags.length ? t('mobile.tags.edit') : t('mobile.header.addTag')}
        </Button>
      </div>
      {tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('mobile.tags.chatTitle')}>
          {tags.map((tag) => (
            <li key={tag} className="min-w-0 max-w-full">
              <Badge variant="secondary" className="max-w-full">
                <Tag aria-hidden />
                <span className="truncate">{tag}</span>
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('mobile.tags.empty')}</p>
      )}
      <ChatTagsSheet
        jid={chat.jid}
        group={chat.type === 'group'}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
