import type React from 'react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Loader2, Pencil, Plus, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import {
  CUSTOMER_TAG_LIMIT,
  CustomerProfileBody,
  customerTagKey,
  normalizeTag,
  type CustomerProfile,
  type CustomerProfileResponse,
} from '@ezychat/shared';
import { errorMessage } from '../api/client';
import { useCustomerProfile, useCustomerTags, useSaveCustomerProfile } from '../api/queries';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useMediaQuery } from '@/lib/use-media-query';
import { formatRelative } from '../lib/format';
import { PanelHeader } from './PanelHeader';
import { TagInput } from './TagInput';
import type { Directory } from './useDirectory';

export interface CustomerPanelProps {
  jid: string;
  open: boolean;
  directory: Directory;
  onClose(): void;
  /**
   * Filled by the panel while editing: run an action (close, switch panels) now, or after the
   * teammate confirms discarding unsaved changes. The conversation header buttons use it.
   */
  guardRef?: React.RefObject<((next: () => void) => void) | null>;
}

type Field = 'name' | 'company' | 'email' | 'otherPhone' | 'address';
interface Draft extends Record<Field, string> {
  tags: string[];
}
type Errors = Partial<Record<Field | 'tags', string>>;

const FIELDS: readonly Field[] = ['name', 'company', 'email', 'otherPhone', 'address'];
const FORM_FIELDS: readonly { key: Field; type: 'text' | 'email' | 'tel' | 'area' }[] = [
  { key: 'name', type: 'text' },
  { key: 'company', type: 'text' },
  { key: 'email', type: 'email' },
  { key: 'otherPhone', type: 'tel' },
  { key: 'address', type: 'area' },
];

function hasDetails(p: CustomerProfile): boolean {
  return FIELDS.some((f) => !!p[f]?.trim()) || p.tags.length > 0;
}

