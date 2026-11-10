import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  DEFAULT_BOOKING_SETTINGS,
  DEFAULT_DRIVE_SETTINGS,
  DEFAULT_GITHUB_SETTINGS,
  DEFAULT_SHEETS_SETTINGS,
  googleSheetUrl,
  spreadsheetIdFromLink,
  type GoogleSheetsStatus,
  type DriveActivity,
  type DriveAgentSettings,
  type DrivePickerBody,
  type DrivePickerProgress,
  type GoogleDriveStatus,
  type GitHubActivity,
  type GitHubAgentSettings,
  type GitHubAgentView,
  type GitHubDeviceProgress,
  type GitHubRepo,
  type GitHubStatus,
  type GitHubTokenError,
  type SheetsActivity,
  type SheetLayout,
  type SheetsAgentSettings,
  type SheetsPickerProgress,
  type SpreadsheetInfo,
  type AiAgentSummary,
  type BookingSettings,
  type CalendarActivity,
  type CalendarBookingList,
  type ConnectorActivity,
  type ConnectorAgentSettings,
  type ConnectorConnectionView,
  type ConnectorConnectProgress,
  type ConnectorConnectResult,
  type ConnectorEntry,
  type ConnectorGallery,
  type ConnectorListStatus,
  type ConnectorProblem,
  type GalleryConnector,
  type GoogleCalendarConnectProgress,
  type GoogleCalendarStatus,
} from '@ezychat/shared';
import { AppLinksProvider } from '@/lib/app-links';
import { resolveAppLinks, type AppLinks } from '@/lib/links';
import type { ConnectorChoices, ConnectorTestResult } from '@ezychat/shared';
import { WebExtensionsProvider, type WebExtension } from '../../extensions';

export const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });

export const CALENDARS: GoogleCalendarStatus['calendars'] = [
  { id: 'primary', name: 'kopiapong@gmail.com', primary: true, readOnly: false },
  { id: 'bookings', name: 'Table bookings', primary: false, readOnly: false },
  { id: 'holidays', name: 'Holidays in Malaysia', primary: false, readOnly: true },
];

export const status = (
  state: GoogleCalendarStatus['state'],
  patch: Partial<GoogleCalendarStatus> = {},
): GoogleCalendarStatus => ({
  state,
  account:
    state === 'connected' || state === 'expired' || state === 'unavailable'
      ? 'kopiapong@gmail.com'
      : null,
  calendars: state === 'disconnected' || state === 'not_configured' ? [] : CALENDARS,
  connectedAt: null,
  problemSince: null,
  ...patch,
});

/** A Google connector's sign-in status (Sheets, Drive: the same shape). */
const signInStatus = (state: GoogleSheetsStatus['state']): GoogleSheetsStatus => ({
  state,
  account:
    state === 'connected' || state === 'expired' || state === 'unavailable'
      ? 'kopiapong@gmail.com'
      : null,
  connectedAt: null,
  problemSince: null,
});
export const sheetsStatus = signInStatus;
export const driveStatus = (state: GoogleDriveStatus['state']): GoogleDriveStatus =>
  signInStatus(state);

/** GitHub's sign-in status: signed in as `kopiapong-dev` unless not connected. */
export const githubStatus = (
  state: GitHubStatus['state'],
  patch: Partial<GitHubStatus> = {},
): GitHubStatus => ({
  state,
  method: state === 'not_connected' ? null : 'app',
  login: state === 'not_connected' ? null : 'kopiapong-dev',
  connectedAt: null,
  tokenExpiresAt: null,
  problemSince: null,
  manageUrl:
    state === 'not_connected'
      ? null
      : 'https://github.com/apps/ezychat-by-anchor-sprint/installations/new',
  ...patch,
});

export const repo = (id: number, fullName: string, isPrivate = true): GitHubRepo => ({
  id,
  fullName,
  private: isPrivate,
});

export const GITHUB_REPOS: GitHubRepo[] = [
  repo(11, 'kopiapong/pos-app'),
  repo(12, 'kopiapong/website', false),
  repo(13, 'kopiapong/payroll'),
  repo(21, 'kopiapong-dev/menu-board', false),
];

