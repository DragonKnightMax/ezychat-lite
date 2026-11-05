import { z } from 'zod';
import { GoogleCalendarState } from './connectors.js';

/**
 * Google Drive connector (core; design docs/features/google-drive/design.md, rules
 * docs/connector-design.md). One Google account per install, signed in separately from Google
 * Calendar and Sheets, scope `drive.file`. Per AI agent: one folder (picked in Google's file
 * picker), Save files (off by default) and Read files (on by default) with the files the admin
 * picked. The connector only grants access: what to save or read, and when, is in the agent's
 * instructions.
 */

/** Same states as Google Calendar's sign-in. */
export const GoogleDriveState = GoogleCalendarState;
export type GoogleDriveState = z.infer<typeof GoogleDriveState>;

/** `GET /api/connectors/google-drive` (admins). Tokens are never sent to the browser. */
export const GoogleDriveStatus = z.object({
  state: GoogleDriveState,
  account: z.string().nullable(),
  connectedAt: z.number().int().nullable(),
  /** When it stopped working (expired/unavailable), else null. */
  problemSince: z.number().int().nullable(),
});
export type GoogleDriveStatus = z.infer<typeof GoogleDriveStatus>;

/** Google Drive file and folder ids: letters, digits, `-` and `_`. */
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
/** Files one agent may read. */
export const DRIVE_MAX_FILES = 50;
/** Largest file the AI saves. */
export const DRIVE_SAVE_MAX_BYTES = 25 * 1024 * 1024;
/** Largest file the AI reads (download or export). */
export const DRIVE_READ_MAX_BYTES = 10 * 1024 * 1024;
/** Characters of text one read returns to the model. */
export const DRIVE_READ_CHARACTERS = 20_000;

/** What kind of file it is for reading: the AI reads text from every kind but `other`. */
export const DriveFileKind = z.enum(['doc', 'sheet', 'pdf', 'word', 'text', 'other']);
export type DriveFileKind = z.infer<typeof DriveFileKind>;

/** Google Drive's own page of a folder. */
export function googleDriveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

/** Google Drive's own page of a file. */
export function googleDriveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

export const DriveFolder = z.object({
  id: z.string().regex(DRIVE_ID),
  name: z.string().max(300),
});
export type DriveFolder = z.infer<typeof DriveFolder>;

export const DriveFile = z.object({
  id: z.string().regex(DRIVE_ID),
  name: z.string().max(300),
  mimeType: z.string().max(200),
  kind: DriveFileKind,
});
export type DriveFile = z.infer<typeof DriveFile>;

/**
 * Per AI agent: `GET`/`PUT /api/connectors/google-drive/agents/:agentId` (admins). The server checks
 * the folder and the files with Google before it saves them and fills in names and kinds.
 */
export const DriveAgentSettings = z
  .object({
    /** The folder; null = not chosen yet. */
    folder: DriveFolder.nullable(),
    /** The AI may save files people send in a chat into the folder (a change: off by default). */
    save: z.boolean().default(false),
    /** The AI may read the files below (a look-up: on by default). */
    read: z.boolean().default(true),
    /** The files the admin picked for the AI to read. */
    files: z.array(DriveFile).max(DRIVE_MAX_FILES).default([]),
  })
  .refine((s) => new Set(s.files.map((f) => f.id)).size === s.files.length, {
    path: ['files'],
    message: 'a file is listed twice',
  });
export type DriveAgentSettings = z.infer<typeof DriveAgentSettings>;

export const DEFAULT_DRIVE_SETTINGS: DriveAgentSettings = {
  folder: null,
  save: false,
  read: true,
  files: [],
};

/** One line of the connector's Activity tab: who and when, never file names or contents. */
export const DriveActivityKind = z.enum(['saved', 'read', 'skipped', 'failed']);
export type DriveActivityKind = z.infer<typeof DriveActivityKind>;
/** Why a file was not saved. */
export const DriveSkipReason = z.enum(['safety', 'size', 'unavailable']);
export type DriveSkipReason = z.infer<typeof DriveSkipReason>;
export const DriveActivity = z.object({
  id: z.number().int(),
  at: z.number().int(),
  kind: DriveActivityKind,
  agentId: z.number().int().nullable(),
  agentName: z.string(),
  chatJid: z.string().nullable(),
  /** The customer's saved or WhatsApp name (shown to admins only). */
  customer: z.string(),
  /** The chat's name when it is a group. */
  group: z.string().nullable().default(null),
  /** skipped: why. */
  reason: DriveSkipReason.nullable().default(null),
});
export type DriveActivity = z.infer<typeof DriveActivity>;

/** `GET /api/connectors/google-drive/activity` (admins): newest first, at most 50. */
export const DriveActivityList = z.object({ activity: z.array(DriveActivity) });
export type DriveActivityList = z.infer<typeof DriveActivityList>;

/**
 * `POST /api/connectors/google-drive/picker` (admins) {kind, folderId?}: Google's file picker on a
 * page of this computer. `folder` picks one folder; `files` picks up to 50 files, opened in the
 * agent's folder. Only what is picked there can be used (`drive.file`).
 */
export const DrivePickerBody = z.object({
  kind: z.enum(['folder', 'files']),
  folderId: z.string().regex(DRIVE_ID).optional(),
});
export type DrivePickerBody = z.infer<typeof DrivePickerBody>;
export const DrivePickerStart = z.object({
  requestId: z.string(),
  pickerUrl: z.string().url(),
});
export type DrivePickerStart = z.infer<typeof DrivePickerStart>;

/** `GET /api/connectors/google-drive/picker/:requestId`: the page polls until it is not pending. */
export const DrivePickerProgress = z.object({
  status: z.enum(['pending', 'done', 'cancelled', 'failed', 'expired']),
  /** done, kind folder: the picked folder. */
  folder: DriveFolder.nullable(),
  /** done, kind files: the picked files (checked with Google). */
  files: z.array(DriveFile).default([]),
});
export type DrivePickerProgress = z.infer<typeof DrivePickerProgress>;

/** The picker page's answer (`POST /api/connectors/google-drive/picker-result`, this computer only). */
export const DrivePickerResult = z.object({
  token: z.string().min(1).max(100),
  ids: z.array(z.string().regex(DRIVE_ID)).max(DRIVE_MAX_FILES).optional(),
  cancelled: z.boolean().optional(),
});
export type DrivePickerResult = z.infer<typeof DrivePickerResult>;
