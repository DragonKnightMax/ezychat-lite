import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';

type Scenario = 'ok' | 'offline' | 'rate_limited';
interface SentReport {
  reference: string;
  product: string;
  report: { type: string; title: string; email: string; area: string; impact?: string };
  files: { name: string; size: number }[];
  diagnostics: Record<string, unknown> | null;
  logLines: number | null;
  recorded: { ip: string; country: string; region: string; city: string };
  install: string | null;
  notified: string;
}
interface MockState {
  scenario: Scenario;
  sent: SentReport[];
}

/**
 * Proposed (in-app-feedback), mock only: switch how the licence portal answers (works, unreachable,
 * too many reports) and see what it recorded for the last report, including the IP address, country
 * and the email to general@ezychat.ai. The app has no such panel.
 */
export function FeedbackMockPanel() {
  const { t } = useTranslation('app');
  const id = useId();
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['mock', 'feedback'],
    queryFn: () => api<MockState>('/mock/feedback'),
    refetchInterval: 1500,
  });
  const setScenario = useMutation({
    mutationFn: (scenario: Scenario) =>
      api<MockState>('/mock/feedback/scenario', { method: 'PUT', body: { scenario } }),
    onSuccess: (data) => qc.setQueryData(['mock', 'feedback'], data),
  });
  const clear = useMutation({
    mutationFn: () => api<MockState>('/mock/feedback', { method: 'DELETE' }),
    onSuccess: (data) => qc.setQueryData(['mock', 'feedback'], data),
  });
  const last = state.data?.sent[0];
  return (
    <section
      className="space-y-3 rounded-lg border border-dashed px-3 py-3 text-sm"
      data-testid="feedback-mock-panel"
    >
      <p id={`${id}-s`} className="font-medium">
        {t('feedbackMock.title')}
      </p>
      <SegmentedControl
        aria-labelledby={`${id}-s`}
        size="sm"
        className="w-full [&>label]:flex-1"
        value={state.data?.scenario ?? 'ok'}
        onValueChange={(v) => setScenario.mutate(v)}
        options={(['ok', 'offline', 'rate_limited'] as const).map((v) => ({
          value: v,
          label: t(`feedbackMock.scenario.${v}`),
        }))}
      />
      {last ? (
        <div className="space-y-1" data-testid="feedback-mock-received">
          <p className="font-medium">
            {t('feedbackMock.received', { reference: last.reference, product: last.product })}
          </p>
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {last.report.type} · {last.report.area}
            {last.report.impact ? ` · ${last.report.impact}` : ''} · “{last.report.title}” ·{' '}
            {last.report.email}
          </p>
          <p className="text-muted-foreground">
            {t('feedbackMock.recorded', {
              ip: last.recorded.ip,
              place: `${last.recorded.city}, ${last.recorded.region}, ${last.recorded.country}`,
            })}
          </p>
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {t('feedbackMock.extras', {
              files: last.files.length ? last.files.map((f) => f.name).join(', ') : '—',
              details: last.diagnostics ? t('feedbackMock.yes') : t('feedbackMock.no'),
              log: last.logLines
                ? t('feedbackMock.logLines', { lines: last.logLines })
                : t('feedbackMock.no'),
            })}
          </p>
          <p className="text-muted-foreground">
            {last.install
              ? t('feedbackMock.install', { install: last.install })
              : t('feedbackMock.noInstall')}
          </p>
          <p className="text-muted-foreground">
            {t('feedbackMock.notified', { to: last.notified })}
          </p>
          <Button variant="ghost" size="touch" onClick={() => clear.mutate()}>
            {t('feedbackMock.clear')}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">{t('feedbackMock.none')}</p>
      )}
    </section>
  );
}
