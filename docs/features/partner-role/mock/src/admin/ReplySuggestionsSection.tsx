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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { suggestModelKey, useSuggestModel } from '@/mock/phrases';
import {
  replySuggestionsKey,
  useReplySuggestionsState,
  type MockInstall,
  type MockSuggestMode,
  type ReplySuggestionsState,
} from '@/mock/replySuggestions';
import { Field, SaveBar } from './adminUi';

/**
 * Proposed (ai-reply-suggestions): Settings → AI card with the team-wide switch. On by default on a
 * new install with an AI connection, off after an update; disabled without a connection. The
 * dashed "Mock only" box switches the mock's install kind and AI behaviour to show every state.
 */
export function ReplySuggestionsSection() {
  const { t } = useTranslation('admin');
  const client = useQueryClient();
  const query = useReplySuggestionsState();
  const [draft, setDraft] = useState<boolean>();
  const enabled = draft ?? query.data?.enabled ?? false;
  // Proposed (ai-phrase-dictionary): which model answers Suggest reply and the grey text.
  const model = useSuggestModel();
  const [modelDraft, setModelDraft] = useState<string>();
  const shownModel = modelDraft ?? model.data?.model ?? 'fast';
  const modelDirty = modelDraft !== undefined && modelDraft !== model.data?.model;
  const dirty = (draft !== undefined && draft !== query.data?.enabled) || modelDirty;
  const connected = query.data?.connected ?? false;
  const installId = useId();
  const modeId = useId();
  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; mode?: MockSuggestMode; install?: MockInstall }) =>
      api<ReplySuggestionsState>('/mock/reply-suggestions', { method: 'PUT', body }),
    onSuccess: (data) => {
      client.setQueryData(replySuggestionsKey, data);
      setDraft(undefined);
    },
  });
  const saveModel = useMutation({
    mutationFn: (value: string) =>
      api('/mock/suggest-model', { method: 'PUT', body: { model: value } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: suggestModelKey });
      setModelDraft(undefined);
    },
  });
  return (
    <Card data-testid="reply-suggestions-settings">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockSuggest.title')}</CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockSuggest.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {query.data?.install === 'upgraded' && !query.data.enabled && connected && (
          <Banner tone="info">{t('mockSuggest.upgraded')}</Banner>
        )}
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="reply-suggestions-enabled">{t('mockSuggest.enable')}</Label>
            <p className="mt-1 text-sm text-muted-foreground">{t('mockSuggest.cost')}</p>
          </div>
          <Label
            htmlFor="reply-suggestions-enabled"
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
          >
            <Switch
              id="reply-suggestions-enabled"
              checked={enabled && connected}
              onCheckedChange={setDraft}
              disabled={query.isPending || !connected}
            />
          </Label>
        </div>
        {query.data && !connected && (
          <Banner tone="warning">{t('mockSuggest.noConnection')}</Banner>
        )}
        {connected && model.data && (
          <Field
            label={t('mockPhrases.model')}
            hint={
              shownModel === 'fast'
                ? t('mockPhrases.modelFastHint', { model: model.data.fastModel })
                : t('mockPhrases.modelSlowHint')
            }
          >
            {(p) => (
              <Select value={shownModel} onValueChange={setModelDraft}>
                <SelectTrigger {...p} className="min-h-11 w-full" data-testid="suggest-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fast">
                    {t('mockPhrases.modelFast', { model: model.data.fastModel })}
                  </SelectItem>
                  <SelectItem value="agent">
                    {t('mockPhrases.modelAgent', { model: model.data.agentModel })}
                  </SelectItem>
                  {model.data.models
                    .filter((id) => id !== model.data.fastModel)
                    .map((id) => (
                      <SelectItem key={id} value={id}>
                        {id}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        )}
        {(save.error || query.error) && (
          <Banner tone="danger">{errorMessage(save.error || query.error)}</Banner>
        )}
        <SaveBar dirty={dirty}>
          <Button
            size="touch"
            disabled={!dirty || save.isPending || saveModel.isPending}
            onClick={() => {
              if (draft !== undefined && draft !== query.data?.enabled) save.mutate({ enabled });
              if (modelDirty) saveModel.mutate(shownModel);
            }}
          >
            {t('settings.save')}
          </Button>
        </SaveBar>
        <div
          className="flex flex-col gap-3 rounded-lg border border-dashed px-3 py-3"
          data-testid="mock-suggest-controls"
        >
          <Badge variant="outline" className="self-start">
            {t('mockSuggest.mockControls')}
          </Badge>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span id={installId} className="text-sm font-medium">
              {t('mockSuggest.install')}
            </span>
            <SegmentedControl<MockInstall>
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
            <SegmentedControl<MockSuggestMode>
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
