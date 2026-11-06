import { useId, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiTokenExpiry } from '@ezychat/shared';
import { useCreateApiToken } from '../api/queries';
import { errorMessage } from '../api/client';
import { Banner, ResponsiveDialog, SegmentedControl } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CopyButton, Field, Pending } from './adminUi';
import { TokenConnectSteps } from './TokenConnectSteps';

const EXPIRY_OPTIONS = ['30', '90', '365', 'never'] as const;
type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];
const EXPIRY_DAYS: Record<ExpiryOption, ApiTokenExpiry> = {
  '30': 30,
  '90': 90,
  '365': 365,
  never: null,
};
const EXPIRY_LABEL_KEY = {
  '30': 'integrations.create.expiry30',
  '90': 'integrations.create.expiry90',
  '365': 'integrations.create.expiry365',
  never: 'integrations.create.expiryNever',
} as const satisfies Record<ExpiryOption, string>;
const NAME_MAX = 64;

/**
 * Create a token, then show its secret and the connect steps exactly once. The secret lives only
 * in this component's state and is cleared whenever the dialog closes (Done, Escape or outside).
 */
export function CreateTokenDialog({
  open,
  onOpenChange,
  endpoint,
  localOnly,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Full MCP URL an assistant connects to. */
  endpoint: string;
  /** True when no tunnel runs, so the URL only works on this computer. */
  localOnly: boolean;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const formId = useId();
  const expiryLabelId = useId();
  const secretLabelId = useId();
  const create = useCreateApiToken();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<ExpiryOption>('90');
  const [canSend, setCanSend] = useState(false);
  const canSendId = useId();
  const [canNew, setCanNew] = useState(false);
  const canNewId = useId();
  const [submitted, setSubmitted] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const trimmed = name.trim();
  const nameError = !submitted
    ? undefined
    : trimmed === ''
      ? t('integrations.create.nameRequired')
      : trimmed.length > NAME_MAX
        ? t('integrations.create.nameTooLong')
        : undefined;

  const close = () => {
    setSecret(null);
    setName('');
    setExpiry('90');
    setCanSend(false);
    setCanNew(false);
    setSubmitted(false);
    create.reset();
    onOpenChange(false);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (trimmed === '' || trimmed.length > NAME_MAX || create.isPending) return;
    create.mutate({
      body: {
        name: trimmed,
        expiresInDays: EXPIRY_DAYS[expiry],
        canSend,
        canMessageNewNumbers: canSend && canNew,
      },
      onSecret: setSecret,
    });
  };

  if (secret !== null) {
    return (
      <ResponsiveDialog
        open={open}
        onOpenChange={(next) => !next && close()}
        title={t('integrations.created.title')}
        description={t('integrations.created.description')}
        size="medium"
        footer={
          <Button type="button" size="touch" className="sm:min-h-9" onClick={close}>
            {t('common:actions.done')}
          </Button>
        }
      >
        <div className="flex min-w-0 flex-col gap-5 pb-1">
          <div className="flex min-w-0 flex-col gap-2">
            <Label id={secretLabelId}>{t('integrations.created.secretLabel')}</Label>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-stretch">
              <p
                aria-labelledby={secretLabelId}
                data-testid="api-token-secret"
                className="m-0 min-w-0 flex-1 rounded-md border border-input bg-muted px-3 py-2 font-mono text-sm leading-snug [overflow-wrap:anywhere] select-all"
              >
                {secret}
              </p>
              <CopyButton
                text={secret}
                label={t('integrations.created.copyToken')}
                className="self-start sm:self-auto"
              />
            </div>
          </div>
          <TokenConnectSteps endpoint={endpoint} secret={secret} localOnly={localOnly} />
        </div>
      </ResponsiveDialog>
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !create.isPending) close();
      }}
      title={t('integrations.create.title')}
      description={t('integrations.create.description')}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="sm:min-h-9"
            disabled={create.isPending}
            onClick={close}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            size="touch"
            className="sm:min-h-9"
            disabled={create.isPending}
          >
            <Pending show={create.isPending} />
            {t('integrations.create.submit')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-5 pb-1">
        <Field
          label={t('integrations.create.name')}
          hint={t('integrations.create.nameHint')}
          error={nameError}
        >
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={NAME_MAX}
              autoComplete="off"
              required
              disabled={create.isPending}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <div className="flex flex-col gap-2">
          <Label id={expiryLabelId}>{t('integrations.create.expiry')}</Label>
          {/* Four equal columns that fit a 360px drawer in every language. */}
          <SegmentedControl
            aria-labelledby={expiryLabelId}
            value={expiry}
            onValueChange={setExpiry}
            className="grid w-full grid-cols-4 [&>label]:px-1"
            options={EXPIRY_OPTIONS.map((value) => ({
              value,
              label: t(EXPIRY_LABEL_KEY[value]),
            }))}
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <Checkbox
              id={canSendId}
              checked={canSend}
              disabled={create.isPending}
              onCheckedChange={(v) => {
                setCanSend(v === true);
                if (v !== true) setCanNew(false);
              }}
              className="mt-0.5"
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor={canSendId} className="flex flex-wrap items-center gap-2">
                {t('mockSend.canSend')}
                <Badge variant="outline">{t('mockSetup.proposed')}</Badge>
              </Label>
              <p className="text-sm text-muted-foreground">{t('mockSend.canSendHint')}</p>
            </div>
          </div>
          {canSend && <Banner tone="warning">{t('mockSend.canSendWarning')}</Banner>}
          {/* Proposed (MCP send to a new number): only under "Can send", off by default. */}
          {canSend && (
            <div className="ml-7 flex flex-col gap-2">
              <div className="flex items-start gap-3">
                <Checkbox
                  id={canNewId}
                  checked={canNew}
                  disabled={create.isPending}
                  onCheckedChange={(v) => setCanNew(v === true)}
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-1">
                  <Label htmlFor={canNewId}>{t('mockSend.canNew')}</Label>
                  <p className="text-sm text-muted-foreground">{t('mockSend.canNewHint')}</p>
                </div>
              </div>
              {canNew && (
                <Banner tone="danger" title={t('mockSend.canNewWarningTitle')}>
                  {t('mockSend.canNewWarning')}
                </Banner>
              )}
            </div>
          )}
        </div>
        {create.error != null && <Banner tone="danger">{errorMessage(create.error)}</Banner>}
      </form>
    </ResponsiveDialog>
  );
}
