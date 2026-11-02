import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bug,
  ExternalLink,
  Info,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Share2,
  Sparkles,
  Sun,
  UserRound,
} from 'lucide-react';
import { isLocale, SUPPORTED_LOCALES } from '@ezychat/shared';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AboutDialog } from '@/components/app';
import { FeatureRequestAction } from '@/components/app/FeatureRequestAction';
import { ShareAppAction } from '@/components/app/ShareAppAction';
import { GITHUB_ISSUES_URL } from '@/lib/links';
import { initials } from '@/lib/format';
import { useAppVersion } from '@/lib/version';
import { THEME_OPTIONS, useTheme } from '@/lib/theme';
import { useChangeLocale } from '@/i18n/use-change-locale';
import { PushToggle } from '../pwa/PushToggle';
import { useAuth } from './AuthProvider';
// Proposed (upgrade-enterprise)
import { useUpgradeUrl } from '@/components/app/UpgradeEnterprise';

/**
 * Account menu: display name, appearance, language, push-notification toggle, Admin link
 * (admins only), change password and sign out. The English accessible names ("Account menu",
 * "Admin settings", "Sign out") are relied on by e2e tests, which run in English.
 */
/** Short button text for the language switch (endonyms/codes, not translated). */
const SHORT_LOCALE: Record<string, string> = { en: 'EN', ms: 'BM', 'zh-CN': '中文' };
function shortLocaleLabel(code: string, nativeName: string): string {
  return SHORT_LOCALE[code] ?? nativeName;
}

interface MenuSegmentOption {
  value: string;
  /** accessible name (also the hover title) */
  title: string;
  lang?: string;
  content: React.ReactNode;
}

/** A label plus a joined row of radio menu items; stays open on select, reachable by arrow keys. */
function MenuSegments({
  labelId,
  label,
  value,
  onValueChange,
  options,
}: {
  labelId: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly MenuSegmentOption[];
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span id={labelId} className="text-sm font-medium">
        {label}
      </span>
      <DropdownMenuRadioGroup
        aria-labelledby={labelId}
        value={value}
        onValueChange={onValueChange}
        className="inline-flex w-fit overflow-hidden rounded-md border border-input"
      >
        {options.map((option) => (
          <DropdownMenuRadioItem
            key={option.value}
            value={option.value}
            title={option.title}
            lang={option.lang}
            onSelect={(e) => e.preventDefault()}
            className={cn(
              'h-8 justify-center rounded-none border-l border-input px-2.5 py-0 pl-2.5 first:border-l-0 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
              'bg-muted text-muted-foreground focus:bg-accent focus:text-accent-foreground',
              'data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
              'data-[state=checked]:focus:bg-primary data-[state=checked]:focus:text-primary-foreground data-[state=checked]:focus:ring-[3px] data-[state=checked]:focus:ring-ring/50 data-[state=checked]:focus:ring-inset',
              '[&>span:first-child]:hidden',
            )}
          >
            {option.content}
            <span className="sr-only">{option.title}</span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </div>
  );
}

export function UserMenu({
  className,
  align = 'end',
}: {
  className?: string;
  align?: 'start' | 'center' | 'end';
}) {
  const { user, isAdmin, logout } = useAuth();
  const version = useAppVersion();
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const { locale, changeLocale } = useChangeLocale();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const upgradeUrl = useUpgradeUrl();
  if (!user) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={t('account.menu')}
            className={cn('rounded-full', className)}
          >
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                {initials(user.displayName) || (
                  <UserRound className="size-[55%]" aria-hidden="true" />
                )}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-64 max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel className="font-normal">
            <p className="truncate text-sm font-semibold">{user.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">
              @{user.username} · {t(`roles.${user.role}`)}
            </p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {/* One compact row each; the segments are real menu items, so arrow keys reach them. */}
          <div className="flex flex-col gap-1 px-2 py-1.5">
            <MenuSegments
              labelId="account-appearance-label"
              label={t('theme.label')}
              value={theme}
              onValueChange={(v) => setTheme(v as typeof theme)}
              options={THEME_OPTIONS.map((option) => {
                const Icon =
                  option.value === 'light' ? Sun : option.value === 'dark' ? Moon : Monitor;
                return {
                  value: option.value,
                  title: t(option.labelKey),
                  content: <Icon aria-hidden="true" className="size-4" />,
                };
              })}
            />
            <MenuSegments
              labelId="account-language-label"
              label={t('language.label')}
              value={locale}
              onValueChange={(v) => isLocale(v) && changeLocale(v)}
              options={SUPPORTED_LOCALES.map((l) => ({
                value: l.code,
                title: l.nativeName,
                lang: l.code,
                content: <span aria-hidden="true">{shortLocaleLabel(l.code, l.nativeName)}</span>,
              }))}
            />
          </div>
          <DropdownMenuSeparator />
          <PushToggle compact className="px-2" />
          <DropdownMenuSeparator />
          {isAdmin && (
            <DropdownMenuItem asChild className="min-h-11">
              <Link to="/admin">
                <Settings aria-hidden="true" />
                {t('account.adminSettings')}
              </Link>
            </DropdownMenuItem>
          )}
          {/* Proposed (upgrade-enterprise): admins only, Lite only. */}
          {isAdmin && upgradeUrl && (
            <DropdownMenuItem asChild className="min-h-11">
              <a
                href={upgradeUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="menu-upgrade"
              >
                <Sparkles aria-hidden="true" />
                {t('upgrade.cta')}
                <ExternalLink aria-hidden="true" className="ml-auto" />
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild className="min-h-11">
            <Link to="/change-password">
              <KeyRound aria-hidden="true" />
              {t('account.changePassword')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="min-h-11" onSelect={() => setShareOpen(true)}>
            <Share2 aria-hidden="true" />
            {t('account.share')}
          </DropdownMenuItem>
          <FeatureRequestAction placement="menu" />
          <DropdownMenuItem asChild className="min-h-11">
            <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer">
              <Bug aria-hidden="true" />
              {t('account.reportIssue')}
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onSelect={() => setAboutOpen(true)}>
            <Info aria-hidden="true" />
            {t('account.about', { appName: t('appName') })}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            className="min-h-11"
            onSelect={() => {
              void logout();
            }}
          >
            <LogOut aria-hidden="true" />
            {t('account.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} version={version ?? undefined} />
      <ShareAppAction open={shareOpen} onOpenChange={setShareOpen} />
    </>
  );
}

export default UserMenu;