export const DRIVE_FOLDER = { id: 'folder-claims-0000000001', name: 'Customer claims' };

export const SHEET_ID = 'kopiapong-prices-000000000000000000';
export const SHEET: SpreadsheetInfo = {
  id: SHEET_ID,
  name: 'Kopi Apong prices',
  tabs: [
    { title: 'Menu', rows: 1000, columns: ['Item', 'Price', 'Stock'] },
    { title: 'Leads', rows: 1000, columns: ['Date', 'Name', 'WhatsApp', 'Email', 'Request'] },
    { title: 'Notes', rows: 1000, columns: [] },
  ],
  checkedAt: null,
  url: googleSheetUrl(SHEET_ID),
};

export const agent = (id: number, displayName: string): AiAgentSummary => ({
  id,
  userId: 100 + id,
  displayName,
  enabled: true,
  preset: 'sales',
  inboxId: id,
  documentCount: 0,
  answerDirect: true,
  groupCount: 0,
});

const HOUR = 3_600_000;

export const listStatus = (
  state: ConnectorListStatus['state'] = 'loaded',
  patch: Partial<ConnectorListStatus> = {},
): ConnectorListStatus => ({
  state,
  generatedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
  sequence: 42,
  checkedAt: Date.now() - 2 * HOUR,
  appVersion: '0.1.62',
  hidden: 0,
  ...patch,
});

/** A list entry: a partner (MCP) connector with an API key unless the patch says otherwise. */
export const entry = (id: string, patch: Partial<ConnectorEntry> = {}): ConnectorEntry => ({
  id,
  schemaVersion: 1,
  minAppVersion: '0.1.0',
  kind: 'mcp',
  editions: ['lite', 'enterprise'],
  name: id,
  summary: { en: `${id} summary` },
  description: { en: `${id} description` },
  category: 'other',
  mcp: { url: `https://${id}.example/mcp` },
  auth: {
    type: 'api_key',
    label: { en: 'API key' },
    header: { name: 'Authorization', value: 'Bearer {key}' },
  },
  tools: [
    {
      name: 'look',
      title: { en: 'Look it up' },
      description: { en: 'Finds things.' },
      access: 'read',
    },
  ],
  ...patch,
});

export const soon = (
  id: string,
  name: string,
  category: ConnectorEntry['category'],
  summary: string,
): ConnectorEntry =>
  entry(id, {
    kind: 'coming_soon',
    name,
    category,
    summary: { en: summary },
    mcp: undefined,
    auth: undefined,
    tools: [
      {
        name: 'one',
        title: { en: `${name} look-up` },
        description: { en: `Reads ${name}.` },
        access: 'read',
      },
    ],
  });

export const connection = (
  state: ConnectorConnectionView['state'] = 'connected',
  patch: Partial<ConnectorConnectionView> = {},
): ConnectorConnectionView => ({
  state,
  account: null,
  keyEnd: null,
  connectedAt: state === 'connected' ? Date.now() - 3 * HOUR : null,
  fields: {},
  ...patch,
});

export const listed = (
  e: ConnectorEntry,
  patch: Partial<Omit<GalleryConnector, 'entry'>> = {},
): GalleryConnector => ({ entry: e, fit: 'ok', delisted: false, connection: null, ...patch });

/** The list the server ships with the app: Google Calendar (built in) and coming-soon entries. */
export const DEFAULT_LIST: GalleryConnector[] = [
  listed(
    entry('google-calendar', {
      kind: 'builtin',
      builtinId: 'google-calendar',
      name: 'Google Calendar',
      category: 'calendar',
      mcp: undefined,
      auth: undefined,
      tools: undefined,
    }),
  ),
  listed(soon('autocount', 'AutoCount', 'accounting', 'Stock and quotations from AutoCount.')),
  listed(soon('xero', 'Xero', 'accounting', 'Invoices and contacts in Xero.')),
  listed(soon('shopify', 'Shopify', 'online_shop', 'Order status and stock from Shopify.')),
  listed(soon('hitpay', 'HitPay', 'payments', 'Send a payment link with HitPay.')),
  listed(soon('billplz', 'Billplz', 'payments', 'Send a payment link with Billplz.')),
];

