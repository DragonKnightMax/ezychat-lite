import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 7420;

export interface ServerConfig {
  dataDir: string;
  port: number;
  host: string;
  mode: 'standalone' | 'service' | 'dev';
  fakeWa: boolean;
  webDistDir: string | null;
  version: string;
  /** true when --port / WATI_PORT was given; otherwise startServer uses the persisted `port` setting */
  portExplicit?: boolean;
  /** true when --host / WATI_HOST was given; otherwise startServer derives it from the `lan_enabled` setting */
  hostExplicit?: boolean;
  /** --max-inboxes (dev + fake WhatsApp only): overrides the build's inbox limit for testing. */
  maxInboxes?: number;
  /**
   * Most AI agents: the build's limit (`CliProduct.maxAgents`), or --max-agents (dev + fake
   * WhatsApp only). Absent = one per inbox (`maxInboxes`; Lite 1).
   */
  maxAgents?: number;
  /**
   * The Google sign-in app of this build (env GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET,
   * desktop client type). null/absent: Google Calendar shows "not configured". Never logged.
   */
  googleOAuth?: { clientId: string; clientSecret: string } | null;
  /**
   * Google's file picker of this build (env GOOGLE_PICKER_API_KEY / GOOGLE_PICKER_APP_ID: a browser
   * API key limited to the Picker API, and the Cloud project number). Google Sheets needs it with
   * `googleOAuth`. Never logged.
   */
  googlePicker?: { apiKey: string; appId: string } | null;
}

const MODES = ['standalone', 'service', 'dev'] as const;

/** Flags without a value. */
const BOOLEAN_FLAGS = new Set(['fake-wa', 'reset-admin', 'ignore-moved', 'restore-moved']);

/** The parsed command line: the server config plus the one-shot commands. */
export interface CliConfig extends ServerConfig {
  resetAdmin: boolean;
  /** Start even when the data folder has `moved.json`. */
  ignoreMoved: boolean;
  /** Remove `moved.json` and rename the moved WhatsApp folders back, then exit. */
  restoreMoved: boolean;
  /** Lite data folder to summarise (read only), then exit. */
  liteSummary?: string;
  /** Lite data folder to import into `dataDir`, then exit. */
  importLite?: string;
  /** JSON file with the merge plan (`LiteImportPlan`). */
  importPlan?: string;
}

/**
 * The Google sign-in app a release bundle carries (esbuild `define` from repository secrets in
 * scripts/google-oauth-define.mjs, Lite and Enterprise). Undeclared in source runs and forks.
 */
declare const __EZYCHAT_GOOGLE_OAUTH__:
  | { clientId?: unknown; clientSecret?: unknown; pickerApiKey?: unknown; pickerAppId?: unknown }
  | undefined;

function bundledGoogleOAuth(): {
  clientId?: string;
  clientSecret?: string;
  pickerApiKey?: string;
  pickerAppId?: string;
} {
  const app =
    typeof __EZYCHAT_GOOGLE_OAUTH__ === 'undefined' ? undefined : __EZYCHAT_GOOGLE_OAUTH__;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    clientId: text(app?.clientId),
    clientSecret: text(app?.clientSecret),
    pickerApiKey: text(app?.pickerApiKey),
    pickerAppId: text(app?.pickerAppId),
  };
}

function readVersion(): string {
  if (process.env.WATI_VERSION) return process.env.WATI_VERSION;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/config.ts and dist/config.js both sit one level below the package root
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function defaultWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '..', '..', '..', 'apps', 'web', 'dist');
  return existsSync(join(candidate, 'index.html')) ? candidate : null;
}