function draftOf(p: CustomerProfile): Draft {
  return {
    name: p.name ?? '',
    company: p.company ?? '',
    email: p.email ?? '',
    otherPhone: p.otherPhone ?? '',
    address: p.address ?? '',
    tags: [...p.tags],
  };
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

function sameDraft(a: Draft, b: Draft): boolean {
  return FIELDS.every((f) => a[f].trim() === b[f].trim()) && sameTags(a.tags, b.tags);
}

/**
 * What to save: the latest profile (a teammate may have saved while this form was open) plus only
 * the fields this teammate changed since the form opened.
 */
function mergeEdits(draft: Draft, initial: Draft, latest: Draft): Draft {
  const out = { ...latest, tags: sameTags(draft.tags, initial.tags) ? latest.tags : draft.tags };
  for (const f of FIELDS) if (draft[f].trim() !== initial[f].trim()) out[f] = draft[f];
  return out;
}

/** `mailto:` that cannot carry extra headers; null when the stored value must stay plain text. */
function mailtoHref(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || /[?#%&\s\p{Cc}]/u.test(email)) return null;
  return `mailto:${encodeURIComponent(email.slice(0, at))}@${email.slice(at + 1)}`;
}

/** A WhatsApp "name" that is really just the phone number (WhatsApp falls back to it). */
function isPhoneLike(name: string, phone: string | null | undefined): boolean {
  return /^\+?[\d\s()-]+$/.test(name) || (!!phone && name.replace(/\D/g, '') === phone);
}

/** Name to start a new profile with: the WhatsApp name, unless it is only the number. */
function prefillName(whatsappName: string | null, whatsappPhone?: string | null): string {
  const name = whatsappName?.trim() ?? '';
  return name && !isPhoneLike(name, whatsappPhone) ? name : '';
}

/** "Farah 🌸 · +60123…": what WhatsApp tells us, minus a name equal to the profile name. */
function whatsappDetails(
  whatsappName: string | null,
  whatsappPhone: string | null | undefined,
  profileName: string | null,
): string | null {
  const name = prefillName(whatsappName, whatsappPhone);
  const parts = [
    name && name !== profileName ? name : null,
    whatsappPhone ? `+${whatsappPhone}` : null,
  ];
  const shown = parts.filter((part): part is string => !!part);
  return shown.length ? shown.join(' · ') : null;
}

type WhatsappFactsData = NonNullable<CustomerProfileResponse['whatsapp']>;

/** Read-only facts from WhatsApp, kept apart from what the team types. */
function WhatsappFacts({ facts }: { facts: WhatsappFactsData }) {
  const { t } = useTranslation('inbox');
  const headingId = useId();
  const rows: { key: string; label: string; value: React.ReactNode }[] = [];
  if (facts.pushName)
    rows.push({ key: 'push', label: t('customer.wa.pushName'), value: facts.pushName });
  if (facts.savedName)
    rows.push({ key: 'saved', label: t('customer.wa.savedName'), value: facts.savedName });
  rows.push({
    key: 'phone',
    label: t('customer.wa.phone'),
    value: facts.phone ? (
      `+${facts.phone}`
    ) : (
      <span className="italic text-muted-foreground">{t('customer.wa.phoneHidden')}</span>
    ),
  });
  if (facts.lid) {
    const lid = facts.lid;
    rows.push({
      key: 'lid',
      label: t('customer.wa.lid'),
      value: (
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-mono text-xs">{lid}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            className="-my-2 shrink-0 text-muted-foreground"
            aria-label={t('customer.wa.copyLid')}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(lid)
                .then(() => toast.success(t('customer.wa.copied')))
                .catch(() => undefined)
            }
          >
            <Copy className="size-4" aria-hidden="true" />
          </Button>
        </span>
      ),
    });
  }
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border bg-muted/40 px-3 py-2 text-sm"
    >
      <h4 id={headingId} className="mb-1 text-xs font-semibold text-muted-foreground">
        {t('customer.wa.title')}
      </h4>
      <dl className="space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="shrink-0 text-xs text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Read-only view of a customer profile (also used in the group sender popover). */
export function CustomerDetails({
  profile,
  whatsappName,
  whatsappPhone,
  whatsapp,
  directory,
}: {
  profile: CustomerProfile;
  whatsappName: string | null;
  /** Digits WhatsApp gave us (no `+`), when known. */
  whatsappPhone?: string | null;
  /** Read-only WhatsApp facts; replaces the one-line summary when the server sends them. */
  whatsapp?: WhatsappFactsData;
  /** For "Updated by <teammate>"; that line is left out without it. */
  directory?: Directory;
}) {
  const { t } = useTranslation('inbox');
  const name = profile.name?.trim() || null;
  const fromWhatsapp = whatsapp ? null : whatsappDetails(whatsappName, whatsappPhone, name);
  const updatedByMe =
    profile.updatedBy != null && directory?.me != null && profile.updatedBy === directory.me.id;
  const updatedByName = directory?.nameOf(profile.updatedBy) ?? null;
  const rows: { key: Field; label: string; value: React.ReactNode }[] = [];
  if (profile.company)
    rows.push({ key: 'company', label: t('customer.company'), value: profile.company });
  if (profile.email) {
    const href = mailtoHref(profile.email);
    rows.push({
      key: 'email',
      label: t('customer.email'),
      value: href ? (
        <a href={href} className="text-primary underline-offset-4 hover:underline">
          {profile.email}
        </a>
      ) : (
        profile.email
      ),
    });
  }
  if (profile.otherPhone)
    rows.push({
      key: 'otherPhone',
      label: t('customer.otherPhone'),
      value: (
        <a
          href={`tel:${profile.otherPhone.replace(/[^0-9+]/g, '')}`}
          className="text-primary underline-offset-4 hover:underline"
        >
          {profile.otherPhone}
        </a>
      ),
    });
  if (profile.address)
    rows.push({
      key: 'address',
      label: t('customer.address'),
      value: <span className="whitespace-pre-wrap">{profile.address}</span>,
    });

  return (
    // What the team keeps comes first (name, fields, tags); WhatsApp's own facts close the panel.
    <div className="min-w-0 space-y-3 text-sm">
      <div className="min-w-0">
        <h4
          className={
            name
              ? 'text-base font-semibold text-foreground [overflow-wrap:anywhere]'
              : 'text-base italic text-muted-foreground'
          }
        >
          {name ?? t('customer.noName')}
        </h4>
        {fromWhatsapp && (
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {t('customer.whatsappName', { name: fromWhatsapp })}
          </p>
        )}
      </div>
      {rows.length > 0 && (
        <dl className="space-y-2">
          {rows.map((row) => (
            <div key={row.key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="break-words [overflow-wrap:anywhere]">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {profile.tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('customer.tags')}>
          {profile.tags.map((tag) => (
            <li key={tag} className="min-w-0 max-w-full">
              <Badge variant="secondary" className="max-w-full">
                <span className="truncate">{tag}</span>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {profile.updatedAt != null && directory && (
        <p className="text-xs text-muted-foreground">
          {updatedByMe
            ? t('customer.updatedByYou', { when: formatRelative(profile.updatedAt) })
            : updatedByName
              ? t('customer.updatedBy', {
                  name: updatedByName,
                  when: formatRelative(profile.updatedAt),
                })
              : t('customer.updated', { when: formatRelative(profile.updatedAt) })}
        </p>
      )}
      {whatsapp && <WhatsappFacts facts={whatsapp} />}
    </div>
  );
}

function issueMessages(
  issues: readonly z.core.$ZodIssue[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): Errors {
  const errors: Errors = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field !== 'string' || field in errors) continue;
    const key = field as Field | 'tags';
    if (key === 'tags') errors.tags = t('customer.errors.tags');
    else if (issue.code === 'too_big')
      errors[key] = t('customer.errors.tooLong', { max: Number(issue.maximum) });
    else if (key === 'email') errors.email = t('customer.errors.email');
    else if (key === 'otherPhone') errors.otherPhone = t('customer.errors.otherPhone');
  }
  return errors;
}

function CustomerForm({
  jid,
  snapshot,
  latest,
  whatsappName,
  whatsappPhone,
  whatsapp,
  directory,
  onDone,
  escapeRef,
  guardRef,
}: {
  jid: string;
  /** The profile when editing started. */
  snapshot: CustomerProfile;
  /** The newest profile from the server (a teammate may save while this form is open). */
  latest: CustomerProfile;
  /** What WhatsApp tells us: prefills a new profile's name and is shown read-only. */
  whatsappName: string | null;
  whatsappPhone?: string | null;
  whatsapp?: WhatsappFactsData;
  directory: Directory;
  onDone(): void;
  /** Lets the panel route Esc here (the Sheet would otherwise close). Returns true if handled. */
  escapeRef: React.RefObject<(() => boolean) | null>;
  /** Runs `next` now, or after "Discard" when there are unsaved changes (close, header buttons). */
  guardRef: React.RefObject<((next: () => void) => void) | null>;
}) {
  const { t } = useTranslation('inbox');
  const ids = useId();
  const formRef = useRef<HTMLFormElement>(null);
  // `initial` is the saved profile (merge baseline: a prefilled name counts as a change and is
  // saved); `start` is what the form opened with (dirty baseline: opening and cancelling never asks).
  const [initial] = useState(() => draftOf(snapshot));
  const [start] = useState<Draft>(() =>
    initial.name ? initial : { ...initial, name: prefillName(whatsappName, whatsappPhone) },
  );
  const [draft, setDraft] = useState<Draft>(start);
  const fromWhatsapp = whatsappDetails(whatsappName, whatsappPhone, snapshot.name?.trim() || null);
  const [errors, setErrors] = useState<Errors>({});
  const [tagQuery, setTagQuery] = useState('');
  /** The action waiting for "Discard" (cancel editing, close the panel, switch panels). */
  const [pending, setPending] = useState<(() => void) | null>(null);
  const tags = useCustomerTags(tagQuery);
  const save = useSaveCustomerProfile(jid);
  const dirty = !sameDraft(draft, start);

  function guard(next: () => void) {
    if (dirty) setPending(() => next);
    else next();
  }
  function cancel() {
    guard(onDone);
  }
  function onEscape() {
    if (pending) return false;
    cancel();
    return true;
  }
  // Registered after commit and cleared on unmount, so a form that closed with its panel
  // (desktop aside, mobile sheet) never leaves a stale guard behind for the header buttons.
  useLayoutEffect(() => {
    escapeRef.current = onEscape;
    guardRef.current = guard;
    return () => {
      if (escapeRef.current === onEscape) escapeRef.current = null;
      if (guardRef.current === guard) guardRef.current = null;
    };
  });
  const changedMeanwhile = latest.updatedAt !== snapshot.updatedAt;
  const changedByMe =
    changedMeanwhile && latest.updatedBy != null && latest.updatedBy === directory.me?.id;
  const changedBy = changedMeanwhile ? directory.nameOf(latest.updatedBy) : null;

  function set(field: Field, value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (save.isPending) return;
    // A tag still in the input (typed, Enter not pressed) is saved too, while there is room.
    const typed = normalizeTag(tagQuery);
    const withTyped =
      typed &&
      draft.tags.length < CUSTOMER_TAG_LIMIT &&
      !draft.tags.some((tag) => customerTagKey(tag) === customerTagKey(typed))
        ? { ...draft, tags: [...draft.tags, typed] }
        : draft;
    const parsed = CustomerProfileBody.safeParse(mergeEdits(withTyped, initial, draftOf(latest)));
    if (!parsed.success) {
      setErrors(issueMessages(parsed.error.issues, t as never));
      return;
    }
    setErrors({});
    save.mutate(parsed.data, {
      onSuccess: onDone,
      onError: (err) => toast.error(t('customer.saveFailed'), { description: errorMessage(err) }),
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      cancel();
    }
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={submit}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
        {changedMeanwhile && (
          <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {changedByMe
              ? t('customer.changedWhileEditingYou')
              : changedBy
                ? t('customer.changedWhileEditing', { name: changedBy })
                : t('customer.changedWhileEditingUnknown')}
          </p>
        )}
        {FORM_FIELDS.map(({ key, type }) => {
          const id = `${ids}-${key}`;
          const errorId = `${id}-error`;
          const common = {
            id,
            value: draft[key],
            'aria-invalid': !!errors[key] || undefined,
            'aria-describedby': errors[key] ? errorId : undefined,
          };
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={id}>{t(`customer.${key}`)}</Label>
              {type === 'area' ? (
                <Textarea
                  {...common}
                  rows={2}
                  onChange={(e) => set(key, e.target.value)}
                  className="field-sizing-fixed min-h-16 resize-none text-base md:text-sm"
                />
              ) : (
                <Input
                  {...common}
                  type={type}
                  inputMode={type === 'tel' ? 'tel' : undefined}
                  autoComplete="off"
                  onChange={(e) => set(key, e.target.value)}
                  className="h-11 text-base md:h-9 md:text-sm"
                />
              )}
              {errors[key] && (
                <p id={errorId} className="text-xs text-danger">
                  {errors[key]}
                </p>
              )}
              {key === 'otherPhone' && whatsappPhone && !errors[key] && (
                <p className="text-xs text-muted-foreground">
                  {t('customer.otherPhoneHint', { phone: `+${whatsappPhone}` })}
                </p>
              )}
            </div>
          );
        })}
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-tags`}>{t('customer.tags')}</Label>
          <TagInput
            id={`${ids}-tags`}
            value={draft.tags}
            onChange={(next) => {
              setDraft((d) => ({ ...d, tags: next }));
              if (errors.tags) setErrors((e) => ({ ...e, tags: undefined }));
            }}
            suggestions={tags.data ?? []}
            onQueryChange={setTagQuery}
            aria-invalid={!!errors.tags || undefined}
            aria-describedby={errors.tags ? `${ids}-tags-error` : undefined}
          />
          {errors.tags && (
            <p id={`${ids}-tags-error`} className="text-xs text-danger">
              {errors.tags}
            </p>
          )}
        </div>
        {/* What WhatsApp says stays visible as a reference, below what the team edits. */}
        {whatsapp ? (
          <WhatsappFacts facts={whatsapp} />
        ) : (
          fromWhatsapp && (
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {t('customer.whatsappName', { name: fromWhatsapp })}
            </p>
          )
        )}
      </div>
      <div className="safe-bottom flex gap-2 border-t p-3">
        <Button type="button" variant="outline" size="touch" className="flex-1" onClick={cancel}>
          {t('customer.cancel')}
        </Button>
        <Button type="submit" size="touch" className="flex-1" disabled={save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
          {t('customer.save')}
        </Button>
      </div>
      <AlertDialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('customer.discardTitle')}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9">
              {t('customer.keepEditing')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 sm:min-h-9"
              onClick={() => {
                const next = pending;
                setPending(null);
                next?.();
              }}
            >
              {t('customer.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

function CustomerBody({
  jid,
  directory,
  onClose,
  title,
  description,
  escapeRef,
  guardRef,
}: Omit<CustomerPanelProps, 'open' | 'guardRef'> & {
  title: React.ReactNode;
  description: React.ReactNode;
  escapeRef: React.RefObject<(() => boolean) | null>;
  guardRef: React.RefObject<((next: () => void) => void) | null>;
}) {
  const { t } = useTranslation(['inbox', 'common']);
  const query = useCustomerProfile(jid);
  /** The profile when editing started; null while viewing. */
  const [editing, setEditing] = useState<CustomerProfile | null>(null);
  const data: CustomerProfileResponse | undefined = query.data;
  const requestClose = () => (guardRef.current ? guardRef.current(onClose) : onClose());
  const viewing = !editing && !query.isError && data && hasDetails(data.profile) ? data : null;

  return (
    <>
      <PanelHeader
        icon={<UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        title={title}
        description={description}
        closeLabel={t('customer.close')}
        onClose={requestClose}
        action={
          viewing && (
            <Button
              variant="ghost"
              size="touch"
              onClick={() => setEditing(viewing.profile)}
              className="shrink-0 text-muted-foreground"
            >
              <Pencil aria-hidden="true" />
              {t('customer.edit')}
            </Button>
          )
        }
      />
      {editing ? (
        <CustomerForm
          jid={jid}
          snapshot={editing}
          latest={data?.profile ?? editing}
          whatsappName={data?.whatsappName ?? null}
          whatsappPhone={data?.whatsappPhone ?? null}
          whatsapp={data?.whatsapp}
          directory={directory}
          onDone={() => setEditing(null)}
          escapeRef={escapeRef}
          guardRef={guardRef}
        />
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-3">
          {query.isPending ? (
            <div className="space-y-2" role="status" aria-label={t('customer.title')}>
              <Skeleton className="h-5 w-40 max-w-full" />
              <Skeleton className="h-4 w-56 max-w-full" />
              <Skeleton className="h-4 w-32" />
            </div>
          ) : query.isError || !data ? (
            <Banner
              tone="danger"
              action={
                <Button
                  variant="outline"
                  size="touch"
                  className="md:min-h-9"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  {query.isFetching && <Loader2 className="animate-spin" aria-hidden="true" />}
                  {t('common:actions.tryAgain')}
                </Button>
              }
            >
              {errorMessage(query.error)}
            </Banner>
          ) : hasDetails(data.profile) ? (
            <CustomerDetails
              profile={data.profile}
              whatsappName={data.whatsappName}
              whatsappPhone={data.whatsappPhone ?? null}
              whatsapp={data.whatsapp}
              directory={directory}
            />
          ) : (
            <div className="space-y-4">
              {/* Compact empty state: what is missing, why it matters, one action. */}
              <div className="space-y-2 rounded-lg border border-dashed px-4 py-4">
                <p className="text-sm font-medium text-foreground">{t('customer.empty')}</p>
                <p className="text-sm text-muted-foreground">{t('customer.emptyHint')}</p>
                <Button size="touch" className="w-full" onClick={() => setEditing(data.profile)}>
                  <Plus aria-hidden="true" />
                  {t('customer.addDetails')}
                </Button>
              </div>
              {data.whatsapp ? (
                <WhatsappFacts facts={data.whatsapp} />
              ) : (
                whatsappDetails(data.whatsappName, data.whatsappPhone, null) && (
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {t('customer.whatsappName', {
                      name: whatsappDetails(data.whatsappName, data.whatsappPhone, null),
                    })}
                  </p>
                )
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Customer profile of a direct chat, editable by every teammate. Side panel on >= lg,
 * full-height Sheet below (same layout as Notes).
 */
export function CustomerPanel({
  open,
  onClose,
  guardRef: outerGuard,
  ...rest
}: CustomerPanelProps) {
  const { t } = useTranslation('inbox');
  const desktop = useMediaQuery('(min-width: 1024px)');
  const escapeRef = useRef<(() => boolean) | null>(null);
  const ownGuard = useRef<((next: () => void) => void) | null>(null);
  const guardRef = outerGuard ?? ownGuard;
  const sheetTitleRef = useRef<HTMLHeadingElement>(null);

  if (desktop) {
    if (!open) return null;
    return (
      <aside
        aria-label={t('customer.title')}
        className="flex w-80 shrink-0 flex-col border-l bg-surface"
      >
        <CustomerBody
          {...rest}
          onClose={onClose}
          escapeRef={escapeRef}
          guardRef={guardRef}
          title={<h3>{t('customer.title')}</h3>}
          description={<p>{t('customer.description')}</p>}
        />
      </aside>
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) (guardRef.current ?? ((next: () => void) => next()))(onClose);
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-label={t('customer.title')}
        // Full width on phones: no left border there.
        className="safe-top safe-x w-full gap-0 bg-surface max-sm:border-l-0 sm:max-w-sm"
        // Start on the title, not with a focus ring on Close.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          sheetTitleRef.current?.focus();
        }}
        onEscapeKeyDown={(e) => {
          if (escapeRef.current?.()) e.preventDefault();
        }}
      >
        <CustomerBody
          {...rest}
          onClose={onClose}
          escapeRef={escapeRef}
          guardRef={guardRef}
          title={
            <SheetTitle ref={sheetTitleRef} tabIndex={-1} className="text-sm outline-none">
              {t('customer.title')}
            </SheetTitle>
          }
          description={
            <SheetDescription className="text-xs">{t('customer.description')}</SheetDescription>
          }
        />
      </SheetContent>
    </Sheet>
  );
}
