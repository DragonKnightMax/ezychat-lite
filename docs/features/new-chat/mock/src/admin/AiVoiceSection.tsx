import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck, Download } from 'lucide-react';
import { toast } from 'sonner';
import {
  VOICE_MODEL_BYTES,
  type VoiceModelError,
  type VoiceStatus,
  type VoiceTranscription,
} from '@ezychat/shared';
import { useVoiceAction, useVoiceStatus } from '../api/voice';
import { errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import { ConfirmDialog, ErrorState, ListSkeleton, Pending } from './adminUi';
// Proposed (claude-provider): with the Claude connection, cloud transcription (OpenAI) is hidden.
import { useMockClaude } from '../mock/claude';
import { InfoTip } from '@/components/app/InfoTip';

const MB = 1024 * 1024;
/** Shown on the download button, rounded to 10 MB (the pinned files total ~358 MiB). */
const MODEL_MB = Math.round(VOICE_MODEL_BYTES / MB / 10) * 10;

/** Settings → AI → Voice messages: transcription engine and the local Whisper model. */
export function AiVoiceSection() {
  const query = useVoiceStatus();
  if (!query.data)
    return query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <ListSkeleton rows={2} />
    );
  return <VoiceCard status={query.data} />;
}

function VoiceCard({ status }: { status: VoiceStatus }) {
  const { t } = useTranslation('admin');
  const groupLabel = useId();
  const action = useVoiceAction();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const model = status.model;
  const installed = model.state === 'installed';
  const claude = useMockClaude().active;

  const allOptions: Array<{
    value: VoiceTranscription;
    label: string;
    hint: string;
    disabled: boolean;
  }> = [
    { value: 'off', label: t('ai.voice.off'), hint: t('ai.voice.offHint'), disabled: false },
    {
      value: 'local',
      label: t('ai.voice.local'),
      hint: installed ? t('ai.voice.localHint') : t('ai.voice.localNeedsModel'),
      disabled: !installed,
    },
    {
      value: 'cloud',
      label: t('ai.voice.cloud'),
      hint: status.cloudAvailable ? t('ai.voice.cloudHint') : t('ai.voice.cloudNeedsKey'),
      disabled: !status.cloudAvailable,
    },
  ];
  const options = claude ? allOptions.filter((option) => option.value !== 'cloud') : allOptions;
  const errorText: Record<VoiceModelError, string> = {
    disk_space: t('ai.voice.errors.disk_space'),
    network: t('ai.voice.errors.network'),
    verification: t('ai.voice.errors.verification'),
    redirect: t('ai.voice.errors.redirect'),
    write: t('ai.voice.errors.write'),
    unknown: t('ai.voice.errors.unknown'),
  };
  const percent = model.totalBytes
    ? Math.min(100, Math.floor((model.receivedBytes / model.totalBytes) * 100))
    : 0;

  const choose = (value: string) =>
    action.mutate(
      { kind: 'set', transcription: value as VoiceTranscription },
      { onSuccess: () => toast.success(t('ai.voice.saved')) },
    );

  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>{t('ai.voice.title')}</CardTitle>
          <InfoTip topic="voice" />
        </div>
        <CardDescription>{t('ai.voice.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend id={groupLabel} className="mb-2 text-sm font-medium">
            {t('ai.voice.engine')}
          </legend>
          <RadioGroup
            aria-labelledby={groupLabel}
            value={status.transcription}
            onValueChange={choose}
            disabled={action.isPending}
            className={cn('grid gap-2', claude ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}
          >
            {options.map((option) => {
              const id = `voice-engine-${option.value}`;
              return (
                <Label
                  key={option.value}
                  htmlFor={id}
                  className={cn(
                    'flex min-h-11 cursor-pointer flex-col items-start gap-1 rounded-lg border p-3 leading-normal transition-colors hover:bg-accent',
                    status.transcription === option.value && 'border-primary bg-primary/5',
                    option.disabled && 'cursor-not-allowed opacity-70 hover:bg-transparent',
                  )}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <RadioGroupItem id={id} value={option.value} disabled={option.disabled} />
                    {option.label}
                  </span>
                  <span className="font-normal text-muted-foreground">{option.hint}</span>
                </Label>
              );
            })}
          </RadioGroup>
          {claude &&
            (status.transcription === 'cloud' ? (
              <Banner tone="warning">{t('mockClaude.voiceCloudOff')}</Banner>
            ) : (
              <p className="text-sm text-muted-foreground">{t('mockClaude.voiceNote')}</p>
            ))}
        </fieldset>

        <section
          className="flex flex-col gap-3 rounded-lg border p-3"
          aria-labelledby="voice-model"
        >
          <h3 id="voice-model" className="text-sm font-medium">
            {t('ai.voice.modelTitle')}
          </h3>
          {model.state === 'downloading' ? (
            <div className="flex flex-col gap-2">
              <Progress value={percent} aria-label={t('ai.voice.downloading', { percent })} />
              <p role="status" className="text-sm text-muted-foreground">
                {t('ai.voice.downloading', { percent })}{' '}
                {t('ai.voice.downloadProgress', {
                  done: Math.floor(model.receivedBytes / MB),
                  total: Math.round(model.totalBytes / MB),
                })}
              </p>
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="self-start"
                disabled={action.isPending}
                onClick={() => action.mutate({ kind: 'cancel' })}
              >
                {t('ai.voice.cancel')}
              </Button>
            </div>
          ) : installed ? (
            <div className="flex flex-wrap items-center gap-3">
              <p role="status" className="flex items-center gap-1.5 text-sm">
                <CircleCheck className="size-4 text-success" aria-hidden />
                {t('ai.voice.installed')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="touch"
                disabled={action.isPending}
                onClick={() => setConfirmRemove(true)}
              >
                {t('ai.voice.remove')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {model.state === 'error' && model.error ? (
                <Banner tone="danger">{errorText[model.error]}</Banner>
              ) : (
                <p className="text-sm text-muted-foreground">{t('ai.voice.notInstalled')}</p>
              )}
              <Button
                type="button"
                size="touch"
                className="self-start whitespace-normal text-left"
                disabled={action.isPending}
                onClick={() => action.mutate({ kind: 'download' })}
              >
                <Pending show={action.isPending} />
                {!action.isPending && <Download aria-hidden />}
                {t('ai.voice.download', { size: MODEL_MB })}
              </Button>
            </div>
          )}
        </section>

        <p className="text-sm text-muted-foreground">
          {claude ? t('mockClaude.voicePrivacy') : t('ai.voice.privacy')}
        </p>
        {action.error && !confirmRemove && (
          <Banner tone="danger">{errorMessage(action.error)}</Banner>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmRemove}
        title={t('ai.voice.removeTitle')}
        confirmLabel={t('ai.voice.removeConfirm')}
        danger
        loading={action.isPending}
        error={confirmRemove ? action.error : undefined}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() =>
          action.mutate({ kind: 'remove' }, { onSuccess: () => setConfirmRemove(false) })
        }
      >
        {t('ai.voice.removeText')}
      </ConfirmDialog>
    </Card>
  );
}
