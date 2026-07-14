-- 0015_threading_production_hardening.sql
--
-- Add stable build cursors and a high-precision parsed-body delivery digest.
-- Existing rows are repaired by the bounded threading worker, never by this
-- migration transaction.

ALTER TABLE public.imap_thread_runs
  ADD COLUMN IF NOT EXISTS cursor_message_id uuid;

ALTER TABLE public.imap_message_bodies
  ADD COLUMN IF NOT EXISTS parsed_delivery_sha256 text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.imap_message_bodies'::regclass
      AND conname = 'imap_message_bodies_parsed_delivery_sha256_check'
  ) THEN
    ALTER TABLE public.imap_message_bodies
      ADD CONSTRAINT imap_message_bodies_parsed_delivery_sha256_check
      CHECK (
        parsed_delivery_sha256 IS NULL
        OR (
          parsed_delivery_sha256 ~ '^[0-9a-f]{64}$'
          AND NOT raw_truncated
        )
      ) NOT VALID;
  END IF;
END
$$;

-- The 0014 trigger deliberately ignores body columns other than the raw MIME
-- digest and recovered headers. This focused companion handles the new parsed
-- delivery digest without rewriting the already-published 0014 migration.
CREATE OR REPLACE FUNCTION public.imap_thread_capture_parsed_delivery_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  scoped_account uuid;
  run_ids uuid[];
BEGIN
  IF OLD.parsed_delivery_sha256 IS NOT DISTINCT FROM NEW.parsed_delivery_sha256 THEN
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
         'parsed_delivery_evidence_changed', 0, now(), NULL, now(), now()
  FROM unnest(coalesce(run_ids, '{}'::uuid[])) AS run_id
  ON CONFLICT (run_id, message_id) DO UPDATE SET
    reason = EXCLUDED.reason, attempts = 0, available_at = now(),
    last_error = NULL, enqueued_at = now(), updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS imap_message_bodies_capture_parsed_delivery ON public.imap_message_bodies;
CREATE TRIGGER imap_message_bodies_capture_parsed_delivery
  AFTER UPDATE OF parsed_delivery_sha256 ON public.imap_message_bodies
  FOR EACH ROW
  EXECUTE FUNCTION public.imap_thread_capture_parsed_delivery_change();

REVOKE ALL ON FUNCTION public.imap_thread_capture_parsed_delivery_change() FROM PUBLIC;
