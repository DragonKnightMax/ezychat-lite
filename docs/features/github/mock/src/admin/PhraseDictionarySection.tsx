import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BookText, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  phraseListKey,
  phrasesKey,
  usePhrases,
  type Phrase,
  type PhraseLanguage,
  type PhraseState,
} from '@/mock/phrases';
import { useReplySuggestionsState } from '@/mock/replySuggestions';

const LANGUAGES: PhraseLanguage[] = ['en', 'ms', 'zh'];

/**
 * Proposed (ai-phrase-dictionary): Settings → AI card for the team's phrase list. The AI builds it
 * in the background from the business context, the AI instructions and the team's sent replies;
 * teammates get its phrases as instant grey text. Admins see, add, edit and delete phrases.
 */
export function PhraseDictionarySection() {
  const { t } = useTranslation('admin');
  const client = useQueryClient();
  const suggest = useReplySuggestionsState();
  const query = usePhrases();
  const [open, setOpen] = useState(false);
  const stateId = useId();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: phrasesKey });
    void client.invalidateQueries({ queryKey: phraseListKey });
  };
  const rebuild = useMutation({
    mutationFn: () => api('/mock/phrases/rebuild', { method: 'POST' }),
    onSuccess: refresh,
  });
  const setState = useMutation({
    mutationFn: (state: PhraseState) =>
      api('/mock/phrases/state', { method: 'PUT', body: { state } }),
    onSuccess: refresh,
  });
  const status = query.data?.status;
  const off = suggest.data && suggest.data.composer === 'off';
  const minutes = status?.updatedAt
    ? Math.max(1, Math.round((Date.now() - status.updatedAt) / 60_000))
    : 0;

  return (
    <Card data-testid="phrase-dictionary-settings">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockPhrases.title')}</CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockPhrases.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {off && <Banner tone="info">{t('mockPhrases.off')}</Banner>}
        {status?.state === 'building' && (
          <div className="flex items-center gap-2 text-sm" role="status">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            {t('mockPhrases.building')}
          </div>
        )}
        {status?.state === 'empty' && (
          <p className="text-sm text-muted-foreground">{t('mockPhrases.empty')}</p>
        )}
        {status?.state === 'error' && <Banner tone="danger">{t('mockPhrases.error')}</Banner>}
        {status?.state === 'ready' && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t('mockPhrases.count', { count: status.count })}</p>
            <div className="flex flex-wrap gap-2">
              {status.languages.map((l) => (
                <Badge key={l.language} variant="secondary">
                  {t(`mockPhrases.lang.${l.language}`)} · {l.count}
                </Badge>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {t('mockPhrases.updated', { minutes })} {t(`mockPhrases.trigger.${status.trigger}`)}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('mockPhrases.next', { count: status.nextAfterReplies - status.newReplies })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('mockPhrases.calls', { used: status.aiCallsToday, limit: status.aiCallsLimit })}
            </p>
          </div>
        )}
        {(query.error || rebuild.error) && (
          <Banner tone="danger">{errorMessage(query.error || rebuild.error)}</Banner>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="touch"
            variant="outline"
            disabled={status?.state !== 'ready'}
            onClick={() => setOpen(true)}
          >
            <BookText aria-hidden />
            {t('mockPhrases.view')}
          </Button>
          <Button
            size="touch"
            variant="outline"
            disabled={status?.state === 'building' || rebuild.isPending || !!off}
            onClick={() => rebuild.mutate()}
          >
            <RefreshCw aria-hidden />
            {status?.state === 'empty' ? t('mockPhrases.build') : t('mockPhrases.rebuild')}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t('mockPhrases.privacy')}</p>
        <div
          className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
          data-testid="mock-phrase-controls"
        >
          <Badge variant="outline" className="self-start">
            {t('mockSuggest.mockControls')}
          </Badge>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span id={stateId} className="text-sm font-medium">
              {t('mockPhrases.mockState')}
            </span>
            <SegmentedControl<PhraseState>
              size="sm"
              aria-labelledby={stateId}
              value={status?.state ?? 'ready'}
              onValueChange={(state) => setState.mutate(state)}
              options={[
                { value: 'ready', label: t('mockPhrases.stateReady') },
                { value: 'empty', label: t('mockPhrases.stateEmpty') },
                { value: 'building', label: t('mockPhrases.stateBuilding') },
                { value: 'error', label: t('mockPhrases.stateError') },
              ]}
            />
          </div>
        </div>
      </CardContent>
      <PhraseListDialog
        open={open}
        onOpenChange={setOpen}
        phrases={query.data?.phrases ?? []}
        onChanged={refresh}
      />
    </Card>
  );
}

