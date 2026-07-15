-- 0018_threading_body_fallback_index.sql
--
-- raw_mime_sha256 is the preferred exact delivery identity. The parsed digest
-- is only a fallback for historical parsed-only rows that lack that evidence;
-- indexing every otherwise-complete body with a NULL parsed digest keeps
-- current rows in the repair index forever and makes the preflight do work that
-- cannot affect an assignment.

CREATE INDEX IF NOT EXISTS imap_message_bodies_thread_digest_fallback_idx
  ON public.imap_message_bodies (message_id)
  WHERE NOT raw_truncated
    AND raw_mime_sha256 IS NULL
    AND (
      raw_mime IS NOT NULL
      OR (
        parsed_delivery_sha256 IS NULL
        AND raw_bytes > 0
        AND headers_json ? 'message-id'
        AND headers_json ? 'from'
        AND coalesce(body_text, body_plain, selected_text_part, body_html) IS NOT NULL
      )
    );

DROP INDEX IF EXISTS public.imap_message_bodies_thread_digest_backfill_idx;
