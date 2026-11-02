-- Google Sheets connector (docs/features/google-sheets/design.md). The Google sign-in itself lives
-- in encrypted settings; these tables hold what each AI agent may do and what it did. Chat keys
-- carry no foreign key (user data never cascades with a chat); chats/merge.ts moves them.

-- Spreadsheet and switches per AI agent (JSON of SheetsAgentSettings).
CREATE TABLE sheets_agent_settings (
  agent_id INTEGER PRIMARY KEY REFERENCES ai_agents(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Lead rows the AI added: at most one per chat per spreadsheet in 24 hours (history: no foreign key).
CREATE TABLE sheets_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  chat_jid TEXT NOT NULL,
  spreadsheet_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sheets_leads_chat ON sheets_leads(chat_jid, spreadsheet_id, created_at);

-- The connector's Activity tab: who and when, never chat text or row values.
CREATE TABLE sheets_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('looked_up', 'lead_added', 'failed')),
  agent_id INTEGER,
  chat_jid TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX idx_sheets_activity_at ON sheets_activity(at DESC, id DESC);
