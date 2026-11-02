import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { toast } from 'sonner';
import {
  BOOKING_TITLE_CHARACTERS,
  BookingSettings,
  type GoogleCalendarStatus,
} from '@ezychat/shared';
import { errorMessage } from '../../api/client';
import { useBookingSettings, useSaveBookingSettings } from '../../api/connectors';
import { Banner } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ErrorState, Field, ListSkeleton, Pending, SaveBar } from '../adminUi';
import { ToolSwitchRow } from './connector-ui';

const LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240];
const GAPS = [0, 5, 10, 15, 30, 60];
const NOTICES = [0, 1, 2, 4, 12, 24, 48, 72];
const AHEAD = [1, 3, 7, 14, 30, 60, 90];
// Monday first, as Malaysian calendars show it.
const DAYS = [1, 2, 3, 4, 5, 6, 0];

/** The listed options plus the saved value when it is not one of them. */
const withValue = (options: number[], value: number) =>
  options.includes(value) ? options : [...options, value].sort((a, b) => a - b);

type FieldErrors = Partial<Record<'title' | 'to' | 'days' | 'calendarId', string>>;

/**
 * Connectors → Google Calendar → Settings, for one AI agent: the calendar it uses, Check free
 * times (on by default), Book appointments (off until an admin turns it on) and the booking rules
 * the server enforces.
 */
