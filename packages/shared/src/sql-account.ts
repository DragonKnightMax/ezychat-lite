import { z } from 'zod';

/**
 * SQL Account connector (core; design docs/features/sql-accounting/design.md). Works only with SQL
 * Account's API service (API Link, eStream Software): HTTPS to a `*.sql.my` name, AWS SigV4 with an
 * access key + secret key made for one SQL Account user. Per AI agent, each SQL Account object is
 * Off / Read / Read + create. The keys never reach the browser.
 */

/**
 * `connected`, or why it does not work: `no_dns` (no API service for this key), `unreachable`
 * (service off, server off, port 443 not forwarded, TLS error, 5xx), `private_ip` (the name points
 * to a private address), `bad_keys` (401/403), `old_version` (404 / not the documented JSON),
 * `unexpected` (anything else, e.g. a redirect or an answer that is too large).
 */
export const SqlAccountState = z.enum([
  'disconnected',
  'connected',
  'no_dns',
  'unreachable',
  'private_ip',
  'bad_keys',
  'old_version',
  'unexpected',
]);
export type SqlAccountState = z.infer<typeof SqlAccountState>;
export type SqlAccountProblem = Exclude<SqlAccountState, 'disconnected' | 'connected'>;

/** The objects the AI may use (paths of the SQL Account API). Anything else is never called. */
export const SQL_OBJECT_IDS = [
  'stockitem',
  'customer',
  'customerinvoice',
  'salesinvoice',
  'salesquotation',
  'salesorder',
  'deliveryorder',
  'customerpayment',
] as const;
export const SqlObjectId = z.enum(SQL_OBJECT_IDS);
export type SqlObjectId = z.infer<typeof SqlObjectId>;

export const SqlAccess = z.enum(['off', 'read', 'create']);
export type SqlAccess = z.infer<typeof SqlAccess>;

export interface SqlObjectDef {
  id: SqlObjectId;
  /** `own`: only the chat's own customer's records (the server adds the customer code). */
  scope: 'everyone' | 'own';
  /** Whether Read + create is offered (only where the core has guards for it). */
  create: boolean;
  /** The access once connected when the admin has not chosen. */
  def: SqlAccess;
}

export const SQL_OBJECTS: readonly SqlObjectDef[] = [
  { id: 'stockitem', scope: 'everyone', create: false, def: 'read' },
  { id: 'customer', scope: 'own', create: false, def: 'off' },
  // The accounts-receivable invoice: amount paid and still owed (money figures: off by default).
  { id: 'customerinvoice', scope: 'own', create: false, def: 'off' },
  { id: 'salesinvoice', scope: 'own', create: false, def: 'read' },
  { id: 'salesquotation', scope: 'own', create: true, def: 'read' },
  { id: 'salesorder', scope: 'own', create: false, def: 'read' },
  { id: 'deliveryorder', scope: 'own', create: false, def: 'read' },
  { id: 'customerpayment', scope: 'own', create: false, def: 'off' },
];

export const SqlStockDetail = z.enum(['inStock', 'quantity']);
export type SqlStockDetail = z.infer<typeof SqlStockDetail>;

/** `GET`/`PUT /api/connectors/sql-account/agents/:agentId` (admins). Missing access = default. */
export const SqlAgentSettings = z.object({
  access: z.partialRecord(SqlObjectId, SqlAccess).default({}),
  showPrice: z.boolean().default(true),
  stockDetail: SqlStockDetail.default('inStock'),
});
export type SqlAgentSettings = z.infer<typeof SqlAgentSettings>;
export const DEFAULT_SQL_AGENT_SETTINGS: SqlAgentSettings = {
  access: {},
  showPrice: true,
  stockDetail: 'inStock',
};

/** The access an agent has to one object (the saved choice, else the object's default). */
export function sqlAccessOf(settings: SqlAgentSettings, id: SqlObjectId): SqlAccess {
  const def = SQL_OBJECTS.find((o) => o.id === id)!;
  const chosen = settings.access[id] ?? def.def;
  return chosen === 'create' && !def.create ? 'read' : chosen;
}

/** SQL Account's access key: `<32 hex>.sql.my/<user>` (as SQL Account shows it). */
export const SQL_ACCESS_KEY = /^([0-9a-f]{32})\.sql\.my\/([A-Za-z0-9_.-]{1,30})$/;
export const SQL_SECRET_MAX = 200;

