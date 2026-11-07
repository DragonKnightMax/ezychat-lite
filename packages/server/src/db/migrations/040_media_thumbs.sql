-- WhatsApp's small preview of an image: the chat shows it, and the real file loads only when the image is opened. The
-- bytes stay in a table of their own, so a message list never reads them; media_has_thumb says one exists.
CREATE TABLE media_thumbs (
  message_id TEXT PRIMARY KEY,
  jpeg BLOB NOT NULL
);

ALTER TABLE messages ADD COLUMN media_has_thumb INTEGER NOT NULL DEFAULT 0;
