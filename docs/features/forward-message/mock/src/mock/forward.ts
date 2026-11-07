// Proposed (forward-message): forward one message to up to 5 existing chats or groups. The app sends
// `POST /api/messages/:id/forward` and reads `Message.forwarded` from the server; the mock asks its own
// routes (`forward.ts` in the mock folder) and keeps the "Forwarded" marks there.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export type ForwardScenario = 'normal' | 'offline' | 'slow_upload' | 'upload_fails';
export type InboxKind = 'linked_phone' | 'business_api';
export interface MediaLimits {
  video: number;
  image: number;
  document: number;
}

export interface ForwardState {
  scenario: ForwardScenario;
  /** message id → forwarding score (1 = "Forwarded", ≥ manyTimesScore = "Forwarded many times"). */
  forwarded: Record<string, number>;
  /** Messages WhatsApp Safety rated High: their files are locked and never forwarded. */
  safetyLocked: string[];
  limits: { maxChats: number; manyTimesScore: number; perMinute: number };
  /** What WhatsApp takes per connection kind (the app: `WaCapabilities.mediaLimits`). */
  mediaLimits: Record<InboxKind, MediaLimits>;
  /** Mock only: file sizes (message id → bytes); the app sends `Message.mediaSize`. */
  sizes: Record<string, number>;
}

/** "70 MB", "850 KB". */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const forwardKey = ['mock', 'forward'] as const;

export function useForwardState() {
  return useQuery({
    queryKey: forwardKey,
    queryFn: () => api<ForwardState>('/mock/forward'),
    refetchInterval: 4_000,
  });
}

/** The message's forwarded mark as WhatsApp shows it, or null. */
export function forwardedMark(
  state: ForwardState | undefined,
  messageId: string,
): 'once' | 'many' | null {
  const score = state?.forwarded[messageId];
  if (!score) return null;
  return score >= (state?.limits.manyTimesScore ?? 5) ? 'many' : 'once';
}
