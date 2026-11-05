/**
 * Google Drive connector (core; design docs/features/google-drive/design.md, rules
 * docs/connector-design.md). One Google account per install (its own sign-in, separate from
 * Google Calendar and Sheets), scope `drive.file`. Per AI agent: one folder, Save files and Read
 * files with the files the admin picked. The connector only grants access; the agent's instructions
 * say what to save or read, and when.
 *
 * Logs carry events, ids, counts, sizes and states only: never tokens, file names, folder names,
 * contents, names or numbers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import {
  DRIVE_MAX_FILES,
  DRIVE_READ_CHARACTERS,
  DRIVE_READ_MAX_BYTES,
  DRIVE_SAVE_MAX_BYTES,
  DriveAgentSettings,
  type DriveActivity,
  type DriveFile,
  type DriveFolder,
  type DrivePickerProgress,
  type DrivePickerStart,
  type DriveSkipReason,
  type GoogleDriveStatus,
} from '@ezychat/shared';
import { agentById } from '../../ai/agents.js';
import { extractKnowledgeIsolated } from '../../ai/knowledge-worker.js';
import { AI_TIMEZONE_SETTING, resolveAiTimeZone } from '../../ai/prompt.js';
import type { AppContext } from '../../context.js';
import { audit } from '../../db/audit.js';
import { HttpError, errors } from '../../http/errors.js';
import { getAliases } from '../../chats/aliases.js';
import { getChats, getMessages } from '../../wa-bridge/index.js';
import { createGoogleAccount } from '../google-account.js';
import { GoogleError } from '../google-calendar/google.js';
import {
  DRIVE_ENDPOINTS,
  DRIVE_REQUIRED_SCOPES,
  DRIVE_SCOPES,
  DriveClient,
  FOLDER_MIME,
  type DriveItem,
} from './drive.js';
import { FAKE_DRIVE_APP, FAKE_DRIVE_ENDPOINTS, FakeGoogleDrive } from './fake.js';
import { cleanSubfolder, driveFileKind, exportMime, savedFileName } from './names.js';
import {
  addActivity,
  forgetFolder,
  insertSaved,
  knownFolder,
  listActivity,
  mediaCandidates,
  readSettings,
  rememberFolder,
  savedFile,
  savedMessageIds,
  writeSettings,
  type ActivityInput,
  type MediaCandidate,
} from './repo.js';

declare module '../../context.js' {
  interface Services {
    googleDrive?: GoogleDriveService;
  }
}

export const TOKENS_SETTING = 'google_drive_tokens';
export const PROBLEM_SETTING = 'google_drive_problem';
export const FAKE_CONSENT_PATH = '/api/dev/fake-google-drive/consent';
export const PICKER_PAGE_PATH = '/api/connectors/google-drive/picker-page';
export const FAKE_PICKER_PATH = '/api/dev/fake-google-drive/picker';
/** A picker window stays usable this long; at most this many open at once. */
export const PICKER_TTL_MS = 10 * 60_000;
const MAX_PICKERS = 20;
/** Files the save tool may choose from: the newest inbound files of this long, at most 10. */
export const SAVE_WINDOW_MS = 24 * 60 * 60_000;
export const SAVE_CANDIDATES = 10;
/** A read's text is kept this long (several reads in one turn share one download). */
const TEXT_TTL_MS = 2 * 60_000;
const MAX_CACHED_TEXTS = 20;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

interface PickerSession {
  requestId: string;
  createdAt: number;
  userId: number;
  kind: 'folder' | 'files';
  /** files: the agent's folder the picker opens in, and the only parent picked files may have. */
  parent: string | null;
  status: DrivePickerProgress['status'];
  folder: DriveFolder | null;
  files: DriveFile[];
  configured: boolean;
}

/** What one agent may do now (connected, a folder and Save or Read on), else null. */
export interface UsableDrive {
  settings: DriveAgentSettings;
  folder: DriveFolder;
  save: boolean;
  /** The picked files the AI may read (Read files on, a kind it can read). */
  readFiles: DriveFile[];
}