export const gallery = (
  connectors: GalleryConnector[] = DEFAULT_LIST,
  listState: ConnectorListStatus = listStatus(),
): ConnectorGallery => ({ status: listState, connectors });

/** The server as the connector pages see it; every write is recorded. */
export interface World {
  google: GoogleCalendarStatus;
  /** Google Sheets: its own sign-in, settings per agent, activity and the sheets Google knows. */
  sheets: GoogleSheetsStatus;
  sheetsProgress: GoogleCalendarConnectProgress[];
  sheetSettings: Record<number, SheetsAgentSettings>;
  sheetsActivity: SheetsActivity[];
  spreadsheets: Record<string, SpreadsheetInfo>;
  /** Answers to the file picker polls, in order (the last one repeats). */
  pickerProgress: SheetsPickerProgress[];
  /**
   * Answers to Refresh (`POST …/agents/:id/refresh`), in order (the last one repeats); empty = the
   * saved spreadsheet as `spreadsheets` holds it. `'busy'` answers 429 rate_limited.
   */
  sheetRefresh: (SpreadsheetInfo | 'busy')[];
  /** Layouts sent to Create a new sheet (`POST …/agents/:id/create`), in order. */
  sheetCreated: SheetLayout[];
  /** Google Drive: its own sign-in, settings per agent, activity and picker answers. */
  drive: GoogleDriveStatus;
  driveProgress: GoogleCalendarConnectProgress[];
  driveSettings: Record<number, DriveAgentSettings>;
  driveActivity: DriveActivity[];
  /** Answers to the Drive picker polls, in order (the last one repeats). */
  drivePicker: DrivePickerProgress[];
  /** Bodies of `POST …/google-drive/picker`. */
  drivePickerBodies: DrivePickerBody[];
  /** GitHub (Lite only): its sign-in, device-flow polls, token answers, repos and settings. */
  github: GitHubStatus;
  /** Answers to the device-code polls, in order (the last one repeats). */
  githubDevice: GitHubDeviceProgress[];
  /** What the next token sign-in answers: refused with this code, else connected with a token. */
  githubTokenError?: GitHubTokenError;
  /** Device sign-ins started (each gets request id `dev-<n>`). */
  githubDeviceStarts?: number;
  /** What "Check again" answers. */
  githubCheck?: GitHubStatus;
  githubRepos: GitHubRepo[];
  githubAgents: Record<number, GitHubAgentView>;
  githubActivity: GitHubActivity[];
  /** `GET /api/health`'s edition; unset = no health answer (edition unknown). */
  edition?: string;
  agents: AiAgentSummary[];
  bookings: Record<number, BookingSettings>;
  activity: CalendarActivity[];
  /** The Bookings tab's list. */
  calendarBookings: CalendarBookingList;
  /** Answers to the sign-in polls, in order (the last one repeats). */
  progress: GoogleCalendarConnectProgress[];
  /** Admin → Connectors: the list as the server keeps it. */
  gallery: ConnectorGallery;
  /** What `POST /connectors/list/refresh` answers (default: the same list). */
  refreshed?: ConnectorGallery;
  /** Partner settings by `<id>:<agentId>`. */
  mcpSettings: Record<string, ConnectorAgentSettings>;
  mcpActivity: Record<string, ConnectorActivity[]>;
  /** Answers to a partner's sign-in polls, in order (the last one repeats). */
  mcpProgress: ConnectorConnectProgress[];
  /** What Connect answers; default: OAuth gives a sign-in page, the others connect at once. */
  mcpConnect?: (id: string, fields: Record<string, string>) => ConnectorConnectResult;
  /** What Test answers. */
  mcpTest?: (id: string, fields: Record<string, string>) => ConnectorTestResult;
  choices: ConnectorChoices;
  /** Fail a path with this status (e.g. 500). */
  fail?: Partial<Record<string, number>>;
  /** Fail a path the way the partner module does: 400 with the problem as the error code. */
  problems?: Partial<Record<string, ConnectorProblem>>;
}

