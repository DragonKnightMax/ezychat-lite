/**
 * Google Sheets connector (core; design docs/features/google-sheets/design.md). One Google account
 * per install (its own sign-in, separate from Google Calendar). Per AI agent: one spreadsheet and
 * each tab's access, Off, Read or Add rows (design docs/features/group-agents/design.md, Part A);
 * the agent's instructions say when to use them.
 *
 * Logs carry events, ids, counts and states only: never tokens, sheet values, names or numbers.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  SHEETS_LEAD_COLUMNS,
  SheetsAgentSettings,
  googleSheetUrl,
  spreadsheetIdFromLink,
  type SheetsActivity,
  type SpreadsheetInfo,
  type GoogleSheetsStatus,
  type SheetsPickerProgress,
  type SheetsPickerStart,
} from '@ezychat/shared';
import { agentById } from '../../ai/agents.js';
import { AI_TIMEZONE_SETTING, resolveAiTimeZone } from '../../ai/prompt.js';
import type { AppContext } from '../../context.js';
import { audit } from '../../db/audit.js';
import { HttpError, errors } from '../../http/errors.js';
import { getChats } from '../../wa-bridge/index.js';
import { createGoogleAccount } from '../google-account.js';
import { GoogleError } from '../google-calendar/google.js';
import { FAKE_SHEETS_APP, FAKE_SHEETS_ENDPOINTS, FakeGoogleSheets } from './fake.js';
import { matchRows, type MatchResult } from './match.js';
import type { SheetRecordContext } from './record.js';
import {
  addActivity,
  insertRow,
  listActivity,
  memberContact,
  newestInbound,
  personTexts,
  readSettings,
  rowAdded,
  writeSettings,
  type ActivityInput,
  type SheetRowKey,
} from './repo.js';
import { legacyLeadsTabOf, upgradeSheetsSettings } from './upgrade.js';
import { autoColumn, columnKey, headerColumns, matchColumns, personWrote } from './values.js';
import {
  SHEETS_ENDPOINTS,
  SHEETS_REQUIRED_SCOPES,
  SHEETS_SCOPES,
  SheetsClient,
  type SpreadsheetMeta,
} from './sheets.js';

declare module '../../context.js' {
  interface Services {
    googleSheets?: GoogleSheetsService;
  }
}

export const TOKENS_SETTING = 'google_sheets_tokens';
export const PROBLEM_SETTING = 'google_sheets_problem';
export const FAKE_CONSENT_PATH = '/api/dev/fake-google-sheets/consent';
const META_TTL_MS = 5 * 60_000;
/** A look-up reads the tab again after this long (several look-ups in one turn share one read). */
const VALUES_TTL_MS = 60_000;
const MAX_CACHED = 50;
/** A tab's column names (its first row) are read again after this long, or on Refresh. */
export const COLUMNS_TTL_MS = 5 * 60_000;
const MAX_CACHED_COLUMNS = 500;
/** Refresh reads Google at most once in this time per install. */
export const REFRESH_INTERVAL_MS = 10_000;
/** A value the AI passes for one cell. */
export const SHEET_VALUE_CHARACTERS = 2000;
/** Google's per-minute write quota (429): wait and try again for at most this long in one turn. */
export const QUOTA_RETRY_MS = 60_000;
const QUOTA_WAITS_MS = [5_000, 10_000, 20_000, 25_000];
/** A picker window stays usable this long; at most this many open at once. */
export const PICKER_TTL_MS = 10 * 60_000;
const MAX_PICKERS = 20;
export const PICKER_PAGE_PATH = '/api/connectors/google-sheets/picker-page';
export const FAKE_PICKER_PATH = '/api/dev/fake-google-sheets/picker';

