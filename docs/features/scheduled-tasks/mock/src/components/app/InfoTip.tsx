import { useId, useRef, useState } from 'react';
import { ChevronDown, CircleHelp, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TIPS, guideUrl, type TipTopic } from '@/lib/tips';

/**
 * PROPOSED (concept-tips): a small "?" next to a label or title. Click or tap opens a short card:
 * what the concept is in one or two sentences, then one row of actions (the outside page where the
 * thing is made, "Show steps" when there are steps, "Full guide"). Steps stay folded until asked for.
 * Nothing is sent or saved; it closes with Esc or a click outside.
 */
export function InfoTip({ topic, className }: { topic: TipTopic; className?: string }) {
  const { t: typedT, i18n } = useTranslation('common');
  // Keys are built from the topic; the catalog tests check every topic's keys exist.
  const t = typedT as unknown as (key: string) => string;
  const tip = TIPS[topic];
  const key = (part: string) => `mockTips.${topic}.${part}`;
  const steps = Array.from({ length: tip.steps }, (_, i) => t(key(`step${i + 1}`)));
  const [showSteps, setShowSteps] = useState(false);
  const stepsId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  return (
    <Popover onOpenChange={(open) => !open && setShowSteps(false)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t(key('title'))}
          data-tip={topic}
          className={cn(
            // 20 px icon, 44 px hit area (the ::after box) so it is easy to tap on a phone.
            'relative inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground',
            'transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            'data-[state=open]:text-primary after:absolute after:-inset-3 after:content-[""]',
            className,
          )}
        >
          <CircleHelp className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={cardRef}
        align="start"
        collisionPadding={16}
        className="flex max-h-(--radix-popover-content-available-height) w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto text-sm"
      >
        <p className="font-semibold">{t(key('title'))}</p>
        <p className="text-muted-foreground">{t(key('body'))}</p>
        {(tip.action || steps.length > 0 || tip.guide) && (
          <div className="flex flex-wrap items-center gap-x-3">
            {tip.action && (
              <Button asChild size="touch" variant="outline" className="md:min-h-9">
                <a href={tip.action} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden />
                  {t(key('action'))}
                </a>
              </Button>
            )}
            {steps.length > 0 && (
              <Button
                type="button"
                size="touch"
                variant="link"
                className="px-0 md:min-h-9"
                aria-expanded={showSteps}
                aria-controls={stepsId}
                onClick={() => {
                  setShowSteps((v) => !v);
                  // The card grows: keep all of it on screen (phones open it low on the page).
                  requestAnimationFrame(() =>
                    cardRef.current?.scrollIntoView({ block: 'nearest' }),
                  );
                }}
              >
                {showSteps ? t('mockTips.hideSteps') : t('mockTips.showSteps')}
                <ChevronDown
                  aria-hidden
                  className={cn('transition-transform', showSteps && 'rotate-180')}
                />
              </Button>
            )}
            {tip.guide && (
              <Button asChild size="touch" variant="link" className="px-0 md:min-h-9">
                <a
                  href={guideUrl(tip.guide, i18n.language, topic)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('mockTips.guide')}
                </a>
              </Button>
            )}
          </div>
        )}
        {showSteps && (
          <ol
            id={stepsId}
            className="flex list-decimal flex-col gap-0.5 pl-5 text-muted-foreground marker:text-foreground"
          >
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
      </PopoverContent>
    </Popover>
  );
}
