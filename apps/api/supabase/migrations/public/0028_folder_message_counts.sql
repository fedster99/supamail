-- 0028_folder_message_counts.sql
--
-- Keep each folder's live message and unread counts in one row, so a folder
-- listing reads one row per folder instead of counting imap_messages. A live
-- message is not deleted in the provider; unread lacks the IMAP \Seen flag.
-- Statement triggers apply each write's net change per folder inside the
-- writer's transaction, so the counts stay exact for every writer. The counts
-- live apart from imap_folders so their row locks never meet the folder-row
-- locks sync takes before it writes messages.

-- Each live row after a statement adds one to its folder and each live row
-- before it subtracts one. Only folders whose counts change are written, in key
-- order, so statements that touch several folders cannot deadlock each other.
-- A statement trigger with transition tables names one event, so inserts and
-- deletes pass their direction and updates net their old and new rows. An
-- account deleted by the same statement is skipped; its counts cascade away.
CREATE OR REPLACE FUNCTION public.imap_folder_message_counts_apply()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  delta_account_ids uuid[];
  delta_paths text[];
  delta_messages int[];
  delta_unread int[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(account_id), array_agg(folder_path), array_agg(messages), array_agg(unread)
    INTO delta_account_ids, delta_paths, delta_messages, delta_unread
    FROM (
      SELECT account_id, folder_path, sum(messages)::int AS messages, sum(unread)::int AS unread
      FROM (
        SELECT account_id, folder_path, 1 AS messages,
               (NOT (coalesce(flags, '{}'::text[]) @> ARRAY['\Seen']::text[]))::int AS unread
        FROM new_rows
        WHERE deleted_in_provider = false
        UNION ALL
        SELECT account_id, folder_path, -1,
               -(NOT (coalesce(flags, '{}'::text[]) @> ARRAY['\Seen']::text[]))::int
        FROM old_rows
        WHERE deleted_in_provider = false
      ) changed
      GROUP BY account_id, folder_path
    ) delta
    WHERE messages <> 0 OR unread <> 0;
  ELSE
    SELECT array_agg(account_id), array_agg(folder_path), array_agg(messages), array_agg(unread)
    INTO delta_account_ids, delta_paths, delta_messages, delta_unread
    FROM (
      SELECT account_id, folder_path,
             TG_ARGV[0]::int * count(*)::int AS messages,
             TG_ARGV[0]::int * count(*) FILTER (
               WHERE NOT (coalesce(flags, '{}'::text[]) @> ARRAY['\Seen']::text[])
             )::int AS unread
      FROM changed_rows
      WHERE deleted_in_provider = false
      GROUP BY account_id, folder_path
    ) delta;
  END IF;

  -- A statement that changes no count writes nothing.
  IF delta_account_ids IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.imap_folder_message_counts AS counts (
    account_id, folder_path, message_count, unread_count
  )
  SELECT delta.account_id, delta.folder_path, delta.messages, delta.unread
  FROM unnest(delta_account_ids, delta_paths, delta_messages, delta_unread)
    AS delta(account_id, folder_path, messages, unread)
  JOIN public.imap_accounts account ON account.id = delta.account_id
  ORDER BY delta.account_id, delta.folder_path
  ON CONFLICT (account_id, folder_path) DO UPDATE
  SET message_count = counts.message_count + EXCLUDED.message_count,
      unread_count = counts.unread_count + EXCLUDED.unread_count;
  RETURN NULL;
END;
$$;

-- One statement, so the table, its one-time backfill, its triggers, and its
-- privileges commit together under any migration runner.
DO $$
BEGIN
  IF to_regclass('public.imap_folder_message_counts') IS NULL THEN
    CREATE TABLE public.imap_folder_message_counts (
      account_id uuid NOT NULL REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
      folder_path text NOT NULL,
      message_count integer NOT NULL DEFAULT 0,
      unread_count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, folder_path)
    );

    -- Block message writes until the triggers below commit with the backfill,
    -- so no write lands between the count and the first counted change.
    LOCK TABLE public.imap_messages IN SHARE MODE;

    INSERT INTO public.imap_folder_message_counts (
      account_id, folder_path, message_count, unread_count
    )
    SELECT
      account_id,
      folder_path,
      count(*)::int,
      count(*) FILTER (
        WHERE NOT (coalesce(flags, '{}'::text[]) @> ARRAY['\Seen']::text[])
      )::int
    FROM public.imap_messages
    WHERE deleted_in_provider = false
    GROUP BY account_id, folder_path;
  END IF;

  DROP TRIGGER IF EXISTS imap_messages_count_inserts ON public.imap_messages;
  CREATE TRIGGER imap_messages_count_inserts
    AFTER INSERT ON public.imap_messages
    REFERENCING NEW TABLE AS changed_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.imap_folder_message_counts_apply('1');

  DROP TRIGGER IF EXISTS imap_messages_count_updates ON public.imap_messages;
  CREATE TRIGGER imap_messages_count_updates
    AFTER UPDATE ON public.imap_messages
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.imap_folder_message_counts_apply();

  DROP TRIGGER IF EXISTS imap_messages_count_deletes ON public.imap_messages;
  CREATE TRIGGER imap_messages_count_deletes
    AFTER DELETE ON public.imap_messages
    REFERENCING OLD TABLE AS changed_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.imap_folder_message_counts_apply('-1');

  ALTER TABLE public.imap_folder_message_counts ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.imap_folder_message_counts FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.imap_folder_message_counts_apply() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.imap_folder_message_counts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.imap_folder_message_counts FROM authenticated;
  END IF;
END $$;
