// Test-only: a fake desktop import bridge and import states (no desktop, no Lite, no disk).
import { vi } from 'vitest';
import type {
  DesktopLiteImportBridge,
  LiteImportState,
  LiteImportStep,
  LiteSummary,
} from '@ezychat/shared';

export const LITE: LiteSummary = {
  dataDir: 'C:/ProgramData/wa-team-inbox',
  schemaVersion: 28,
  number: '+60 12-345 6789',
  ownJid: '60123456789@s.whatsapp.net',
  chats: 214,
  customers: 187,
  messages: 9000,
  mediaBytes: 1_000_000,
  totalBytes: 2 * 1024 ** 3,
  users: [
    { id: 1, username: 'aisyah', displayName: 'Aisyah', role: 'admin' },
    { id: 2, username: 'meiling', displayName: 'Mei Ling', role: 'agent' },
    { id: 3, username: 'junhao', displayName: 'Jun Hao', role: 'agent' },
  ],
  aiAgents: [{ id: 1, name: 'Kopi Sales', enabled: true }],
  quickReplyShortcuts: ['hi', 'price'],
  tokens: [
    { name: 'Claude Desktop', kind: 'oauth' },
    { name: 'ChatGPT', kind: 'token' },
  ],
  remote: 'managed',
  address: 'chat.kopiapong.my',
  port: 7420,
};

export const STEPS: LiteImportStep[] = [
  { id: 'stop', state: 'done', progress: null },
  { id: 'copy', state: 'running', progress: 0.5 },
  { id: 'merge', state: 'waiting', progress: null },
  { id: 'start', state: 'waiting', progress: null },
];

export function liteState(patch: Partial<LiteImportState> = {}): LiteImportState {
  return {
    phase: 'found',
    mode: 'merge',
    lite: LITE,
    liteService: false,
    enterprise: { hasData: true, inboxes: 2, maxInboxes: 10, freeBytes: 50 * 1024 ** 3 },
    issues: [],
    steps: [],
    result: null,
    failure: null,
    ...patch,
  };
}

/** A fake bridge: every call answers with `next` (or the state given); `emit` plays onChanged. */
export function fakeBridge(initial: LiteImportState) {
  let listener: ((s: LiteImportState) => void) | null = null;
  const bridge = {
    getState: vi.fn(async () => initial),
    scan: vi.fn(async () => initial),
    start: vi.fn(async () => liteState({ ...initial, phase: 'running', steps: STEPS })),
    reset: vi.fn(async () => liteState({ ...initial, phase: 'idle' })),
    saveSupportFile: vi.fn(async () => true),
    onChanged: vi.fn((cb: (s: LiteImportState) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  } satisfies DesktopLiteImportBridge;
  const emit = (s: LiteImportState) => listener?.(s);
  return { bridge, emit };
}
