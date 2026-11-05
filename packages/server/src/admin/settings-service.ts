import type { Settings, SettingsPatchBody } from '@ezychat/shared';
import { DEFAULT_PORT } from '../config.js';
import type { AppContext } from '../context.js';
import { TUNNEL_HOSTNAME_KEY, TUNNEL_TOKEN_KEY } from '../tunnel/manager.js';
import { usageStatsEnabled } from '../usage/service.js';

/** Settings keys (shared with main.ts which reads port / lan_enabled / history_days at startup). */
export const SETTINGS_KEYS = {
  port: 'port',
  lanEnabled: 'lan_enabled',
  historyDays: 'history_days',
  namedTunnelHostname: TUNNEL_HOSTNAME_KEY,
  tunnelToken: TUNNEL_TOKEN_KEY,
} as const;

/** small by default: a fresh link imports only the last few days (media is fetched on demand) */
export const DEFAULT_HISTORY_DAYS = 3;

export interface PatchSettingsResult {
  settings: Settings;
  /** true when port or LAN binding changed (applied on next server start) */
  restartRequired: boolean;
}

export interface SettingsService {
  get(): Settings;
  patch(body: SettingsPatchBody): PatchSettingsResult;
}

function validPort(p: number): boolean {
  return Number.isInteger(p) && p >= 1024 && p <= 65535;
}

export function createSettingsService(ctx: AppContext): SettingsService {
  const s = ctx.settings;
  const defaultPort = validPort(ctx.config.port) ? ctx.config.port : DEFAULT_PORT;

  const get = (): Settings => ({
    port: s.get<number>(SETTINGS_KEYS.port, defaultPort),
    lanEnabled: s.get<boolean>(SETTINGS_KEYS.lanEnabled, false),
    historyDays: s.get<number>(SETTINGS_KEYS.historyDays, DEFAULT_HISTORY_DAYS),
    namedTunnelHostname: s.get<string | null>(SETTINGS_KEYS.namedTunnelHostname, null),
    hasTunnelToken: s.getSecret(SETTINGS_KEYS.tunnelToken) !== null,
    usageStats: usageStatsEnabled(s),
  });

  return {
    get,
    patch(body) {
      const before = get();
      if (body.port !== undefined) s.set(SETTINGS_KEYS.port, body.port);
      if (body.lanEnabled !== undefined) s.set(SETTINGS_KEYS.lanEnabled, body.lanEnabled);
      if (body.historyDays !== undefined) s.set(SETTINGS_KEYS.historyDays, body.historyDays);
      if (body.namedTunnelHostname !== undefined) {
        s.set(SETTINGS_KEYS.namedTunnelHostname, body.namedTunnelHostname?.trim() || null);
      }
      const settings = get();
      const restartRequired = settings.port !== before.port || settings.lanEnabled !== before.lanEnabled;
      return { settings, restartRequired };
    },
  };
}
