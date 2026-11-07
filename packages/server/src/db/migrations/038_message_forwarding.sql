-- Forward a message (docs/features/forward-message/design.md, "Data"). forwarding_score: WhatsApp's
-- forwarding score of an inbound forwarded message, or of a copy we forwarded (the source's + 1); NULL =
-- not forwarded. media_size: bytes of the stored file, written when a file is stored (upload, download,
-- forward); NULL = not known yet. Nullable, no backfill.
ALTER TABLE messages ADD COLUMN forwarding_score INTEGER;
ALTER TABLE messages ADD COLUMN media_size INTEGER;
