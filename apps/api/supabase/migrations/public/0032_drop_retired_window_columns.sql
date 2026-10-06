-- 0032_drop_retired_window_columns.sql
--
-- Drop what ADR 0039 retired. No runtime from 0030 on reads or writes these. A
-- runtime that requires a migration before 0030 still writes window_status, and
-- its own readiness check would accept this schema, so every host must run core
-- 0030 or later before it applies this migration (a reviewed removal: ADR 0040).
-- Each migration runs once, so the earlier files that create these objects do
-- not run again.
--
-- Order keeps the table scan outside the exclusive lock: the UPDATE takes row
-- locks only, then every ACCESS EXCLUSIVE step is metadata-only. lock_timeout
-- fails the migration rather than queue every reader behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Nothing writes MOVED_OUT since 0030 made body-lane tombstones recoverable
-- RECONCILE_MISSING; a runtime from before 0030 could have, so convert any row.
UPDATE public.imap_messages
SET deleted_reason = 'RECONCILE_MISSING'
WHERE deleted_reason = 'MOVED_OUT';

-- Retire the value. NOT VALID skips a second scan under the exclusive lock; the
-- UPDATE above already cleaned existing rows, and new rows are checked.
ALTER TABLE public.imap_messages DROP CONSTRAINT IF EXISTS imap_messages_deleted_reason_check;
ALTER TABLE public.imap_messages
  ADD CONSTRAINT imap_messages_deleted_reason_check CHECK (
    deleted_reason IS NULL OR deleted_reason IN (
      'PROVIDER_DELETED',
      'FOLDER_MISSING',
      'UIDVALIDITY_RESET',
      'RECONCILE_MISSING'
    )
  ) NOT VALID;

-- The lane-predicated body indexes were only as correct as the stored lane.
DROP INDEX IF EXISTS public.imap_messages_body_backlog_idx;
DROP INDEX IF EXISTS public.imap_messages_live_body_progress_idx;

ALTER TABLE public.imap_messages DROP COLUMN IF EXISTS window_status;
ALTER TABLE public.imap_folders DROP COLUMN IF EXISTS last_archive_refresh_at;
ALTER TABLE public.imap_accounts
  DROP COLUMN IF EXISTS archive_refresh_interval,
  DROP COLUMN IF EXISTS archive_flag_sync;