export function BookingSettingsCard({
  agentId,
  name,
  status,
  onConnect,
}: Readonly<{
  agentId: number;
  name: string;
  status: GoogleCalendarStatus;
  /** Shows the account card (Overview tab) to connect. */
  onConnect: () => void;
}>) {
  const { t, i18n } = useTranslation('admin');
  const connected = status.state !== 'disconnected' && status.state !== 'not_configured';
  const query = useBookingSettings(agentId, connected);
  const save = useSaveBookingSettings(agentId);
  const [draft, setDraft] = useState<BookingSettings>();
  const [errors, setErrors] = useState<FieldErrors>({});
  const ids = { free: useId(), book: useId(), from: useId(), to: useId() };
  const saved = query.data;
  const value = draft ?? saved;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<BookingSettings>) => {
    if (value) setDraft({ ...value, ...patch });
  };
  const writable = status.calendars.filter((c) => !c.readOnly);
  const dayName = (day: number) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: 'short' }).format(
      new Date(2026, 0, 4 + day), // 4 Jan 2026 is a Sunday
    );
  const minutes = (n: number) => t('connectors.booking.minutes', { count: n });

  const submit = () => {
    if (!value) return;
    const next: FieldErrors = {};
    if (!value.title.trim()) next.title = t('connectors.booking.titleRequired');
    if (value.from >= value.to) next.to = t('connectors.booking.toAfterFrom');
    if ((value.checkFree || value.book) && value.days.length === 0)
      next.days = t('connectors.booking.daysRequired');
    if ((value.checkFree || value.book) && !value.calendarId)
      next.calendarId = t('connectors.booking.calendarRequired');
    setErrors(next);
    const parsed = BookingSettings.safeParse(value);
    if (Object.keys(next).length > 0 || !parsed.success) return;
    save.mutate(parsed.data, {
      onSuccess: () => {
        setDraft(undefined);
        toast.success(t('connectors.booking.saved'));
      },
    });
  };

  return (
    <Card className="gap-4" data-testid="agent-bookings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="size-5 text-muted-foreground" aria-hidden />
          {t('connectors.booking.title')}
        </CardTitle>
        <CardDescription>{t('connectors.booking.description', { name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!connected && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {status.state === 'not_configured'
                ? t('connectors.gc.notConfiguredBody')
                : t('connectors.booking.notConnected')}
            </p>
            {status.state === 'disconnected' && (
              <Button size="touch" onClick={onConnect}>
                {t('connectors.gc.connect')}
              </Button>
            )}
          </div>
        )}
        {connected && query.isPending && <ListSkeleton rows={3} />}
        {connected && query.error && (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
        {connected && value && (
          <>
            {(status.state === 'expired' || status.state === 'unavailable') && (
              <Banner tone="warning" title={t(`connectors.booking.paused.${status.state}`)}>
                {t('connectors.booking.pausedBody', { name })}{' '}
                <Button variant="link" className="h-auto p-0 align-baseline" onClick={onConnect}>
                  {t('connectors.booking.openAccount')}
                </Button>
              </Banner>
            )}
            <Field
              label={t('connectors.booking.calendar')}
              hint={t('connectors.booking.calendarHint')}
              error={errors.calendarId}
            >
              {(p) => (
                <Select
                  value={value.calendarId ?? ''}
                  onValueChange={(calendarId) => set({ calendarId })}
                >
                  <SelectTrigger
                    {...p}
                    className="min-h-11 w-full *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate"
                    data-testid="booking-calendar"
                  >
                    <SelectValue placeholder={t('connectors.booking.chooseCalendar')} />
                  </SelectTrigger>
                  <SelectContent>
                    {writable.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            <div className="flex flex-col divide-y rounded-lg border">
              <ToolSwitchRow
                id={ids.free}
                label={t('connectors.tools.checkFree')}
                hint={t('connectors.booking.checkFreeHint')}
                checked={value.checkFree}
                onCheckedChange={(checkFree) =>
                  set({ checkFree, book: checkFree ? value.book : false })
                }
              />
              <ToolSwitchRow
                id={ids.book}
                label={t('connectors.tools.book')}
                badge={t('connectors.booking.changesCalendar')}
                hint={
                  value.checkFree
                    ? t('connectors.booking.bookHint')
                    : t('connectors.booking.bookNeedsFree')
                }
                checked={value.book}
                disabled={!value.checkFree}
                onCheckedChange={(book) => set({ book })}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('connectors.booking.eventTitle')}
                hint={t('connectors.booking.eventTitleHint')}
                error={errors.title}
              >
                {(p) => (
                  <Input
                    {...p}
                    value={value.title}
                    maxLength={BOOKING_TITLE_CHARACTERS}
                    className="min-h-11"
                    onChange={(e) => set({ title: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('connectors.booking.length')}>
                {(p) => (
                  <Select
                    value={String(value.lengthMin)}
                    onValueChange={(v) => set({ lengthMin: Number(v) })}
                  >
                    <SelectTrigger {...p} className="min-h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {withValue(LENGTHS, value.lengthMin).map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {minutes(n)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">{t('connectors.booking.hours')}</legend>
              <div className="flex flex-wrap gap-2">
                {DAYS.map((day) => {
                  const id = `booking-day-${agentId}-${day}`;
                  return (
                    <Label
                      key={day}
                      htmlFor={id}
                      className="flex min-h-11 items-center gap-2 rounded-md border px-3"
                    >
                      <Checkbox
                        id={id}
                        checked={value.days.includes(day)}
                        onCheckedChange={(on) =>
                          set({
                            days:
                              on === true
                                ? [...value.days.filter((d) => d !== day), day].sort(
                                    (a, b) => a - b,
                                  )
                                : value.days.filter((d) => d !== day),
                          })
                        }
                      />
                      {dayName(day)}
                    </Label>
                  );
                })}
              </div>
              {errors.days && <p className="text-sm text-danger">{errors.days}</p>}
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={ids.from}>{t('connectors.booking.from')}</Label>
                  <Input
                    id={ids.from}
                    type="time"
                    value={value.from}
                    className="min-h-11 w-36"
                    onChange={(e) => set({ from: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={ids.to}>{t('connectors.booking.to')}</Label>
                  <Input
                    id={ids.to}
                    type="time"
                    value={value.to}
                    aria-invalid={errors.to ? true : undefined}
                    className="min-h-11 w-36"
                    onChange={(e) => set({ to: e.target.value })}
                  />
                </div>
              </div>
              {errors.to && <p className="text-sm text-danger">{errors.to}</p>}
              <p className="text-sm text-muted-foreground">{t('connectors.booking.hoursHint')}</p>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('connectors.booking.gap')}>
                {(p) => (
                  <Select
                    value={String(value.gapMin)}
                    onValueChange={(v) => set({ gapMin: Number(v) })}
                  >
                    <SelectTrigger {...p} className="min-h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {withValue(GAPS, value.gapMin).map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n === 0 ? t('connectors.booking.noGap') : minutes(n)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label={t('connectors.booking.notice')}>
                {(p) => (
                  <Select
                    value={String(value.noticeHours)}
                    onValueChange={(v) => set({ noticeHours: Number(v) })}
                  >
                    <SelectTrigger {...p} className="min-h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {withValue(NOTICES, value.noticeHours).map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n === 0
                            ? t('connectors.booking.noNotice')
                            : t('connectors.booking.hoursAhead', { count: n })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label={t('connectors.booking.ahead')}>
                {(p) => (
                  <Select
                    value={String(value.maxDays)}
                    onValueChange={(v) => set({ maxDays: Number(v) })}
                  >
                    <SelectTrigger {...p} className="min-h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {withValue(AHEAD, value.maxDays).map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {t('connectors.booking.daysAhead', { count: n })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>

            <div className="rounded-lg bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">
                {t('connectors.booking.rulesTitle')}
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>{t('connectors.booking.rule1')}</li>
                <li>{t('connectors.booking.rule2')}</li>
                <li>{t('connectors.booking.rule3')}</li>
                <li>{t('connectors.booking.rule4')}</li>
              </ul>
            </div>
            {save.error && <Banner tone="danger">{errorMessage(save.error)}</Banner>}
            <SaveBar dirty={dirty} inset="card">
              <Button size="touch" disabled={!dirty || save.isPending} onClick={submit}>
                <Pending show={save.isPending} />
                {t('connectors.booking.save')}
              </Button>
            </SaveBar>
          </>
        )}
      </CardContent>
    </Card>
  );
}
