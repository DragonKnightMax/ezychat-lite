-- SQL Account connector (docs/features/sql-accounting/design.md). The keys live in an encrypted
-- setting; these tables hold what each AI agent may use, which chat is which SQL Account customer,
-- quotation drafts and the Activity tab. Chat keys carry no foreign key (user data never cascades
-- with a chat); chats/merge.ts moves them. Never amounts, names or document contents in activity.

-- Object access and display choices per AI agent (JSON of SqlAgentSettings).
CREATE TABLE sql_account_agent_settings (
  agent_id INTEGER PRIMARY KEY REFERENCES ai_agents(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A teammate's link from a direct chat to a SQL Account customer code (wins over a phone match).
CREATE TABLE sql_account_links (
  chat_jid TEXT PRIMARY KEY,
  customer_code TEXT NOT NULL,
  linked_by INTEGER,
  linked_at INTEGER NOT NULL
);

-- Stock item codes a look-up returned in a chat: a quotation may hold only these items.
CREATE TABLE sql_account_seen_items (
  chat_jid TEXT NOT NULL,
  item_code TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (chat_jid, item_code)
);

-- Quotation drafts the AI showed a customer; created only after a newer customer message.
CREATE TABLE sql_account_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  chat_jid TEXT NOT NULL,
  customer_code TEXT NOT NULL,
  items TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consent_message_id TEXT,
  dockey INTEGER,
  done_at INTEGER
);
CREATE INDEX idx_sql_account_quotes_chat ON sql_account_quotes(chat_jid, done_at);
CREATE INDEX idx_sql_account_quotes_agent ON sql_account_quotes(agent_id, done_at);

-- The connector's Activity tab: who, what and when.
CREATE TABLE sql_account_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL CHECK (tool IN ('stock', 'account', 'document', 'payments', 'quotation')),
  result TEXT NOT NULL CHECK (result IN ('done', 'refused', 'failed')),
  reason TEXT,
  agent_id INTEGER,
  chat_jid TEXT,
  dockey INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX idx_sql_account_activity_at ON sql_account_activity(at DESC, id DESC);