export function world(patch: Partial<World> = {}): World {
  return {
    google: status('connected'),
    sheets: sheetsStatus('disconnected'),
    sheetsProgress: [{ status: 'done', error: null }],
    sheetSettings: {},
    sheetsActivity: [],
    spreadsheets: { [SHEET_ID]: SHEET },
    pickerProgress: [{ status: 'done', sheet: SHEET }],
    sheetRefresh: [],
    sheetCreated: [],
    drive: driveStatus('disconnected'),
    driveProgress: [{ status: 'done', error: null }],
    driveSettings: {},
    driveActivity: [],
    drivePicker: [{ status: 'done', folder: DRIVE_FOLDER, files: [] }],
    drivePickerBodies: [],
    github: githubStatus('not_connected'),
    githubDevice: [{ status: 'pending', github: null }],
    githubRepos: GITHUB_REPOS,
    githubAgents: {},
    githubActivity: [],
    agents: [agent(1, 'Aina')],
    bookings: {},
    activity: [],
    calendarBookings: {
      upcoming: [],
      past: [],
      calendarUrl: 'https://calendar.google.com/calendar/r?authuser=kopiapong%40gmail.com',
    },
    progress: [{ status: 'done', error: null }],
    gallery: gallery(),
    mcpSettings: {},
    mcpActivity: {},
    mcpProgress: [{ status: 'done', problem: null }],
    choices: {
      options: [
        { value: 'main', label: 'Main calendar' },
        { value: 'team', label: 'Team calendar' },
      ],
    },
    ...patch,
  };
}

/** Puts a partner connection into the world's list. */
function setConnection(w: World, id: string, view: ConnectorConnectionView) {
  w.gallery = {
    ...w.gallery,
    connectors: w.gallery.connectors.map((c) =>
      c.entry.id === id ? { ...c, connection: view } : c,
    ),
  };
}

/** `/connectors/mcp/:id/*` of the partner connections module. */
function mcpRoute(w: World, method: string, path: string, init?: RequestInit): Response | null {
  const m = /^\/connectors\/mcp\/([^/]+)\/(.+)$/.exec(path);
  if (!m) return null;
  const id = decodeURIComponent(m[1]!);
  const rest = m[2]!;
  const body = init?.body
    ? (JSON.parse(String(init.body)) as { fields?: Record<string, string> })
    : {};
  const fields = body.fields ?? {};
  const e = w.gallery.connectors.find((c) => c.entry.id === id)?.entry;
  if (rest === 'connect' && method === 'POST') {
    const oauth = e?.auth?.type === 'oauth' || e?.auth?.type === 'oauth_own_app';
    const result: ConnectorConnectResult =
      w.mcpConnect?.(id, fields) ??
      (oauth
        ? {
            authorizationUrl: 'https://partner.example/authorize?x=1',
            requestId: 'req-9',
            connection: connection('waiting'),
          }
        : {
            authorizationUrl: null,
            requestId: null,
            connection: connection('connected', {
              keyEnd: (fields.key ?? Object.values(fields).at(-1) ?? '').slice(-4) || null,
            }),
          });
    setConnection(w, id, result.connection);
    return json(result);
  }
  if (rest.startsWith('connect/')) {
    const next = w.mcpProgress.length > 1 ? w.mcpProgress.shift()! : w.mcpProgress[0]!;
    if (next.status === 'done')
      setConnection(w, id, connection('connected', { account: 'owner@kopiapong.my' }));
    return json(next);
  }
  if (rest === 'test' && method === 'POST')
    return json(
      w.mcpTest?.(id, fields) ?? {
        ok: true,
        tools: ['find_invoice', 'check_stock', 'create_quotation'],
        problem: null,
      },
    );
  if (rest === 'disconnect' && method === 'POST') {
    const view = connection('disconnected');
    setConnection(w, id, view);
    return json(view);
  }
  const agentMatch = /^agents\/(\d+)$/.exec(rest);
  if (agentMatch) {
    const key = `${id}:${agentMatch[1]}`;
    if (method === 'PUT')
      w.mcpSettings[key] = JSON.parse(String(init!.body)) as ConnectorAgentSettings;
    return json(w.mcpSettings[key] ?? { settings: {}, tools: {} });
  }
  if (rest === 'activity') return json({ activity: w.mcpActivity[id] ?? [] });
  if (rest.startsWith('choices/')) return json(w.choices);
  return null;
}

