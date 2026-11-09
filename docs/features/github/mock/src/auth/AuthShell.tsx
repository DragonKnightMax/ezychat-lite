import * as React from 'react';
import { ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LanguageSelect } from '@/i18n/LanguageSelect';
import { GITHUB_ISSUES_URL } from '@/lib/links';
import { useAppVersion } from '@/lib/version';

/** Official EzyChat brand mark, shared by desktop and installed PWA. */
export function AppMark({ className = 'size-10' }: { className?: string }) {
  return (
    <img
      src="/icon-192.png"
      alt=""
      aria-hidden="true"
      className={cn('select-none rounded-lg', className)}
    />
  );
}

/** Centered, safe-area aware Card layout for login / setup / password screens. */
export function AuthShell({
  title,
  subtitle,
  children,
  wide = false,
  illustration,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
  /** Optional decorative illustration shown above the title. */
  illustration?: string;
}) {
  const { t } = useTranslation(['common', 'app']);
  const version = useAppVersion();
  return (
    <div className="safe-x safe-top safe-bottom relative min-h-dvh bg-background text-foreground">
      <main className="flex min-h-dvh flex-col items-center px-4 py-8 sm:justify-center">
        <div className={cn('w-full min-w-0', wide ? 'max-w-xl' : 'max-w-sm')}>
          {/* Top-right of the page on wider screens; above the card on phones. */}
          <div className="mb-2 flex justify-end sm:absolute sm:top-4 sm:right-4 sm:mb-0">
            <LanguageSelect />
          </div>
          <div className="mb-4 flex items-center justify-center gap-2">
            <AppMark className="size-8 rounded-lg" />
            <span className="text-sm font-semibold tracking-tight">{t('appName')}</span>
          </div>
          <Card className="gap-5 py-5 sm:py-6">
            <CardHeader className="items-center px-4 text-center sm:px-6">
              {illustration && (
                <img
                  src={illustration}
                  alt=""
                  aria-hidden="true"
                  className="mx-auto mb-1 h-28 w-auto max-w-full select-none object-contain"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              )}
              <CardTitle>
                <h1 className="text-xl font-semibold leading-tight">{title}</h1>
              </CardTitle>
              {subtitle && <CardDescription>{subtitle}</CardDescription>}
            </CardHeader>
            <CardContent className="px-4 sm:px-6">{children}</CardContent>
          </Card>
          {/* Only what someone stuck at sign-in needs: the version and a way to report it. */}
          <footer className="mt-4 flex items-center justify-center gap-x-3 text-sm text-muted-foreground">
            {version && <span>{t('app:credits.versionShort', { version })}</span>}
            <a
              href={GITHUB_ISSUES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1 rounded-sm px-1 py-2 underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {t('app:credits.reportIssue')}
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
            </a>
          </footer>
        </div>
      </main>
    </div>
  );
}

/** Label + Input + hint/error, wired with ids for accessibility. 16px text, 44px tall. */
export function Field({
  label,
  hint,
  error,
  className,
  id: idProp,
  ...props
}: React.ComponentProps<'input'> & {
  label: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
}) {
  const { t } = useTranslation('auth');
  const autoId = React.useId();
  const id = idProp ?? autoId;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const isPassword = props.type === 'password';
  const [revealed, setRevealed] = React.useState(false);
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn('h-11 text-base md:text-base', isPassword && 'pr-12')}
          {...props}
          type={isPassword && revealed ? 'text' : props.type}
        />
        {isPassword && (
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            className="absolute inset-y-0 right-0 text-muted-foreground hover:bg-transparent"
            aria-label={revealed ? t('reveal.hide') : t('reveal.show')}
            aria-controls={id}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
        )}
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Spinner icon used inside busy Buttons. */
export function ButtonSpinner() {
  return <Loader2 className="animate-spin" aria-hidden="true" />;
}

/** Full-viewport loading state while auth/setup status resolves. */
export function FullPageLoader({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ?? t('status.loading')}
      className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground"
    >
      <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
    </div>
  );
}
