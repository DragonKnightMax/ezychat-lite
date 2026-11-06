// Proposed (new-chat): start a chat with a number that is not in the inbox yet. The app reads the
// switch from the bootstrap payload and calls `/api/inboxes/:id/new-chat[/check]`; the mock asks its own
// routes (`new-chat.ts` in the mock folder).
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export type NewChatScenario = 'normal' | 'disconnected' | 'daily_limit' | 'template_error';

export interface NewChatState {
  /** Settings → General: team members (not only admins) may start new chats. Off by default. */
  staffEnabled: boolean;
  /** The signed-in user may start new chats (admin, or the switch is on). */
  allowed: boolean;
  scenario: NewChatScenario;
  usedToday: Record<string, number>;
  /** perInboxPerDay: the admin's setting (default 20; 0 = no limit), linked phones only. */
  limits: { perInboxPerDay: number; perUserPerHour: number };
}

export type NewChatCheck =
  | { next: 'existing'; phone: string; chatJid: string }
  | { next: 'check' | 'template'; phone: string };

export const newChatKey = ['mock', 'new-chat'] as const;

export function useNewChatState() {
  return useQuery({
    queryKey: newChatKey,
    queryFn: () => api<NewChatState>('/mock/new-chat'),
    refetchInterval: 5_000,
  });
}

/** `+60 12-345 6789` from `60123456789` (Malaysian grouping; others in blocks of 4). */
export function formatIntl(digits: string): string {
  if (digits.startsWith('60')) {
    const rest = digits.slice(2);
    const head = rest.startsWith('1') ? rest.slice(0, 2) : rest.slice(0, 1);
    const tail = rest.slice(head.length);
    const a = tail.length > 7 ? tail.slice(0, 4) : tail.slice(0, 3);
    return `+60 ${head}-${a} ${tail.slice(a.length)}`;
  }
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 8) : digits.slice(0, 2);
  const rest = digits.slice(cc.length);
  return `+${cc} ${rest.slice(0, 4)} ${rest.slice(4)}`.trim();
}

/** The browser's quick format check (the server checks again): digits in international form or null. */
export function normalizePhone(raw: string, defaultCountry = '60'): string | null {
  const trimmed = raw.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    /* already international */
  } else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = defaultCountry + digits.slice(1);
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  if (digits.startsWith('601') && (digits.length < 11 || digits.length > 12)) return null;
  return digits;
}
