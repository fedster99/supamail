-- BODY_STORAGE_MODE=parsed_only stores parsed body content without retaining the
-- original RFC822/MIME blob, so raw_mime must accept NULL for those rows.
ALTER TABLE public.imap_message_bodies
  ALTER COLUMN raw_mime DROP NOT NULL;
