import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Badge } from '@/components/ui/badge';
import { setMockEdition, useMockEdition, type MockEdition } from './edition';

/** Proposed (custom-agents): mock-only switch between the Enterprise and the Lite view. */
export function EditionSwitch() {
  const { t } = useTranslation('admin');
  const edition = useMockEdition();
  const labelId = useId();
  const hintId = useId();
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed px-3 py-2"
      data-testid="mock-edition"
    >
      <Badge variant="outline">{t('mockAgents.proposed')}</Badge>
      <span id={labelId} className="text-sm font-medium">
        {t('mockAgents.edition.label')}
      </span>
      <SegmentedControl<MockEdition>
        size="sm"
        aria-labelledby={labelId}
        aria-describedby={hintId}
        value={edition}
        onValueChange={setMockEdition}
        options={[
          { value: 'enterprise', label: t('mockAgents.edition.enterprise') },
          { value: 'lite', label: t('mockAgents.edition.lite') },
        ]}
      />
      <span id={hintId} className="min-w-0 basis-full text-xs text-muted-foreground sm:basis-auto">
        {t('mockAgents.edition.hint')}
      </span>
    </div>
  );
}