/** The Google Sheets routes of the fake server. */
function sheetsRoute(w: World, method: string, path: string, init?: RequestInit): Response | null {
  if (!path.startsWith('/connectors/google-sheets')) return null;
  const rest = path.slice('/connectors/google-sheets'.length);
  if (rest === '') return json(w.sheets);
  if (rest === '/connect' && method === 'POST')
    return json({
      requestId: 'req-s',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?s=1',
    });
  if (rest.startsWith('/connect/')) {
    const next = w.sheetsProgress.length > 1 ? w.sheetsProgress.shift()! : w.sheetsProgress[0]!;
    if (next.status === 'done') w.sheets = sheetsStatus('connected');
    return json(next);
  }
  if (rest === '/disconnect' && method === 'POST') {
    w.sheets = sheetsStatus('disconnected');
    return json(w.sheets);
  }
  if (rest === '/picker' && method === 'POST')
    return json({
      requestId: 'pick-1',
      pickerUrl: 'http://127.0.0.1:7420/api/connectors/google-sheets/picker-page?token=t',
    });
  if (rest.startsWith('/picker/'))
    return json(w.pickerProgress.length > 1 ? w.pickerProgress.shift()! : w.pickerProgress[0]!);
  if (rest === '/spreadsheet' && method === 'POST') {
    const { link } = JSON.parse(String(init!.body)) as { link: string };
    const found = w.spreadsheets[spreadsheetIdFromLink(link) ?? ''];
    return found
      ? json(found)
      : json(
          {
            error: {
              code: 'validation',
              message: 'The connected Google account cannot open this spreadsheet.',
            },
          },
          400,
        );
  }
  const refreshMatch = /^\/agents\/(\d+)\/refresh$/.exec(rest);
  if (refreshMatch && method === 'POST') {
    const next = w.sheetRefresh.length > 1 ? w.sheetRefresh.shift()! : (w.sheetRefresh[0] ?? null);
    if (next === 'busy')
      return json({ error: { code: 'rate_limited', message: 'Too many requests' } }, 429);
    const saved = w.sheetSettings[Number(refreshMatch[1])]?.spreadsheetId ?? '';
    const found = next ?? w.spreadsheets[saved];
    return found
      ? json(found)
      : json({ error: { code: 'validation', message: 'No spreadsheet chosen.' } }, 400);
  }
  const createMatch = /^\/agents\/(\d+)\/create$/.exec(rest);
  if (createMatch && method === 'POST') {
    const layout = JSON.parse(init!.body as string) as SheetLayout;
    w.sheetCreated.push(layout);
    const id = `created-sheet-${w.sheetCreated.length}-000000000000`;
    w.spreadsheets[id] = {
      id,
      name: layout.name,
      tabs: layout.tabs.map((tab) => ({ title: tab.title, rows: 1000, columns: tab.columns })),
      checkedAt: Date.now(),
      url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
    };
    w.sheetSettings[Number(createMatch[1])] = {
      spreadsheetId: id,
      spreadsheetName: layout.name,
      tabs: layout.tabs
        .filter((tab) => tab.access !== 'off')
        .map((tab) => ({ title: tab.title, access: tab.access })),
    };
    return json(w.sheetSettings[Number(createMatch[1])]);
  }
  const agentMatch = /^\/agents\/(\d+)$/.exec(rest);
  if (agentMatch) {
    const id = Number(agentMatch[1]);
    if (method === 'PUT') {
      const body = JSON.parse(String(init!.body)) as SheetsAgentSettings;
      w.sheetSettings[id] = {
        ...body,
        spreadsheetName: body.spreadsheetId
          ? (w.spreadsheets[body.spreadsheetId]?.name ?? null)
          : null,
      };
    }
    return json(w.sheetSettings[id] ?? DEFAULT_SHEETS_SETTINGS);
  }
  if (rest === '/activity') return json({ activity: w.sheetsActivity });
  return null;
}

