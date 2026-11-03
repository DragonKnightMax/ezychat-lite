import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookingSettings,
  CalendarActivityList,
  CalendarBookingList,
  GoogleCalendarConnectProgress,
  GoogleCalendarConnectStart,
  GoogleCalendarStatus,
  GoogleSheetsStatus,
  SheetsActivityList,
  SheetsAgentSettings,
  SheetsPickerProgress,
  SheetsPickerStart,
  SpreadsheetInfo,
} from '@ezychat/shared';
import { api } from './client';

/** Admin → Connectors → Google Calendar (admins only). Tokens never reach the browser. */
export const googleCalendarKey = ['connectors', 'google-calendar'] as const;
export const bookingSettingsKey = (agentId: number) =>
  [...googleCalendarKey, 'agent', agentId] as const;
export const calendarActivityKey = [...googleCalendarKey, 'activity'] as const;
export const calendarBookingsKey = [...googleCalendarKey, 'bookings'] as const;

export function useGoogleCalendar(enabled = true) {
  return useQuery({
    queryKey: googleCalendarKey,
    queryFn: ({ signal }) =>
      api('/connectors/google-calendar', { signal, schema: GoogleCalendarStatus }),
    enabled,
  });
}

/** Starts Google's sign-in: the page opens `authorizationUrl` and polls the request. */
export function useGoogleCalendarConnect() {
  return useMutation({
    mutationFn: () =>
      api('/connectors/google-calendar/connect', {
        method: 'POST',
        schema: GoogleCalendarConnectStart,
      }),
  });
}

/** Polls a sign-in every 2 s until Google sent the person back (done) or it failed. */
export function useGoogleCalendarProgress(requestId: string | null) {
  return useQuery({
    queryKey: [...googleCalendarKey, 'connect', requestId] as const,
    queryFn: ({ signal }) =>
      api(`/connectors/google-calendar/connect/${encodeURIComponent(requestId ?? '')}`, {
        signal,
        schema: GoogleCalendarConnectProgress,
      }),
    enabled: requestId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 2000 : false),
    gcTime: 0,
  });
}

export function useGoogleCalendarDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/connectors/google-calendar/disconnect', { method: 'POST' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: googleCalendarKey }),
  });
}

/** One AI agent's booking settings (the defaults until an admin saves them). */
export function useBookingSettings(agentId: number | null, enabled = true) {
  return useQuery({
    queryKey: bookingSettingsKey(agentId ?? 0),
    queryFn: ({ signal }) =>
      api(`/connectors/google-calendar/agents/${agentId}`, { signal, schema: BookingSettings }),
    enabled: enabled && agentId !== null,
  });
}

export function useSaveBookingSettings(agentId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BookingSettings) =>
      api(`/connectors/google-calendar/agents/${agentId}`, {
        method: 'PUT',
        body,
        schema: BookingSettings,
      }),
    onSuccess: (saved) => qc.setQueryData(bookingSettingsKey(agentId), saved),
  });
}

/** Bookings tab: the events the AI added (EzyChat's own records) and links into Google Calendar. */
export function useCalendarBookings(enabled = true) {
  return useQuery({
    queryKey: calendarBookingsKey,
    queryFn: ({ signal }) =>
      api('/connectors/google-calendar/bookings', { signal, schema: CalendarBookingList }),
    enabled,
  });
}

export function useCalendarActivity(enabled = true) {
  return useQuery({
    queryKey: calendarActivityKey,
    queryFn: ({ signal }) =>
      api('/connectors/google-calendar/activity', { signal, schema: CalendarActivityList }),
    enabled,
  });
}

/** Admin → Connectors → Google Sheets (admins only). Tokens never reach the browser. */
export const googleSheetsKey = ['connectors', 'google-sheets'] as const;
export const sheetsSettingsKey = (agentId: number) =>
  [...googleSheetsKey, 'agent', agentId] as const;
export const sheetsActivityKey = [...googleSheetsKey, 'activity'] as const;

