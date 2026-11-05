import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Copy, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '../api/client';
import { useRequestPairingCode } from '../api/queries';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** "ABCD1234" → "ABCD-1234", the way WhatsApp displays pairing codes. */
export function formatPairingCode(code: string): string {
  const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** Link WhatsApp with a phone number + 8-character pairing code instead of scanning a QR. */
export function PhoneLink() {
  const { t } = useTranslation('inbox');
  const [phone, setPhone] = useState('');
  const req = useRequestPairingCode();
  const code = req.data?.code ? formatPairingCode(req.data.code) : null;

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          req.mutate(phone);
        }}
      >
        <Label htmlFor="wa-phone">{t('phoneLink.label')}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="wa-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+60 12-345 6789"
            className="min-h-11"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
          <Button
            type="submit"
            size="touch"
            disabled={req.isPending || phone.replace(/\D/g, '').length < 8}
          >
            <KeyRound aria-hidden="true" />
            {req.isPending ? t('phoneLink.requesting') : t('phoneLink.getCode')}
          </Button>
        </div>
      </form>

      {req.error && <Banner tone="danger">{errorMessage(req.error)}</Banner>}

      {code && (
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">{t('phoneLink.enterCode')}</p>
          <p
            data-testid="pairing-code"
            className="font-mono text-3xl font-semibold tracking-[0.2em] select-all"
          >
            {code}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(code.replace('-', ''));
              toast.success(t('phoneLink.copied'));
            }}
          >
            <Copy aria-hidden="true" />
            {t('phoneLink.copy')}
          </Button>
        </div>
      )}

      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t('phoneLink.step1')}</li>
        <li>
          <Trans
            t={t}
            i18nKey="phoneLink.step2"
            components={{ strong: <strong className="text-foreground" /> }}
          />
        </li>
        <li>
          <Trans
            t={t}
            i18nKey="phoneLink.step3"
            components={{ strong: <strong className="text-foreground" /> }}
          />
        </li>
      </ol>
    </div>
  );
}