/** A fake request's JSON body as text. */
const bodyText = (init?: RequestInit) => (typeof init?.body === 'string' ? init.body : '{}');

/** The Google Drive sign-in routes of the fake server (`rest` after the connector's path). */
function driveSignIn(w: World, method: string, rest: string): Response | null {
  if (rest === '') return json(w.drive);
  if (rest === '/connect' && method === 'POST')
    return json({
      requestId: 'req-d',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?d=1',
    });
  if (rest.startsWith('/connect/')) {
    const next = w.driveProgress.length > 1 ? w.driveProgress.shift()! : w.driveProgress[0]!;
    if (next.status === 'done') w.drive = driveStatus('connected');
    return json(next);
  }
  if (rest === '/disconnect' && method === 'POST') {
    w.drive = driveStatus('disconnected');
    return json(w.drive);
  }
  return null;
}

/** The Google Drive routes of the fake server. */
function driveRoute(w: World, method: string, path: string, init?: RequestInit): Response | null {
  if (!path.startsWith('/connectors/google-drive')) return null;
  const rest = path.slice('/connectors/google-drive'.length);
  const signIn = driveSignIn(w, method, rest);
  if (signIn) return signIn;
  if (rest === '/picker' && method === 'POST') {
    w.drivePickerBodies.push(JSON.parse(bodyText(init)) as DrivePickerBody);
    return json({
      requestId: `dpick-${w.drivePickerBodies.length}`,
      pickerUrl: 'http://127.0.0.1:7420/api/connectors/google-drive/picker-page?token=t',
    });
  }
  if (rest.startsWith('/picker/'))
    return json(w.drivePicker.length > 1 ? w.drivePicker.shift()! : w.drivePicker[0]!);
  const agentMatch = /^\/agents\/(\d+)$/.exec(rest);
  if (agentMatch) {
    const id = Number(agentMatch[1]);
    if (method === 'PUT') w.driveSettings[id] = JSON.parse(bodyText(init)) as DriveAgentSettings;
    return json(w.driveSettings[id] ?? DEFAULT_DRIVE_SETTINGS);
  }
  if (rest === '/activity') return json({ activity: w.driveActivity });
  return null;
}

/** The GitHub routes of the fake server. */
function githubRoute(w: World, method: string, path: string, init?: RequestInit): Response | null {
  if (!path.startsWith('/connectors/github')) return null;
  const rest = path.slice('/connectors/github'.length);
  if (rest === '') return json(w.github);
  if (rest === '/device' && method === 'POST')
    return json({
      requestId: `dev-${(w.githubDeviceStarts = (w.githubDeviceStarts ?? 0) + 1)}`,
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresAt: Date.now() + 900_000,
    });
  if (/^\/device\/[^/]+\/cancel$/.test(rest)) return new Response(null, { status: 204 });
  if (rest.startsWith('/device/')) {
    const next = w.githubDevice.length > 1 ? w.githubDevice.shift()! : w.githubDevice[0]!;
    if (next.status === 'done' && next.github) w.github = next.github;
    return json(next);
  }
  if (rest === '/token' && method === 'POST') {
    if (w.githubTokenError)
      return json({ error: { code: w.githubTokenError, message: 'Token refused' } }, 400);
    w.github = githubStatus('connected', {
      method: 'token',
      tokenExpiresAt: Date.now() + 60 * 86_400_000,
      manageUrl: 'https://github.com/settings/personal-access-tokens',
    });
    return json(w.github);
  }
  if (rest === '/check' && method === 'POST') {
    w.github = w.githubCheck ?? githubStatus('connected');
    return json(w.github);
  }
  if (rest === '/disconnect' && method === 'POST') {
    w.github = githubStatus('not_connected');
    return json(w.github);
  }
  if (rest === '/repos') return json({ repos: w.githubRepos, checkedAt: Date.now() });
  const agentMatch = /^\/agents\/(\d+)$/.exec(rest);
  if (agentMatch) {
    const id = Number(agentMatch[1]);
    const view = w.githubAgents[id] ?? {
      settings: DEFAULT_GITHUB_SETTINGS,
      unavailableRepoIds: [],
    };
    if (method === 'PUT') {
      const settings = JSON.parse(bodyText(init)) as GitHubAgentSettings;
      w.githubAgents[id] = {
        settings,
        unavailableRepoIds: view.unavailableRepoIds.filter((x) =>
          settings.repos.some((r) => r.id === x),
        ),
      };
    }
    return json(w.githubAgents[id] ?? view);
  }
  if (rest === '/activity') return json({ activity: w.githubActivity });
  return null;
}