/**
 * Flags: --data <dir> (required unless WATI_DATA env), --port <n>, --host <h>, --mode <m>,
 * --fake-wa, --web-dist <dir>, --reset-admin, --max-inboxes <n>, --max-agents <n>. Also accepts --flag=value.
 * Env fallbacks: WATI_DATA, WATI_PORT, WATI_HOST, WATI_MODE, WATI_WEB_DIST. Google sign-in app:
 * GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET (both or neither), else the release bundle's;
 * Google's file picker likewise: GOOGLE_PICKER_API_KEY + GOOGLE_PICKER_APP_ID.
 * Fake WhatsApp is enabled ONLY by the explicit --fake-wa flag (never by env), and never in service mode.
 * --max-inboxes and --max-agents are accepted only together with --mode dev and --fake-wa (never by env).
 * Lite → Enterprise (flag-only, never env): --ignore-moved (start although `moved.json` is there),
 * --restore-moved (put a moved Lite folder back, then exit), --lite-summary <liteDir> (print the
 * summary, then exit; --data is optional with it), --import-lite <liteDir> [--import-plan <file>]
 * (import into --data, then exit). At most one of --reset-admin, --restore-moved, --lite-summary
 * and --import-lite.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliConfig {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`missing value for --${name}`);
    flags.set(name, next);
    i++;
  }
  const known = new Set([
    'data',
    'port',
    'host',
    'mode',
    'fake-wa',
    'web-dist',
    'reset-admin',
    'max-inboxes',
    'max-agents',
    'ignore-moved',
    'restore-moved',
    'lite-summary',
    'import-lite',
    'import-plan',
  ]);
  for (const k of flags.keys()) if (!known.has(k)) throw new Error(`unknown flag: --${k}`);

  const str = (k: string): string | undefined => {
    const v = flags.get(k);
    return typeof v === 'string' ? v : undefined;
  };

  for (const k of ['ignore-moved', 'restore-moved'])
    if (flags.has(k) && flags.get(k) !== true) throw new Error(`--${k} takes no value`);
  const liteSummary = str('lite-summary');
  const importLite = str('import-lite');
  const importPlan = str('import-plan');
  const commands = [
    flags.get('reset-admin') === true,
    flags.get('restore-moved') === true,
    liteSummary !== undefined,
    importLite !== undefined,
  ].filter(Boolean).length;
  if (commands > 1)
    throw new Error(
      'use only one of --reset-admin, --restore-moved, --lite-summary and --import-lite',
    );
  if (importPlan !== undefined && importLite === undefined)
    throw new Error('--import-plan is allowed only with --import-lite');

  // --lite-summary reads another folder only: --data may be left out there.
  const data = str('data') ?? env.WATI_DATA ?? liteSummary;
  if (!data) throw new Error('--data <dir> is required (or set WATI_DATA)');

  const portRaw = str('port') ?? env.WATI_PORT;
  let port = DEFAULT_PORT;
  if (portRaw !== undefined) {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`invalid port: ${portRaw}`);
  }

  const modeRaw = str('mode') ?? env.WATI_MODE ?? 'standalone';
  if (!(MODES as readonly string[]).includes(modeRaw)) throw new Error(`invalid mode: ${modeRaw}`);

  if (flags.get('fake-wa') === true && modeRaw === 'service')
    throw new Error('--fake-wa is not allowed in service mode');

  let maxInboxes: number | undefined;
  const maxInboxesRaw = str('max-inboxes');
  if (maxInboxesRaw !== undefined) {
    if (modeRaw !== 'dev' || flags.get('fake-wa') !== true)
      throw new Error('--max-inboxes is allowed only with --mode dev and --fake-wa');
    maxInboxes = Number(maxInboxesRaw);
    if (!Number.isInteger(maxInboxes) || maxInboxes < 1 || maxInboxes > 100)
      throw new Error(`invalid --max-inboxes: ${maxInboxesRaw}`);
  }

  let maxAgents: number | undefined;
  const maxAgentsRaw = str('max-agents');
  if (maxAgentsRaw !== undefined) {
    if (modeRaw !== 'dev' || flags.get('fake-wa') !== true)
      throw new Error('--max-agents is allowed only with --mode dev and --fake-wa');
    maxAgents = Number(maxAgentsRaw);
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 100)
      throw new Error(`invalid --max-agents: ${maxAgentsRaw}`);
  }

  const hostRaw = str('host') ?? env.WATI_HOST;
  // The environment (Dev Builds, own builds) wins over the app the release bundle carries.
  const bundled = bundledGoogleOAuth();
  const envGoogle = env.GOOGLE_OAUTH_CLIENT_ID?.trim() && env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const googleClientId = envGoogle ? env.GOOGLE_OAUTH_CLIENT_ID?.trim() : bundled.clientId;
  const googleClientSecret = envGoogle
    ? env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
    : bundled.clientSecret;
  const envPicker = env.GOOGLE_PICKER_API_KEY?.trim() && env.GOOGLE_PICKER_APP_ID?.trim();
  const pickerApiKey = envPicker ? env.GOOGLE_PICKER_API_KEY?.trim() : bundled.pickerApiKey;
  const pickerAppId = envPicker ? env.GOOGLE_PICKER_APP_ID?.trim() : bundled.pickerAppId;
  const webDist = str('web-dist') ?? env.WATI_WEB_DIST;

  return {
    dataDir: resolve(data),
    port,
    host: hostRaw ?? '127.0.0.1',
    mode: modeRaw as ServerConfig['mode'],
    fakeWa: flags.get('fake-wa') === true,
    webDistDir: webDist ? resolve(webDist) : defaultWebDist(),
    version: readVersion(),
    portExplicit: portRaw !== undefined,
    hostExplicit: hostRaw !== undefined,
    resetAdmin: flags.get('reset-admin') === true,
    ignoreMoved: flags.get('ignore-moved') === true,
    restoreMoved: flags.get('restore-moved') === true,
    ...(liteSummary !== undefined ? { liteSummary: resolve(liteSummary) } : {}),
    ...(importLite !== undefined ? { importLite: resolve(importLite) } : {}),
    ...(importPlan !== undefined ? { importPlan: resolve(importPlan) } : {}),
    ...(maxInboxes !== undefined ? { maxInboxes } : {}),
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    googleOAuth:
      googleClientId && googleClientSecret
        ? { clientId: googleClientId, clientSecret: googleClientSecret }
        : null,
    googlePicker: pickerApiKey && pickerAppId ? { apiKey: pickerApiKey, appId: pickerAppId } : null,
  };
}
