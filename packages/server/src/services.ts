import type { AppContext } from './context.js';

/**
 * Service initializers, run in order by startServer()/makeTestApp() before routes are built.
 * APPEND-ONLY SHARED FILE: later tasks add one import + one push line each, e.g.
 *   import { initAuth } from './auth/index.js';
 *   initializers.push(initAuth);
 */
export const initializers: Array<(ctx: AppContext) => void | Promise<void>> = [];

import { initTunnel } from './tunnel/index.js';
initializers.push(initTunnel);

import { initAuth } from './auth/index.js';
initializers.unshift(initAuth); // auth first: other services/guards depend on it

import { initApiTokens } from './api-tokens/index.js';
initializers.push(initApiTokens);

import { initAdmin } from './admin/index.js';
initializers.push(initAdmin);

import { initMessaging } from './wa-bridge/index.js';
initializers.push(initMessaging);

// WhatsApp Safety: message ingest calls it, so it is ready before WhatsApp connects.
import { initSafety } from './safety/service.js';
initializers.push(initSafety);

import { initPush } from './push/index.js';
initializers.push(initPush);

import { initVoice } from './voice/service.js';
initializers.push(initVoice);

import { initCustomers } from './customers/service.js';
initializers.push(initCustomers);

import { initAi } from './ai/service.js';
initializers.push(initAi);

import { initEnrichment } from './customers/enrichment.js';
initializers.push(initEnrichment);

import { initPhrases } from './ai/phrases/service.js';
initializers.push(initPhrases);

import { initGoogleCalendar } from './connectors/google-calendar/service.js';
initializers.push(initGoogleCalendar);

import { initGoogleSheets } from './connectors/google-sheets/service.js';
initializers.push(initGoogleSheets);

import { initConnectorList } from './connectors/list/service.js';
initializers.push(initConnectorList);

import { initConnectorMcp } from './connectors/mcp/service.js';
initializers.push(initConnectorMcp);
