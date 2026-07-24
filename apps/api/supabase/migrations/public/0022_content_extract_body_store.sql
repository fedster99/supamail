-- 0022_content_extract_body_store.sql
--
-- Separate searchable/threading evidence from the full body payload. New sync
-- writes commit this bounded extract and the existing delivery digests before a
-- pluggable body store receives parsed text, HTML, or retained raw MIME.

CREATE OR REPLACE FUNCTION public.imap_bounded_search_extract(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  low_chars integer := 0;
  high_chars integer := least(char_length(value), 32768);
  middle_chars integer;
BEGIN
  IF octet_length(value) <= 32768 THEN
    RETURN value;
  END IF;

  WHILE low_chars < high_chars LOOP
    middle_chars := (low_chars + high_chars + 1) / 2;
    IF octet_length(left(value, middle_chars)) <= 32768 THEN
      low_chars := middle_chars;
    ELSE
      high_chars := middle_chars - 1;
    END IF;
  END LOOP;
  RETURN left(value, low_chars);
END;
$$;

ALTER TABLE public.imap_message_bodies
  ADD COLUMN IF NOT EXISTS search_extract text,
  ADD COLUMN IF NOT EXISTS threading_payload_sha256 text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.imap_message_bodies'::regclass
      AND conname = 'imap_message_bodies_search_extract_bound_check'
  ) THEN
    ALTER TABLE public.imap_message_bodies
      ADD CONSTRAINT imap_message_bodies_search_extract_bound_check
      CHECK (search_extract IS NULL OR octet_length(search_extract) <= 32768)
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.imap_message_bodies'::regclass
      AND conname = 'imap_message_bodies_threading_payload_sha256_check'
  ) THEN
    ALTER TABLE public.imap_message_bodies
      ADD CONSTRAINT imap_message_bodies_threading_payload_sha256_check
      CHECK (
        threading_payload_sha256 IS NULL
        OR threading_payload_sha256 ~ '^[0-9a-f]{64}$'
      )
      NOT VALID;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.imap_threading_payload_sha256(
  body_text text,
  body_html text,
  body_plain text,
  selected_text_part text,
  selected_text_format text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT encode(
    extensions.digest(
      convert_to(
        (CASE WHEN body_text IS NULL THEN '-:' ELSE octet_length(body_text)::text || ':' || body_text END) ||
        (CASE WHEN body_html IS NULL THEN '-:' ELSE octet_length(body_html)::text || ':' || body_html END) ||
        (CASE WHEN body_plain IS NULL THEN '-:' ELSE octet_length(body_plain)::text || ':' || body_plain END) ||
        (CASE WHEN selected_text_part IS NULL THEN '-:' ELSE octet_length(selected_text_part)::text || ':' || selected_text_part END) ||
        (CASE WHEN selected_text_format IS NULL THEN '-:' ELSE octet_length(selected_text_format)::text || ':' || selected_text_format END),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

REVOKE ALL ON FUNCTION public.imap_threading_payload_sha256(
  text, text, text, text, text
) FROM PUBLIC;

-- Existing mirrors become searchable through the new seam without a re-sync.
-- body_text is already the selected normalized plain text (plain MIME preferred,
-- otherwise HTML stripped); body_plain is retained only for old rows.
UPDATE public.imap_message_bodies
SET search_extract = public.imap_bounded_search_extract(
  coalesce(body_text, body_plain)
)
WHERE search_extract IS NULL
  AND coalesce(body_text, body_plain) IS NOT NULL;

-- Preserve a payload-independent threading token before body bytes can move.
-- This one-time additive backfill lets upgraded mirrors keep their existing
-- delivery-corroboration behavior without re-fetching messages.
UPDATE public.imap_message_bodies
SET threading_payload_sha256 = public.imap_threading_payload_sha256(
  body_text,
  body_html,
  body_plain,
  selected_text_part,
  selected_text_format
)
WHERE threading_payload_sha256 IS NULL
  AND coalesce(body_text, body_plain, selected_text_part, body_html) IS NOT NULL;

CREATE OR REPLACE FUNCTION public.imap_search_extract_fts(value text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT setweight(
    to_tsvector('english', public.f_unaccent(coalesce(value, ''))),
    'D'
  )
$$;

CREATE INDEX IF NOT EXISTS imap_message_bodies_search_extract_fts_gin
  ON public.imap_message_bodies
  USING gin (public.imap_search_extract_fts(search_extract));

-- Since 0022, parsed/authored digests are computed from decoded MIME before the
-- payload write. Invalidate them only when their compact evidence changes; a
-- body-store write or removal must not make threading depend on payload access.
CREATE OR REPLACE FUNCTION public.imap_thread_invalidate_delivery_digests_from_body()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF ROW(
    OLD.raw_bytes, OLD.raw_truncated,
    OLD.threading_payload_sha256,
    OLD.headers_json, OLD.mime_structure, OLD.parser_warnings,
    OLD.structured_evidence_sha256, OLD.structured_evidence_complete
  ) IS DISTINCT FROM ROW(
    NEW.raw_bytes, NEW.raw_truncated,
    NEW.threading_payload_sha256,
    NEW.headers_json, NEW.mime_structure, NEW.parser_warnings,
    NEW.structured_evidence_sha256, NEW.structured_evidence_complete
  ) THEN
    IF OLD.parsed_delivery_sha256 IS NOT DISTINCT FROM NEW.parsed_delivery_sha256 THEN
      NEW.parsed_delivery_sha256 := NULL;
    END IF;
    IF OLD.authored_delivery_sha256 IS NOT DISTINCT FROM NEW.authored_delivery_sha256 THEN
      NEW.authored_delivery_sha256 := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.imap_thread_invalidate_delivery_digests_from_body() FROM PUBLIC;

-- Envelope corrections still invalidate their projections, but the bounded
-- worker can rebuild them from threading_payload_sha256 and the other compact
-- evidence columns without reading the body payload.
CREATE OR REPLACE FUNCTION public.imap_thread_invalidate_delivery_digests_from_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF ROW(
    OLD.size_bytes, OLD.subject, OLD.from_email,
    OLD.to_emails, OLD.cc_emails, OLD.bcc_emails
  ) IS NOT DISTINCT FROM ROW(
    NEW.size_bytes, NEW.subject, NEW.from_email,
    NEW.to_emails, NEW.cc_emails, NEW.bcc_emails
  ) THEN
    RETURN NEW;
  END IF;

  UPDATE public.imap_message_bodies body
  SET parsed_delivery_sha256 = NULL,
      authored_delivery_sha256 = NULL
  WHERE body.message_id = NEW.id
    AND (
      body.parsed_delivery_sha256 IS NOT NULL
      OR body.authored_delivery_sha256 IS NOT NULL
    );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.imap_thread_invalidate_delivery_digests_from_message() FROM PUBLIC;

-- Rolling-deploy compatibility: a pre-0022 writer knows only body_text. Keep
-- such writes searchable while new writers still commit search_extract first.
CREATE OR REPLACE FUNCTION public.imap_capture_search_extract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.search_extract IS NULL THEN
      NEW.search_extract := public.imap_bounded_search_extract(
        coalesce(NEW.body_text, NEW.body_plain)
      );
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(OLD.body_text, OLD.body_plain)
    IS DISTINCT FROM ROW(NEW.body_text, NEW.body_plain)
    AND NEW.search_extract IS NOT DISTINCT FROM OLD.search_extract
    AND coalesce(NEW.body_text, NEW.body_plain) IS NOT NULL
  THEN
    NEW.search_extract := public.imap_bounded_search_extract(
      coalesce(NEW.body_text, NEW.body_plain)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS imap_message_bodies_capture_search_extract
  ON public.imap_message_bodies;
CREATE TRIGGER imap_message_bodies_capture_search_extract
  BEFORE INSERT OR UPDATE OF body_text, body_plain
  ON public.imap_message_bodies
  FOR EACH ROW
  EXECUTE FUNCTION public.imap_capture_search_extract();

REVOKE ALL ON FUNCTION public.imap_capture_search_extract() FROM PUBLIC;

-- Old writers still write parsed columns directly. Derive the compact payload
-- fingerprint for them, while preserving it when an external body store later
-- removes those columns.
CREATE OR REPLACE FUNCTION public.imap_capture_threading_payload_sha256()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(
    NEW.body_text,
    NEW.body_plain,
    NEW.selected_text_part,
    NEW.body_html
  ) IS NULL THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.threading_payload_sha256 := OLD.threading_payload_sha256;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
    OR ROW(
      OLD.body_text, OLD.body_html, OLD.body_plain,
      OLD.selected_text_part, OLD.selected_text_format
    ) IS DISTINCT FROM ROW(
      NEW.body_text, NEW.body_html, NEW.body_plain,
      NEW.selected_text_part, NEW.selected_text_format
    )
  THEN
    NEW.threading_payload_sha256 := public.imap_threading_payload_sha256(
      NEW.body_text,
      NEW.body_html,
      NEW.body_plain,
      NEW.selected_text_part,
      NEW.selected_text_format
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS imap_message_bodies_capture_threading_payload_sha256
  ON public.imap_message_bodies;
CREATE TRIGGER imap_message_bodies_capture_threading_payload_sha256
  BEFORE INSERT OR UPDATE OF
    body_text, body_html, body_plain, selected_text_part, selected_text_format
  ON public.imap_message_bodies
  FOR EACH ROW
  EXECUTE FUNCTION public.imap_capture_threading_payload_sha256();

REVOKE ALL ON FUNCTION public.imap_capture_threading_payload_sha256() FROM PUBLIC;

-- An evidence row exists before the payload store succeeds. Preserve the
-- row-accurate coverage contract by also requiring the completion marker.
CREATE OR REPLACE VIEW public.imap_account_progress
WITH (security_invoker = true)
AS
WITH folder_progress AS (
  SELECT
    f.account_id,
    count(*) FILTER (WHERE f.live_window_target_count IS NOT NULL)::int AS live_window_known_folder_count,
    count(*) FILTER (WHERE f.historical_target_count IS NOT NULL)::int AS historical_known_folder_count,
    COALESCE(sum(LEAST(f.headers_synced_count, COALESCE(f.live_window_target_count, 0))), 0)::int
      AS live_headers_synced_count,
    COALESCE(sum(COALESCE(f.live_window_target_count, 0)), 0)::int AS live_headers_target_count,
    COALESCE(sum(GREATEST(f.headers_synced_count - COALESCE(f.live_window_target_count, 0), 0)), 0)::int
      AS historical_headers_synced_count,
    COALESCE(sum(COALESCE(f.historical_target_count, 0)), 0)::int AS historical_headers_target_count,
    COALESCE(sum(GREATEST(f.bodies_fetched_count - COALESCE(f.live_window_target_count, 0), 0)), 0)::int
      AS historical_bodies_fetched_count,
    COALESCE(sum(COALESCE(f.historical_target_count, 0)), 0)::int AS historical_bodies_target_count
  FROM public.imap_folders f
  WHERE f.tracked = true
    AND f.status != 'MISSING'
  GROUP BY f.account_id
),
active_body_folder_progress AS (
  SELECT
    f.account_id,
    count(*) FILTER (WHERE f.live_window_target_count IS NOT NULL)::int AS live_window_known_folder_count,
    count(*) FILTER (
      WHERE f.sync_priority <= 10
        AND f.live_window_target_count IS NOT NULL
    )::int AS priority_live_window_known_folder_count
  FROM public.imap_folders f
  WHERE f.tracked = true
    AND f.missing_since IS NULL
    AND f.status NOT IN ('MISSING', 'PENDING_VERIFICATION')
  GROUP BY f.account_id
),
current_live_body_progress AS (
  SELECT
    m.account_id,
    count(*)::int AS live_bodies_target_count,
    count(*) FILTER (
      WHERE m.body_fetched_at IS NOT NULL
        AND b.message_id IS NOT NULL
        AND NOT b.raw_truncated
    )::int AS live_bodies_fetched_count,
    count(*) FILTER (
      WHERE f.sync_priority <= 10
    )::int AS priority_bodies_target_count,
    count(*) FILTER (
      WHERE f.sync_priority <= 10
        AND m.body_fetched_at IS NOT NULL
        AND b.message_id IS NOT NULL
        AND NOT b.raw_truncated
    )::int AS priority_bodies_fetched_count
  FROM public.imap_messages m
  JOIN public.imap_folders f
    ON f.account_id = m.account_id
   AND f.path = m.folder_path
  LEFT JOIN public.imap_message_bodies b
    ON b.message_id = m.id
  WHERE f.tracked = true
    AND f.missing_since IS NULL
    AND f.status NOT IN ('MISSING', 'PENDING_VERIFICATION')
    AND m.deleted_in_provider = false
    AND m.window_status = 'IN_WINDOW'
  GROUP BY m.account_id
)
SELECT
  a.id AS account_id,
  COALESCE(p.live_headers_synced_count, 0) AS live_headers_synced_count,
  COALESCE(p.live_headers_target_count, 0) AS live_headers_target_count,
  CASE
    WHEN COALESCE(p.live_headers_target_count, 0) > 0
      THEN LEAST(100, round((p.live_headers_synced_count::numeric / p.live_headers_target_count::numeric) * 100)::int)
    WHEN COALESCE(p.live_window_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS live_headers_complete_pct,
  COALESCE(b.priority_bodies_fetched_count, 0) AS priority_bodies_fetched_count,
  COALESCE(b.priority_bodies_target_count, 0) AS priority_bodies_target_count,
  CASE
    WHEN COALESCE(b.priority_bodies_target_count, 0) > 0
      THEN LEAST(100, round((b.priority_bodies_fetched_count::numeric / b.priority_bodies_target_count::numeric) * 100)::int)
    WHEN COALESCE(ab.priority_live_window_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS priority_bodies_complete_pct,
  COALESCE(b.live_bodies_fetched_count, 0) AS live_bodies_fetched_count,
  COALESCE(b.live_bodies_target_count, 0) AS live_bodies_target_count,
  CASE
    WHEN COALESCE(b.live_bodies_target_count, 0) > 0
      THEN LEAST(100, round((b.live_bodies_fetched_count::numeric / b.live_bodies_target_count::numeric) * 100)::int)
    WHEN COALESCE(ab.live_window_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS live_bodies_complete_pct,
  COALESCE(p.historical_headers_synced_count, 0) AS historical_headers_synced_count,
  COALESCE(p.historical_headers_target_count, 0) AS historical_headers_target_count,
  CASE
    WHEN COALESCE(p.historical_headers_target_count, 0) > 0
      THEN LEAST(100, round((p.historical_headers_synced_count::numeric / p.historical_headers_target_count::numeric) * 100)::int)
    WHEN COALESCE(p.historical_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS historical_headers_complete_pct,
  COALESCE(p.historical_bodies_fetched_count, 0) AS historical_bodies_fetched_count,
  COALESCE(p.historical_bodies_target_count, 0) AS historical_bodies_target_count,
  CASE
    WHEN COALESCE(p.historical_bodies_target_count, 0) > 0
      THEN LEAST(100, round((p.historical_bodies_fetched_count::numeric / p.historical_bodies_target_count::numeric) * 100)::int)
    WHEN COALESCE(p.historical_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS historical_bodies_complete_pct,
  NULL::timestamptz AS estimated_full_sync_at
FROM public.imap_accounts a
LEFT JOIN folder_progress p ON p.account_id = a.id
LEFT JOIN active_body_folder_progress ab ON ab.account_id = a.id
LEFT JOIN current_live_body_progress b ON b.account_id = a.id;
