-- Edited and deleted messages (docs/features/message-edit-delete/design.md). Adds only; nothing
-- existing moves. A deleted message keeps its row and text (admins can read the original); the
-- API returns it without body or media. deleted_by: 'sender' (the customer or group member who
-- wrote it), 'group_admin', 'team' (deleted_by_user_id) or 'phone' (the linked phone).
-- hidden_at: "Delete for me", hidden for the whole team.
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_by TEXT
  CHECK (deleted_by IS NULL OR deleted_by IN ('sender', 'group_admin', 'team', 'phone'));
ALTER TABLE messages ADD COLUMN deleted_by_user_id INTEGER;
ALTER TABLE messages ADD COLUMN hidden_at INTEGER;
ALTER TABLE messages ADD COLUMN hidden_by_user_id INTEGER;

-- Earlier versions of an edited message, oldest first. message_id is the stored message key and has
-- no foreign key (like reactions): a message never cascades away.
CREATE TABLE message_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  previous_body TEXT,
  edited_at INTEGER NOT NULL,
  edited_by TEXT NOT NULL CHECK (edited_by IN ('sender', 'team', 'phone')),
  user_id INTEGER
);
CREATE INDEX idx_message_edits_message ON message_edits(message_id, id);

-- An edit or delete WhatsApp delivered before its message was stored (history order): applied when
-- the message arrives, only if it is in the same chat (chat_jid: the chat key the change routed to).
-- One row per message and kind (the newest edit wins).
CREATE TABLE message_changes_pending (
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'delete')),
  chat_jid TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  sender_jid TEXT,
  body TEXT,
  changed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind)
) WITHOUT ROWID;
