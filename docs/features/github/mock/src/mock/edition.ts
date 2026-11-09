// Proposed (custom-agents): mock-only edition switch. "enterprise" shows several inboxes and one AI agent
// per inbox; "lite" shows the Lite app: one inbox, exactly one agent, no inbox UI, no Delete. The production
// app gets this from the server (`maxInboxes`, `maxAgents`), never from the browser.
import { useSyncExternalStore } from 'react';

export type MockEdition = 'enterprise' | 'lite';

const KEY = 'mock.customAgents.edition.v1';

let edition: MockEdition = initial();
const listeners = new Set<() => void>();

function initial(): MockEdition {
  // `?edition=lite` (or `enterprise`) in the address wins and is remembered.
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('edition');
    if (fromUrl === 'lite' || fromUrl === 'enterprise') {
      localStorage.setItem(KEY, fromUrl);
      return fromUrl;
    }
    const stored = localStorage.getItem(KEY);
    if (stored === 'lite' || stored === 'enterprise') return stored;
  } catch {
    // Private window or blocked storage: Enterprise view.
  }
  return 'enterprise';
}

export function setMockEdition(next: MockEdition) {
  edition = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked: keep the choice for this page only.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMockEdition(): MockEdition {
  return useSyncExternalStore(subscribe, () => edition);
}
