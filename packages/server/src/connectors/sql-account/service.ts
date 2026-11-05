import {
  SQL_ACCESS_KEY,
  SqlAgentSettings,
  sqlAccessOf,
  sqlHostFromKey,
  sqlKeyEnd,
  type SqlAccess,
  type SqlAccountProblem,
  type SqlAccountState,
  type SqlAccountStatus,
  type SqlConnectBody,
  type SqlConnectResult,
  type SqlCustomerRow,
  type SqlDebtor,
  type SqlMatchKind,
  type SqlObjectId,
} from '@ezychat/shared';
import { agentById } from '../../ai/agents.js';
import { AI_TIMEZONE_SETTING } from '../../ai/prompt.js';
import type { AppContext } from '../../context.js';
import { audit } from '../../db/audit.js';
import {
  SqlClient,
  SqlError,
  sqlText,
  validSqlHost,
  type SqlConnection,
  type SqlRecord,
} from './client.js';
import { FakeSqlAccount } from './fake.js';
import {
  addActivity,
  allLinks,
  chatPhones,
  directChats,
  linkOf,
  listActivity,
  readAgentSettings,
  setLink,
  writeAgentSettings,
} from './repo.js';

declare module '../../context.js' {
  interface Services {
    sqlAccount?: SqlAccountService;
  }
}

export const CONNECTION_SETTING = 'sql_account_connection';
export const STATE_SETTING = 'sql_account_state';
export const MATCH_SETTING = 'sql_account_match_by_phone';
/** The phone → customer index is read again after this long. */
export const INDEX_TTL_MS = 24 * 60 * 60_000;
/** At most this many SQL Account customers are read for the phone index (40 pages of 50). */
export const INDEX_MAX_PAGES = 40;
/**
 * Phones live on each customer's branches, which only the single-customer read returns (eStream
 * Postman collection: `customer.sdsbranch[].phone1/phone2/mobile`), so the index reads customers one
 * by one in the background, at most one every 4 s (15 a minute), leaving the rest of the 30-a-minute
 * budget to the AI's look-ups.
 */
export const INDEX_GAP_MS = 4_000;
/** While an agent uses the connector, the connection is checked again after this long. */
export const RECHECK_MS = 30 * 60_000;

export interface Actor {
  userId: number;
  ip: string | null;
}

export interface ChatMatch {
  kind: SqlMatchKind;
  code: string | null;
  sqlName: string | null;
}

/** `60123456789`: digits with Malaysia's 60 for a leading 0; null when too short to trust. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `6${digits}`;
  return digits.length >= 9 && digits.length <= 15 ? digits : null;
}

const PHONE_FIELD = /phone|mobile|tel/i;

/** Every phone-like value of a customer record (any field named phone/mobile/tel, also nested). */
export function recordPhones(record: SqlRecord, depth = 0): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      const n = PHONE_FIELD.test(key) ? normalizePhone(value) : null;
      if (n) out.push(n);
    } else if (Array.isArray(value) && depth < 2) {
      out.push(...nestedPhones(value, depth + 1));
    }
  }
  return out;
}

function nestedPhones(rows: unknown[], depth: number): string[] {
  return rows
    .filter((item): item is SqlRecord => !!item && typeof item === 'object')
    .flatMap((item) => recordPhones(item, depth));
}

const text = sqlText;

/** The fake answers only with --fake-wa (never in service mode), like the fake Google. */
function defaultFake(ctx: AppContext): FakeSqlAccount | null {
  return ctx.config.fakeWa && ctx.config.mode !== 'service' ? new FakeSqlAccount() : null;
}

const NO_MATCH: ChatMatch = { kind: 'none', code: null, sqlName: null };

export interface SqlAccountServiceOptions {
  /** Replaces the network (tests). With `fake`, the fake answers. */
  fetch?: typeof fetch;
  fake?: FakeSqlAccount | null;
  now?: () => number;
  /** Waits between two customer reads of the phone index (tests: none). */
  sleep?: (ms: number) => Promise<void>;
}

