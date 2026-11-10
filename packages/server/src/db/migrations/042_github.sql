-- GitHub connector (docs/features/github/design.md). The sign-in itself lives in the encrypted
-- setting github_auth; these tables hold what each AI agent may reach and what it did. Chat keys
-- carry no foreign key (user data never cascades with a chat); chats/merge.ts moves them.

-- Repositories and switches per AI agent (JSON of GitHubAgentSettings).
CREATE TABLE github_agent_settings (
  agent_id INTEGER PRIMARY KEY REFERENCES ai_agents(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The connector's Activity tab: who and when, never repository names, queries, titles or text.
CREATE TABLE github_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('searched', 'read', 'refused', 'failed')),
  agent_id INTEGER,
  chat_jid TEXT,
  at INTEGER NOT NULL,
  group_name TEXT
);
CREATE INDEX idx_github_activity_at ON github_activity(at DESC, id DESC);
CREATE INDEX idx_github_activity_chat ON github_activity(chat_jid);
