import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  SHEET_LAYOUT_TABS,
  SheetLayout,
  type SheetLayoutInput,
  type SheetLayoutTab,
  type SheetTabAccess,
} from '@ezychat/shared';
import { errorMessage } from '../../api/client';
import { useTemplateCatalog } from '../../api/ai-templates';
import { useCreateSheet } from '../../api/connectors';
import { Banner, SegmentedControl } from '@/components/app';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, Pending } from '../adminUi';
import { galleryTemplates } from '../business-templates';

const ACCESS = ['off', 'read', 'add'] as const satisfies readonly SheetTabAccess[];
const BLANK = 'blank';

interface DraftTab {
  key: number;
  title: string;
  /** Column names as typed, separated by commas. */
  columns: string;
  access: SheetTabAccess;
  /** A template layout's formulas (kept as they are; not edited here). */
  formulas?: SheetLayoutTab['formulas'];
}
interface Draft {
  name: string;
  tabs: DraftTab[];
}

let nextKey = 1;
const blankTab = (): DraftTab => ({ key: nextKey++, title: '', columns: '', access: 'add' });
const fromLayout = (layout: SheetLayoutInput): Draft => ({
  name: layout.name,
  tabs: layout.tabs.map((tab) => ({
    key: nextKey++,
    title: tab.title,
    columns: tab.columns.join(', '),
    access: tab.access ?? 'off',
    ...(tab.formulas?.length ? { formulas: tab.formulas } : {}),
  })),
});
const splitColumns = (text: string) =>
  text
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

