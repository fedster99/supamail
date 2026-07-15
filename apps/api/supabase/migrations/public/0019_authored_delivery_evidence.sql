-- 0019_authored_delivery_evidence.sql
--
-- A mailbox provider commonly prepends Received/authentication headers to the
-- Inbox copy of a self-sent message, so exact wire and full parsed-representation
-- hashes can both differ from the Sent copy. Keep a third, transport-invariant
-- digest over the complete authored MIME representation. It is populated only
-- for an observed strict-Message-ID collision, never as a migration backfill.

ALTER TABLE public.imap_message_bodies
  ADD COLUMN IF NOT EXISTS authored_delivery_sha256 text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.imap_message_bodies'::regclass
      AND conname = 'imap_message_bodies_authored_delivery_sha256_check'
  ) THEN
    ALTER TABLE public.imap_message_bodies
      ADD CONSTRAINT imap_message_bodies_authored_delivery_sha256_check
      CHECK (
        authored_delivery_sha256 IS NULL
        OR (
          authored_delivery_sha256 ~ '^[0-9a-f]{64}$'
          AND NOT raw_truncated
          AND structured_evidence_complete
          AND structured_evidence_sha256 IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END
$$;

-- Both delivery digests are projections of mutable body evidence. Clear them
-- in the database before a refetch/update can make either value stale. The
-- existing parsed/authored change triggers then queue every live run.
CREATE OR REPLACE FUNCTION public.imap_thread_invalidate_delivery_digests_from_body()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF ROW(
    OLD.raw_mime, OLD.raw_bytes, OLD.raw_truncated,
    OLD.body_text, OLD.body_html, OLD.body_plain,
    OLD.selected_text_part, OLD.selected_text_format,
    OLD.headers_json, OLD.mime_structure, OLD.parser_warnings,
    OLD.structured_evidence_sha256, OLD.structured_evidence_complete
  ) IS DISTINCT FROM ROW(
    NEW.raw_mime, NEW.raw_bytes, NEW.raw_truncated,
    NEW.body_text, NEW.body_html, NEW.body_plain,
    NEW.selected_text_part, NEW.selected_text_format,
    NEW.headers_json, NEW.mime_structure, NEW.parser_warnings,
    NEW.structured_evidence_sha256, NEW.structured_evidence_complete
  ) THEN
    NEW.parsed_delivery_sha256 := NULL;
    NEW.authored_delivery_sha256 := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS imap_message_bodies_invalidate_delivery_digests ON public.imap_message_bodies;
CREATE TRIGGER imap_message_bodies_invalidate_delivery_digests
  BEFORE UPDATE OF
    raw_mime, raw_bytes, raw_truncated,
    body_text, body_html, body_plain,
    selected_text_part, selected_text_format,
    headers_json, mime_structure, parser_warnings,
    structured_evidence_sha256, structured_evidence_complete
  ON public.imap_message_bodies
  FOR EACH ROW
  EXECUTE FUNCTION public.imap_thread_invalidate_delivery_digests_from_body();

REVOKE ALL ON FUNCTION public.imap_thread_invalidate_delivery_digests_from_body() FROM PUBLIC;

-- Parsed and authored delivery digests also include the stable envelope fields
-- stored on imap_messages. Provider metadata refreshes may correct those fields,
-- so invalidate both projections rather than retaining a false exact match.
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

DROP TRIGGER IF EXISTS imap_messages_invalidate_delivery_digests ON public.imap_messages;
CREATE TRIGGER imap_messages_invalidate_delivery_digests
  AFTER UPDATE OF size_bytes, subject, from_email, to_emails, cc_emails, bcc_emails
  ON public.imap_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.imap_thread_invalidate_delivery_digests_from_message();

REVOKE ALL ON FUNCTION public.imap_thread_invalidate_delivery_digests_from_message() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.imap_thread_capture_authored_delivery_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  scoped_account uuid;
  run_ids uuid[];
BEGIN
  IF OLD.authored_delivery_sha256 IS NOT DISTINCT FROM NEW.authored_delivery_sha256 THEN
    RETURN NEW;
  END IF;

  SELECT message.account_id INTO scoped_account
  FROM public.imap_messages message
  WHERE message.id = NEW.message_id;
  IF scoped_account IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.imap_thread_state (account_id)
  VALUES (scoped_account)
  ON CONFLICT (account_id) DO NOTHING;
  INSERT INTO public.imap_thread_evidence_clock (account_id)
  VALUES (scoped_account)
  ON CONFLICT (account_id) DO NOTHING;

  SELECT array_remove(
    ARRAY[state.active_run_id, state.previous_run_id, state.building_run_id]::uuid[],
    NULL
  )
  INTO run_ids
  FROM public.imap_thread_state state
  WHERE state.account_id = scoped_account
  FOR SHARE;

  UPDATE public.imap_thread_evidence_clock
  SET revision = revision + 1
  WHERE account_id = scoped_account;

  INSERT INTO public.imap_thread_work_queue (
    run_id, message_id, account_id, reason, attempts, available_at,
    last_error, enqueued_at, updated_at
  )
  SELECT run_id, NEW.message_id, scoped_account,
         'authored_delivery_evidence_changed', 0, now(), NULL, now(), now()
  FROM unnest(coalesce(run_ids, '{}'::uuid[])) AS run_id
  ON CONFLICT (run_id, message_id) DO UPDATE SET
    reason = EXCLUDED.reason, attempts = 0, available_at = now(),
    last_error = NULL, enqueued_at = now(), updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS imap_message_bodies_capture_authored_delivery ON public.imap_message_bodies;
CREATE TRIGGER imap_message_bodies_capture_authored_delivery
  AFTER UPDATE ON public.imap_message_bodies
  FOR EACH ROW
  WHEN (OLD.authored_delivery_sha256 IS DISTINCT FROM NEW.authored_delivery_sha256)
  EXECUTE FUNCTION public.imap_thread_capture_authored_delivery_change();

-- 0015 used UPDATE OF, which does not observe a digest cleared by a BEFORE
-- trigger. Recreate it with a row predicate so source invalidation is durable.
DROP TRIGGER IF EXISTS imap_message_bodies_capture_parsed_delivery ON public.imap_message_bodies;
CREATE TRIGGER imap_message_bodies_capture_parsed_delivery
  AFTER UPDATE ON public.imap_message_bodies
  FOR EACH ROW
  WHEN (OLD.parsed_delivery_sha256 IS DISTINCT FROM NEW.parsed_delivery_sha256)
  EXECUTE FUNCTION public.imap_thread_capture_parsed_delivery_change();

REVOKE ALL ON FUNCTION public.imap_thread_capture_authored_delivery_change() FROM PUBLIC;