interface PickerSession {
  requestId: string;
  createdAt: number;
  userId: number;
  status: SheetsPickerProgress['status'];
  sheet: SpreadsheetInfo | null;
  /** The page fetched its access token once already. */
  configured: boolean;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export type AddRowResult =
  | { ok: true; already: boolean; tab: string }
  | { ok: false; reason: 'not_allowed'; tabs: string[] }
  | { ok: false; reason: 'no_columns'; tab: string }
  | { ok: false; reason: 'unknown_columns'; tab: string; unknown: string[]; columns: string[] }
  | { ok: false; reason: 'not_from_person'; tab: string; columns: string[] };

export interface GoogleSheetsServiceOptions {
  /** Overrides the client (tests); default from the build's Google app, or the fake with --fake-wa. */
  client?: SheetsClient | null;
  fake?: FakeGoogleSheets | null;
  now?: () => number;
  /** Waits before a retry after Google's per-minute quota (tests pass a fast one). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What one agent may do now (connected, a spreadsheet and at least one tab on), else null. */
export interface UsableSheets {
  settings: SheetsAgentSettings;
  spreadsheetId: string;
  /** Tabs on Read, in the saved order. */
  readTabs: string[];
  /** Tabs on Add rows, in the saved order. */
  addTabs: string[];
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The duplicate guard's hash of the AI's values (column keys sorted; never stored as text). */
function valuesHash(values: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(values)
    .map(([name, value]) => [columnKey(name), oneLine(value)] as const)
    .filter(([, value]) => value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha(JSON.stringify(pairs));
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function createGoogleSheetsService(
  ctx: AppContext,
  options: GoogleSheetsServiceOptions = {},
) {
  const log = ctx.log.child({ mod: 'google-sheets' });
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  // The fake replaces Google only with --fake-wa (never in service mode) and no Google app
  // configured: a Dev Build with GOOGLE_OAUTH_CLIENT_ID/_SECRET talks to real Google.
  const fake =
    options.fake !== undefined
      ? options.fake
      : ctx.config.fakeWa && ctx.config.mode !== 'service' && !ctx.config.googleOAuth
        ? new FakeGoogleSheets()
        : null;
  const client: SheetsClient | null =
    options.client !== undefined
      ? options.client
      : fake
        ? new SheetsClient(FAKE_SHEETS_APP, FAKE_SHEETS_ENDPOINTS, fake.fetch)
        : ctx.config.googleOAuth
          ? new SheetsClient(ctx.config.googleOAuth, SHEETS_ENDPOINTS)
          : null;

  const account = createGoogleAccount(ctx, {
    key: 'google_sheets',
    label: 'Google Sheets',
    tokensSetting: TOKENS_SETTING,
    problemSetting: PROBLEM_SETTING,
    scopes: SHEETS_SCOPES,
    requiredScopes: SHEETS_REQUIRED_SCOPES,
    client,
    fake,
    fakeConsentPath: FAKE_CONSENT_PATH,
    now,
  });

  // Real Google needs its file picker too (drive.file): without the key Sheets is not available.
  const pickerApp = fake ? { apiKey: 'fake-key', appId: '0' } : (ctx.config.googlePicker ?? null);
  const configured = () => account.configured() && pickerApp !== null;
  const pickers = new Map<string, PickerSession>(); // by token hash
  const pickerByRequest = new Map<string, string>(); // requestId → token hash

  const metas = new Map<string, { at: number; meta: SpreadsheetMeta }>();
  const values = new Map<string, { at: number; rows: string[][] }>();
  // Column names per agent, spreadsheet and tab (the tools' descriptions and the row check).
  const columnCache = new Map<string, { at: number; columns: string[] }>();
  const columnKeyOf = (agentId: number, spreadsheetId: string, tab: string) =>
    `${agentId}\n${spreadsheetId}\n${tab}`;
  const clearColumns = (agentId?: number) => {
    for (const key of [...columnCache.keys()])
      if (agentId === undefined || key.startsWith(`${agentId}\n`)) columnCache.delete(key);
  };
  const clearCaches = () => {
    metas.clear();
    values.clear();
    clearColumns();
  };
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  // Rows being added now (a second identical call waits for nothing and adds nothing).
  const adding = new Set<string>();
  account.onChange(clearCaches);
  const remember = <T>(map: Map<string, T>, key: string, value: T, limit = MAX_CACHED) => {
    if (!map.has(key) && map.size >= limit) map.delete(map.keys().next().value!);
    map.set(key, value);
  };

  const linked = () => {
    if (!configured()) return false;
    const state = account.state();
    return state === 'connected' || state === 'unavailable';
  };

  async function meta(id: string, force = false, signal?: AbortSignal): Promise<SpreadsheetMeta> {
    const cached = metas.get(id);
    if (!force && cached && now() - cached.at < META_TTL_MS) return cached.meta;
    const fresh = await account.withToken((token) => client!.spreadsheet(token, id, signal));
    remember(metas, id, { at: now(), meta: fresh });
    return fresh;
  }

  async function tabValues(id: string, tab: string, signal?: AbortSignal): Promise<string[][]> {
    const key = `${id}\n${tab}`;
    const cached = values.get(key);
    if (cached && now() - cached.at < VALUES_TTL_MS) return cached.rows;
    const rows = await account.withToken((token) => client!.values(token, id, tab, signal));
    remember(values, key, { at: now(), rows });
    return rows;
  }

  /**
   * The column names (first row) of `tabs` for one agent, cached 5 minutes; tabs read together in
   * one request. Google errors are thrown.
   */
  async function tabColumns(
    agentId: number,
    spreadsheetId: string,
    tabs: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const missing: string[] = [];
    for (const tab of tabs) {
      const cached = columnCache.get(columnKeyOf(agentId, spreadsheetId, tab));
      if (cached && now() - cached.at < COLUMNS_TTL_MS) out.set(tab, cached.columns);
      else missing.push(tab);
    }
    if (missing.length) {
      const rows = await account.withToken((token) =>
        client!.firstRows(token, spreadsheetId, missing, signal),
      );
      for (const tab of missing) {
        const columns = headerColumns(rows.get(tab));
        remember(
          columnCache,
          columnKeyOf(agentId, spreadsheetId, tab),
          { at: now(), columns },
          MAX_CACHED_COLUMNS,
        );
        out.set(tab, columns);
      }
    }
    return out;
  }

  /** Google's answer as the route shows it: rejected 400, out of reach 503. */
  function googleHttpError(error: unknown): HttpError {
    if (error instanceof GoogleError && error.kind === 'rejected')
      return errors.validation(
        'EzyChat cannot open this spreadsheet. Choose it again with Choose a sheet.',
      );
    return new HttpError(503, 'google_unavailable', 'Google Sheets could not be reached');
  }

  /** A sheet the account cannot open answers 400; Google out of reach 503. */
  async function checkedMeta(id: string): Promise<SpreadsheetMeta> {
    try {
      return await meta(id, true);
    } catch (error) {
      throw googleHttpError(error);
    }
  }

  /** The spreadsheet, its tabs and each tab's column names, read from Google now. */
  async function checkedInfo(id: string): Promise<SpreadsheetInfo> {
    const found = await checkedMeta(id);
    let rows: Map<string, string[]>;
    try {
      rows = await account.withToken((token) =>
        client!.firstRows(
          token,
          id,
          found.tabs.map((tab) => tab.title),
        ),
      );
    } catch (error) {
      throw googleHttpError(error);
    }
    return {
      id,
      name: found.name,
      tabs: found.tabs.map((tab) => ({ ...tab, columns: headerColumns(rows.get(tab.title)) })),
      checkedAt: now(),
      url: googleSheetUrl(id),
    };
  }

  /** Appends rows, waiting out Google's per-minute quota (429) for at most a minute in all. */
  async function appendWithQuota(
    spreadsheetId: string,
    tab: string,
    rows: string[][],
    signal?: AbortSignal,
  ): Promise<void> {
    await account.withToken(async (token) => {
      let waited = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          return await client!.append(token, spreadsheetId, tab, rows, signal);
        } catch (error) {
          const wait = QUOTA_WAITS_MS[attempt];
          const quota = error instanceof GoogleError && error.status === 429;
          if (!quota || wait === undefined || waited + wait > QUOTA_RETRY_MS) throw error;
          log.info({ event: 'google_sheets_quota_wait', ms: wait }, 'Google Sheets quota: waiting');
          await sleep(wait, signal);
          waited += wait;
        }
      }
    });
  }

  function timeZone(): string {
    return resolveAiTimeZone(ctx.settings.get<unknown>(AI_TIMEZONE_SETTING, null));
  }

  /** The customer's name, email and WhatsApp number as the team saved them (never for a group). */
  function savedContact(chatJid: string): {
    name: string | null;
    email: string | null;
    phone: string | null;
  } {
    const chat = getChats(ctx).get(chatJid);
    if (!chat || chat.type === 'group') return { name: null, email: null, phone: null };
    const profile = ctx.services.customers?.profile(chatJid).profile ?? null;
    // A chat named after its number has no real name.
    const named = (value: string | null | undefined) =>
      value?.trim() && /\p{L}/u.test(value) ? value.trim() : null;
    return {
      name: named(profile?.name) ?? named(chat.name) ?? named(chat.whatsappName),
      email: profile?.email?.trim() || null,
      phone:
        chat.phone ?? (chat.waJid.endsWith('@s.whatsapp.net') ? chat.waJid.split('@')[0]! : null),
    };
  }

  function localTime(at: number): string {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }

  const service = {
    fake,
    account,
    configured,
    timeZone,
    savedContact,

    status(): GoogleSheetsStatus {
      const tokens = configured() ? account.tokens() : null;
      return {
        state: configured() ? account.state() : 'not_configured',
        account: tokens?.account ?? null,
        connectedAt: tokens?.connectedAt ?? null,
        problemSince: account.problemSince(),
      };
    },

    /** The agent's spreadsheet and the tabs it may use now, else null. */
    usable(agentId: number | undefined | null): UsableSheets | null {
      if (agentId === undefined || agentId === null) return null;
      if (!linked() || !agentById(ctx.db, agentId)) return null;
      const settings = readSettings(ctx.db, agentId);
      if (!settings.spreadsheetId) return null;
      const readTabs = settings.tabs.filter((t) => t.access === 'read').map((t) => t.title);
      const addTabs = settings.tabs.filter((t) => t.access === 'add').map((t) => t.title);
      if (!readTabs.length && !addTabs.length) return null;
      return { settings, spreadsheetId: settings.spreadsheetId, readTabs, addTabs };
    },

    /** The column names of these tabs of the agent's spreadsheet (cached 5 minutes). */
    columns(
      agentId: number,
      spreadsheetId: string,
      tabs: readonly string[],
      signal?: AbortSignal,
    ): Promise<Map<string, string[]>> {
      return tabColumns(agentId, spreadsheetId, tabs, signal);
    },

    /** Settings tab: the spreadsheet behind a pasted link (name, tabs and their columns). */
    async spreadsheetInfo(link: string): Promise<SpreadsheetInfo> {
      if (!linked()) throw new HttpError(409, 'not_connected', 'Connect a Google account first');
      const id = spreadsheetIdFromLink(link);
      if (!id) throw errors.validation('Paste the link of a Google Sheets spreadsheet');
      return checkedInfo(id);
    },

    /**
     * Settings → Refresh: the agent's spreadsheet, tabs and column names read from Google again
     * (at most once in 10 s per install); the AI uses the new columns from its next reply.
     */
    async refresh(agentId: number): Promise<SpreadsheetInfo> {
      if (!agentById(ctx.db, agentId)) throw errors.notFound('Agent');
      const settings = readSettings(ctx.db, agentId);
      if (!settings.spreadsheetId) throw errors.validation('Choose a spreadsheet first');
      if (!linked()) throw new HttpError(409, 'not_connected', 'Connect a Google account first');
      const at = now();
      if (at - lastRefreshAt < REFRESH_INTERVAL_MS)
        throw errors.rateLimited(Math.ceil((lastRefreshAt + REFRESH_INTERVAL_MS - at) / 1000));
      lastRefreshAt = at;
      clearColumns(agentId);
      for (const key of [...values.keys()])
        if (key.startsWith(`${settings.spreadsheetId}\n`)) values.delete(key);
      const info = await checkedInfo(settings.spreadsheetId);
      for (const tab of info.tabs)
        remember(
          columnCache,
          columnKeyOf(agentId, settings.spreadsheetId, tab.title),
          { at, columns: tab.columns },
          MAX_CACHED_COLUMNS,
        );
      log.info(
        { event: 'google_sheets_refresh', agentId, tabs: info.tabs.length },
        'Spreadsheet tabs read again',
      );
      return info;
    },

    getSettings(agentId: number): SheetsAgentSettings {
      if (!agentById(ctx.db, agentId)) throw errors.notFound('Agent');
      return readSettings(ctx.db, agentId);
    },

    async putSettings(
      agentId: number,
      next: SheetsAgentSettings,
      actor: { userId: number; ip: string | null },
    ): Promise<SheetsAgentSettings> {
      if (!agentById(ctx.db, agentId)) throw errors.notFound('Agent');
      const parsed = SheetsAgentSettings.parse(next);
      const before = readSettings(ctx.db, agentId);
      let saved: SheetsAgentSettings;
      let droppedTabs = 0;
      if (!parsed.spreadsheetId) saved = { spreadsheetId: null, spreadsheetName: null, tabs: [] };
      else if (linked()) {
        // The spreadsheet must open for the connected account. A tab Google no longer lists loses
        // its access on this Save (Settings marked it removed before the admin saved).
        const found = await checkedMeta(parsed.spreadsheetId);
        const titles = new Set(found.tabs.map((tab) => tab.title));
        const tabs = parsed.tabs.filter((tab) => titles.has(tab.title));
        droppedTabs = parsed.tabs.length - tabs.length;
        saved = { ...parsed, spreadsheetName: found.name, tabs };
      } else if (parsed.spreadsheetId !== before.spreadsheetId)
        throw new HttpError(409, 'not_connected', 'Connect a Google account first');
      else saved = { ...parsed, spreadsheetName: before.spreadsheetName };
      const fields: string[] = [];
      if (before.spreadsheetId !== saved.spreadsheetId) fields.push('spreadsheetId');
      if (JSON.stringify(before.tabs) !== JSON.stringify(saved.tabs)) fields.push('tabs');
      writeSettings(ctx.db, agentId, saved, now());
      clearColumns(agentId);
      if (fields.length)
        audit(ctx.db, {
          userId: actor.userId,
          action: 'google_sheets.agent_settings',
          ip: actor.ip,
          meta: { agentId, fields, ...(droppedTabs ? { droppedTabs } : {}) },
        });
      return saved;
    },

    activity(): SheetsActivity[] {
      return listActivity(ctx.db);
    },

    addActivity(row: ActivityInput) {
      addActivity(ctx.db, row, now());
    },

    /** The agent's older leads tab (it may still be empty; see upgrade.ts), else null. */
    legacyLeadsTab(agentId: number): string | null {
      return legacyLeadsTabOf(ctx, agentId);
    },

    /** The group's name when `chatJid` is a group, else null (Activity shows it). */
    groupName(chatJid: string | null): string | null {
      if (!chatJid) return null;
      const chat = getChats(ctx).get(chatJid);
      return chat?.type === 'group' ? chat.name || null : null;
    },

    /** The rows of a Read tab that answer `query` (whole tab when it is small). */
    async lookup(
      usable: UsableSheets,
      tab: string,
      query: string,
      signal?: AbortSignal,
    ): Promise<MatchResult> {
      const rows = await tabValues(usable.spreadsheetId, tab, signal);
      return matchRows(rows, query);
    },

    /**
     * Adds one row to a tab on Add rows (design group-agents Part A). Guards: the tab is on Add
     * rows for this agent, the column names are the tab's own, every value the AI passes (auto
     * columns aside) was written by the person this row is for unless a file they sent was given
     * to the model, and the same row (chat, tab, newest message, values) is never added twice.
     * Values are written RAW. Google errors are thrown (the tool hands over).
     */
    async addRow(
      agentId: number,
      chatJid: string,
      input: { tab: string; values: Record<string, string> },
      record: SheetRecordContext | undefined,
      signal?: AbortSignal,
    ): Promise<AddRowResult> {
      const usable = service.usable(agentId);
      const tab =
        usable?.addTabs.find((title) => title === input.tab) ??
        usable?.addTabs.find((title) => columnKey(title) === columnKey(input.tab));
      if (!usable || !tab) return { ok: false, reason: 'not_allowed', tabs: usable?.addTabs ?? [] };
      let header = (await tabColumns(agentId, usable.spreadsheetId, [tab], signal)).get(tab) ?? [];
      // An older leads tab still empty: the lead header goes in with the first row, as before.
      const writeHeader = !header.some(Boolean) && service.legacyLeadsTab(agentId) === tab;
      if (writeHeader) header = [...SHEETS_LEAD_COLUMNS];
      const columns = header.filter(Boolean);
      if (!columns.length) return { ok: false, reason: 'no_columns', tab };
      const given = Object.fromEntries(
        Object.entries(input.values)
          .map(([name, value]) => [name.trim(), oneLine(String(value ?? ''))] as const)
          .filter(([name]) => name),
      );
      const matched = matchColumns(header, given);
      if (!matched.ok)
        return { ok: false, reason: 'unknown_columns', tab, unknown: matched.unknown, columns };

      const chat = getChats(ctx).get(chatJid);
      const group = chat?.type === 'group';
      const newest = newestInbound(ctx.db, chatJid);
      // No record context (a direct chat's turn): the customer, the newest inbound message.
      let personJids = record?.personJids ?? null;
      if (!personJids && group && newest?.senderJid) personJids = [newest.senderJid];
      const filesGiven = record?.filesGiven ?? false;
      if (!filesGiven) {
        const texts = personTexts(ctx.db, chatJid, personJids);
        const refused = [...matched.byIndex]
          .filter(([i, value]) => value && !autoColumn(header[i]!) && !personWrote(texts, value))
          .map(([i]) => header[i]!);
        if (refused.length) return { ok: false, reason: 'not_from_person', tab, columns: refused };
      }

      const key: SheetRowKey = {
        chatJid,
        spreadsheetId: usable.spreadsheetId,
        tab,
        messageId: record?.messageIds.at(-1) ?? newest?.id ?? null,
        valuesHash: valuesHash(given),
      };
      const flight = JSON.stringify(key);
      if (adding.has(flight) || rowAdded(ctx.db, key)) return { ok: true, already: true, tab };

      // EzyChat's own columns, unless the AI passed a value for one.
      const person = group
        ? personJids?.length
          ? memberContact(ctx.db, chatJid, personJids[personJids.length - 1]!)
          : { name: newest?.senderName ?? null, phone: null }
        : (() => {
            const saved = savedContact(chatJid);
            return { name: saved.name, phone: saved.phone };
          })();
      const auto: Record<string, string> = {
        date: localTime(now()),
        name: person.name ?? '',
        whatsapp: person.phone ? `+${person.phone}` : '',
        group: group ? (chat?.name ?? '') : '',
        aiagent: agentById(ctx.db, agentId)?.displayName ?? '',
        source: record?.fileNames.length ? record.fileNames.join(', ') : 'Message',
      };
      const row = header.map((name, i) => {
        const value = matched.byIndex.get(i);
        if (value !== undefined && value !== '') return value.slice(0, SHEET_VALUE_CHARACTERS);
        const which = name ? autoColumn(name) : null;
        return which ? oneLine(auto[which] ?? '').slice(0, SHEET_VALUE_CHARACTERS) : '';
      });
      while (row.length && !row[row.length - 1]) row.pop();

      adding.add(flight);
      try {
        await appendWithQuota(
          usable.spreadsheetId,
          tab,
          writeHeader ? [header, row] : [row],
          signal,
        );
        values.delete(`${usable.spreadsheetId}\n${tab}`);
        if (writeHeader)
          remember(
            columnCache,
            columnKeyOf(agentId, usable.spreadsheetId, tab),
            { at: now(), columns: header },
            MAX_CACHED_COLUMNS,
          );
        insertRow(ctx.db, { ...key, agentId }, now());
      } finally {
        adding.delete(flight);
      }
      addActivity(
        ctx.db,
        { kind: 'row_added', agentId, chatJid, tab, group: group ? chat?.name || null : null },
        now(),
      );
      log.info(
        { event: 'google_sheets_row_added', agentId, columns: matched.byIndex.size },
        'AI added a sheet row',
      );
      return { ok: true, already: false, tab };
    },

    /**
     * Opens Google's file picker for an admin: a one-time session whose page (this computer only)
     * gets a fresh access token once and posts the picked spreadsheet back.
     */
    startPicker(origin: string, actor: { userId: number }): SheetsPickerStart {
      if (!linked()) throw new HttpError(409, 'not_connected', 'Connect a Google account first');
      const at = now();
      for (const [hash, entry] of pickers)
        if (at - entry.createdAt > PICKER_TTL_MS) {
          pickers.delete(hash);
          pickerByRequest.delete(entry.requestId);
        }
      while (pickers.size >= MAX_PICKERS) {
        const oldest = pickers.keys().next().value!;
        pickerByRequest.delete(pickers.get(oldest)!.requestId);
        pickers.delete(oldest);
      }
      const token = randomBytes(24).toString('base64url');
      const requestId = randomBytes(12).toString('hex');
      pickers.set(sha(token), {
        requestId,
        createdAt: at,
        userId: actor.userId,
        status: 'pending',
        sheet: null,
        configured: false,
      });
      pickerByRequest.set(requestId, sha(token));
      const url = new URL(fake ? FAKE_PICKER_PATH : PICKER_PAGE_PATH, origin);
      url.searchParams.set('token', token);
      return { requestId, pickerUrl: url.toString() };
    },

    pickerProgress(requestId: string): SheetsPickerProgress | null {
      const hash = pickerByRequest.get(requestId);
      const entry = hash ? pickers.get(hash) : undefined;
      if (!entry) return null;
      if (entry.status === 'pending' && now() - entry.createdAt > PICKER_TTL_MS)
        return { status: 'expired', sheet: null };
      return { status: entry.status, sheet: entry.sheet };
    },

    /** A still-open picker session of this token, else null. */
    pickerSession(token: string): PickerSession | null {
      const entry = token ? pickers.get(sha(token)) : undefined;
      if (!entry || entry.status !== 'pending') return null;
      return now() - entry.createdAt > PICKER_TTL_MS ? null : entry;
    },

    /** What the picker page needs, once per session: a fresh access token, the key and app id. */
    async pickerConfig(
      token: string,
    ): Promise<{ oauthToken: string; developerKey: string; appId: string } | null> {
      const entry = service.pickerSession(token);
      if (!entry || entry.configured || !pickerApp) return null;
      entry.configured = true;
      const oauthToken = await account.withToken(async (access) => access);
      return { oauthToken, developerKey: pickerApp.apiKey, appId: pickerApp.appId };
    },

    /** The page's answer: the picked spreadsheet (checked with Google) or a cancel. */
    async pickerResult(token: string, picked: { id?: string; cancelled?: boolean }) {
      const entry = service.pickerSession(token);
      if (!entry) return false;
      if (picked.cancelled || !picked.id) {
        entry.status = 'cancelled';
        return true;
      }
      if (fake) fake.grant(picked.id);
      try {
        entry.sheet = await service.spreadsheetInfo(picked.id);
        entry.status = 'done';
      } catch {
        entry.status = 'failed';
        return false;
      }
      log.info({ event: 'google_sheets_picked', userId: entry.userId }, 'Spreadsheet picked');
      return true;
    },

    startConnect: account.startConnect,
    progress: account.progress,
    callback: account.callback,
    fakeConsent: account.fakeConsent,

    async disconnect(actor: { userId: number; ip: string | null }) {
      await account.disconnect(actor);
    },

    shutdown() {
      pickers.clear();
      pickerByRequest.clear();
      account.shutdown();
      clearCaches();
    },
  };
  return service;
}

export type GoogleSheetsService = ReturnType<typeof createGoogleSheetsService>;

export function initGoogleSheets(ctx: AppContext) {
  // Older saves become tab access (permanent, idempotent; after the AI agents exist).
  upgradeSheetsSettings(ctx);
  ctx.services.googleSheets = createGoogleSheetsService(ctx);
}

export function getGoogleSheets(ctx: AppContext): GoogleSheetsService {
  const service = ctx.services.googleSheets;
  if (!service) throw new Error('Google Sheets service not initialised');
  return service;
}
