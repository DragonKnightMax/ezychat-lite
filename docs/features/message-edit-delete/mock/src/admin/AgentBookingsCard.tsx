import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '../api/client';
import { Banner } from '@/components/app';
import { Badge } from '@/components/ui/badge';
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
import { Switch } from '@/components/ui/switch';
import {
  bookingFor,
  useGoogleCalendar,
  useGoogleCalendarAction,
  type AgentBooking,
} from '@/mock/googleCalendar';
import { Field, SaveBar } from './adminUi';

const LENGTHS = [30, 45, 60, 90, 120];
const GAPS = [0, 10, 15, 30];
const NOTICES = [0, 1, 2, 4, 24];
const AHEAD = [7, 14, 30, 60];
// Monday first, as Malaysian calendars show it.
const DAYS = [1, 2, 3, 4, 5, 6, 0];

/**
 * Proposed (google-calendar): agent page → Bookings. Which calendar this agent uses, the two AI
 * switches (Check free times on by default; Book appointments off until an admin turns it on) and
 * the booking rules the server enforces (length, opening hours, gap, notice, how far ahead).
 */
export function AgentBookingsCard({ agentId, name }: Readonly<{ agentId: string; name: string }>) {
  const { t, i18n } = useTranslation('admin');
  const query = useGoogleCalendar();
  const action = useGoogleCalendarAction();
  const saved = bookingFor(query.data, agentId);
  const [draft, setDraft] = useState<AgentBooking>();
  const value = draft ?? saved;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<AgentBooking>) => setDraft({ ...value, ...patch });
  const ids = { free: useId(), book: useId(), from: useId(), to: useId() };
  const state = query.data?.state ?? 'disconnected';
  const writable = (query.data?.calendars ?? []).filter((c) => !c.readOnly);
  const dayName = (day: number) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: 'short' }).format(
      new Date(2026, 0, 4 + day), // 4 Jan 2026 is a Sunday
    );
  const minutes = (n: number) => t('mockCalendar.minutes', { count: n });
  const save = () =>
    action.mutate(
      { kind: 'agent', agentId, booking: value },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast.success(t('mockCalendar.saved'));
        },
      },
    );

  return (
    <Card
      id="bookings"
      tabIndex={-1}
      className="scroll-mt-4 gap-4 outline-none"
      data-testid="agent-bookings"
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="size-5 text-muted-foreground" aria-hidden />
            {t('mockCalendar.agentTitle')}
          </CardTitle>
          <Badge variant="outline">{t('mockSuggest.proposed')}</Badge>
        </div>
        <CardDescription>{t('mockCalendar.agentDescription', { name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {query.data && state === 'disconnected' && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">{t('mockCalendar.agentNotConnected')}</p>
            <Button asChild size="touch">
              <Link to="/admin/connectors/google-calendar">{t('mockCalendar.connect')}</Link>
            </Button>
          </div>
        )}
        {query.data && state !== 'disconnected' && (
          <>
            {state !== 'connected' && (
              <Banner tone="warning" title={t(`mockCalendar.agentPaused.${state}`)}>
                {t('mockCalendar.agentPausedBody', { name })}{' '}
                <Link
                  to="/admin/connectors/google-calendar"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {t('mockConnectors.gc.openAccount')}
                </Link>
              </Banner>
            )}
            <Field label={t('mockCalendar.calendar')} hint={t('mockCalendar.calendarHint')}>
              {(p) => (
                <Select
                  value={value.calendarId}
                  onValueChange={(calendarId) => set({ calendarId })}
                >
                  <SelectTrigger {...p} className="min-h-11 w-full" data-testid="booking-calendar">
                    <SelectValue />
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
              <div className="flex items-start justify-between gap-4 px-3 py-3">
                <div className="min-w-0">
                  <Label htmlFor={ids.free}>{t('mockCalendar.checkFree')}</Label>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('mockCalendar.checkFreeHint')}
                  </p>
                </div>
                <Label
                  htmlFor={ids.free}
                  className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
                >
                  <Switch
                    id={ids.free}
                    checked={value.checkFree}
                    onCheckedChange={(checkFree) =>
                      set({ checkFree, book: checkFree ? value.book : false })
                    }
                  />
                </Label>
              </div>
              <div className="flex items-start justify-between gap-4 px-3 py-3">
                <div className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={ids.book}>{t('mockCalendar.book')}</Label>
                    <Badge variant="secondary">{t('mockCalendar.changesCalendar')}</Badge>
                  </span>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {value.checkFree ? t('mockCalendar.bookHint') : t('mockCalendar.bookNeedsFree')}
                  </p>
                </div>
                <Label
                  htmlFor={ids.book}
                  className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
                >
                  <Switch
                    id={ids.book}
                    checked={value.book}
                    disabled={!value.checkFree}
                    onCheckedChange={(book) => set({ book })}
                  />
                </Label>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('mockCalendar.eventTitle')} hint={t('mockCalendar.eventTitleHint')}>
                {(p) => (
                  <Input
                    {...p}
                    value={value.title}
                    maxLength={60}
                    className="min-h-11"
                    onChange={(e) => set({ title: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('mockCalendar.length')}>
                {(p) => (
                  <Select
                    value={String(value.lengthMin)}
                    onValueChange={(v) => set({ lengthMin: Number(v) })}
                  >
                    <SelectTrigger {...p} className="min-h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LENGTHS.map((n) => (
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
              <legend className="mb-2 text-sm font-medium">{t('mockCalendar.hours')}</legend>
              <div className="flex flex-wrap gap-2">
                {DAYS.map((day) => {
                  const id = `booking-day-${day}`;
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
                            days: on ? [...value.days, day] : value.days.filter((d) => d !== day),
                          })
                        }
                      />
                      {dayName(day)}
                    </Label>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={ids.from}>{t('mockCalendar.from')}</Label>
                  <Input
                    id={ids.from}
                    type="time"
                    value={value.from}
                    className="min-h-11 w-36"
                    onChange={(e) => set({ from: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={ids.to}>{t('mockCalendar.to')}</Label>
                  <Input
                    id={ids.to}
                    type="time"
                    value={value.to}
                    className="min-h-11 w-36"
                    onChange={(e) => set({ to: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-sm text-muted-foreground">{t('mockCalendar.hoursHint')}</p>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('mockCalendar.gap')}>
                {(p) => (
                  <Select
                    value={String(value.gapMin)}
                    onValueChange={(v) => set({ gapMin: Number(v) })}
                  >
                    <SelectTrigger {...p} className="min-h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GAPS.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n === 0 ? t('mockCalendar.noGap') : minutes(n)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label={t('mockCalendar.notice')}>
                {(p) => (
                  <Select
                    value={String(value.noticeHours)}
                    onValueChange={(v) => set({ noticeHours: Number(v) })}
                  >
                    <SelectTrigger {...p} className="min-h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NOTICES.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n === 0
                            ? t('mockCalendar.noNotice')
                            : t('mockCalendar.hoursAhead', { count: n })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label={t('mockCalendar.ahead')}>
                {(p) => (
                  <Select
                    value={String(value.maxDays)}
                    onValueChange={(v) => set({ maxDays: Number(v) })}
                  >
                    <SelectTrigger {...p} className="min-h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AHEAD.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {t('mockCalendar.daysAhead', { count: n })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>

            <div className="rounded-lg bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">{t('mockCalendar.rulesTitle')}</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>{t('mockCalendar.rule1')}</li>
                <li>{t('mockCalendar.rule2')}</li>
                <li>{t('mockCalendar.rule3')}</li>
                <li>{t('mockCalendar.rule4')}</li>
              </ul>
            </div>
            {action.error && <Banner tone="danger">{errorMessage(action.error)}</Banner>}
            <SaveBar dirty={dirty}>
              <Button size="touch" disabled={!dirty || action.isPending} onClick={save}>
                {t('mockCalendar.save')}
              </Button>
            </SaveBar>
          </>
        )}
      </CardContent>
    </Card>
  );
}
