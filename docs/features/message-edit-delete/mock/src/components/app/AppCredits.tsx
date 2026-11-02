import * as React from 'react';
import { ChevronDown, ExternalLink, LifeBuoy } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ANCHOR_SPRINT_URL, CUSTOM_FEATURE_URL, GITHUB_ISSUES_URL } from '@/lib/links';

function CreditLink({
  href,
  children,
  className,
}: {
  href: string;
  /** Optional so `<Trans>` can supply the translated link text. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}
    >
      {children}
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

/** Muted attribution and support, with a stacked layout for narrow admin sidebars. */
export function AppCredits({
  version,
  className,
  variant = 'inline',
}: {
  version?: string;
  className?: string;
  variant?: 'inline' | 'sidebar';
}) {
  const { t } = useTranslation('app');
  const [open, setOpen] = React.useState(false);
  const linksId = React.useId();
  if (variant === 'sidebar') {
    // One quiet "Help & feedback" row instead of three always-visible links (version inside).
    return (
      <div className={cn('min-w-0 text-xs text-muted-foreground', className)}>
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="touch"
            aria-expanded={open}
            aria-controls={linksId}
            className="min-w-0 flex-1 justify-start px-2 text-sm font-normal text-muted-foreground"
            onClick={() => setOpen((o) => !o)}
          >
            <LifeBuoy aria-hidden="true" />
            <span className="truncate">{t('credits.helpFeedback')}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn('ml-auto transition-transform', open && 'rotate-180')}
            />
          </Button>
        </div>
        <nav
          id={linksId}
          hidden={!open}
          aria-label={t('credits.supportLinks')}
          className="flex flex-col pl-6"
        >
          {/* The version lives in the panel: beside the toggle it squeezed "Help & feedback". */}
          {version && (
            <span className="px-2 py-1 whitespace-nowrap">
              {t('credits.versionShort', { version })}
            </span>
          )}
          {[
            { href: GITHUB_ISSUES_URL, label: t('credits.reportIssue') },
            { href: CUSTOM_FEATURE_URL, label: t('credits.customFeatures') },
          ].map(({ href, label }) => (
            <Button
              key={label}
              asChild
              variant="ghost"
              size="touch"
              className="justify-between px-2 text-sm font-normal text-muted-foreground"
            >
              <a href={href} target="_blank" rel="noopener noreferrer">
                {label}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            </Button>
          ))}
          <span className="inline-flex items-center gap-1 px-2 whitespace-nowrap">
            <Trans
              t={t}
              i18nKey="credits.builtBy"
              components={{ a: <CreditLink href={ANCHOR_SPRINT_URL} className="min-h-11" /> }}
            />
          </span>
        </nav>
      </div>
    );
  }

  return (
    <p
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs text-muted-foreground',
        className,
      )}
    >
      {version && <span>{t('credits.versionShort', { version })}</span>}
      <span className="inline-flex items-center gap-1">
        <Trans
          t={t}
          i18nKey="credits.builtBy"
          components={{ a: <CreditLink href={ANCHOR_SPRINT_URL} /> }}
        />
      </span>
      <CreditLink href={GITHUB_ISSUES_URL}>{t('credits.reportIssue')}</CreditLink>
      <span className="inline-flex flex-wrap items-center justify-center gap-1">
        <Trans
          t={t}
          i18nKey="credits.customFeature"
          components={{ a: <CreditLink href={CUSTOM_FEATURE_URL} /> }}
        />
      </span>
    </p>
  );
}

export default AppCredits;
