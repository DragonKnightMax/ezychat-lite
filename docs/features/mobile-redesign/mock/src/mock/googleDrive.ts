import { useSyncExternalStore } from 'react';

/**
 * Proposed (google-drive): stand-in for the built-in Google Drive connector. Nothing calls Google:
 * the sign-in, Google's file picker and the AI's saves are simulated in this browser (kept in
 * localStorage so a reload keeps them). Production plan: `/api/connectors/google-drive/*` with the
 * shared Google sign-in (`connectors/google-account.ts`, scope `drive.file`), see ../../design.md.
 */
export type DriveState = 'disconnected' | 'connected' | 'expired' | 'unavailable';
export type DriveFileKind = 'doc' | 'sheet' | 'pdf' | 'text' | 'word';

export interface DriveFolder {
  id: string;
  name: string;
}

export interface DriveFile {
  id: string;
  name: string;
  kind: DriveFileKind;
  /** Characters of text the AI can read from it (null: Google answered, the file has no text). */
  characters: number | null;
}

export interface DriveAgentSettings {
  folder: DriveFolder | null;
  save: boolean;
  read: boolean;
  /** The files the admin picked for the AI to read (inside the folder). */
  files: DriveFile[];
}

export interface DriveActivity {
  at: number;
  kind: 'saved' | 'read' | 'skipped' | 'failed';
  agent: string;
  customer: string;
  /** read: how many files the AI opened; skipped: why it did not save. */
  count?: number;
  reason?: 'safety' | 'size' | 'already';
}

export interface DriveMockState {
  state: DriveState;
  account: string | null;
  agents: Record<string, DriveAgentSettings>;
  activity: DriveActivity[];
}

export const DRIVE_ACCOUNT = 'kopiapong.penang@gmail.com';
/** Folders Google's picker shows (stand-in). */
export const PICKER_FOLDERS: readonly DriveFolder[] = [
  { id: 'f-uploads', name: 'Customer files from WhatsApp' },
  { id: 'f-claims', name: 'Claims 2026' },
  { id: 'f-shared', name: 'Kopi Apong shared' },
];
/** Files inside the picked folder that Google's picker offers for reading (stand-in). */
export const PICKER_FILES: readonly DriveFile[] = [
  { id: 'd-menu', name: 'Menu and prices November', kind: 'doc', characters: 4_820 },
  { id: 'd-catering', name: 'Catering packages 2026.pdf', kind: 'pdf', characters: 11_400 },
  { id: 'd-stock', name: 'Stock this week', kind: 'sheet', characters: 2_260 },
  { id: 'd-faq', name: 'Delivery FAQ.txt', kind: 'text', characters: 1_380 },
  { id: 'd-terms', name: 'Terms for corporate orders.docx', kind: 'word', characters: 7_900 },
  { id: 'd-scan', name: 'Old flyer scan.pdf', kind: 'pdf', characters: null },
];
/** At most this many files per agent (design: one list read per turn stays small). */
export const MAX_READ_FILES = 50;
export const MAX_SAVE_MB = 25;

export const DEFAULT_DRIVE_SETTINGS: DriveAgentSettings = {
  folder: null,
  save: false,
  read: true,
  files: [],
};

const KEY = 'ezychat-mock-google-drive-v2';
const initial = (): DriveMockState => ({
  state: 'disconnected',
  account: null,
  agents: {},
  activity: [],
});

function load(): DriveMockState {
  try {
    const raw = localStorage.getItem(KEY);
    // v2: settings without use-case options (owner 2026-11-05).
    if (raw) return { ...initial(), ...(JSON.parse(raw) as DriveMockState) };
  } catch {
    // Private window or blocked storage: start empty.
  }
  return initial();
}

let current: DriveMockState = load();
const listeners = new Set<() => void>();

function set(next: DriveMockState) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Kept in memory only.
  }
  for (const listener of listeners) listener();
}

/** The current state outside React (gallery rows). */
export function readDriveState(): DriveState {
  return current.state;
}

export function useGoogleDrive(): DriveMockState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export function driveSettingsFor(state: DriveMockState, agentId: string): DriveAgentSettings {
  return state.agents[agentId] ?? DEFAULT_DRIVE_SETTINGS;
}

export const driveActions = {
  connect() {
    set({ ...current, state: 'connected', account: DRIVE_ACCOUNT });
  },
  setState(state: Exclude<DriveState, 'disconnected'>) {
    set({ ...current, state });
  },
  disconnect() {
    // Settings stay (like Google Calendar and Sheets); the AI stops using Drive until reconnected.
    set({ ...current, state: 'disconnected', account: null });
  },
  saveAgent(agentId: string, settings: DriveAgentSettings) {
    set({ ...current, agents: { ...current.agents, [agentId]: settings } });
  },
  addActivity(row: DriveActivity) {
    set({ ...current, activity: [row, ...current.activity].slice(0, 50) });
  },
  reset() {
    set(initial());
  },
};

/** The "Open in Google Drive" link of a folder (stand-in ids open Drive's home). */
export function driveFolderUrl(folder: DriveFolder): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folder.id)}`;
}

/**
 * The name EzyChat gives a saved file (design: never the customer's own file name, which can carry
 * anything): date, time, kind and a short reference, plus the type's extension.
 */
export function savedFileName(kind: 'photo' | 'pdf' | 'document', at: Date, ext: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}`;
  const label = kind === 'photo' ? 'Photo' : kind === 'pdf' ? 'PDF' : 'Document';
  return `${day} ${time} ${label} 7F3A.${ext}`;
}

/** The gallery card and page header status. */
export function driveStatus(state: DriveState): 'connected' | 'attention' | 'notConnected' {
  if (state === 'connected') return 'connected';
  if (state === 'expired' || state === 'unavailable') return 'attention';
  return 'notConnected';
}
