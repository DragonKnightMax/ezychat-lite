-- Several AI agents per WhatsApp number (docs/features/group-agents/design.md, Part B).

-- 1. `ai_agents.inbox_id` loses its UNIQUE constraint: an inbox may have several agents (at most one
-- answering direct chats, checked by the server). SQLite cannot drop a column constraint in place,
-- so the table is rebuilt with the same ids. Migrations run with foreign keys on, so dropping the old
-- table deletes the rows of every table that references it (ON DELETE CASCADE): they are kept in
-- temporary copies and put back unchanged (OR IGNORE: rows the drop did not delete, e.g. items
-- without an agent or a connection with foreign keys off, stay as they are).
CREATE TEMP TABLE keep_ai_documents AS SELECT * FROM ai_documents WHERE agent_id IS NOT NULL;
CREATE TEMP TABLE keep_reply_phrases AS SELECT * FROM reply_phrases;
CREATE TEMP TABLE keep_calendar_agent_settings AS SELECT * FROM calendar_agent_settings;
CREATE TEMP TABLE keep_calendar_offers AS SELECT * FROM calendar_offers;
CREATE TEMP TABLE keep_connector_agent_settings AS SELECT * FROM connector_agent_settings;
CREATE TEMP TABLE keep_sheets_agent_settings AS SELECT * FROM sheets_agent_settings;

CREATE TABLE ai_agents_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  inbox_id INTEGER REFERENCES inboxes(id),
  preset TEXT NOT NULL DEFAULT 'sales' CHECK (preset IN ('sales', 'faq', 'custom')),
  instructions TEXT,
  handoff_rules TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  answer_groups INTEGER NOT NULL DEFAULT 0 CHECK (answer_groups IN (0, 1)),
  resolution_check INTEGER NOT NULL DEFAULT 0 CHECK (resolution_check IN (0, 1)),
  answer_direct INTEGER NOT NULL DEFAULT 1 CHECK (answer_direct IN (0, 1))
);
INSERT INTO ai_agents_new (id, user_id, inbox_id, preset, instructions, handoff_rules, created_at,
  updated_at, answer_groups, resolution_check, answer_direct)
  SELECT id, user_id, inbox_id, preset, instructions, handoff_rules, created_at, updated_at,
  answer_groups, resolution_check, answer_direct FROM ai_agents;
DROP TABLE ai_agents;
ALTER TABLE ai_agents_new RENAME TO ai_agents;
CREATE INDEX idx_ai_agents_inbox ON ai_agents(inbox_id);

INSERT OR IGNORE INTO ai_documents SELECT * FROM temp.keep_ai_documents;
INSERT OR IGNORE INTO reply_phrases SELECT * FROM temp.keep_reply_phrases;
INSERT OR IGNORE INTO calendar_agent_settings SELECT * FROM temp.keep_calendar_agent_settings;
INSERT OR IGNORE INTO calendar_offers SELECT * FROM temp.keep_calendar_offers;
INSERT OR IGNORE INTO connector_agent_settings SELECT * FROM temp.keep_connector_agent_settings;
INSERT OR IGNORE INTO sheets_agent_settings SELECT * FROM temp.keep_sheets_agent_settings;
DROP TABLE temp.keep_ai_documents;
DROP TABLE temp.keep_reply_phrases;
DROP TABLE temp.keep_calendar_agent_settings;
DROP TABLE temp.keep_calendar_offers;
DROP TABLE temp.keep_connector_agent_settings;
DROP TABLE temp.keep_sheets_agent_settings;

-- 2. A group is answered by the agent its row names (NULL = none); "Reads every message" (`listen`)
-- makes every live member message start a turn of that agent (default off: tags and quotes only).
ALTER TABLE ai_group_chats ADD COLUMN agent_id INTEGER;
ALTER TABLE ai_group_chats ADD COLUMN listen INTEGER NOT NULL DEFAULT 0 CHECK (listen IN (0, 1));

-- Existing switched-on groups keep the agent of their inbox (until now the only one). The inbox is
-- read from the chat key: inbox 1 has none, other inboxes end in `#<id>` (inboxes/keys.ts).
UPDATE ai_group_chats SET agent_id = (
  SELECT a.id FROM ai_agents a
  WHERE a.inbox_id = CASE WHEN instr(ai_group_chats.chat_jid, '#') > 0
    THEN CAST(substr(ai_group_chats.chat_jid, instr(ai_group_chats.chat_jid, '#') + 1) AS INTEGER)
    ELSE 1 END
  ORDER BY a.id LIMIT 1
) WHERE enabled = 1;

CREATE INDEX idx_ai_group_chats_agent ON ai_group_chats(agent_id);
