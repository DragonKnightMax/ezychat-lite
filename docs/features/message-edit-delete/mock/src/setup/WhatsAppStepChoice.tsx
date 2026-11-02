// Proposed (business-api): the setup wizard's WhatsApp step in Enterprise offers the linked phone (QR
// scan, the default) or a number on the WhatsApp Business API for the first inbox. Lite has no choice:
// the step is the QR scan as today.
import { useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, CircleCheck } from 'lucide-react';
import { SegmentedControl } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiNumberSummary, BusinessApiForm, WebhookStatus } from '../admin/BusinessApiForm';
import { useMockEdition } from '../mock/edition';
import { updateInbox, useMockInboxes, type MockApiConnection } from '../mock/inboxes';

type Choice = 'linked_phone' | 'business_api';

export function WhatsAppStepChoice({
  phoneStep,
  onContinue,
  onSkip,
}: Readonly<{
  /** Today's QR step (WaLinkStep and its demo scan). */
  phoneStep: React.ReactNode;
  onContinue(): void;
  onSkip(): void;
}>) {
  const { t } = useTranslation('admin');
  const lite = useMockEdition() === 'lite';
  const inboxes = useMockInboxes();
  const first = inboxes.inboxes[0];
  const [choice, setChoice] = useState<Choice>('linked_phone');
  const [connected, setConnected] = useState<{ api: MockApiConnection; number: string } | null>(
    null,
  );
  if (lite) return <>{phoneStep}</>;

  return (
    <div className="flex flex-col gap-5" data-testid="wa-step-choice">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span id="wa-choice-label" className="text-sm font-medium">
            {t('mockApi.setupChoice')}
          </span>
          <Badge variant="outline">{t('mockAgents.proposed')}</Badge>
        </div>
        <SegmentedControl
          aria-labelledby="wa-choice-label"
          value={choice}
          onValueChange={setChoice}
          className="w-full [&>label]:flex-1"
          options={[
            { value: 'linked_phone', label: t('mockApi.setupPhone') },
            { value: 'business_api', label: t('mockApi.setupApi') },
          ]}
        />
        <p className="text-sm text-muted-foreground">
          {choice === 'linked_phone' ? t('mockApi.typePhoneHint') : t('mockApi.typeApiHint')}
        </p>
      </div>

      {choice === 'linked_phone' && phoneStep}

      {choice === 'business_api' && (
        <div className="flex flex-col gap-5">
          <h2 className="text-base font-semibold">{t('mockApi.setupApiTitle')}</h2>
          {connected ? (
            <div className="flex flex-col gap-4">
              <div
                role="status"
                className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-sm"
              >
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                <p className="font-medium">{t('mockApi.setupConnected')}</p>
              </div>
              <ApiNumberSummary api={connected.api} number={connected.number} />
              <WebhookStatus compact />
            </div>
          ) : (
            <BusinessApiForm
              onConnected={(result) => {
                // Inbox 1 becomes a Business API inbox; its chats and keys stay inbox 1's.
                if (first)
                  updateInbox(first.id, {
                    type: 'business_api',
                    api: result.api,
                    number: result.number,
                    status: 'connected',
                  });
                setConnected(result);
              }}
            />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {!connected && (
              <Button variant="ghost" size="touch" onClick={onSkip}>
                {t('mockApi.setupSkip')}
              </Button>
            )}
            <Button size="touch" onClick={onContinue} disabled={!connected}>
              {t('mockApi.setupContinue')}
              <ArrowRight aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
