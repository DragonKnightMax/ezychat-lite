import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { useServerMode } from '@/lib/version';

/**
 * Marks a dev or test server (`--mode dev`) on every screen and in the tab title, so a local test
 * instance is never mistaken for the real inbox. Renders nothing for production servers.
 */
export function DevBuildBadge() {
  const { t } = useTranslation('common');
  const dev = useServerMode() === 'dev';
  const label = t('devBuild');

  useEffect(() => {
    if (!dev) return;
    const prefix = `[${label}] `;
    const mark = () => {
      if (!document.title.startsWith(prefix)) document.title = prefix + document.title;
    };
    mark();
    // Pages set their own titles later; keep the prefix on whatever they set.
    const titleEl = document.querySelector('title');
    const observer = titleEl ? new MutationObserver(mark) : null;
    if (titleEl) observer?.observe(titleEl, { childList: true });
    return () => observer?.disconnect();
  }, [dev, label]);

  if (!dev) return null;
  // A small tab hanging from the top edge, centred: corners hold the avatar, menu, sidebar
  // links and last-card actions, which a corner badge used to cover.
  return (
    <Badge
      variant="destructive"
      className="pointer-events-none fixed top-[env(safe-area-inset-top)] left-1/2 z-50 -translate-x-1/2 rounded-none rounded-b-md px-2 py-0 text-[0.625rem] leading-3.5 opacity-90 shadow-sm"
      role="status"
    >
      {label}
    </Badge>
  );
}