export function useGoogleSheets(enabled = true) {
  return useQuery({
    queryKey: googleSheetsKey,
    queryFn: ({ signal }) =>
      api('/connectors/google-sheets', { signal, schema: GoogleSheetsStatus }),
    enabled,
  });
}

/** Starts Google's sign-in for Google Sheets (its own sign-in, separate from the calendar's). */
export function useGoogleSheetsConnect() {
  return useMutation({
    mutationFn: () =>
      api('/connectors/google-sheets/connect', {
        method: 'POST',
        schema: GoogleCalendarConnectStart,
      }),
  });
}

/** Polls a Google Sheets sign-in every 2 s until it is done or failed. */
export function useGoogleSheetsProgress(requestId: string | null) {
  return useQuery({
    queryKey: [...googleSheetsKey, 'connect', requestId] as const,
    queryFn: ({ signal }) =>
      api(`/connectors/google-sheets/connect/${encodeURIComponent(requestId ?? '')}`, {
        signal,
        schema: GoogleCalendarConnectProgress,
      }),
    enabled: requestId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 2000 : false),
    gcTime: 0,
  });
}

export function useGoogleSheetsDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/connectors/google-sheets/disconnect', { method: 'POST' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: googleSheetsKey }),
  });
}

/** The spreadsheet behind a pasted link: its name and tabs (checked with Google). */
export function useSpreadsheetLookup() {
  return useMutation({
    mutationFn: (link: string) =>
      api('/connectors/google-sheets/spreadsheet', {
        method: 'POST',
        body: { link },
        schema: SpreadsheetInfo,
      }),
  });
}

/** One AI agent's Google Sheets settings (the defaults until an admin saves them). */
export function useSheetsSettings(agentId: number | null, enabled = true) {
  return useQuery({
    queryKey: sheetsSettingsKey(agentId ?? 0),
    queryFn: ({ signal }) =>
      api(`/connectors/google-sheets/agents/${agentId}`, { signal, schema: SheetsAgentSettings }),
    enabled: enabled && agentId !== null,
  });
}

export function useSaveSheetsSettings(agentId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SheetsAgentSettings) =>
      api(`/connectors/google-sheets/agents/${agentId}`, {
        method: 'PUT',
        body,
        schema: SheetsAgentSettings,
      }),
    onSuccess: (saved) => qc.setQueryData(sheetsSettingsKey(agentId), saved),
  });
}

/**
 * Reads the agent's spreadsheet again from Google (tab names and first rows) and clears the AI's
 * column cache. One a 10 s per install (429 `rate_limited`).
 */
export function useRefreshSheetTabs(agentId: number) {
  return useMutation({
    mutationFn: () =>
      api(`/connectors/google-sheets/agents/${agentId}/refresh`, {
        method: 'POST',
        schema: SpreadsheetInfo,
      }),
  });
}

export function useSheetsActivity(enabled = true) {
  return useQuery({
    queryKey: sheetsActivityKey,
    queryFn: ({ signal }) =>
      api('/connectors/google-sheets/activity', { signal, schema: SheetsActivityList }),
    enabled,
  });
}

/** Opens Google's file picker (a page on the computer that runs EzyChat). */
export function useSheetsPicker() {
  return useMutation({
    mutationFn: () =>
      api('/connectors/google-sheets/picker', { method: 'POST', schema: SheetsPickerStart }),
  });
}

/** Polls the picker every 2 s until the admin picked a sheet, cancelled, or it expired. */
export function useSheetsPickerProgress(requestId: string | null) {
  return useQuery({
    queryKey: [...googleSheetsKey, 'picker', requestId] as const,
    queryFn: ({ signal }) =>
      api(`/connectors/google-sheets/picker/${encodeURIComponent(requestId ?? '')}`, {
        signal,
        schema: SheetsPickerProgress,
      }),
    enabled: requestId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 2000 : false),
    gcTime: 0,
  });
}
