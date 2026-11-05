import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { BookOpen, Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  addTeamWord,
  grammarKey,
  removeTeamWord,
  teamWordsKey,
  useGrammarState,
  useTeamWords,
  type GrammarState,
  type MockGrammarInstall,
  type MockGrammarMode,
} from '@/mock/grammar';
import { SaveBar } from './adminUi';

/**
 * Proposed (grammar-fix): Settings → AI card with the team-wide Fix English switch and the team
 * word list. On by default on a new install, off after an update. Spelling needs no AI (dictionary
 * in the browser); grammar uses the "Model for suggestions" and needs the AI connection. The dashed
 * "Mock only" box switches the mock's install kind and AI behaviour to show every state.
 */
export function GrammarFixSection() {
  const { t } = useTranslation('admin');
  const client = useQueryClient();
  const query = useGrammarState();
  const [draft, setDraft] = useState<boolean>();
  const enabled = draft ?? query.data?.enabled ?? false;
  const dirty = draft !== undefined && draft !== query.data?.enabled;
  const connected = query.data?.connected ?? false;
  const installId = useId();
  const modeId = useId();
  const save = useMutation({
    mutationFn: (body: {
      enabled?: boolean;
      mode?: MockGrammarMode;
      install?: MockGrammarInstall;
    }) => api<GrammarState>('/mock/grammar', { method: 'PUT', body }),
    onSuccess: (data) => {
      client.setQueryData(grammarKey, data);
      setDraft(undefined);
    },
  });
  return (
    <Card data-testid="grammar-settings">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockGrammar.title')}</CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockGrammar.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {query.data?.install === 'upgraded' && !query.data.enabled && (
          <Banner tone="info">{t('mockGrammar.upgraded')}</Banner>
        )}
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="grammar-enabled">{t('mockGrammar.enable')}</Label>
            <p className="mt-1 text-sm text-muted-foreground">{t('mockGrammar.cost')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('mockGrammar.rules')}</p>
          </div>
          <Label
            htmlFor="grammar-enabled"
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
          >
            <Switch
              id="grammar-enabled"
              checked={enabled}
              onCheckedChange={setDraft}
              disabled={query.isPending}
            />
          </Label>
        </div>
        {query.data && !connected && enabled && (
          <Banner tone="info">{t('mockGrammar.noConnection')}</Banner>
        )}
        {(save.error || query.error) && (
          <Banner tone="danger">{errorMessage(save.error || query.error)}</Banner>
        )}
        <SaveBar dirty={dirty}>
          <Button
            size="touch"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate({ enabled })}
          >
            {t('settings.save')}
          </Button>
        </SaveBar>
        <TeamWords />
        <div
          className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
          data-testid="mock-grammar-controls"
        >
          <Badge variant="outline" className="self-start">
            {t('mockSuggest.mockControls')}
          </Badge>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span id={installId} className="text-sm font-medium">
              {t('mockSuggest.install')}
            </span>
            <SegmentedControl<MockGrammarInstall>
              size="sm"
              aria-labelledby={installId}
              value={query.data?.install ?? 'new'}
              onValueChange={(install) => save.mutate({ install })}
              options={[
                { value: 'new', label: t('mockSuggest.installNew') },
                { value: 'upgraded', label: t('mockSuggest.installUpgraded') },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span id={modeId} className="text-sm font-medium">
              {t('mockSuggest.mode')}
            </span>
            <SegmentedControl<MockGrammarMode>
              size="sm"
              aria-labelledby={modeId}
              value={query.data?.mode ?? 'normal'}
              onValueChange={(mode) => save.mutate({ mode })}
              options={[
                { value: 'normal', label: t('mockSuggest.modeNormal') },
                { value: 'slow', label: t('mockSuggest.modeSlow') },
                { value: 'error', label: t('mockSuggest.modeError') },
                { value: 'expired', label: t('mockSuggest.modeExpired') },
              ]}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Team words: never underlined. Words of the Business context that no English dictionary knows are
 * added by themselves; teammates add more from the underline card; admins remove them here.
 */
function TeamWords() {
  const { t } = useTranslation('admin');
  const client = useQueryClient();
  const words = useTeamWords();
  const [word, setWord] = useState('');
  const inputId = useId();
  const add = useMutation({
    mutationFn: (value: string) => addTeamWord(value),
    onSuccess: (data) => {
      client.setQueryData(teamWordsKey, data);
      setWord('');
    },
  });
  const remove = useMutation({
    mutationFn: (value: string) => removeTeamWord(value),
    onSuccess: (data) => client.setQueryData(teamWordsKey, data),
  });
  const list = words.data?.words ?? [];
  return (
    <section
      className="space-y-3 border-t pt-5"
      aria-labelledby={inputId + '-title'}
      data-testid="team-words"
    >
      <div>
        <h3 id={inputId + '-title'} className="flex items-center gap-2 text-sm font-medium">
          <BookOpen className="size-4 text-muted-foreground" aria-hidden="true" />
          {t('mockGrammar.wordsTitle', { count: list.length })}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('mockGrammar.wordsHint')}</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (word.trim()) add.mutate(word.trim());
        }}
      >
        <Label htmlFor={inputId} className="sr-only">
          {t('mockGrammar.wordsAdd')}
        </Label>
        <Input
          id={inputId}
          value={word}
          maxLength={40}
          placeholder={t('mockGrammar.wordsPlaceholder')}
          onChange={(e) => setWord(e.target.value)}
          className="min-h-11 min-w-0 flex-1"
        />
        <Button
          type="submit"
          variant="outline"
          size="touch"
          disabled={!word.trim() || add.isPending}
        >
          <Plus aria-hidden="true" />
          {t('mockGrammar.wordsAdd')}
        </Button>
      </form>
      {add.error && <Banner tone="danger">{errorMessage(add.error)}</Banner>}
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('mockGrammar.wordsEmpty')}</p>
      ) : (
        <ul
          className="flex flex-wrap gap-2"
          aria-label={t('mockGrammar.wordsTitle', { count: list.length })}
        >
          {list.map((w) => (
            <li
              key={w.word}
              className="flex max-w-full items-center gap-1 rounded-full border bg-muted py-0.5 pr-0.5 pl-3 text-sm"
            >
              <span className="min-w-0 truncate">{w.word}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                ·{' '}
                {w.source === 'business'
                  ? t('mockGrammar.wordsFromContext')
                  : t('mockGrammar.wordsAddedBy', { name: w.addedBy ?? '—' })}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 rounded-full text-muted-foreground pointer-coarse:size-11"
                aria-label={t('mockGrammar.wordsRemove', { word: w.word })}
                disabled={remove.isPending}
                onClick={() => remove.mutate(w.word)}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
