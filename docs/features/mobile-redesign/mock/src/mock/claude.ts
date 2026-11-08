// Proposed (claude-provider): mock-only "Claude API key" connection. Production keeps the mode, the
// Anthropic key (encrypted, `ai_claude_api_key`) and the model on the server; this mock keeps them in
// the browser and, so the agents can be turned on and tried, keeps the server on its OpenAI API key
// connection underneath (a stand-in key when none was saved). No request ever reaches Anthropic.
import { useSyncExternalStore } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AiMemberStatus } from '@ezychat/shared';
import { api } from '../api/client';

/** The three fixed models of the spec; '' (not chosen yet) means the default, Sonnet. */
export const MOCK_CLAUDE_MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', labelKey: 'mockClaude.models.sonnet' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', labelKey: 'mockClaude.models.opus' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', labelKey: 'mockClaude.models.haiku' },
] as const;
export const MOCK_CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_CONSOLE_URL = 'https://console.anthropic.com/settings/keys';

/** The connection the screens show: the server's two modes plus the proposed third. */
export type ShownMode = 'chatgpt' | 'api' | 'claude';

export interface MockClaudeState {
  /** The saved connection is the Claude API key. */
  active: boolean;
  /** An Anthropic key is saved (kept when the admin switches to another connection). */
  hasKey: boolean;
  model: string;
  /** The server holds the stand-in OpenAI key, so the OpenAI view must say "no key saved". */
  openAiStandIn: boolean;
}

const KEY = 'mock.claudeProvider.v1';
const EMPTY: MockClaudeState = { active: false, hasKey: false, model: '', openAiStandIn: false };
/** Placeholder only; the mock runner never sends it anywhere (all outside requests are blocked). */
const STAND_IN_OPENAI_KEY = 'sk-mock-stand-in-for-claude';

let state: MockClaudeState = initial();
const listeners = new Set<() => void>();

function initial(): MockClaudeState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<MockClaudeState>;
    return {
      active: parsed.active === true,
      hasKey: parsed.hasKey === true,
      model: typeof parsed.model === 'string' ? parsed.model : '',
      openAiStandIn: parsed.openAiStandIn === true,
    };
  } catch {
    // Private window or blocked storage: start with no Claude connection.
    return EMPTY;
  }
}

export function setMockClaude(patch: Partial<MockClaudeState>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: keep it for this page only.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMockClaude(): MockClaudeState {
  return useSyncExternalStore(subscribe, () => state);
}

/** The mode the screens show: Claude while the mock connection is active, else the server's. */
export function shownMode(status: AiMemberStatus, claude: MockClaudeState): ShownMode {
  return claude.active ? 'claude' : status.settings.mode === 'chatgpt' ? 'chatgpt' : 'api';
}

/** An OpenAI key the admin saved (not the mock's stand-in). */
export function shownHasOpenAiKey(status: AiMemberStatus, claude: MockClaudeState): boolean {
  return status.hasApiKey && !claude.openAiStandIn;
}

type ConnectionSave = (settings: {
  mode: 'api';
  model: string;
  apiKey?: string;
}) => Promise<unknown>;

/**
 * Saves the Claude connection: the server goes to (or stays on) its OpenAI-key connection so the
 * mock's AI is "ready", then the browser records Claude as the saved connection.
 */
export async function saveMockClaude(
  status: AiMemberStatus,
  save: ConnectionSave,
  next: { model: string; newKey: boolean },
) {
  const standIn = !status.hasApiKey;
  if (status.settings.mode !== 'api' || standIn)
    await save({
      mode: 'api',
      model: status.settings.mode === 'api' ? status.settings.model : '',
      ...(standIn ? { apiKey: STAND_IN_OPENAI_KEY } : {}),
    });
  setMockClaude({
    active: true,
    hasKey: state.hasKey || next.newKey,
    model: next.model,
    openAiStandIn: state.openAiStandIn || standIn,
  });
}

export type ClaudeKeyCheck = { ok: boolean; error: string | null; warning: string | null };

/**
 * PROPOSED (mock): checks an Anthropic key before it is saved. The mock runner accepts keys that
 * start with "sk-ant-"; production calls GET https://api.anthropic.com/v1/models with the key.
 */
export function useTestClaudeKey() {
  return useMutation({
    mutationFn: (apiKey: string) =>
      api<ClaudeKeyCheck>('/mock/ai/test-claude-key', { method: 'POST', body: { apiKey } }),
  });
}

/** Simulated "Test connection" with the saved Claude key: a short fixed reply, no model call. */
export function useTestClaudeConnection() {
  return useMutation({
    mutationFn: async (model: string) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const id = model || MOCK_CLAUDE_DEFAULT_MODEL;
      // The product name, not the model id (production: the AI SDK reports the id; show the name).
      const name = MOCK_CLAUDE_MODELS.find((m) => m.id === id)?.name ?? id;
      return { ok: true as const, model: name, reply: 'Hello!' };
    },
  });
}
