// Upload progress of composer files, by the message's clientId: the sending bubble shows it.
import { useSyncExternalStore } from 'react';

const progress = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** The share of `clientId`'s file uploaded so far (0..1), or null to clear it. */
export function setUploadProgress(clientId: string, share: number | null): void {
  if (share === null) {
    if (!progress.delete(clientId)) return;
  } else {
    progress.set(clientId, Math.min(1, Math.max(0, share)));
  }
  emit();
}

/** The current share of `clientId`'s upload (0..1), or null. */
export function uploadProgressOf(clientId: string): number | null {
  return progress.get(clientId) ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The upload progress of a message's file (0..1), or null when it is not uploading. */
export function useUploadProgress(clientId: string | null | undefined): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (clientId ? uploadProgressOf(clientId) : null),
    () => null,
  );
}
