/** Shared by live logging and support exports, including logs written before redaction existed. */
const SECRET_FIELDS = [
  'password',
  'token',
  'apiToken',
  'apiKey',
  'loginUrl',
  'authUrl',
  'accessToken',
  'refreshToken',
  'privateKey',
  'mediaKey',
  'keyData',
  'noiseKey',
  'signedIdentityKey',
  'signedPreKey',
  'advSecretKey',
  'authorization',
  'cookie',
  'set-cookie',
  // EXPERIMENTAL ChatGPT direct sign-in (OAuth tokens, PKCE, callback data).
  'idToken',
  'id_token',
  'access_token',
  'refresh_token',
  'authCode',
  'codeVerifier',
  'code_verifier',
  'oauthState',
  'authorizeUrl',
  'callbackUrl',
  'chatgptAccountId',
  'chatgpt-account-id',
  'pastedUrl',
  'codeChallenge',
  'code_challenge',
  'verifier',
  // Google Calendar connector (OAuth app secret).
  'clientSecret',
  'client_secret',
  'googleOAuth',
  'googlePicker',
  // GitHub connector (device flow).
  'deviceCode',
  'device_code',
];

const OAUTH_URL =
  /(https?:\/\/(?:auth\.openai\.com\/oauth\/(?:authorize|token)|(?:localhost|127\.0\.0\.1):1455\/auth\/callback))\?[^\s"'<>]*/gi;
// Personal access tokens (api-tokens/service.ts); the 12-character display prefix stays visible.
const PAT = /\bezc_pat_[A-Za-z0-9_-]{8,}/g;
// GitHub tokens: fine-grained (github_pat_) and classic/App/OAuth (ghp_, gho_, ghu_, ghs_, ghr_).
const GITHUB_TOKEN = /\b(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,})/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// A real token shape: 16+ token characters, or 8+ with a digit or token punctuation.
const BEARER =
  /\bBearer\s+(?:[A-Za-z0-9._~+/=-]{16,}|(?=[A-Za-z0-9]*[._~+/=0-9-])[A-Za-z0-9._~+/=-]{8,})/gi;
// JSON-embedded token fields, also inside a stringified (escaped) JSON message.
const JSON_TOKEN =
  /(\\?"(?:access_token|refresh_token|id_token|code_verifier|code_challenge|device_code)\\?"\s*:\s*\\?")[^"\\]*/gi;
// code= and state= are common words, so they only count as URL query parameters.
const QUERY_PARAM = /(?<=^|[?&#])(code|state)=[^&\s"']+/gi;
const QUERY_SECRET_KEYS = new Set([
  'code',
  'state',
  'code_verifier',
  'code_challenge',
  'refresh_token',
  'access_token',
  'id_token',
  'token',
  'client_secret',
]);
const OAUTH_PARAM =
  /\b(code_verifier|code_challenge|access_token|refresh_token|id_token)=[^&\s"']+/gi;

// Inbox search and tag filter terms are customer data (names, emails, phones): only as URL query
// parameters, so prose such as "a q=b" is left alone.
const SEARCH_PARAM = /(?<=[?&])(q|tag)=[^&#\s"']*/gi;

/** Scrubs OAuth addresses, bearer tokens, JWTs, OAuth parameters and search/tag terms from free text. */
export function redactSecretText(text: string): string {
  return text
    .replace(OAUTH_URL, '$1?[REDACTED]')
    .replace(PAT, 'ezc_pat_[REDACTED]')
    .replace(GITHUB_TOKEN, '[REDACTED_GITHUB_TOKEN]')
    .replace(JWT, '[REDACTED_JWT]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(JSON_TOKEN, '$1[REDACTED]')
    .replace(QUERY_PARAM, '$1=[REDACTED]')
    .replace(OAUTH_PARAM, '$1=[REDACTED]')
    .replace(SEARCH_PARAM, '$1=[REDACTED]');
}

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remotePort?: number };
}

/**
 * pino serializers for the live logger. `req` mirrors Fastify's default request serializer, with
 * secrets and search/tag terms scrubbed from the URL (serializers run after the logMethod hook).
 */
export const LOG_SERIALIZERS = {
  req(req: LoggedRequest) {
    return {
      method: req.method,
      url: typeof req.url === 'string' ? redactSecretText(req.url) : req.url,
      version: req.headers?.['accept-version'],
      host: req.host,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    };
  },
};

export const LOG_REDACT_PATHS = SECRET_FIELDS.flatMap((field) => [
  `["${field}"]`,
  `*["${field}"]`,
  `*.*["${field}"]`,
]);
const secrets = new Set(SECRET_FIELDS.map((field) => field.toLowerCase()));

const isPlainObject = (value: object) => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Copy of a live log argument with secret keys and secret-looking text scrubbed. Only plain
 * objects, arrays and Errors are copied; other instances (Fastify requests) are left to pino's
 * serializers.
 */
export function scrubLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[Truncated]';
  if (value instanceof URL) return redactSecretText(value.toString());
  if (value instanceof URLSearchParams)
    return [...value]
      .map(
        ([key, item]) =>
          `${key}=${QUERY_SECRET_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactSecretText(item)}`,
      )
      .join('&');
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    const cause = (value as { cause?: unknown }).cause;
    return {
      type: value.name,
      errType: value.constructor.name,
      message: redactSecretText(value.message),
      ...(value.stack ? { stack: redactSecretText(value.stack) } : {}),
      ...(typeof code === 'string' ? { code } : {}),
      ...(cause === undefined ? {} : { cause: scrubLogValue(cause, depth + 1) }),
    };
  }
  if (Array.isArray(value)) return value.map((item) => scrubLogValue(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value))
    out[key] = secrets.has(key.toLowerCase()) ? '[REDACTED]' : scrubLogValue(child, depth + 1);
  return out;
}

function redact(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (secrets.has(key.toLowerCase())) {
      (value as Record<string, unknown>)[key] = '[REDACTED]';
    } else if (typeof child === 'string') {
      (value as Record<string, unknown>)[key] = redactSecretText(child);
    } else {
      redact(child);
    }
  }
}

/** Fail closed for incomplete/non-JSON records; never export an unexamined raw line. */
export function redactLogLine(line: string): string {
  try {
    const record: unknown = JSON.parse(line);
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error('Not a log record');
    redact(record);
    return JSON.stringify(record) + '\n';
  } catch {
    return '{"msg":"Unstructured or incomplete log record omitted from support export"}\n';
  }
}
