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
import {
  FEEDBACK_AREAS,
  FEEDBACK_FILE_EXTENSIONS,
  FEEDBACK_MAX_FILE_BYTES,
  FEEDBACK_MAX_FILES,
  FEEDBACK_TYPES,
  FeedbackDefaults,
  FeedbackSentResponse,
  type FeedbackArea,
  type FeedbackClient,
  type FeedbackFrequency,
  type FeedbackImpact,
  type FeedbackReportBody,
  type FeedbackType,
} from '@ezychat/shared';
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
import { ApiError, api } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { useAppLinks } from '@/lib/app-links';
import { Banner, ResponsiveDialog } from './index';
import { SegmentedControl } from './SegmentedControl';

/**
 * Send feedback (docs/features/in-app-feedback/design.md). Anyone signed in can send a problem, an
 * idea, a question or anything else, with up to 3 files. The local server adds the app details and
 * forwards it to Anchor Sprint's licence portal; nothing is sent until the user presses Send. Opened
 * from the account menu, Admin → Help & feedback, About and the error panel (`openFeedback`); the
 * draft survives closing the dialog.
 */

declare global {
  interface Window {
    /** Desktop app only (inbox-preload): a PNG of this window, or null. */
    watiCapture?: { captureWindow(): Promise<Uint8Array | null> };
  }
}

const TYPE_ICON = { problem: Bug, idea: Lightbulb, question: HelpCircle, other: MessageSquare };
const ACCEPT = FEEDBACK_FILE_EXTENSIONS.map((e) => `.${e}`).join(',');
const ALLOWED = new RegExp(`\\.(${FEEDBACK_FILE_EXTENSIONS.join('|')})$`, 'i');
const EMAIL_KEY = 'ezychat.feedback.email';

export const OPEN_FEEDBACK_EVENT = 'ezychat:feedback';
export interface FeedbackPrefill {
  type?: FeedbackType;
  details?: string;
}
/** Opens the Send feedback dialog from anywhere (menu, About, error panel). */
export function openFeedback(prefill: FeedbackPrefill = {}): void {
  window.dispatchEvent(new CustomEvent<FeedbackPrefill>(OPEN_FEEDBACK_EVENT, { detail: prefill }));
}

