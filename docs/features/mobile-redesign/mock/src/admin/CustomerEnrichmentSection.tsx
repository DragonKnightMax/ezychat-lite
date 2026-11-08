import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, errorMessage } from '../api/client';
import { useAiMember } from '../api/ai';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { SaveBar } from './adminUi';

interface Setting {
  enabled: boolean;
  connected: boolean;
}
const key = ['mock-enrichment'];
export function CustomerEnrichmentSection() {
  const { t } = useTranslation('admin');
  const client = useQueryClient();
  const ai = useAiMember();
  const connected = ai.data?.connection.state === 'connected';
  const query = useQuery({ queryKey: key, queryFn: () => api<Setting>('/mock/enrichment') });
  const [draft, setDraft] = useState<boolean>();
  const enabled = draft ?? query.data?.enabled ?? false;
  const dirty = draft !== undefined && draft !== query.data?.enabled;
  const save = useMutation({
    mutationFn: () => api<Setting>('/mock/enrichment', { method: 'PUT', body: { enabled } }),
    onSuccess: (data) => {
      client.setQueryData(key, data);
      setDraft(undefined);
    },
  });
  const demo = useMutation({
    mutationFn: () => api('/mock/enrichment/preview', { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries(),
  });
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockEnrichment.title')}</CardTitle>
          <Badge variant="outline">{t('mockEnrichment.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockEnrichment.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="enrichment-enabled">{t('mockEnrichment.enable')}</Label>
            <p className="mt-1 text-sm text-muted-foreground">{t('mockEnrichment.independent')}</p>
          </div>
          <Label
            htmlFor="enrichment-enabled"
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
          >
            <Switch
              id="enrichment-enabled"
              checked={enabled}
              onCheckedChange={setDraft}
              disabled={query.isPending}
            />
          </Label>
        </div>
        {ai.data && !connected && <Banner tone="warning">{t('mockEnrichment.paused')}</Banner>}
        <p className="text-sm text-muted-foreground">{t('mockEnrichment.thresholds')}</p>
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm text-primary">
            {t('mockEnrichment.rules')}
          </summary>
          <p className="text-sm text-muted-foreground">{t('mockEnrichment.weights')}</p>
        </details>
        {(save.error || query.error || demo.error) && (
          <Banner tone="danger">{errorMessage(save.error || query.error || demo.error)}</Banner>
        )}
        <SaveBar dirty={dirty}>
          <Button size="touch" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {t('settings.save')}
          </Button>
        </SaveBar>
        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button
            variant="outline"
            size="touch"
            onClick={() => demo.mutate()}
            disabled={!query.data?.enabled || !connected || demo.isPending}
          >
            {t('mockEnrichment.demo')}
          </Button>
          <Button asChild variant="link" size="touch">
            <Link to="/admin/audit">{t('mockEnrichment.audit')}</Link>
          </Button>
        </div>
        {demo.isSuccess && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('mockEnrichment.delivered')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
