-- Limited chat access (docs/features/partner-role/design.md, "limited chat access"). An agent whose
-- chat_scope is 'chosen' opens only the chats in member_chats (any inbox); 'all' (every existing user)
-- keeps today's inbox access. "Chosen" with no rows means no chats, never all. Chat keys carry no
-- foreign key (user data never cascades with a chat); chats/merge.ts moves them.
ALTER TABLE users ADD COLUMN chat_scope TEXT NOT NULL DEFAULT 'all' CHECK (chat_scope IN ('all', 'chosen'));

CREATE TABLE member_chats (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_jid)
);
CREATE INDEX idx_member_chats_chat ON member_chats(chat_jid);
