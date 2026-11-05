// Proposed (ai-handoff-rules), mock only: each agent's "Ask if the question is answered" switch,
// kept in this browser (localStorage) like the mock agents. Production: `ai_agents.resolution_check`
// (migration 026) through PUT /api/ai/agents/:agentId/resolution-check; off for every agent.
import { useSyncExternalStore } from 'react';
import type { AgentPreset } from './agents';

const KEY = 'mock.ai-resolution-check';
let state: Record<string, boolean> = load();
const listeners = new Set<() => void>();

function load(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    // Private window or blocked storage: every agent starts at its preset default.
  }
  return {};
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The agent's switch: its saved value, else off (every preset). */
export function useResolutionCheck(agentId: string, _preset: AgentPreset): boolean {
  const saved = useSyncExternalStore(subscribe, () => state);
  return saved[agentId] ?? false;
}

export function setResolutionCheck(agentId: string, enabled: boolean) {
  state = { ...state, [agentId]: enabled };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: keep the change for this page only.
  }
  for (const l of listeners) l();
}
