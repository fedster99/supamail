-- 0035_message_change_outbox.sql
--
-- A durable feed of changes to existing mirror messages. A statement trigger
-- records one row per updated message that is still live (not deleted in the
-- provider), in the writer's transaction, whoever the writer is: sync, a flag
-- or move written through by an API or MCP action, or a host. A consumer reads
-- the rows and deletes the ones it handled, so it never needs an index on
-- imap_messages.updated_at, and message updates can stay heap-only (HOT).
-- New messages are not recorded here; consumers find them by (created_at, id).
--
-- The trigger function is SECURITY DEFINER, like the threading evidence
-- outbox: a writer needs no rights on this table, so the migration needs no
-- grant change and no pause. Rows nobody claims are pruned by retention.

CREATE OR REPLACE FUNCTION public.imap_message_changes_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.imap_message_changes (account_id, message_id)
  SELECT account_id, id
  FROM changed_rows
  WHERE deleted_in_provider = false;
  RETURN NULL;
END;
$$;

-- One statement, so the table, its trigger, and its privileges commit together
-- under any migration runner.
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS public.imap_message_changes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
    message_id uuid NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
  );

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.imap_messages'::regclass
      AND tgname = 'imap_messages_capture_changes'
  ) THEN
    CREATE TRIGGER imap_messages_capture_changes
      AFTER UPDATE ON public.imap_messages
      REFERENCING NEW TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.imap_message_changes_capture();
  END IF;

  ALTER TABLE public.imap_message_changes ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.imap_message_changes FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.imap_message_changes_capture() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.imap_message_changes FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.imap_message_changes FROM authenticated;
  END IF;
END $$;
