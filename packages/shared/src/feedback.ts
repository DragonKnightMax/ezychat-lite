import { z } from 'zod';

/**
 * Send feedback (docs/features/in-app-feedback/design.md): the browser sends a report to the local
 * server (`POST /api/feedback`, multipart: part `report` = this JSON, 0–3 `file` parts), which adds
 * the app details and the optional redacted log on the server and forwards it to the licence portal.
 * Nothing is sent until the user presses Send.
 */

export const FEEDBACK_TYPES = ['problem', 'idea', 'question', 'other'] as const;
export const FeedbackType = z.enum(FEEDBACK_TYPES);
export type FeedbackType = z.infer<typeof FeedbackType>;

/** The part of the app a report is about (the licence portal's codes). */
export const FEEDBACK_AREAS = [
  'inbox',
  'ai_agent',
  'whatsapp_link',
  'connectors',
  'reports',
  'settings',
  'install_update',
  'other',
] as const;
export const FeedbackArea = z.enum(FEEDBACK_AREAS);
export type FeedbackArea = z.infer<typeof FeedbackArea>;

export const FeedbackFrequency = z.enum(['always', 'sometimes', 'once']);
export type FeedbackFrequency = z.infer<typeof FeedbackFrequency>;
export const FeedbackImpact = z.enum(['blocking', 'slow', 'minor']);
export type FeedbackImpact = z.infer<typeof FeedbackImpact>;
export const FeedbackClient = z.enum(['desktop', 'browser']);
export type FeedbackClient = z.infer<typeof FeedbackClient>;

/** Attachment limits (the server reads the real type from the bytes). */
export const FEEDBACK_MAX_FILES = 3;
export const FEEDBACK_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
/** File names the dialog offers; the server checks the bytes, not the name. */
export const FEEDBACK_FILE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'pdf',
  'txt',
  'log',
  'mp4',
] as const;
/** The optional log: at most this many lines and bytes. */
export const FEEDBACK_LOG_LINES = 200;
export const FEEDBACK_LOG_MAX_BYTES = 64 * 1024;

/** Part `report` of `POST /api/feedback`. */
export const FeedbackReportBody = z
  .strictObject({
    /** Random per report; a retry with the same id is not sent twice. */
    clientReportId: z.string().uuid(),
    type: FeedbackType,
    title: z.string().trim().min(3).max(120),
    details: z.string().trim().min(10).max(5000),
    area: FeedbackArea,
    /** Problem only. */
    frequency: FeedbackFrequency.optional(),
    /** Problem only. */
    impact: FeedbackImpact.optional(),
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(200),
    company: z.string().trim().max(120).optional(),
    contactOk: z.boolean(),
    /** Attach the app details (edition, version, computer, connection states). */
    includeDetails: z.boolean(),
    /** Attach the last lines of the server log, redacted by the server. */
    includeLog: z.boolean(),
    /** The screen the user was on (app path); ids and numbers are removed by the server. */
    screen: z.string().max(300).default('/'),
    client: FeedbackClient,
    /** UI language and the browser's time zone (shown under "See what is sent"). */
    language: z.string().max(20).default(''),
    timeZone: z.string().max(64).default(''),
  })
  .refine((r) => r.type === 'problem' || (r.frequency === undefined && r.impact === undefined), {
    message: 'frequency and impact are for problems only',
    path: ['type'],
  });
export type FeedbackReportBody = z.infer<typeof FeedbackReportBody>;

/** App details the server knows (the browser adds client, language, time zone and screen). */
export const FeedbackServerDiagnostics = z.object({
  edition: z.enum(['lite', 'enterprise']),
  version: z.string(),
  os: z.string(),
  osVersion: z.string(),
  mode: z.enum(['standalone', 'service', 'dev']),
  waConnected: z.boolean(),
  /** `off`, or the connected AI mode (`api`, `chatgpt`, `claude`). Never a key. */
  aiMode: z.string(),
});
export type FeedbackServerDiagnostics = z.infer<typeof FeedbackServerDiagnostics>;

/** The app details sent with a report (`diagnostics` of the portal contract). */
export const FeedbackDiagnostics = FeedbackServerDiagnostics.extend({
  client: FeedbackClient,
  language: z.string(),
  timeZone: z.string(),
  screen: z.string(),
});
export type FeedbackDiagnostics = z.infer<typeof FeedbackDiagnostics>;

/** `GET /api/feedback/defaults`: what the dialog shows before anything is sent. */
export const FeedbackDefaults = z.object({
  /** The company an edition knows (e.g. from the licence); null in Lite. */
  company: z.string().nullable(),
  /** Lines in the log that would be attached (0 when there is none). */
  logLines: z.number().int().nonnegative(),
  /** Exactly the redacted log text that would be attached. */
  logPreview: z.string(),
  diagnostics: FeedbackServerDiagnostics,
});
export type FeedbackDefaults = z.infer<typeof FeedbackDefaults>;

/** 201 of `POST /api/feedback`: the portal's reference (e.g. FB-0043). */
export const FeedbackSentResponse = z.object({ reference: z.string().min(1).max(40) });
export type FeedbackSentResponse = z.infer<typeof FeedbackSentResponse>;
