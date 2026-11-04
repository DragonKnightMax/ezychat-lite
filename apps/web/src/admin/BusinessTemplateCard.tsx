import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGrid, Search } from 'lucide-react';
import { Banner, ResponsiveDialog } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import {
  BUSINESS_TEMPLATES,
  isGroupAgentTemplate,
  TEMPLATE_CATEGORIES,
  templateMatches,
  type BusinessTemplateId,
  type TemplateCategory,
} from './business-templates';

/**
 * "Start from a business template": opens the template gallery. Apply fills the page's draft (the
 * admin checks it and saves); `pendingItem` names the Business context item the next Save adds.
 * `groupSetup` follows a group-agent template (Claims): what Save does for a new agent, or what the
 * admin still switches on an existing one, then the remaining steps.
 */
export function BusinessTemplateCard({
  disabled,
  pendingItem,
  groupSetup = null,
  onApply,
}: {
  disabled: boolean;
  pendingItem: string | null;
  groupSetup?: 'new' | 'existing' | null;
  onApply: (id: BusinessTemplateId) => void;
}) {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);
  return (
    <Card className="gap-4" data-testid="business-templates">
      <CardHeader>
        <CardTitle>{t('ai.businessTemplates.title')}</CardTitle>
        <CardDescription>
          {t('ai.businessTemplates.hint', { count: BUSINESS_TEMPLATES.length })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-0 flex-[1_1_240px] text-sm text-muted-foreground">
          {pendingItem
            ? t('ai.businessTemplates.pendingItem', { item: pendingItem })
            : t('ai.businessTemplates.applyHint')}
        </p>
        {groupSetup && (
          <div className="order-last basis-full" data-testid="group-setup">
            <Banner tone="info">
              <p>
                {groupSetup === 'new'
                  ? t('ai.businessTemplates.groupSetupNew')
                  : t('ai.businessTemplates.groupSetupExisting')}
              </p>
              <p className="mt-1">{t('ai.businessTemplates.groupSetupNext')}</p>
            </Banner>
          </div>
        )}
        <Button
          type="button"
          size="touch"
          className="md:min-h-9"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <LayoutGrid aria-hidden />
          {t('ai.businessTemplates.browse')}
        </Button>
      </CardContent>
      <TemplateGallery
        open={open}
        onOpenChange={setOpen}
        onApply={(id) => {
          setOpen(false);
          onApply(id);
        }}
      />
    </Card>
  );
}

/** The gallery: search, category chips and the template cards; Apply hands the choice back. */
function TemplateGallery({
  open,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (id: BusinessTemplateId) => void;
}) {
  const { t } = useTranslation('admin');
  const { t: tCommon } = useTranslation('common');
  const listId = useId();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<TemplateCategory | null>(null);
  const [selected, setSelected] = useState<BusinessTemplateId | null>(null);
  const shown = useMemo(
    () =>
      BUSINESS_TEMPLATES.filter(
        (tpl) =>
          (category === null || tpl.category === category) && templateMatches(tpl.id, query, t),
      ),
    [category, query, t],
  );
  const chip = (value: TemplateCategory | null, label: string) => (
    <Button
      key={value ?? 'all'}
      type="button"
      size="sm"
      variant={category === value ? 'default' : 'outline'}
      aria-pressed={category === value}
      className="min-h-11 rounded-full md:min-h-8"
      onClick={() => setCategory(value)}
    >
      {label}
    </Button>
  );
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={t('ai.businessTemplates.galleryTitle')}
      description={t('ai.businessTemplates.galleryHint')}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="sm:min-h-9"
            onClick={() => onOpenChange(false)}
          >
            {tCommon('actions.cancel')}
          </Button>
          <Button
            type="button"
            size="touch"
            className="sm:min-h-9"
            disabled={selected === null}
            onClick={() => selected && onApply(selected)}
          >
            {t('ai.businessTemplates.apply')}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3 pb-1" data-testid="template-gallery">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            aria-label={t('ai.businessTemplates.search')}
            placeholder={t('ai.businessTemplates.searchPlaceholder')}
            className="min-h-11 ps-9 md:min-h-9"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div
          role="group"
          aria-label={t('ai.businessTemplates.categories')}
          className="flex flex-wrap gap-2"
        >
          {chip(null, t('ai.businessTemplates.category.all'))}
          {TEMPLATE_CATEGORIES.map((c) => chip(c, t(`ai.businessTemplates.category.${c}`)))}
        </div>
        {shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" role="status">
            {t('ai.businessTemplates.noMatch')}
          </p>
        ) : (
          <RadioGroup
            id={listId}
            aria-label={t('ai.businessTemplates.galleryTitle')}
            value={selected ?? ''}
            onValueChange={(value) => setSelected(value as BusinessTemplateId)}
            className="grid gap-3 sm:max-h-[50vh] sm:grid-cols-2 sm:overflow-y-auto sm:p-0.5 lg:grid-cols-3"
          >
            {shown.map(({ id, preset, icon: Icon }) => {
              const optionId = `${listId}-${id}`;
              const name = t(`ai.businessTemplates.${id}.name`);
              return (
                <Label
                  key={id}
                  htmlFor={optionId}
                  className={cn(
                    'flex min-h-11 cursor-pointer flex-col items-start gap-1.5 rounded-lg border bg-card p-3 font-normal transition-colors',
                    'hover:bg-accent has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5',
                    'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <Icon aria-hidden className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 font-medium">{name}</span>
                    {/* Named by the business only: the type line below would make "FAQ" ambiguous. */}
                    <RadioGroupItem
                      id={optionId}
                      value={id}
                      aria-label={name}
                      className="ml-auto"
                    />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {isGroupAgentTemplate(id)
                      ? [t(`ai.presets.${preset}`), t('ai.businessTemplates.groupAgentTag')].join(
                          ' · ',
                        )
                      : t(`ai.presets.${preset}`)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t(`ai.businessTemplates.${id}.description`)}
                  </span>
                </Label>
              );
            })}
          </RadioGroup>
        )}
      </div>
    </ResponsiveDialog>
  );
}
