-- Google Sheets tab access (docs/features/group-agents/design.md, Part A). Agents add rows to any tab
-- on Add rows; the settings JSON is mapped by start-up code (connectors/google-sheets/upgrade.ts).

-- Rows the AI added: the duplicate guard keys on chat, tab, the newest message of the batch and a
-- hash of the values (never the values themselves). Older lead rows keep NULLs.
ALTER TABLE sheets_leads ADD COLUMN tab TEXT;
ALTER TABLE sheets_leads ADD COLUMN message_id TEXT;
ALTER TABLE sheets_leads ADD COLUMN values_hash TEXT;
CREATE INDEX idx_sheets_leads_row ON sheets_leads(chat_jid, tab, message_id, values_hash);

-- Activity gains `row_added`, the tab and the group's name (a CHECK cannot be altered: rebuild).
CREATE TABLE sheets_activity_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('looked_up', 'lead_added', 'row_added', 'failed')),
  agent_id INTEGER,
  chat_jid TEXT,
  at INTEGER NOT NULL,
  tab TEXT,
  group_name TEXT
);
INSERT INTO sheets_activity_new (id, kind, agent_id, chat_jid, at)
  SELECT id, kind, agent_id, chat_jid, at FROM sheets_activity;
DROP TABLE sheets_activity;
ALTER TABLE sheets_activity_new RENAME TO sheets_activity;
CREATE INDEX idx_sheets_activity_at ON sheets_activity(at DESC, id DESC);