/**
 * SQL Account's API address. eStream's Postman collection (2026-05-28) uses `https://api.sql.my`;
 * the access key itself names the company (`<32 hex>.sql.my/<user>`), so the same address serves
 * every company.
 */
export const SQL_API_HOST = 'api.sql.my';

/** The API address for an access key, or null when the key has another form. */
export function sqlHostFromKey(accessKey: string): string | null {
  return SQL_ACCESS_KEY.test(accessKey.trim()) ? SQL_API_HOST : null;
}

/** `…c393/APIUSER`: the only part of the key ever shown again. */
export function sqlKeyEnd(accessKey: string): string | null {
  const match = SQL_ACCESS_KEY.exec(accessKey.trim());
  return match ? `…${match[1]!.slice(-4)}/${match[2]}` : null;
}

/** `GET /api/connectors/sql-account` (admins). */
export const SqlAccountStatus = z.object({
  state: SqlAccountState,
  /** `https://api.sql.my` while keys are saved, else null. */
  host: z.string().nullable(),
  keyEnd: z.string().nullable(),
  checkedAt: z.number().int().nullable(),
  /** Match a chat to a SQL Account customer by phone number (else only teammate links). */
  matchByPhone: z.boolean(),
  /**
   * The phone index (read in the background from each customer's branches): `building` while the
   * first read runs, `unavailable` when no customer has a phone number EzyChat can read.
   */
  phoneMatch: z.enum(['unknown', 'building', 'available', 'unavailable']),
});
export type SqlAccountStatus = z.infer<typeof SqlAccountStatus>;

export const SqlConnectBody = z.object({
  accessKey: z.string().trim().min(1).max(200),
  secretKey: z.string().min(1).max(SQL_SECRET_MAX),
});
export type SqlConnectBody = z.infer<typeof SqlConnectBody>;

/** `POST /api/connectors/sql-account/connect`: keys are saved only when SQL Account answered. */
export const SqlConnectResult = z.object({
  ok: z.boolean(),
  error: z.union([SqlAccountState, z.literal('key_format')]).nullable(),
  status: SqlAccountStatus,
});
export type SqlConnectResult = z.infer<typeof SqlConnectResult>;

export const SqlMatchBody = z.object({ matchByPhone: z.boolean() });

/** How a chat is matched to a SQL Account customer. Never by name. */
export const SqlMatchKind = z.enum(['linked', 'phone', 'several', 'none']);
export type SqlMatchKind = z.infer<typeof SqlMatchKind>;

/** `GET /api/connectors/sql-account/customers` (admins): direct chats and their match. */
export const SqlCustomerRow = z.object({
  jid: z.string(),
  name: z.string(),
  kind: SqlMatchKind,
  code: z.string().nullable(),
  sqlName: z.string().nullable(),
});
export type SqlCustomerRow = z.infer<typeof SqlCustomerRow>;

export const SQL_CUSTOMER_CODE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,29}$/;

/** `PUT /api/connectors/sql-account/links` {jid, code}: code null unlinks. */
export const SqlLinkBody = z.object({
  jid: z.string().min(3).max(200),
  code: z.string().trim().regex(SQL_CUSTOMER_CODE).nullable(),
});
export type SqlLinkBody = z.infer<typeof SqlLinkBody>;

/** `GET /api/connectors/sql-account/debtors?q=` (admins): SQL Account customers for Link. */
export const SqlDebtor = z.object({ code: z.string(), name: z.string() });
export type SqlDebtor = z.infer<typeof SqlDebtor>;

export const SqlActivityTool = z.enum(['stock', 'account', 'document', 'payments', 'quotation']);
export type SqlActivityTool = z.infer<typeof SqlActivityTool>;
export const SqlActivityResult = z.enum(['done', 'refused', 'failed']);

/** One line of the Activity tab: who and when, never amounts, names or document contents. */
export const SqlActivity = z.object({
  id: z.number().int(),
  at: z.number().int(),
  agentId: z.number().int().nullable(),
  agentName: z.string().nullable(),
  chatJid: z.string().nullable(),
  chatName: z.string().nullable(),
  tool: SqlActivityTool,
  result: SqlActivityResult,
  reason: z.string().nullable(),
  /** A created quotation's SQL Account internal id. */
  dockey: z.number().int().nullable(),
});
export type SqlActivity = z.infer<typeof SqlActivity>;
