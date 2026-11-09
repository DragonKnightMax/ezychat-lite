-- Which inbox blocked the number: WhatsApp blocks per WhatsApp number, so a block made on one inbox must not silence
-- the AI or show "blocked" in the same customer's chat on another inbox. NULL: blocked before this column existed (or
-- imported), and it counts for every inbox as before.
ALTER TABLE safety_numbers ADD COLUMN blocked_inbox_id INTEGER;