export function stubServer(w: World) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^\/api/, '').split('?')[0]!;
    const failCode = w.fail?.[`${method} ${path}`];
    if (failCode) return json({ error: { code: 'internal', message: 'Boom' } }, failCode);
    const problem = w.problems?.[`${method} ${path}`];
    if (problem) return json({ error: { code: problem, message: 'Partner said no' } }, 400);
    if (path === '/connectors/list') return json(w.gallery);
    if (path === '/connectors/list/refresh' && method === 'POST') {
      if (w.refreshed) w.gallery = w.refreshed;
      return json(w.gallery);
    }
    const mcp = mcpRoute(w, method, path, init);
    if (mcp) return mcp;
    const sheets = sheetsRoute(w, method, path, init);
    if (sheets) return sheets;
    const drive = driveRoute(w, method, path, init);
    if (drive) return drive;
    const github = githubRoute(w, method, path, init);
    if (github) return github;
    if (path === '/health' && w.edition)
      return json({ app: 'wa-team-inbox', version: '0.1.83', mode: 'dev', edition: w.edition });
    if (path === '/connectors/google-calendar') return json(w.google);
    if (path === '/connectors/google-calendar/connect' && method === 'POST')
      return json({
        requestId: 'req-1',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      });
    if (path.startsWith('/connectors/google-calendar/connect/')) {
      const next = w.progress.length > 1 ? w.progress.shift()! : w.progress[0]!;
      if (next.status === 'done') w.google = status('connected');
      return json(next);
    }
    if (path === '/connectors/google-calendar/disconnect' && method === 'POST') {
      w.google = status('disconnected');
      return json({ ok: true });
    }
    const agentMatch = /^\/connectors\/google-calendar\/agents\/(\d+)$/.exec(path);
    if (agentMatch) {
      const id = Number(agentMatch[1]);
      if (method === 'PUT') w.bookings[id] = JSON.parse(String(init!.body)) as BookingSettings;
      return json(w.bookings[id] ?? DEFAULT_BOOKING_SETTINGS);
    }
    if (path === '/connectors/google-calendar/activity') return json({ activity: w.activity });
    if (path === '/connectors/google-calendar/bookings') return json(w.calendarBookings);
    if (path === '/ai/agents') return json({ agents: w.agents, maxAgents: 5 });
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const writes = (fetchMock: ReturnType<typeof stubServer>) =>
  fetchMock.mock.calls
    .filter((c) => c[1]?.method && c[1].method !== 'GET')
    .map((c) => `${c[1]!.method} ${c[0]}`);

function Location() {
  const l = useLocation();
  return <output data-testid="location">{`${l.pathname}${l.search}`}</output>;
}

export function renderAt(
  path: string,
  element: ReactNode,
  {
    route = '/admin/connectors/:id',
    extensions = [],
    links = {},
  }: { route?: string; extensions?: WebExtension[]; links?: Partial<AppLinks> } = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AppLinksProvider links={resolveAppLinks(links)}>
        <WebExtensionsProvider extensions={extensions}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={route} element={element} />
              <Route path="*" element={<p>elsewhere</p>} />
            </Routes>
            <Location />
          </MemoryRouter>
        </WebExtensionsProvider>
      </AppLinksProvider>
    </QueryClientProvider>,
  );
}
