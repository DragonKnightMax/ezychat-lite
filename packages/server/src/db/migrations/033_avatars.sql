-- WhatsApp profile photos kept by the server (docs/superpowers/specs/2026-11-04-pwa-cache-design.md).
-- One row per photo key: a chat key, or `m:<group member identity>` for a group member. The bytes live in
-- `<data>/avatars/<sha256 of key>.jpg`; `hash` is a short sha256 of those bytes (NULL when no photo).
-- A cache only: no foreign key to chats, nothing else reads it, and a missing row means "not looked up".
CREATE TABLE avatars (
  key TEXT PRIMARY KEY,
  has_photo INTEGER NOT NULL CHECK (has_photo IN (0, 1)),
  hash TEXT,
  fetched_at INTEGER NOT NULL
);
