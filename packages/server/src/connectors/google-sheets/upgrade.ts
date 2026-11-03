/**
 * Start-up upgrade of the Google Sheets settings (design docs/features/group-agents/design.md,
 * Part A). Permanent code, idempotent: the updater jumps straight to the newest release, so an
 * install may arrive here from any older one.
 *
 * An older save (`lookupTab`/`lookup`, `leadsTab`/`addLeads`) becomes tab access. The tools no longer
 * say when to add a lead (the agent's instructions do), so an agent that added leads gets one line
 * appended to its saved instructions (kept as a setup version and audited), unless they already name
 * that tab. Logs carry ids and counts only.
 */
import { AI_INSTRUCTIONS_CHARACTERS, presetTexts } from '@ezychat/shared';
import { agentById, updateAgentTexts } from '../../ai/agents.js';
import { recordSetupVersion } from '../../ai/setup-versions.js';
import type { AppContext } from '../../context.js';
import { audit } from '../../db/audit.js';
import {
  isLegacySettings,
  legacyLeadsTab,
  mapLegacySettings,
  storedSettings,
  writeSettings,
} from './repo.js';

/** The line an agent that used Add leads gets (the tab name in quotes). */
/**
 * Agents whose older Add leads tab may still be empty (`{ [agentId]: tab }`): the old tool wrote
 * the lead header itself on the first lead, so such a tab keeps getting rows with that header.
 */
export const LEGACY_LEADS_SETTING = 'google_sheets_legacy_leads';

/** The older leads tab of this agent, else null. */
export function legacyLeadsTabOf(ctx: AppContext, agentId: number): string | null {
  const map = ctx.settings.get<unknown>(LEGACY_LEADS_SETTING, null);
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const tab = (map as Record<string, unknown>)[String(agentId)];
  return typeof tab === 'string' && tab ? tab : null;
}

export const leadsInstruction = (tab: string) =>
  `Add customers who want to buy as a new row to the tab "${tab}".`;

export function upgradeSheetsSettings(ctx: AppContext, now = Date.now()): number {
  const log = ctx.log.child({ mod: 'google-sheets' });
  let upgraded = 0;
  for (const row of storedSettings(ctx.db)) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.settings);
    } catch {
      continue;
    }
    if (!isLegacySettings(raw)) continue;
    const leadsTab = legacyLeadsTab(raw);
    const settings = mapLegacySettings(raw);
    let instructionsChanged = false;
    ctx.db.transaction(() => {
      const agent = agentById(ctx.db, row.agentId);
      if (agent && leadsTab) {
        const current = agent.instructions ?? presetTexts(agent.preset).instructions;
        const line = leadsInstruction(leadsTab);
        const next = current.trim() ? `${current.trimEnd()}\n\n${line}` : line;
        if (
          !current.toLowerCase().includes(leadsTab.toLowerCase()) &&
          next.length <= AI_INSTRUCTIONS_CHARACTERS
        ) {
          updateAgentTexts(ctx.db, agent.id, { instructions: next }, now);
          recordSetupVersion(
            ctx.db,
            agent.id,
            'instructions',
            null,
            current,
            next,
            {
              userId: null,
              via: 'app',
              reason: 'Google Sheets: the leads tab moved to instructions',
            },
            now,
          );
          audit(ctx.db, {
            userId: null,
            ip: null,
            action: 'google_sheets.upgrade',
            meta: { agentId: agent.id, instructionsChanged: true },
          });
          instructionsChanged = true;
        }
      }
      if (leadsTab) {
        const map = ctx.settings.get<Record<string, string> | null>(LEGACY_LEADS_SETTING, null);
        ctx.settings.set(LEGACY_LEADS_SETTING, { ...(map ?? {}), [row.agentId]: leadsTab });
      }
      writeSettings(ctx.db, row.agentId, settings, now);
    })();
    upgraded++;
    log.info(
      {
        event: 'google_sheets_settings_upgraded',
        agentId: row.agentId,
        tabs: settings.tabs.length,
        instructionsChanged,
      },
      'Google Sheets settings upgraded to tab access',
    );
  }
  return upgraded;
}