export type SaveResult =
  | { ok: true; already: boolean }
  | { ok: false; reason: 'not_allowed' | 'not_found' | DriveSkipReason };

export type ReadResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: 'not_allowed' | 'too_large' | 'no_text' };

export interface GoogleDriveServiceOptions {
  /** Overrides the client (tests); default from the build's Google app, or the fake with --fake-wa. */
  client?: DriveClient | null;
  fake?: FakeGoogleDrive | null;
  now?: () => number;
}

/** Google's answer as a route shows it: rejected 400, out of reach 503. */
function googleHttpError(error: unknown, what: string): HttpError {
  if (error instanceof GoogleError && error.kind === 'rejected')
    return errors.validation(`EzyChat cannot open this ${what}. Choose it again in Google Drive.`);
  return new HttpError(503, 'google_unavailable', 'Google Drive could not be reached');
}

export function toDriveFile(item: DriveItem): DriveFile {
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    kind: driveFileKind(item.mimeType),
  };
}

function defaultFake(ctx: AppContext): FakeGoogleDrive | null {
  const useFake = ctx.config.fakeWa && ctx.config.mode !== 'service' && !ctx.config.googleOAuth;
  return useFake ? new FakeGoogleDrive() : null;
}

function defaultClient(ctx: AppContext, fake: FakeGoogleDrive | null): DriveClient | null {
  if (fake) return new DriveClient(FAKE_DRIVE_APP, FAKE_DRIVE_ENDPOINTS, fake.fetch);
  if (ctx.config.googleOAuth) return new DriveClient(ctx.config.googleOAuth, DRIVE_ENDPOINTS);
  return null;
}

