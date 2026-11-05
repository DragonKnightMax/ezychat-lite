import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bug,
  Camera,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  HelpCircle,
  Lightbulb,
  MessageSquare,
  Paperclip,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { ApiError, api } from '@/api/client';
import { GITHUB_ISSUES_URL } from '@/lib/links';
import { useAuth } from '@/auth/AuthProvider';
import { useMockEdition } from '@/mock/edition';
import { FeedbackMockPanel } from '@/mock/FeedbackMockPanel';
import { Banner, ResponsiveDialog } from './index';

/**
 * Proposed (in-app-feedback): Send feedback. Anyone signed in can send a problem, an idea, a question or
 * anything else, with up to 3 files. The local server forwards it to Anchor Sprint's licence portal;
 * nothing is sent until the user presses Send. Opened from the account menu and from the error panel
 * (`openFeedback`), so the draft survives closing the dialog.
 */

export type FeedbackType = 'problem' | 'idea' | 'question' | 'other';
export type FeedbackArea =
  'inbox' | 'ai' | 'whatsapp' | 'connectors' | 'reports' | 'settings' | 'install' | 'other';
type Frequency = 'always' | 'sometimes' | 'once';
type Impact = 'blocking' | 'slow' | 'minor';

const TYPES: readonly FeedbackType[] = ['problem', 'idea', 'question', 'other'];
const AREAS: readonly FeedbackArea[] = [
  'inbox',
  'ai',
  'whatsapp',
  'connectors',
  'reports',
  'settings',
  'install',
  'other',
];
const TYPE_ICON = { problem: Bug, idea: Lightbulb, question: HelpCircle, other: MessageSquare };
const ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,.txt,.log,.mp4';
const ALLOWED = /\.(png|jpe?g|webp|pdf|txt|log|mp4)$/i;
const MAX_FILES = 3;
const MAX_FILE = 10 * 1024 * 1024;
const EMAIL_KEY = 'ezychat.feedback.email';

export const OPEN_FEEDBACK_EVENT = 'ezychat:feedback';
export interface FeedbackPrefill {
  type?: FeedbackType;
  details?: string;
}
/** Opens the Send feedback dialog from anywhere (menu, error panel). */
export function openFeedback(prefill: FeedbackPrefill = {}): void {
  window.dispatchEvent(new CustomEvent<FeedbackPrefill>(OPEN_FEEDBACK_EVENT, { detail: prefill }));
}

/** The area a screen belongs to, so the report starts with the right one. */
export function areaForPath(path: string): FeedbackArea {
  if (path.startsWith('/admin/members/ai') || path.startsWith('/admin/ai')) return 'ai';
  if (path.startsWith('/admin/whatsapp') || path.startsWith('/admin/inboxes')) return 'whatsapp';
  if (path.startsWith('/admin/connectors')) return 'connectors';
  if (path.startsWith('/admin/reports')) return 'reports';
  if (path.startsWith('/admin')) return 'settings';
  return 'inbox';
}

interface Preview {
  diagnostics: Record<string, string | boolean>;
  log: { lines: number; preview: string };
  company: string | null;
}

function readEmail(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

const sizeLabel = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Mock stand-in for the desktop window capture (`webContents.capturePage`). */
async function mockWindowScreenshot(): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 800;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#f4f6f5';
  g.fillRect(0, 0, 1280, 800);
  g.fillStyle = '#0F766E';
  g.fillRect(0, 0, 1280, 56);
  g.fillStyle = '#111';
  g.font = '28px sans-serif';
  g.fillText('EzyChat window (demo screenshot)', 40, 120);
  const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), 'image/png'));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return new File([blob], `screenshot-${stamp}.png`, { type: 'image/png' });
}

export function FeedbackHost() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<FeedbackPrefill & { n: number }>({ n: 0 });
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<FeedbackPrefill>).detail ?? {};
      setPrefill((p) => ({ ...detail, n: p.n + 1 }));
      setOpen(true);
    };
    window.addEventListener(OPEN_FEEDBACK_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FEEDBACK_EVENT, onOpen);
  }, []);
  // Anyone signed in may send feedback; nothing shows on the sign-in page.
  if (!user) return null;
  return <FeedbackDialog open={open} onOpenChange={setOpen} prefill={prefill} />;
}

