// Public API for other product builds. Anything not exported here is internal.
export { buildApp } from './app.js';
export { requireAdmin, requireUser } from './auth/guards.js';
export { parseArgs, type ServerConfig } from './config.js';
export type { AppContext, Services } from './context.js';
export type { InboxRow } from './inboxes/repo.js';
export { getInboxService, type InboxActor, type InboxService } from './inboxes/service.js';
export { ACCESS_CODE_PATTERN, type AccessGate, type AccessState } from './access/gate.js';
export {
  EXTENSION_NAME,
  type FeedbackAuth,
  type InboxTypeDefinition,
  type PublicRoutes,
  type ServerExtension,
} from './extensions.js';
export {
  AGENT_TOOL_NAME,
  CORE_AGENT_TOOL_NAMES,
  ToolHandoverError,
  type AgentKind,
  type AgentToolInfo,
  type AgentToolsInput,
  type AgentToolsResult,
  type AiToolCallEvent,
} from './ai/agent/extension-tools.js';
export { AGENT_MAX_STEPS } from './ai/agent/turn.js';
export { tryAgentReply } from './ai/try-agent.js';
export { tunnelPublicUrls } from './tunnel/index.js';
/** The AI SDK the agent runs on, so extension tools come from the same `ai` package. */
export { dynamicTool, jsonSchema, tool, type Tool, type ToolSet } from 'ai';
export { createContext, runInitializers, shutdownServices, startServer } from './main.js';
export { runCli, type CliProduct } from './run-cli.js';