/** The draft as the server's layout, or null when a box is missing or a tab name is repeated. */
export function draftLayout(draft: Draft): SheetLayout | null {
  const parsed = SheetLayout.safeParse({
    name: draft.name,
    tabs: draft.tabs.map((tab) => ({
      title: tab.title,
      columns: splitColumns(tab.columns),
      access: tab.access,
      ...(tab.formulas ? { formulas: tab.formulas } : {}),
    })),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Connectors → Google Sheets → Settings → "Create a new sheet" (docs/connector-design.md, Part E): a new
 * spreadsheet in the connected Google account, blank or from a template's layout, saved as the
 * agent's spreadsheet with each tab's access. Admins only; the AI never creates a sheet.
 */
export function CreateSheetDialog({
  agentId,
  name,
  open,
  onOpenChange,
  onCreated,
}: Readonly<{
  agentId: number;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}>) {
  const { t, i18n } = useTranslation('admin');
  const create = useCreateSheet(agentId);
  const catalog = useTemplateCatalog(open);
  const layouts = useMemo(
    () =>
      galleryTemplates(t, i18n.language, catalog.data).filter(
        (tpl): tpl is typeof tpl & { sheet: SheetLayoutInput } => tpl.sheet !== null,
      ),
    [t, i18n.language, catalog.data],
  );
  const [start, setStart] = useState(BLANK);
  const [draft, setDraft] = useState<Draft>(() => ({ name: '', tabs: [blankTab()] }));
  const [invalid, setInvalid] = useState(false);
  const headingId = useId();

  const reset = () => {
    setStart(BLANK);
    setDraft({ name: '', tabs: [blankTab()] });
    setInvalid(false);
    create.reset();
  };
  const choose = (id: string) => {
    setStart(id);
    setInvalid(false);
    const tpl = layouts.find((x) => x.id === id);
    setDraft(tpl ? fromLayout(tpl.sheet) : { name: '', tabs: [blankTab()] });
  };
  const setTab = (key: number, patch: Partial<DraftTab>) =>
    setDraft((d) => ({ ...d, tabs: d.tabs.map((x) => (x.key === key ? { ...x, ...patch } : x)) }));

  const submit = () => {
    const layout = draftLayout(draft);
    setInvalid(!layout);
    if (!layout) return;
    create.mutate(layout, {
      onSuccess: () => {
        toast.success(t('connectors.sheets.create.done'));
        onOpenChange(false);
        reset();
        onCreated();
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col sm:max-w-2xl"
        data-testid="sheets-create"
      >
        <DialogHeader>
          <DialogTitle>{t('connectors.sheets.create.title')}</DialogTitle>
          <DialogDescription>
            {t('connectors.sheets.create.description', { name })}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
          {layouts.length > 0 && (
            <Field label={t('connectors.sheets.create.start')}>
              {(p) => (
                <Select value={start} onValueChange={choose}>
                  <SelectTrigger
                    {...p}
                    className="min-h-11 w-full"
                    data-testid="sheets-create-start"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={BLANK}>{t('connectors.sheets.create.blank')}</SelectItem>
                    {layouts.map((tpl) => (
                      <SelectItem key={tpl.id} value={tpl.id}>
                        {t('connectors.sheets.create.fromLayout', { template: tpl.texts.name })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          )}
          <Field label={t('connectors.sheets.create.name')}>
            {(p) => (
              <Input
                {...p}
                value={draft.name}
                maxLength={100}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                data-testid="sheets-create-name"
              />
            )}
          </Field>
          <section aria-labelledby={headingId} className="flex flex-col gap-3">
            <h3 id={headingId} className="text-base font-semibold">
              {t('connectors.sheets.create.tabs')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t('connectors.sheets.create.tabsHint')}
            </p>
            <ul className="flex flex-col gap-3">
              {draft.tabs.map((tab, i) => (
                <CreateTabRow
                  key={tab.key}
                  index={i + 1}
                  tab={tab}
                  canRemove={draft.tabs.length > 1}
                  onChange={(patch) => setTab(tab.key, patch)}
                  onRemove={() =>
                    setDraft((d) => ({ ...d, tabs: d.tabs.filter((x) => x.key !== tab.key) }))
                  }
                />
              ))}
            </ul>
            {draft.tabs.length < SHEET_LAYOUT_TABS && (
              <Button
                variant="outline"
                size="touch"
                className="self-start"
                onClick={() => setDraft((d) => ({ ...d, tabs: [...d.tabs, blankTab()] }))}
              >
                <Plus aria-hidden />
                {t('connectors.sheets.create.addTab')}
              </Button>
            )}
          </section>
          {invalid && <Banner tone="danger">{t('connectors.sheets.create.invalid')}</Banner>}
          {create.error && <Banner tone="danger">{errorMessage(create.error)}</Banner>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="touch" onClick={() => onOpenChange(false)}>
            {t('connectors.sheets.create.cancel')}
          </Button>
          <Button size="touch" disabled={create.isPending} onClick={submit}>
            <Pending show={create.isPending} />
            {t('connectors.sheets.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateTabRow({
  index,
  tab,
  canRemove,
  onChange,
  onRemove,
}: Readonly<{
  index: number;
  tab: DraftTab;
  canRemove: boolean;
  onChange: (patch: Partial<DraftTab>) => void;
  onRemove: () => void;
}>) {
  const { t } = useTranslation('admin');
  const accessId = useId();
  const label = tab.title.trim() || t('connectors.sheets.create.tabN', { n: index });
  return (
    <li className="flex flex-col gap-3 rounded-lg border px-3 py-3" data-testid="sheets-create-tab">
      <div className="flex items-end gap-2">
        <Field label={t('connectors.sheets.create.tabName')} className="min-w-0 flex-1">
          {(p) => (
            <Input
              {...p}
              value={tab.title}
              maxLength={100}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          )}
        </Field>
        {canRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={t('connectors.sheets.create.removeTab', { tab: label })}
            onClick={onRemove}
          >
            <Trash2 aria-hidden />
          </Button>
        )}
      </div>
      <Field
        label={t('connectors.sheets.create.columns')}
        hint={t('connectors.sheets.create.columnsHint')}
      >
        {(p) => (
          <Input
            {...p}
            value={tab.columns}
            onChange={(e) => onChange({ columns: e.target.value })}
          />
        )}
      </Field>
      <div className="flex flex-col gap-1.5">
        <span id={accessId} className="text-sm font-medium">
          {t('connectors.sheets.create.access', { tab: label })}
        </span>
        <SegmentedControl
          aria-labelledby={accessId}
          value={tab.access}
          onValueChange={(access: SheetTabAccess) => onChange({ access })}
          options={ACCESS.map((value) => ({
            value,
            label: t(`connectors.sheets.access.${value}`),
          }))}
          className="self-start"
        />
      </div>
      {tab.formulas?.length ? (
        <p className="text-sm text-muted-foreground">
          {t('connectors.sheets.create.formulas', { count: tab.formulas.length })}
        </p>
      ) : null}
    </li>
  );
}
