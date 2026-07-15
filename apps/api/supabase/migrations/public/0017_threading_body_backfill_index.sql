-- 0017_threading_body_backfill_index.sql
--
-- Initial conversation builds repair exact delivery fingerprints written by
-- binaries that predate those columns. Once the backlog is sparse, walking the
-- whole body primary key to find the next repair can exceed the worker's
-- statement timeout. Keep only repair-eligible rows in a small ordered index;
-- repaired rows leave the index automatically.

CREATE INDEX IF NOT EXISTS imap_message_bodies_thread_digest_backfill_idx
  ON public.imap_message_bodies (message_id)
  WHERE NOT raw_truncated
    AND (
      (raw_mime_sha256 IS NULL AND raw_mime IS NOT NULL)
      OR (
        parsed_delivery_sha256 IS NULL
        AND raw_bytes > 0
        AND headers_json ? 'message-id'
        AND headers_json ? 'from'
        AND coalesce(body_text, body_plain, selected_text_part, body_html) IS NOT NULL
      )
    );