function PhraseListDialog({
  open,
  onOpenChange,
  phrases,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phrases: Phrase[];
  onChanged: () => void;
}) {
  const { t } = useTranslation('admin');
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState<PhraseLanguage | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const filterId = useId();
  const shown = phrases.filter(
    (p) =>
      (language === 'all' || p.language === language) &&
      p.text.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const remove = useMutation({
    mutationFn: (id: number) => api(`/mock/phrases/${id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-2xl" data-testid="phrase-list">
        <DialogHeader>
          <DialogTitle>{t('mockPhrases.listTitle')}</DialogTitle>
          <DialogDescription>{t('mockPhrases.listDescription')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('mockPhrases.search')}
            label={t('mockPhrases.search')}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span id={filterId} className="sr-only">
              {t('mockPhrases.language')}
            </span>
            <SegmentedControl<PhraseLanguage | 'all'>
              size="sm"
              aria-labelledby={filterId}
              value={language}
              onValueChange={setLanguage}
              options={[
                { value: 'all', label: t('mockPhrases.all') },
                ...LANGUAGES.map((l) => ({ value: l, label: t(`mockPhrases.lang.${l}`) })),
              ]}
            />
            <Button
              size="touch"
              variant="outline"
              onClick={() => setAdding(true)}
              disabled={adding}
            >
              <Plus aria-hidden />
              {t('mockPhrases.add')}
            </Button>
          </div>
          {adding && (
            <PhraseEditor
              onDone={() => {
                setAdding(false);
                onChanged();
              }}
              onCancel={() => setAdding(false)}
            />
          )}
        </div>
        <ul className="-mx-1 min-h-0 flex-1 divide-y overflow-y-auto px-1">
          {shown.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground">
              {t('mockPhrases.noMatch')}
            </li>
          )}
          {shown.map((phrase) =>
            editing === phrase.id ? (
              <li key={phrase.id} className="py-3">
                <PhraseEditor
                  phrase={phrase}
                  onDone={() => {
                    setEditing(null);
                    onChanged();
                  }}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li key={phrase.id} className="flex items-start gap-2 py-3" data-testid="phrase-row">
                <div className="min-w-0 flex-1">
                  <p className="text-sm break-words">{phrase.text}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <Badge variant="outline">{t(`mockPhrases.source.${phrase.source}`)}</Badge>
                    <span>{t(`mockPhrases.lang.${phrase.language}`)}</span>
                    <span>{t('mockPhrases.uses', { count: phrase.uses })}</span>
                    {phrase.fact && <span>{t('mockPhrases.fact')}</span>}
                  </div>
                </div>
                <Button
                  size="icon-touch"
                  variant="ghost"
                  aria-label={t('mockPhrases.edit')}
                  onClick={() => setEditing(phrase.id)}
                >
                  <Pencil aria-hidden />
                </Button>
                <Button
                  size="icon-touch"
                  variant="ghost"
                  aria-label={t('mockPhrases.delete')}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(phrase.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ),
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function PhraseEditor({
  phrase,
  onDone,
  onCancel,
}: {
  phrase?: Phrase;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('admin');
  const [text, setText] = useState(phrase?.text ?? '');
  const [language, setLanguage] = useState<PhraseLanguage>(phrase?.language ?? 'en');
  const textId = useId();
  const save = useMutation({
    mutationFn: () =>
      api(phrase ? `/mock/phrases/${phrase.id}` : '/mock/phrases', {
        method: phrase ? 'PUT' : 'POST',
        body: { text, language },
      }),
    onSuccess: onDone,
  });
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
      <label htmlFor={textId} className="text-sm font-medium">
        {phrase ? t('mockPhrases.edit') : t('mockPhrases.add')}
      </label>
      <Textarea
        id={textId}
        value={text}
        rows={2}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={language} onValueChange={(v) => setLanguage(v as PhraseLanguage)}>
          <SelectTrigger className="min-h-11 w-44" aria-label={t('mockPhrases.language')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l} value={l}>
                {t(`mockPhrases.lang.${l}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="touch"
          disabled={text.trim().length < 3 || save.isPending}
          onClick={() => save.mutate()}
        >
          {t('mockPhrases.save')}
        </Button>
        <Button size="touch" variant="ghost" onClick={onCancel}>
          {t('mockPhrases.cancel')}
        </Button>
      </div>
      {save.error && <Banner tone="danger">{errorMessage(save.error)}</Banner>}
    </div>
  );
}
