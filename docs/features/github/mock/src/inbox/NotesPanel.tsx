import type React from 'react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import type { Note } from '@ezychat/shared';
import { useAddNote } from '../api/queries';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useMediaQuery } from '@/lib/use-media-query';
import { formatDateTime } from '../lib/format';
import { PanelHeader } from './PanelHeader';
import type { Directory } from './useDirectory';

export interface NotesPanelProps {
  jid: string;
  open: boolean;
  notes: Note[];
  loading: boolean;
  directory: Directory;
  onClose(): void;
}

function NotesBody({
  jid,
  notes,
  loading,
  directory,
  onClose,
  title,
  description,
}: Omit<NotesPanelProps, 'open'> & { title: React.ReactNode; description: React.ReactNode }) {
  const { t } = useTranslation('inbox');
  const [body, setBody] = useState('');
  const add = useAddNote(jid);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = body.trim();
    if (!v) return;
    add.mutate(v, {
      onSuccess: () => setBody(''),
      onError: (err) => toast.error(err instanceof Error ? err.message : t('notes.saveFailed')),
    });
  }

  const sorted = [...notes].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <PanelHeader
        icon={<Lock className="size-4 shrink-0 text-note-foreground" aria-hidden="true" />}
        title={title}
        description={description}
        closeLabel={t('notes.close')}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-4 py-3">
        {loading ? (
          <div className="space-y-2" role="status" aria-label={t('notes.loading')}>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('notes.empty')}</p>
        ) : (
          sorted.map((n) => (
            <div
              key={n.id}
              className="rounded-lg border border-dashed border-note-border bg-note px-3 py-2 text-sm text-note-foreground"
            >
              <p className="mb-0.5 flex gap-2 text-xs">
                <span className="truncate font-semibold">
                  {directory.nameOf(n.userId, { youLabel: true })}
                </span>
                <span className="ml-auto shrink-0 opacity-80">{formatDateTime(n.createdAt)}</span>
              </p>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{n.body}</p>
            </div>
          ))
        )}
      </div>
      <form onSubmit={submit} className="safe-bottom border-t">
        <div className="flex flex-col gap-2 px-4 py-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={8192}
            aria-label={t('notes.newNote')}
            placeholder={t('notes.placeholder')}
            className="field-sizing-fixed min-h-20 resize-none bg-surface text-base md:text-sm"
          />
          <Button type="submit" size="touch" disabled={!body.trim() || add.isPending}>
            {add.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            {t('notes.add')}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Internal notes (never sent to the customer). Side panel on >= lg, full-height Sheet below.
 */
export function NotesPanel({ open, onClose, ...rest }: NotesPanelProps) {
  const { t } = useTranslation('inbox');
  const desktop = useMediaQuery('(min-width: 1024px)');
  const titleRef = useRef<HTMLHeadingElement>(null);

  if (desktop) {
    if (!open) return null;
    return (
      <aside
        aria-label={t('notes.title')}
        className="flex w-80 shrink-0 flex-col border-l bg-surface"
      >
        <NotesBody
          {...rest}
          onClose={onClose}
          title={<h3>{t('notes.title')}</h3>}
          description={<p>{t('notes.description')}</p>}
        />
      </aside>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-label={t('notes.title')}
        // Same as the Customer sheet: no left border at full width, focus starts on the title.
        className="safe-top safe-x w-full gap-0 bg-surface max-sm:border-l-0 sm:max-w-sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <NotesBody
          {...rest}
          onClose={onClose}
          title={
            <SheetTitle ref={titleRef} tabIndex={-1} className="text-sm outline-none">
              {t('notes.title')}
            </SheetTitle>
          }
          description={
            <SheetDescription className="text-xs">{t('notes.description')}</SheetDescription>
          }
        />
      </SheetContent>
    </Sheet>
  );
}
