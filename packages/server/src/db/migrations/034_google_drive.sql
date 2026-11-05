-- Google Drive connector (docs/features/google-drive/design.md). The Google sign-in itself lives in
-- encrypted settings; these tables hold what each AI agent may reach and what it did. Chat keys carry
-- no foreign key (user data never cascades with a chat); chats/merge.ts moves them.

-- Folder, switches and picked files per AI agent (JSON of DriveAgentSettings).
CREATE TABLE drive_agent_settings (
  agent_id INTEGER PRIMARY KEY REFERENCES ai_agents(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Files the AI saved: a message's file goes into one folder once (the duplicate guard).
CREATE TABLE drive_saved_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  chat_jid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_drive_saved_message ON drive_saved_files(message_id, folder_id);
CREATE INDEX idx_drive_saved_chat ON drive_saved_files(chat_jid);

-- Sub-folders EzyChat created (by parent and name), so it finds them again without a search.
CREATE TABLE drive_folders (
  parent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (parent_id, name)
);

-- The connector's Activity tab: who and when, never file names or contents.
CREATE TABLE drive_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('saved', 'read', 'skipped', 'failed')),
  agent_id INTEGER,
  chat_jid TEXT,
  at INTEGER NOT NULL,
  group_name TEXT,
  reason TEXT
);
CREATE INDEX idx_drive_activity_at ON drive_activity(at DESC, id DESC);
