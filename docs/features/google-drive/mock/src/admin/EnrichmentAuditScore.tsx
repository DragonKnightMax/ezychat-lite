import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AuditEntry } from '@ezychat/shared';
import { ResponsiveDialog } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Record {
  average: number;
  messageId: string;
  policy: string;
  fields: {
    field: 'name' | 'company' | 'email';
    score: number;
    points: number[];
    operation: 'added' | 'replaced';
    threshold: number;
    reason: string;
  }[];
}
const CRITERIA = ['ownership', 'clarity', 'context', 'validation', 'freshness'] as const;
export function EnrichmentAuditScore({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);
  if (entry.action !== 'customer.enrichment_update') return null;
  const record = entry.meta.enrichment as Record;
  if (!record?.fields?.length) return null;
  return (
    <>
      <Button
        variant="link"
        size="touch"
        className="gap-1 px-0 underline has-[>svg]:px-0 md:pointer-fine:min-h-8"
        aria-label={`${t('mockEnrichment.details')}: ${t('mockEnrichment.average', { score: Math.round(record.average) })}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {t('mockEnrichment.average', { score: Math.round(record.average) })}
        <ChevronRight aria-hidden className="size-3.5" />
      </Button>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        size="medium"
        title={t('mockEnrichment.details')}
        description={t('mockEnrichment.meaning')}
        footer={
          <Button variant="outline" size="touch" onClick={() => setOpen(false)}>
            {t('mockEnrichment.close')}
          </Button>
        }
      >
        <div className="space-y-5">
          <div className="flex items-center gap-4 border-b pb-4">
            <strong className="text-3xl">
              {Math.round(record.average)}
              <span className="text-base font-normal text-muted-foreground">/100</span>
            </strong>
            <p className="text-sm text-muted-foreground">
              {t('mockEnrichment.savedFields', { count: record.fields.length })}
            </p>
          </div>
          {record.fields.map((field) => (
            <section key={field.field} className="space-y-3 border-b pb-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{t(`mockEnrichment.fields.${field.field}`)}</strong>
                  <Badge variant="secondary">{t(`mockEnrichment.${field.operation}`)}</Badge>
                </div>
                <div className="text-right">
                  <strong>{field.score}/100</strong>
                  <p className="text-xs text-muted-foreground">
                    {t('mockEnrichment.threshold', { score: field.threshold })}
                  </p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">{field.reason}</p>
              <dl className="space-y-2">
                {CRITERIA.map((criterion, index) => (
                  <div key={criterion} className="flex justify-between gap-4 text-sm">
                    <dt className="text-muted-foreground">
                      {t(`mockEnrichment.criteria.${criterion}`)}
                    </dt>
                    <dd>
                      {field.points[index]} / {[30, 25, 20, 15, 10][index]}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <Button asChild variant="link" size="touch">
            <Link to={`/chats/${encodeURIComponent(String(entry.meta.chatJid))}`}>
              {t('mockEnrichment.source')}
            </Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            {t('mockEnrichment.policy', {
              average: record.average.toFixed(2),
              policy: record.policy,
            })}
          </p>
        </div>
      </ResponsiveDialog>
    </>
  );
}
