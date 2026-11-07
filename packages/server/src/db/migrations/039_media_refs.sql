-- Imported media is downloaded on demand. media_refs keeps what the WhatsApp adapter needs for that download (an opaque
-- string), so it still works after a restart; the row goes when the file is stored or the message is deleted. It is a
-- table of its own so that a message row, which every list reads, never carries it.
CREATE TABLE media_refs (
  message_id TEXT PRIMARY KEY,
  ref TEXT NOT NULL
);

-- The image's size as WhatsApp reports it: the chat keeps the right space before the file arrives. NULL = not known.
ALTER TABLE messages ADD COLUMN media_width INTEGER;
ALTER TABLE messages ADD COLUMN media_height INTEGER;
