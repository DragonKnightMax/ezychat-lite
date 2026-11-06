import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { newChatKey, useNewChatState, type NewChatState } from '@/mock/newChat';
import { SaveBar } from './adminUi';

/**
 * Proposed (new-chat): Settings → General card. Admins can always start a chat with a new number; the
 * switch lets team members do it too (off by default). The daily limit per linked WhatsApp number is
 * the admin's choice (default 20, 0 = no limit; owner 2026-11-06), shared with AI assistants (MCP).
 * Both are audited with before/after.
 */
export function NewChatSection() {
  const { t } = useTranslation('admin');
  const client = useQueryClient();
  const query = useNewChatState();
  const limitId = useId();
  const [staffDraft, setStaffDraft] = useState<boolean>();
  const [limitDraft, setLimitDraft] = useState<string>();
  const staff = staffDraft ?? query.data?.staffEnabled ?? false;
  const savedLimit = query.data?.limits.perInboxPerDay ?? 20;
  const limitText = limitDraft ?? String(savedLimit);
  const limit = Number(limitText);
  const limitError =
    limitText.trim() === '' || !Number.isInteger(limit) || limit < 0 || limit > 1000
      ? t('mockNewChat.limitInvalid')
      : undefined;
  const body: { staffEnabled?: boolean; dailyLimit?: number } = {};
  if (staffDraft !== undefined && staffDraft !== query.data?.staffEnabled)
    body.staffEnabled = staffDraft;
  if (!limitError && limit !== savedLimit) body.dailyLimit = limit;
  const dirty = Object.keys(body).length > 0 || (limitDraft !== undefined && !!limitError);
  const save = useMutation({
    mutationFn: () => api<NewChatState>('/mock/new-chat', { method: 'PUT', body }),
    onSuccess: (data) => {
      client.setQueryData(newChatKey, data);
      setStaffDraft(undefined);
      setLimitDraft(undefined);
      toast.success(t('settings.saved'));
    },
  });
  return (
    <Card className="gap-4" data-testid="new-chat-settings">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>{t('mockNewChat.title')}</CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockNewChat.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="new-chat-staff">{t('mockNewChat.staff')}</Label>
            <p className="mt-1 text-sm text-muted-foreground">
              {staff ? t('mockNewChat.staffOn') : t('mockNewChat.staffOff')}
            </p>
          </div>
          <Label
            htmlFor="new-chat-staff"
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
          >
            <Switch
              id="new-chat-staff"
              checked={staff}
              onCheckedChange={setStaffDraft}
              disabled={query.isPending}
            />
          </Label>
        </div>

        <div className="flex flex-col gap-2" data-testid="new-chat-daily-limit">
          <Label htmlFor={limitId}>{t('mockNewChat.limitLabel')}</Label>
          <div className="flex items-center gap-2">
            <Input
              id={limitId}
              type="number"
              inputMode="numeric"
              min={0}
              max={1000}
              className="h-11 max-w-32 md:h-9"
              value={limitText}
              aria-invalid={!!limitError || undefined}
              aria-describedby={`${limitId}-hint`}
              onChange={(e) => setLimitDraft(e.target.value)}
              disabled={query.isPending}
            />
            <span className="text-sm text-muted-foreground">{t('mockNewChat.limitUnit')}</span>
          </div>
          {limitError ? (
            <p id={`${limitId}-hint`} className="text-sm text-danger">
              {limitError}
            </p>
          ) : (
            <p id={`${limitId}-hint`} className="text-sm text-muted-foreground">
              {limit === 0 ? t('mockNewChat.limitNone') : t('mockNewChat.limitHint')}
            </p>
          )}
          <Banner tone="warning" title={t('mockNewChat.limitBanTitle')}>
            {t('mockNewChat.limitBanBody')}
          </Banner>
        </div>

        {(save.error || query.error) && (
          <Banner tone="danger">{errorMessage(save.error || query.error)}</Banner>
        )}
        <SaveBar dirty={dirty}>
          <Button
            size="touch"
            className="md:min-h-9"
            disabled={!dirty || !!limitError || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('settings.save')}
          </Button>
        </SaveBar>
      </CardContent>
    </Card>
  );
}
