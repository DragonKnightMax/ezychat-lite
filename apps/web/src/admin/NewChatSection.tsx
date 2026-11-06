import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { NEW_CHAT_MAX_DAILY_LIMIT, type NewChatSettingsBody } from '@ezychat/shared';
import { errorMessage } from '../api/client';
import { useNewChatStatus, useUpdateNewChatSettings } from '../api/new-chat';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Pending, SaveBar } from './adminUi';

/**
 * Settings → General → New chats (docs/features/new-chat/design.md): admins can always start a chat with
 * a new number; the switch lets team members do it too (off by default). The daily limit per linked
 * WhatsApp number is the admin's choice (default 20, 0 = no limit), shared with AI assistants (MCP).
 * Each change is audited with before/after.
 */
export function NewChatSection() {
  const { t } = useTranslation('admin');
  const status = useNewChatStatus();
  const update = useUpdateNewChatSettings();
  const staffId = useId();
  const limitId = useId();
  const [staffDraft, setStaffDraft] = useState<boolean>();
  const [limitDraft, setLimitDraft] = useState<string>();
  const savedStaff = status.data?.staffEnabled ?? false;
  const savedLimit = status.data?.dailyLimit ?? 20;
  const staff = staffDraft ?? savedStaff;
  const limitText = limitDraft ?? String(savedLimit);
  const limit = Number(limitText);
  const limitError =
    limitText.trim() === '' ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > NEW_CHAT_MAX_DAILY_LIMIT
      ? t('newChat.limitInvalid', { max: NEW_CHAT_MAX_DAILY_LIMIT })
      : undefined;
  const body: NewChatSettingsBody = {};
  if (staffDraft !== undefined && staffDraft !== savedStaff) body.staffEnabled = staffDraft;
  if (!limitError && limit !== savedLimit) body.dailyLimit = limit;
  const dirty = Object.keys(body).length > 0 || (limitDraft !== undefined && !!limitError);

  const save = () =>
    update.mutate(body, {
      onSuccess: () => {
        setStaffDraft(undefined);
        setLimitDraft(undefined);
        toast.success(t('settings.saved'));
      },
    });

  return (
    <Card className="gap-4" data-testid="new-chat-settings">
      <CardHeader>
        <CardTitle>{t('newChat.title')}</CardTitle>
        <CardDescription>{t('newChat.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor={staffId} className="leading-normal">
              {t('newChat.staff')}
            </Label>
            <p id={`${staffId}-hint`} className="mt-0.5 text-sm text-muted-foreground">
              {staff ? t('newChat.staffOn') : t('newChat.staffOff')}
            </p>
          </div>
          <Label
            htmlFor={staffId}
            className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center"
          >
            <Switch
              id={staffId}
              aria-describedby={`${staffId}-hint`}
              checked={staff}
              disabled={status.isPending}
              onCheckedChange={setStaffDraft}
            />
          </Label>
        </div>

        <div className="flex flex-col gap-2" data-testid="new-chat-daily-limit">
          <Label htmlFor={limitId}>{t('newChat.limitLabel')}</Label>
          <div className="flex items-center gap-2">
            <Input
              id={limitId}
              type="number"
              inputMode="numeric"
              min={0}
              max={NEW_CHAT_MAX_DAILY_LIMIT}
              className="h-11 max-w-32 md:h-9"
              value={limitText}
              disabled={status.isPending}
              aria-invalid={!!limitError || undefined}
              aria-describedby={`${limitId}-hint`}
              onChange={(e) => setLimitDraft(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">{t('newChat.limitUnit')}</span>
          </div>
          <p
            id={`${limitId}-hint`}
            className={limitError ? 'text-sm text-danger' : 'text-sm text-muted-foreground'}
          >
            {limitError ?? (limit === 0 ? t('newChat.limitNone') : t('newChat.limitHint'))}
          </p>
          <Banner tone="warning" title={t('newChat.limitBanTitle')}>
            {t('newChat.limitBanBody')}
          </Banner>
        </div>

        {(update.error || status.error) && (
          <Banner tone="danger">{errorMessage(update.error || status.error)}</Banner>
        )}
        <SaveBar dirty={dirty} inset="card">
          <Button
            size="touch"
            className="md:min-h-9"
            disabled={!dirty || !!limitError || update.isPending}
            onClick={save}
          >
            <Pending show={update.isPending} />
            {t('settings.save')}
          </Button>
        </SaveBar>
      </CardContent>
    </Card>
  );
}