export function createSqlAccountService(ctx: AppContext, options: SqlAccountServiceOptions = {}) {
  const log = ctx.log.child({ mod: 'sql-account' });
  const now = options.now ?? Date.now;
  const fake = options.fake === undefined ? defaultFake(ctx) : options.fake;
  const fetchFn = options.fetch ?? fake?.fetch;
  let client: SqlClient | null = null;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** Phone → customer codes, filled in the background; numbers stay in memory only. */
  let index: {
    at: number;
    byPhone: Map<string, Set<string>>;
    names: Map<string, string>;
    complete: boolean;
  } | null = null;
  let indexing: Promise<void> | null = null;
  /** Bumped on disconnect and shutdown: a running index read stops. */
  let generation = 0;

  const readConnection = (): SqlConnection | null => {
    const raw = ctx.settings.getSecret(CONNECTION_SETTING);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SqlConnection;
      return validSqlHost(parsed.host) && SQL_ACCESS_KEY.test(parsed.accessKey) ? parsed : null;
    } catch {
      return null;
    }
  };
  const stateOf = (): { state: SqlAccountState; checkedAt: number | null } => {
    const saved = ctx.settings.get<{ state: SqlAccountState; checkedAt: number | null } | null>(
      STATE_SETTING,
      null,
    );
    if (!readConnection()) return { state: 'disconnected', checkedAt: null };
    return saved ?? { state: 'connected', checkedAt: null };
  };
  const setState = (state: SqlAccountState) => {
    const before = stateOf().state;
    ctx.settings.set(STATE_SETTING, { state, checkedAt: now() });
    if (before !== state) log.info({ event: 'sql_account_state', state }, 'SQL Account state');
  };
  const getClient = (): SqlClient | null => {
    const connection = readConnection();
    if (!connection) return null;
    client ??= new SqlClient(connection, { fetch: fetchFn, now });
    return client;
  };
  const matchByPhone = () => ctx.settings.get<boolean>(MATCH_SETTING, true);

  const phoneMatchState = (): SqlAccountStatus['phoneMatch'] => {
    if (!index) return 'unknown';
    if (index.byPhone.size > 0) return 'available';
    return index.complete ? 'unavailable' : 'building';
  };

  const status = (): SqlAccountStatus => {
    const connection = readConnection();
    const { state, checkedAt } = stateOf();
    return {
      state,
      host: connection ? `https://${connection.host}` : null,
      keyEnd: connection ? sqlKeyEnd(connection.accessKey) : null,
      checkedAt,
      matchByPhone: matchByPhone(),
      phoneMatch: phoneMatchState(),
    };
  };

  /** A request failed: a key or network problem also changes the connection state. */
  const noteFailure = (error: unknown) => {
    if (error instanceof SqlError && error.status !== 429) setState(error.kind);
  };

  const timed = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    const started = now();
    try {
      const out = await run();
      log.info(
        { event: 'sql_account_call', what, ok: true, ms: now() - started },
        'SQL Account call',
      );
      return out;
    } catch (error) {
      log.warn(
        {
          event: 'sql_account_call',
          what,
          ok: false,
          kind: error instanceof SqlError ? error.kind : 'other',
          status: error instanceof SqlError ? error.status : null,
          ms: now() - started,
        },
        'SQL Account call',
      );
      throw error;
    }
  };

  const require = (): SqlClient => {
    const c = getClient();
    if (!c || stateOf().state !== 'connected') throw new SqlError('unreachable');
    return c;
  };

  const refreshIndex = async () => {
    const run = generation;
    const c = require();
    const rows = await timed('customer_index', () =>
      c.list('customer', {}, undefined, INDEX_MAX_PAGES),
    );
    const next = {
      at: now(),
      byPhone: new Map<string, Set<string>>(),
      names: new Map(rows.map((r) => [text(r.code), text(r.companyname)])),
      complete: false,
    };
    next.names.delete('');
    index = next;
    const codes = [...next.names.keys()];
    // One customer at a time, paced: a sequential chain on purpose (never parallel requests).
    const readFrom = async (i: number): Promise<boolean> => {
      if (run !== generation) return false;
      if (i >= codes.length) return true;
      const code = codes[i]!;
      const detail = await c.one('customer', code);
      for (const phone of detail ? recordPhones(detail) : []) {
        const set = next.byPhone.get(phone) ?? new Set<string>();
        set.add(code);
        next.byPhone.set(phone, set);
      }
      await sleep(INDEX_GAP_MS);
      return readFrom(i + 1);
    };
    if (!(await readFrom(0))) return;
    next.complete = true;
    log.info(
      { event: 'sql_account_index', customers: next.names.size, phones: next.byPhone.size },
      'SQL Account phone index read',
    );
  };

  /** Starts the background read when there is no fresh index (never waits for it). */
  const ensureIndex = (): Promise<void> => {
    if (!matchByPhone() || stateOf().state !== 'connected') return Promise.resolve();
    if (index && now() - index.at < INDEX_TTL_MS) return indexing ?? Promise.resolve();
    indexing ??= refreshIndex()
      .catch((error: unknown) => {
        noteFailure(error);
        log.warn(
          {
            event: 'sql_account_index_failed',
            kind: error instanceof SqlError ? error.kind : 'other',
          },
          'SQL Account phone index not read',
        );
      })
      .finally(() => {
        indexing = null;
      });
    return indexing;
  };

  const phoneMatch = (jid: string): ChatMatch => {
    if (!index) return NO_MATCH;
    const codes = new Set<string>();
    for (const raw of chatPhones(ctx.db, jid)) {
      const n = normalizePhone(raw);
      for (const code of (n && index.byPhone.get(n)) || []) codes.add(code);
    }
    if (codes.size === 1) {
      const code = [...codes][0]!;
      return { kind: 'phone', code, sqlName: index.names.get(code) ?? null };
    }
    return codes.size > 1 ? { kind: 'several', code: null, sqlName: null } : NO_MATCH;
  };

  const service = {
    fake,
    status,

    async connect(body: SqlConnectBody, actor: Actor): Promise<SqlConnectResult> {
      const accessKey = body.accessKey.trim();
      const host = sqlHostFromKey(accessKey);
      if (!host) return { ok: false, error: 'key_format', status: status() };
      const trial = new SqlClient(
        { host, accessKey, secretKey: body.secretKey },
        { fetch: fetchFn, now },
      );
      try {
        await timed('check', () => trial.check());
      } catch (error) {
        const kind: SqlAccountProblem = error instanceof SqlError ? error.kind : 'unexpected';
        audit(ctx.db, {
          userId: actor.userId,
          action: 'sql_account.connect_failed',
          ip: actor.ip,
          meta: { state: kind },
        });
        return { ok: false, error: kind, status: status() };
      }
      ctx.settings.setSecret(
        CONNECTION_SETTING,
        JSON.stringify({ host, accessKey, secretKey: body.secretKey }),
      );
      client = trial;
      index = null;
      generation++;
      setState('connected');
      void ensureIndex();
      audit(ctx.db, {
        userId: actor.userId,
        action: 'sql_account.connect',
        ip: actor.ip,
        meta: { keyEnd: sqlKeyEnd(accessKey) },
      });
      return { ok: true, error: null, status: status() };
    },

    async test(): Promise<SqlAccountStatus> {
      const c = getClient();
      if (!c) return status();
      try {
        await timed('check', () => c.check());
        setState('connected');
      } catch (error) {
        setState(error instanceof SqlError ? error.kind : 'unexpected');
      }
      return status();
    },

    /** Checks again when the last check is older than RECHECK_MS (agents' turns call this). */
    async recheckIfStale(): Promise<void> {
      const { state, checkedAt } = stateOf();
      if (state === 'disconnected') return;
      if (checkedAt !== null && now() - checkedAt < RECHECK_MS) return;
      await service.test();
    },

    disconnect(actor: Actor): SqlAccountStatus {
      ctx.settings.setSecret(CONNECTION_SETTING, null);
      ctx.settings.set(STATE_SETTING, null);
      client = null;
      index = null;
      generation++;
      audit(ctx.db, { userId: actor.userId, action: 'sql_account.disconnect', ip: actor.ip });
      return status();
    },

    setMatchByPhone(value: boolean, actor: Actor): SqlAccountStatus {
      ctx.settings.set(MATCH_SETTING, value);
      void ensureIndex();
      audit(ctx.db, {
        userId: actor.userId,
        action: 'sql_account.match_setting',
        ip: actor.ip,
        meta: { matchByPhone: value },
      });
      return status();
    },

    agentSettings(agentId: number): SqlAgentSettings | null {
      return agentById(ctx.db, agentId) ? readAgentSettings(ctx.db, agentId) : null;
    },

    saveAgentSettings(agentId: number, settings: SqlAgentSettings, actor: Actor) {
      if (!agentById(ctx.db, agentId)) return null;
      const before = readAgentSettings(ctx.db, agentId);
      const clean = SqlAgentSettings.parse(settings);
      // Create only where the core guards it: anything else is saved as Read.
      for (const [id, access] of Object.entries(clean.access))
        if (access === 'create')
          clean.access[id as SqlObjectId] = sqlAccessOf(clean, id as SqlObjectId);
      writeAgentSettings(ctx.db, agentId, clean, now());
      const changed = (Object.keys({ ...before.access, ...clean.access }) as SqlObjectId[]).filter(
        (id) => sqlAccessOf(before, id) !== sqlAccessOf(clean, id),
      );
      audit(ctx.db, {
        userId: actor.userId,
        action: 'sql_account.agent_settings',
        ip: actor.ip,
        meta: {
          agentId,
          objects: changed,
          showPrice: before.showPrice !== clean.showPrice ? clean.showPrice : undefined,
          stockDetail: before.stockDetail !== clean.stockDetail ? clean.stockDetail : undefined,
        },
      });
      return clean;
    },

    /** The agent's settings when the connector is connected (the AI may use it), else null. */
    usable(agentId: number | null | undefined): SqlAgentSettings | null {
      if (agentId === null || agentId === undefined) return null;
      if (stateOf().state !== 'connected' || !readConnection()) return null;
      return readAgentSettings(ctx.db, agentId);
    },

    access(agentId: number, object: SqlObjectId): SqlAccess {
      const settings = service.usable(agentId);
      return settings ? sqlAccessOf(settings, object) : 'off';
    },

    /**
     * Which SQL Account customer writes in this chat: the teammate's link, else exactly one
     * customer with this WhatsApp number (when matching by phone is on). Never by name.
     */
    async match(chatJid: string, signal?: AbortSignal): Promise<ChatMatch> {
      const linked = linkOf(ctx.db, chatJid);
      if (linked) {
        const c = require();
        const rows = await timed('customer', () => c.list('customer', { code: linked }, signal));
        const row = rows.find((r) => text(r.code) === linked);
        return row
          ? { kind: 'linked', code: linked, sqlName: text(row.companyname) || null }
          : NO_MATCH;
      }
      if (!matchByPhone()) return NO_MATCH;
      void ensureIndex();
      return phoneMatch(chatJid);
    },

    /** Customers tab: every direct chat and its match (from the index so far; no per-chat call). */
    customers(): SqlCustomerRow[] {
      void ensureIndex();
      const links = allLinks(ctx.db);
      return directChats(ctx.db).map(({ jid, name }) => {
        const linked = links.get(jid);
        if (linked)
          return {
            jid,
            name,
            kind: 'linked',
            code: linked,
            sqlName: index?.names.get(linked) ?? null,
          };
        const m: ChatMatch = matchByPhone() ? phoneMatch(jid) : NO_MATCH;
        return { jid, name, ...m };
      });
    },

    /** SQL Account customers by code or company name (the Link dialog). */
    async debtors(q: string): Promise<SqlDebtor[]> {
      const c = require();
      const query = q.trim();
      const run = async (filters: Record<string, string>) =>
        (await timed('customer_search', () => c.list('customer', filters))).map((r) => ({
          code: text(r.code),
          name: text(r.companyname),
        }));
      try {
        if (!query) return (await run({})).slice(0, 20);
        const byCode = await run({ code: query });
        if (byCode.length) return byCode.slice(0, 20);
        return (await run({ companyname: `*${query.replaceAll('*', '')}*` })).slice(0, 20);
      } catch (error) {
        noteFailure(error);
        throw error;
      }
    },

    /** Links (or unlinks) a direct chat; the code must exist in SQL Account. */
    async link(
      jid: string,
      code: string | null,
      actor: Actor,
    ): Promise<'ok' | 'unknown_code' | 'not_found'> {
      const chat = ctx.db.prepare('SELECT jid FROM chats WHERE jid = ?').get(jid);
      if (!chat || jid.endsWith('@g.us')) return 'not_found';
      if (code !== null) {
        const c = require();
        const rows = await timed('customer', () => c.list('customer', { code })).catch(
          (error: unknown) => {
            noteFailure(error);
            throw error;
          },
        );
        if (!rows.some((r) => text(r.code) === code)) return 'unknown_code';
      }
      setLink(ctx.db, jid, code, actor.userId, now());
      audit(ctx.db, {
        userId: actor.userId,
        action: 'sql_account.customer_link',
        ip: actor.ip,
        meta: { chatJid: jid, linked: code !== null },
      });
      return 'ok';
    },

    /** Resolves when the running phone-index read ends (tests, Dev Build checks). */
    indexReady: (): Promise<void> => indexing ?? Promise.resolve(),
    activity: () => listActivity(ctx.db),
    addActivity: (row: Parameters<typeof addActivity>[1]) => addActivity(ctx.db, row, now()),
    noteFailure,
    timed,
    client: require,
    now,

    /** Now in the business time zone, `YYYY-MM-DD HH:mm` (when the AI read an amount). */
    asOf(): string {
      const zone = ctx.settings.get<string>(AI_TIMEZONE_SETTING, '') || 'Asia/Kuala_Lumpur';
      const format = (timeZone: string) =>
        new Intl.DateTimeFormat('sv-SE', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(now()));
      try {
        return format(zone);
      } catch {
        return format('Asia/Kuala_Lumpur');
      }
    },

    /** Today in the business time zone, `YYYY-MM-DD` (a quotation's date). */
    today(): string {
      const zone = ctx.settings.get<string>(AI_TIMEZONE_SETTING, '') || 'Asia/Kuala_Lumpur';
      try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(now()));
      } catch {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(
          new Date(now()),
        );
      }
    },

    shutdown() {
      client = null;
      index = null;
      generation++;
    },
  };
  return service;
}

export type SqlAccountService = ReturnType<typeof createSqlAccountService>;

export function initSqlAccount(ctx: AppContext) {
  ctx.services.sqlAccount = createSqlAccountService(ctx);
}

export function getSqlAccount(ctx: AppContext): SqlAccountService {
  const service = ctx.services.sqlAccount;
  if (!service) throw new Error('SQL Account service not initialised');
  return service;
}
