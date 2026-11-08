import type { McpSettingsResponse } from '@ezychat/shared';
import type { AppContext } from '../context.js';

export const MCP_ENABLED_SETTING = 'mcp_enabled';
export const MCP_PATH = '/mcp';
/** Binary or multipart file uploads for the send tools (`uploadId`). */
export const MCP_UPLOADS_PATH = '/mcp/uploads';

/** AI assistant (MCP) access is off until an admin turns it on. */
export function isMcpEnabled(ctx: AppContext): boolean {
  return ctx.settings.get<boolean>(MCP_ENABLED_SETTING, false) === true;
}

export function setMcpEnabled(ctx: AppContext, enabled: boolean): void {
  ctx.settings.set(MCP_ENABLED_SETTING, enabled);
}

/** HTTPS base URL of the running tunnel, which remote MCP clients connect through. */
function publicUrl(ctx: AppContext): string | null {
  const status = ctx.services.tunnel?.status();
  if (!status || status.state !== 'running') return null;
  if (status.url) return status.url.replace(/\/+$/, '');
  return status.hostname ? `https://${status.hostname}` : null;
}

export function mcpSettings(ctx: AppContext): McpSettingsResponse {
  return {
    enabled: isMcpEnabled(ctx),
    endpointPath: MCP_PATH,
    publicUrl: publicUrl(ctx),
    // config.port is the port actually listened on (a saved port change applies after a restart).
    localUrl: `http://127.0.0.1:${ctx.config.port}`,
  };
}