export function FeedbackDialog({
  open,
  onOpenChange,
  prefill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill: FeedbackPrefill & { n: number };
}) {
  const { t } = useTranslation(['app', 'common']);
  const id = useId();
  const { user } = useAuth();
  const edition = useMockEdition();
  const { pathname } = useLocation();
  const fileInput = useRef<HTMLInputElement>(null);

  const [type, setType] = useState<FeedbackType>('problem');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [area, setArea] = useState<FeedbackArea>(() => areaForPath(pathname));
  const [frequency, setFrequency] = useState<Frequency | ''>('');
  const [impact, setImpact] = useState<Impact | ''>('');
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(readEmail);
  const [company, setCompany] = useState('');
  const [contactOk, setContactOk] = useState(true);
  const [includeDetails, setIncludeDetails] = useState(true);
  const [includeLog, setIncludeLog] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [screen, setScreen] = useState(pathname);
  const [clientReportId, setClientReportId] = useState(() => crypto.randomUUID());
  const [touched, setTouched] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // A new open (menu or error panel) takes the screen the user is on and any prefill.
  useEffect(() => {
    if (!prefill.n) return;
    setScreen(pathname);
    if (sent) reset();
    if (!title && !details) setArea(areaForPath(pathname));
    if (prefill.type) setType(prefill.type);
    if (prefill.details && !details) setDetails(prefill.details);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill.n]);

  const preview = useQuery({
    queryKey: ['mock', 'feedback', 'preview', screen, edition],
    queryFn: () =>
      api<Preview>(
        `/mock/feedback/preview?screen=${encodeURIComponent(screen)}&edition=${edition}`,
      ),
    enabled: open,
  });
  useEffect(() => {
    if (preview.data?.company && !company) setCompany(preview.data.company);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.data?.company]);

  function reset() {
    setTitle('');
    setDetails('');
    setFrequency('');
    setImpact('');
    setFiles([]);
    setIncludeLog(false);
    setTouched(false);
    setSendError(null);
    setSent(null);
    setClientReportId(crypto.randomUUID());
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const problems = {
    title: title.trim().length < 3 ? t('feedback.errors.title') : null,
    details: details.trim().length < 10 ? t('feedback.errors.details') : null,
    name: !name.trim() ? t('feedback.errors.name') : null,
    email: !email.trim()
      ? t('feedback.errors.emailRequired')
      : !emailOk
        ? t('feedback.errors.emailInvalid')
        : null,
  };
  const valid = Object.values(problems).every((p) => !p);

  function addFiles(list: FileList | File[] | null) {
    setFileError(null);
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= MAX_FILES) {
        setFileError(t('feedback.files.tooMany', { max: MAX_FILES }));
        break;
      }
      if (!ALLOWED.test(f.name)) {
        setFileError(t('feedback.files.badType', { name: f.name }));
        continue;
      }
      if (f.size > MAX_FILE) {
        setFileError(t('feedback.files.tooBig', { name: f.name }));
        continue;
      }
      next.push(f);
    }
    setFiles(next);
  }

  async function send() {
    setTouched(true);
    setSendError(null);
    if (!valid) return;
    setSending(true);
    try {
      localStorage.setItem(EMAIL_KEY, email.trim());
    } catch {
      /* per-device convenience only */
    }
    const form = new FormData();
    form.append(
      'report',
      JSON.stringify({
        clientReportId,
        type,
        title: title.trim(),
        details: details.trim(),
        area,
        ...(type === 'problem' && frequency ? { frequency } : {}),
        ...(type === 'problem' && impact ? { impact } : {}),
        name: name.trim(),
        email: email.trim(),
        ...(company.trim() ? { company: company.trim() } : {}),
        contactOk,
        includeDetails,
        includeLog,
        screen,
        edition,
      }),
    );
    for (const f of files) form.append('file', f, f.name);
    try {
      const res = await api<{ reference: string }>('/feedback', { form });
      setSent(res.reference);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setSendError(
        err?.status === 429
          ? t('feedback.errors.rateLimited')
          : err?.status === 0 || err?.status === 502
            ? t('feedback.errors.unreachable')
            : (err?.message ?? t('feedback.errors.generic')),
      );
    } finally {
      setSending(false);
    }
  }

  const fieldError = (msg: string | null, key: string) =>
    touched && msg ? (
      <p id={`${id}-${key}-error`} className="text-sm text-destructive">
        {msg}
      </p>
    ) : null;

  if (sent) {
    return (
      <ResponsiveDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('feedback.sent.title')}
        footer={
          <>
            <Button
              variant="outline"
              size="touch"
              onClick={() => {
                reset();
              }}
            >
              {t('feedback.sent.another')}
            </Button>
            <Button
              size="touch"
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
            >
              {t('common:actions.done')}
            </Button>
          </>
        }
      >
        <div className="space-y-3 pb-4" data-testid="feedback-sent">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{t('feedback.sent.thanks')}</p>
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {t('feedback.sent.reference', { reference: sent })}
              </p>
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {contactOk
                  ? t('feedback.sent.reply', { email: email.trim() })
                  : t('feedback.sent.noReply')}
              </p>
            </div>
          </div>
          <FeedbackMockPanel />
        </div>
      </ResponsiveDialog>
    );
  }

  const diag = preview.data?.diagnostics;
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      size="medium"
      title={t('feedback.title')}
      description={t('feedback.description')}
      footer={
        <>
          <Button variant="outline" size="touch" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            size="touch"
            disabled={sending}
            onClick={() => void send()}
            data-testid="feedback-send"
          >
            {sending ? t('feedback.sending') : t('feedback.send')}
          </Button>
        </>
      }
    >
      <div className="min-w-0 space-y-5 pb-4">
        <div className="space-y-2">
          <p id={`${id}-type`} className="text-sm font-medium">
            {t('feedback.type.label')}
          </p>
          <SegmentedControl
            aria-labelledby={`${id}-type`}
            className="grid w-full grid-cols-2 sm:grid-cols-4 [&>label]:min-h-11 [&>label:nth-child(3)]:border-l-0 sm:[&>label:nth-child(3)]:border-l [&>label:nth-child(n+3)]:border-t sm:[&>label:nth-child(n+3)]:border-t-0"
            value={type}
            onValueChange={(v) => {
              setType(v);
              setIncludeDetails(v === 'problem' || includeDetails);
            }}
            options={TYPES.map((v) => {
              const Icon = TYPE_ICON[v];
              return {
                value: v,
                label: (
                  <span className="flex items-center gap-1.5">
                    <Icon className="size-4" aria-hidden="true" />
                    {t(`feedback.type.${v}`)}
                  </span>
                ),
              };
            })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${id}-title`}>{t('feedback.titleLabel')}</Label>
          <Input
            id={`${id}-title`}
            value={title}
            maxLength={120}
            placeholder={t(`feedback.titlePlaceholder.${type}`)}
            aria-invalid={touched && !!problems.title}
            aria-describedby={problems.title ? `${id}-title-error` : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
          {fieldError(problems.title, 'title')}
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${id}-details`}>{t('feedback.detailsLabel')}</Label>
          <Textarea
            id={`${id}-details`}
            value={details}
            maxLength={5000}
            placeholder={t(`feedback.detailsPlaceholder.${type}`)}
            className="max-h-72 min-h-32 resize-y [overflow-wrap:anywhere]"
            aria-invalid={touched && !!problems.details}
            aria-describedby={problems.details ? `${id}-details-error` : undefined}
            onChange={(e) => setDetails(e.target.value)}
          />
          <div className="flex justify-between gap-2">
            {fieldError(problems.details, 'details') ?? <span />}
            <span className="text-xs text-muted-foreground">{details.length} / 5000</span>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${id}-area`}>{t('feedback.area.label')}</Label>
          <Select value={area} onValueChange={(v) => setArea(v as FeedbackArea)}>
            <SelectTrigger id={`${id}-area`} className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AREAS.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`feedback.area.${a}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {type === 'problem' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <p id={`${id}-freq`} className="text-sm font-medium">
                {t('feedback.frequency.label')}
              </p>
              <SegmentedControl
                aria-labelledby={`${id}-freq`}
                size="sm"
                className="w-full [&>label]:flex-1"
                value={frequency as Frequency}
                onValueChange={setFrequency}
                options={(['always', 'sometimes', 'once'] as const).map((v) => ({
                  value: v,
                  label: t(`feedback.frequency.${v}`),
                }))}
              />
            </div>
            <div className="min-w-0 space-y-2">
              <p id={`${id}-impact`} className="text-sm font-medium">
                {t('feedback.impact.label')}
              </p>
              <SegmentedControl
                aria-labelledby={`${id}-impact`}
                size="sm"
                className="w-full [&>label]:flex-1"
                value={impact as Impact}
                onValueChange={setImpact}
                options={(['blocking', 'slow', 'minor'] as const).map((v) => ({
                  value: v,
                  label: t(`feedback.impact.${v}`),
                }))}
              />
            </div>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium">{t('feedback.files.label')}</p>
          <p className="text-sm text-muted-foreground">{t('feedback.files.hint')}</p>
          {files.length > 0 && (
            <ul className="space-y-1" data-testid="feedback-files">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm"
                >
                  <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {sizeLabel(f.size)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t('feedback.files.remove', { name: f.name })}
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="touch"
              disabled={files.length >= MAX_FILES}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip aria-hidden="true" /> {t('feedback.files.add')}
            </Button>
            <Button
              variant="outline"
              size="touch"
              disabled={files.length >= MAX_FILES}
              onClick={() => void mockWindowScreenshot().then((f) => addFiles([f]))}
            >
              <Camera aria-hidden="true" /> {t('feedback.files.screenshot')}
            </Button>
          </div>
          {fileError && (
            <p role="alert" className="text-sm text-destructive">
              {fileError}
            </p>
          )}
        </div>

        <fieldset className="space-y-4 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{t('feedback.contact.legend')}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <Label htmlFor={`${id}-name`}>{t('feedback.contact.name')}</Label>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={80}
                autoComplete="name"
                aria-invalid={touched && !!problems.name}
                onChange={(e) => setName(e.target.value)}
              />
              {fieldError(problems.name, 'name')}
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor={`${id}-email`}>{t('feedback.contact.email')}</Label>
              <Input
                id={`${id}-email`}
                type="email"
                value={email}
                maxLength={200}
                autoComplete="email"
                inputMode="email"
                aria-invalid={touched && !!problems.email}
                aria-describedby={problems.email ? `${id}-email-error` : undefined}
                onChange={(e) => setEmail(e.target.value)}
              />
              {fieldError(problems.email, 'email')}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-company`}>
              {t('feedback.contact.company')}{' '}
              {edition === 'lite' && (
                <span className="font-normal text-muted-foreground">
                  {t('feedback.contact.optional')}
                </span>
              )}
            </Label>
            <Input
              id={`${id}-company`}
              value={company}
              maxLength={120}
              autoComplete="organization"
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={contactOk}
              onCheckedChange={(v) => setContactOk(v === true)}
            />
            <span>{t('feedback.contact.ok')}</span>
          </label>
        </fieldset>

        <div className="space-y-3">
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={includeDetails}
              onCheckedChange={(v) => setIncludeDetails(v === true)}
            />
            <span>
              <span className="font-medium">{t('feedback.include.details')}</span>
              <span className="block text-muted-foreground">
                {t('feedback.include.detailsHint')}
              </span>
            </span>
          </label>
          <Button
            variant="ghost"
            size="touch"
            aria-expanded={showDetails}
            onClick={() => setShowDetails(!showDetails)}
          >
            <ChevronDown
              aria-hidden="true"
              className={showDetails ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
            {t('feedback.include.seeDetails')}
          </Button>
          {showDetails && diag && (
            <dl
              className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-3 text-sm"
              data-testid="feedback-diagnostics"
            >
              {Object.entries(diag).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">
                    {t(`feedback.diag.${k}` as `feedback.diag.edition`)}
                  </dt>
                  <dd className="min-w-0 [overflow-wrap:anywhere]">
                    {typeof v === 'boolean' ? t(v ? 'feedback.diag.yes' : 'feedback.diag.no') : v}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <label className="flex min-h-11 items-start gap-3 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={includeLog}
              onCheckedChange={(v) => setIncludeLog(v === true)}
              data-testid="feedback-include-log"
            />
            <span>
              <span className="font-medium">{t('feedback.include.log')}</span>
              <span className="block text-muted-foreground">
                {t('feedback.include.logHint', { lines: preview.data?.log.lines ?? 200 })}
              </span>
            </span>
          </label>
          {includeLog && (
            <>
              <Button
                variant="ghost"
                size="touch"
                aria-expanded={showLog}
                onClick={() => setShowLog(!showLog)}
              >
                <ChevronDown
                  aria-hidden="true"
                  className={showLog ? 'rotate-180 transition-transform' : 'transition-transform'}
                />
                {t('feedback.include.seeLog')}
              </Button>
              {showLog && preview.data && (
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-3 font-mono text-xs">
                  {preview.data.log.preview}
                </pre>
              )}
            </>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          {t('feedback.privacy', {
            product: edition === 'enterprise' ? 'EzyChat Enterprise' : 'EzyChat Lite',
          })}
        </p>
        {edition === 'lite' && (
          <p className="text-sm">
            <a
              className="inline-flex min-h-11 items-center gap-1 text-primary underline-offset-4 hover:underline"
              href={GITHUB_ISSUES_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('feedback.github')} <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </p>
        )}

        {sendError && (
          <Banner tone="danger" title={t('feedback.errors.notSent')}>
            <span role="alert">{sendError}</span>
          </Banner>
        )}
        {touched && !valid && (
          <p role="alert" className="text-sm text-destructive">
            {t('feedback.errors.fix')}
          </p>
        )}
        <FeedbackMockPanel />
      </div>
    </ResponsiveDialog>
  );
}