/** The part of the app a screen belongs to, so the report starts with the right one. */
/** "en" → "English" in the UI language; the code itself when the browser cannot name it. */
export function languageName(code: string, uiLanguage = code): string {
  try {
    return new Intl.DisplayNames([uiLanguage], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function areaForPath(path: string): FeedbackArea {
  if (path.startsWith('/admin/members/ai') || path.startsWith('/admin/ai')) return 'ai_agent';
  if (path.startsWith('/admin/whatsapp') || path.startsWith('/admin/inboxes'))
    return 'whatsapp_link';
  if (path.startsWith('/admin/connectors')) return 'connectors';
  if (path.startsWith('/admin/reports')) return 'reports';
  if (path.startsWith('/admin')) return 'settings';
  return 'inbox';
}

/** The desktop app's window has the update bridge; a browser or phone never does. */
const feedbackClient = (): FeedbackClient => (window.watiUpdates ? 'desktop' : 'browser');

function readEmail(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveEmail(email: string): void {
  try {
    localStorage.setItem(EMAIL_KEY, email);
  } catch {
    /* a per-device convenience only */
  }
}

const sizeLabel = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Error codes of `POST /api/feedback` → the message key the dialog shows. */
function sendErrorKey(e: unknown) {
  const err = e instanceof ApiError ? e : null;
  switch (err?.code) {
    case 'rate_limited':
      return 'feedback.errors.rateLimited' as const;
    case 'feedback_closed':
      return 'feedback.errors.closed' as const;
    case 'feedback_unavailable':
      return 'feedback.errors.unavailable' as const;
    case 'too_large':
    case 'payload_too_large':
      return 'feedback.errors.tooLarge' as const;
    case 'file_type':
      return 'feedback.errors.fileType' as const;
    case 'network':
    case 'feedback_unreachable':
      return 'feedback.errors.unreachable' as const;
    default:
      return 'feedback.errors.generic' as const;
  }
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
  const { t, i18n } = useTranslation(['app', 'common']);
  const id = useId();
  const { user } = useAuth();
  const links = useAppLinks();
  const { pathname } = useLocation();
  const fileInput = useRef<HTMLInputElement>(null);

  const [type, setType] = useState<FeedbackType>('problem');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [area, setArea] = useState<FeedbackArea>(() => areaForPath(pathname));
  const [frequency, setFrequency] = useState<FeedbackFrequency | ''>('');
  const [impact, setImpact] = useState<FeedbackImpact | ''>('');
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

  const defaults = useQuery({
    queryKey: ['feedback', 'defaults'],
    queryFn: () => api('/feedback/defaults', { schema: FeedbackDefaults }),
    enabled: open,
    staleTime: 0,
  });
  useEffect(() => {
    if (defaults.data?.company && !company) setCompany(defaults.data.company);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.data?.company]);

  function reset() {
    setTitle('');
    setDetails('');
    setFrequency('');
    setImpact('');
    setFiles([]);
    setIncludeLog(false);
    setTouched(false);
    setSendError(null);
    setFileError(null);
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
      if (next.length >= FEEDBACK_MAX_FILES) {
        setFileError(t('feedback.files.tooMany', { max: FEEDBACK_MAX_FILES }));
        break;
      }
      if (!ALLOWED.test(f.name)) {
        setFileError(t('feedback.files.badType', { name: f.name }));
        continue;
      }
      if (f.size > FEEDBACK_MAX_FILE_BYTES) {
        setFileError(t('feedback.files.tooBig', { name: f.name }));
        continue;
      }
      next.push(f);
    }
    setFiles(next);
  }

  async function addScreenshot() {
    setFileError(null);
    try {
      const png = await window.watiCapture?.captureWindow();
      if (!png) throw new Error('no picture');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      addFiles([new File([new Uint8Array(png)], `screenshot-${stamp}.png`, { type: 'image/png' })]);
    } catch {
      setFileError(t('feedback.files.screenshotFailed'));
    }
  }

  async function send() {
    setTouched(true);
    setSendError(null);
    if (!valid) return;
    setSending(true);
    saveEmail(email.trim());
    const report: FeedbackReportBody = {
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
      client: feedbackClient(),
      language: i18n.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const form = new FormData();
    form.append('report', JSON.stringify(report));
    for (const f of files) form.append('file', f, f.name);
    try {
      const res = await api('/feedback', { form, schema: FeedbackSentResponse });
      setSent(res.reference);
    } catch (e) {
      setSendError(t(sendErrorKey(e)));
    } finally {
      setSending(false);
    }
  }

  type Field = keyof typeof problems;
  const fieldError = (key: Field) =>
    touched && problems[key] ? (
      <p id={`${id}-${key}-error`} className="text-sm text-destructive">
        {problems[key]}
      </p>
    ) : null;
  const fields = Object.fromEntries(
    (Object.keys(problems) as Field[]).map((k) => [k, k]),
  ) as Record<Field, Field>;

  if (sent) {
    return (
      <ResponsiveDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('feedback.sent.title')}
        footer={
          <>
            <Button variant="outline" size="touch" onClick={() => reset()}>
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
        </div>
      </ResponsiveDialog>
    );
  }

  const server = defaults.data?.diagnostics;
  const client = feedbackClient();
  const diagRows: [string, string][] = server
    ? [
        ['edition', t('feedback.diagValue.edition')],
        ['version', server.version],
        ['os', server.os],
        ['osVersion', server.osVersion],
        ['client', t(`feedback.diagValue.${client}`)],
        ['mode', t(`feedback.diagValue.${server.mode}`)],
        ['language', languageName(i18n.language)],
        ['timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone],
        ['screen', screen],
        ['waConnected', t(server.waConnected ? 'feedback.diag.yes' : 'feedback.diag.no')],
        [
          'aiMode',
          (['off', 'api', 'chatgpt', 'claude'] as const).includes(
            server.aiMode as 'off' | 'api' | 'chatgpt' | 'claude',
          )
            ? t(`feedback.diagValue.${server.aiMode as 'off' | 'api' | 'chatgpt' | 'claude'}`)
            : server.aiMode,
        ],
      ]
    : [];
  const companyFromEdition = !!defaults.data?.company;
  const canCapture = !!window.watiCapture;

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
            options={FEEDBACK_TYPES.map((v) => {
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
            aria-describedby={touched && problems.title ? `${id}-title-error` : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
          {fieldError(fields.title)}
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
            aria-describedby={touched && problems.details ? `${id}-details-error` : undefined}
            onChange={(e) => setDetails(e.target.value)}
          />
          <div className="flex justify-between gap-2">
            {fieldError(fields.details) ?? <span />}
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
              {FEEDBACK_AREAS.map((a) => (
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
                value={frequency as FeedbackFrequency}
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
                value={impact as FeedbackImpact}
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
            data-testid="feedback-file-input"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="touch"
              disabled={files.length >= FEEDBACK_MAX_FILES}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip aria-hidden="true" /> {t('feedback.files.add')}
            </Button>
            {canCapture && (
              <Button
                variant="outline"
                size="touch"
                disabled={files.length >= FEEDBACK_MAX_FILES}
                onClick={() => void addScreenshot()}
              >
                <Camera aria-hidden="true" /> {t('feedback.files.screenshot')}
              </Button>
            )}
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
                aria-describedby={touched && problems.name ? `${id}-name-error` : undefined}
                onChange={(e) => setName(e.target.value)}
              />
              {fieldError(fields.name)}
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
                aria-describedby={touched && problems.email ? `${id}-email-error` : undefined}
                onChange={(e) => setEmail(e.target.value)}
              />
              {fieldError(fields.email)}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-company`}>
              {t('feedback.contact.company')}{' '}
              {!companyFromEdition && (
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
              data-testid="feedback-include-details"
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
          {showDetails && diagRows.length > 0 && (
            <dl
              className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-3 text-sm"
              data-testid="feedback-diagnostics"
            >
              {diagRows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">
                    {t(`feedback.diag.${k}` as 'feedback.diag.edition')}
                  </dt>
                  <dd className="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
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
                {t('feedback.include.logHint', { lines: defaults.data?.logLines ?? 200 })}
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
              {showLog && defaults.data && (
                <pre
                  className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-3 font-mono text-xs"
                  data-testid="feedback-log"
                >
                  {defaults.data.logPreview}
                </pre>
              )}
            </>
          )}
        </div>

        <p className="text-sm text-muted-foreground">{t('feedback.privacy')}</p>
        {links.reportIssue && (
          <p className="text-sm">
            <a
              className="inline-flex min-h-11 items-center gap-1 text-primary underline-offset-4 hover:underline"
              href={links.reportIssue}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('feedback.github')} <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </p>
        )}

        {sendError && (
          <Banner tone="danger" title={t('feedback.errors.notSent')}>
            <span>{sendError}</span>
          </Banner>
        )}
        {touched && !valid && (
          <p role="alert" className="text-sm text-destructive">
            {t('feedback.errors.fix')}
          </p>
        )}
      </div>
    </ResponsiveDialog>
  );
}