export function createGoogleDriveService(ctx: AppContext, options: GoogleDriveServiceOptions = {}) {
  const log = ctx.log.child({ mod: 'google-drive' });
  const now = options.now ?? Date.now;
  // The fake replaces Google only with --fake-wa (never in service mode) and no Google app
  // configured: a Dev Build with GOOGLE_OAUTH_CLIENT_ID/_SECRET talks to real Google.
  const fake = options.fake === undefined ? defaultFake(ctx) : options.fake;
  const client = options.client === undefined ? defaultClient(ctx, fake) : options.client;

  const account = createGoogleAccount(ctx, {
    key: 'google_drive',
    label: 'Google Drive',
    tokensSetting: TOKENS_SETTING,
    problemSetting: PROBLEM_SETTING,
    scopes: DRIVE_SCOPES,
    requiredScopes: DRIVE_REQUIRED_SCOPES,
    client,
    fake,
    fakeConsentPath: FAKE_CONSENT_PATH,
    now,
  });

  // Real Google needs its file picker too (drive.file): without the key Drive is not available.
  const pickerApp = fake ? { apiKey: 'fake-key', appId: '0' } : (ctx.config.googlePicker ?? null);
  const configured = () => account.configured() && pickerApp !== null;
  const pickers = new Map<string, PickerSession>(); // by token hash
  const pickerByRequest = new Map<string, string>(); // requestId → token hash
  const texts = new Map<string, { at: number; text: string; truncated: boolean }>();
  // Saves running now (a second identical call waits for nothing and saves nothing).
  const saving = new Set<string>();
  account.onChange(() => texts.clear());

  const linked = () => {
    if (!configured()) return false;
    const state = account.state();
    return state === 'connected' || state === 'unavailable';
  };
  const requireLinked = () => {
    if (!linked()) throw new HttpError(409, 'not_connected', 'Connect a Google account first');
  };

  const timeZone = () => resolveAiTimeZone(ctx.settings.get<unknown>(AI_TIMEZONE_SETTING, null));

  /** The folder, checked with Google now (a folder the account can open, not in the bin). */
  async function checkedFolder(id: string): Promise<DriveFolder> {
    let item: DriveItem;
    try {
      item = await account.withToken((token) => client!.file(token, id));
    } catch (error) {
      throw googleHttpError(error, 'folder');
    }
    if (item.mimeType !== FOLDER_MIME || item.trashed)
      throw errors.validation('Choose a folder in Google Drive');
    return { id: item.id, name: item.name };
  }

  /** The files Google still lets EzyChat open inside `folderId`; others are left out. */
  async function checkedFiles(
    ids: readonly string[],
    folderId: string,
  ): Promise<{ files: DriveFile[]; dropped: number }> {
    const files: DriveFile[] = [];
    let dropped = 0;
    for (const id of ids.slice(0, DRIVE_MAX_FILES)) {
      try {
        const item = await account.withToken((token) => client!.file(token, id));
        if (item.trashed || item.mimeType === FOLDER_MIME || !item.parents.includes(folderId))
          dropped++;
        else files.push(toDriveFile(item));
      } catch (error) {
        if (error instanceof GoogleError && error.kind === 'rejected') dropped++;
        else throw googleHttpError(error, 'file');
      }
    }
    return { files, dropped };
  }

  /** The sub-folder `name` in `parentId` (EzyChat's own, created once). */
  async function subfolder(parentId: string, name: string, signal?: AbortSignal): Promise<string> {
    const known = knownFolder(ctx.db, parentId, name);
    if (known) return known;
    const id = await account.withToken(async (token) => {
      const found = await client!.findFolder(token, parentId, name, signal);
      return found ?? client!.createFolder(token, name, parentId, signal);
    });
    rememberFolder(ctx.db, parentId, name, id, now());
    log.info({ event: 'google_drive_folder_ready' }, 'Drive sub-folder ready');
    return id;
  }

  async function uploadOnce(
    parentId: string,
    input: { name: string; mimeType: string; bytes: Buffer; appKey: string },
    signal?: AbortSignal,
  ): Promise<string> {
    return account.withToken(async (token) => {
      const found = await client!.findUploaded(token, parentId, input.appKey, signal);
      if (found) return found;
      return client!.upload(token, { ...input, parentId }, signal);
    });
  }

  const service = {
    fake,
    account,
    configured,
    timeZone,

    status(): GoogleDriveStatus {
      const tokens = configured() ? account.tokens() : null;
      return {
        state: configured() ? account.state() : 'not_configured',
        account: tokens?.account ?? null,
        connectedAt: tokens?.connectedAt ?? null,
        problemSince: account.problemSince(),
      };
    },

    /** The agent's folder and what it may do now, else null. */
    usable(agentId: number | undefined | null): UsableDrive | null {
      if (agentId === undefined || agentId === null) return null;
      if (!linked() || !agentById(ctx.db, agentId)) return null;
      const settings = readSettings(ctx.db, agentId);
      if (!settings.folder) return null;
      const readFiles = settings.read ? settings.files.filter((f) => f.kind !== 'other') : [];
      if (!settings.save && !readFiles.length) return null;
      return { settings, folder: settings.folder, save: settings.save, readFiles };
    },

    getSettings(agentId: number): DriveAgentSettings {
      if (!agentById(ctx.db, agentId)) throw errors.notFound('Agent');
      return readSettings(ctx.db, agentId);
    },

    /**
     * Saves one agent's settings. With Google reachable, the folder and every file are checked
     * again (names and kinds from Google; a file Google no longer opens, or one outside the folder,
     * is left out). Without a sign-in only the switches may change.
     */
    async putSettings(
      agentId: number,
      next: DriveAgentSettings,
      actor: { userId: number; ip: string | null },
    ): Promise<DriveAgentSettings> {
      if (!agentById(ctx.db, agentId)) throw errors.notFound('Agent');
      const parsed = DriveAgentSettings.parse(next);
      const before = readSettings(ctx.db, agentId);
      let saved: DriveAgentSettings;
      let dropped = 0;
      if (!parsed.folder) saved = { ...parsed, folder: null, files: [] };
      else if (linked()) {
        const folder = await checkedFolder(parsed.folder.id);
        const checked = await checkedFiles(
          parsed.files.map((f) => f.id),
          folder.id,
        );
        dropped = checked.dropped;
        saved = { ...parsed, folder, files: checked.files };
      } else if (
        parsed.folder.id !== before.folder?.id ||
        JSON.stringify(parsed.files.map((f) => f.id)) !==
          JSON.stringify(before.files.map((f) => f.id))
      )
        throw new HttpError(409, 'not_connected', 'Connect a Google account first');
      else saved = { ...parsed, folder: before.folder, files: before.files };
      const fields: string[] = [];
      if (before.folder?.id !== saved.folder?.id) fields.push('folder');
      if (before.save !== saved.save) fields.push('save');
      if (before.read !== saved.read) fields.push('read');
      if (
        JSON.stringify(before.files.map((f) => f.id)) !==
        JSON.stringify(saved.files.map((f) => f.id))
      )
        fields.push('files');
      writeSettings(ctx.db, agentId, saved, now());
      texts.clear();
      if (fields.length)
        audit(ctx.db, {
          userId: actor.userId,
          action: 'google_drive.agent_settings',
          ip: actor.ip,
          meta: { agentId, fields, files: saved.files.length, ...(dropped ? { dropped } : {}) },
        });
      return saved;
    },

    activity(): DriveActivity[] {
      return listActivity(ctx.db);
    },

    addActivity(row: ActivityInput) {
      addActivity(ctx.db, row, now());
    },

    /** The group's name when `chatJid` is a group, else null (Activity shows it). */
    groupName(chatJid: string | null): string | null {
      if (!chatJid) return null;
      const chat = getChats(ctx).get(chatJid);
      return chat?.type === 'group' ? chat.name || null : null;
    },

    /**
     * Files of this chat the save tool may offer: the newest inbound files of the last 24 hours
     * (in a group, only from `personJids`), at most 10, with whether each is already saved.
     */
    saveCandidates(
      chatJid: string,
      folderId: string,
      personJids: readonly string[] | null,
    ): Array<MediaCandidate & { saved: boolean }> {
      const found = mediaCandidates(ctx.db, chatJid, {
        ids: null,
        since: now() - SAVE_WINDOW_MS,
        limit: personJids ? 50 : SAVE_CANDIDATES,
      });
      const aliases = getAliases(ctx);
      const resolve = (jid: string | null) => (jid ? aliases.resolve(jid) : null);
      const people = personJids ? new Set(personJids) : null;
      const saved = savedMessageIds(ctx.db, chatJid, folderId);
      return found
        .filter((m) => !people || people.has(resolve(m.senderJid) ?? ''))
        .slice(0, SAVE_CANDIDATES)
        .map((m) => ({ ...m, saved: saved.has(m.id) }));
    },

    /**
     * Saves one inbound file of this chat into the agent's folder (or the sub-folder its
     * instructions name). Guards: Save files on with a folder; the message is an inbound,
     * not-deleted file of this chat; never a file WhatsApp Safety rated High or locked; at most
     * 25 MB; the same message never twice into the same folder (Drive's own app key also finds a
     * file a crashed save already uploaded). EzyChat names the file. Google errors are thrown (the
     * tool hands over).
     */
    async saveFile(
      agentId: number,
      chatJid: string,
      messageId: string,
      subfolderName: string | null,
      signal?: AbortSignal,
    ): Promise<SaveResult> {
      const usable = service.usable(agentId);
      if (!usable?.save) return { ok: false, reason: 'not_allowed' };
      const [message] = mediaCandidates(ctx.db, chatJid, {
        ids: [messageId],
        since: 0,
        limit: 1,
      });
      if (!message) return { ok: false, reason: 'not_found' };
      const group = service.groupName(chatJid);
      const skip = (reason: DriveSkipReason): SaveResult => {
        addActivity(ctx.db, { kind: 'skipped', agentId, chatJid, group, reason }, now());
        log.info({ event: 'google_drive_save_skipped', agentId, reason }, 'Drive save skipped');
        return { ok: false, reason };
      };
      if (ctx.services.safety?.levelOf(messageId) === 'high') return skip('safety');
      const sub = cleanSubfolder(subfolderName);
      const targetKey = `${usable.folder.id}\n${sub ?? ''}`;
      const flight = `${messageId}\n${targetKey}`;
      const recordKey = sub ? `${usable.folder.id}/${sub}` : usable.folder.id;
      if (saving.has(flight) || savedFile(ctx.db, messageId, recordKey))
        return { ok: true, already: true };
      const media = await getMessages(ctx).ensureMedia(messageId);
      if (!media || media === 'unavailable') return skip('unavailable');
      if (/[\\/]quarantine[\\/]/.test(media.path)) return skip('safety');
      let size: number;
      try {
        size = statSync(media.path).size;
      } catch {
        return skip('unavailable');
      }
      if (size > DRIVE_SAVE_MAX_BYTES) return skip('size');
      saving.add(flight);
      try {
        const bytes = readFileSync(media.path);
        let parentId = sub ? await subfolder(usable.folder.id, sub, signal) : usable.folder.id;
        const name = savedFileName(
          { type: message.type, mime: media.mime, sentAt: message.timestamp },
          timeZone(),
        );
        const input = {
          name,
          mimeType: media.mime || 'application/octet-stream',
          bytes,
          appKey: sha(`${messageId}\n${recordKey}`).slice(0, 40),
        };
        let fileId: string;
        try {
          fileId = await uploadOnce(parentId, input, signal);
        } catch (error) {
          // A sub-folder deleted in Drive since: forget it, make it again once.
          if (!sub || !(error instanceof GoogleError) || error.kind !== 'rejected') throw error;
          forgetFolder(ctx.db, usable.folder.id, sub);
          parentId = await subfolder(usable.folder.id, sub, signal);
          fileId = await uploadOnce(parentId, input, signal);
        }
        insertSaved(ctx.db, { agentId, chatJid, messageId, folderId: recordKey, fileId }, now());
      } finally {
        saving.delete(flight);
      }
      addActivity(ctx.db, { kind: 'saved', agentId, chatJid, group }, now());
      log.info(
        { event: 'google_drive_saved', agentId, bytes: size, type: message.type, subfolder: !!sub },
        'AI saved a file to Drive',
      );
      return { ok: true, already: false };
    },

    /** The picked files whose names match the words of `query` (all of them without a query). */
    findFiles(usable: UsableDrive, query: string | undefined): DriveFile[] {
      const words = (query ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1);
      if (!words.length) return usable.readFiles;
      const scored = usable.readFiles
        .map((f) => {
          const name = f.name.toLowerCase();
          return { f, score: words.filter((w) => name.includes(w)).length };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      return scored.length ? scored.map((x) => x.f) : usable.readFiles;
    },

    /**
     * The text of one picked file (Google Docs exported, PDF and Word read by the document
     * worker, text as UTF-8), at most 20,000 characters. Google errors are thrown.
     */
    async readFile(usable: UsableDrive, fileId: string, signal?: AbortSignal): Promise<ReadResult> {
      const file = usable.readFiles.find((f) => f.id === fileId);
      if (!file) return { ok: false, reason: 'not_allowed' };
      const cached = texts.get(fileId);
      if (cached && now() - cached.at < TEXT_TTL_MS)
        return { ok: true, text: cached.text, truncated: cached.truncated };
      const asExport = exportMime(file.mimeType);
      const bytes = await account.withToken((token) =>
        asExport
          ? client!.export(token, file.id, asExport, DRIVE_READ_MAX_BYTES, signal)
          : client!.download(token, file.id, DRIVE_READ_MAX_BYTES, signal),
      );
      if (bytes === 'tooLarge') return { ok: false, reason: 'too_large' };
      let text: string;
      try {
        if (asExport || file.kind === 'text') {
          text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replaceAll('\0', '');
        } else
          text = await extractKnowledgeIsolated(
            file.kind === 'pdf' ? 'file.pdf' : 'file.docx',
            bytes,
          );
      } catch {
        return { ok: false, reason: 'no_text' };
      }
      text = text.replace(/\r\n?/g, '\n').trim();
      if (!text) return { ok: false, reason: 'no_text' };
      const truncated = text.length > DRIVE_READ_CHARACTERS;
      if (truncated) text = text.slice(0, DRIVE_READ_CHARACTERS);
      if (texts.size >= MAX_CACHED_TEXTS) texts.delete(texts.keys().next().value!);
      texts.set(fileId, { at: now(), text, truncated });
      log.info(
        { event: 'google_drive_read', kind: file.kind, characters: text.length },
        'AI read a Drive file',
      );
      return { ok: true, text, truncated };
    },

    /**
     * Opens Google's file picker for an admin: a one-time session whose page (this computer only)
     * gets a fresh access token once and posts the picked folder or files back.
     */
    startPicker(
      origin: string,
      input: { kind: 'folder' | 'files'; folderId?: string },
      actor: { userId: number },
    ): DrivePickerStart {
      requireLinked();
      if (input.kind === 'files' && !input.folderId)
        throw errors.validation('Choose a folder first');
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
        kind: input.kind,
        parent: input.kind === 'files' ? input.folderId! : null,
        status: 'pending',
        folder: null,
        files: [],
        configured: false,
      });
      pickerByRequest.set(requestId, sha(token));
      const url = new URL(fake ? FAKE_PICKER_PATH : PICKER_PAGE_PATH, origin);
      url.searchParams.set('token', token);
      return { requestId, pickerUrl: url.toString() };
    },

    pickerProgress(requestId: string): DrivePickerProgress | null {
      const hash = pickerByRequest.get(requestId);
      const entry = hash ? pickers.get(hash) : undefined;
      if (!entry) return null;
      if (entry.status === 'pending' && now() - entry.createdAt > PICKER_TTL_MS)
        return { status: 'expired', folder: null, files: [] };
      return { status: entry.status, folder: entry.folder, files: entry.files };
    },

    /** A still-open picker session of this token, else null. */
    pickerSession(token: string): PickerSession | null {
      const entry = token ? pickers.get(sha(token)) : undefined;
      if (entry?.status !== 'pending') return null;
      return now() - entry.createdAt > PICKER_TTL_MS ? null : entry;
    },

    /** What the picker page needs, once per session: a fresh access token, the key, the mode. */
    async pickerConfig(token: string): Promise<{
      oauthToken: string;
      developerKey: string;
      appId: string;
      mode: 'folder' | 'files';
      parent: string | null;
      maxItems: number;
    } | null> {
      const entry = service.pickerSession(token);
      if (!entry || entry.configured || !pickerApp) return null;
      entry.configured = true;
      const oauthToken = await account.withToken((access) => Promise.resolve(access));
      return {
        oauthToken,
        developerKey: pickerApp.apiKey,
        appId: pickerApp.appId,
        mode: entry.kind,
        parent: entry.parent,
        maxItems: DRIVE_MAX_FILES,
      };
    },

    /** The page's answer: the picked folder or files (checked with Google), or a cancel. */
    async pickerResult(token: string, picked: { ids?: string[]; cancelled?: boolean }) {
      const entry = service.pickerSession(token);
      if (!entry) return false;
      if (picked.cancelled || !picked.ids?.length) {
        entry.status = 'cancelled';
        return true;
      }
      if (fake) for (const id of picked.ids) fake.grant(id);
      try {
        if (entry.kind === 'folder') entry.folder = await checkedFolder(picked.ids[0]!);
        else {
          const { files } = await checkedFiles(picked.ids, entry.parent!);
          if (!files.length) throw errors.validation('Choose files inside the folder');
          entry.files = files;
        }
        entry.status = 'done';
      } catch {
        entry.status = 'failed';
        return false;
      }
      log.info(
        { event: 'google_drive_picked', kind: entry.kind, count: picked.ids.length },
        'Drive items picked',
      );
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
      texts.clear();
      account.shutdown();
    },
  };
  return service;
}

export type GoogleDriveService = ReturnType<typeof createGoogleDriveService>;

export function initGoogleDrive(ctx: AppContext) {
  ctx.services.googleDrive = createGoogleDriveService(ctx);
}

export function getGoogleDrive(ctx: AppContext): GoogleDriveService {
  const service = ctx.services.googleDrive;
  if (!service) throw new Error('Google Drive service not initialised');
  return service;
}
