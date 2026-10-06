-- 0032_drop_retired_window_columns.sql
--
-- Drop what ADR 0039 retired. No runtime from 0030 on reads or writes these, so
-- the release is compatible with it; a runtime that requires a migration before
-- 0030 still writes window_status and must not run on this schema (the
-- compatibility floor in migration-id.ts). Each migration runs once (ADR 0040),
-- so earlier files that create these objects do not run again.

-- The lane-predicated body indexes were only as correct as the stored lane.
DROP INDEX IF EXISTS public.imap_messages_body_backlog_idx;
DROP INDEX IF EXISTS public.imap_messages_live_body_progress_idx;

ALTER TABLE public.imap_messages DROP COLUMN IF EXISTS window_status;
ALTER TABLE public.imap_folders DROP COLUMN IF EXISTS last_archive_refresh_at;
ALTER TABLE public.imap_accounts
  DROP COLUMN IF EXISTS archive_refresh_interval,
  DROP COLUMN IF EXISTS archive_flag_sync;

-- Nothing writes MOVED_OUT since 0030 made body-lane tombstones recoverable
-- RECONCILE_MISSING. Convert any row left, then retire the value. NOT VALID plus
-- VALIDATE checks existing rows without blocking writes for the scan.
UPDATE public.imap_messages
SET deleted_reason = 'RECONCILE_MISSING'
WHERE deleted_reason = 'MOVED_OUT';

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
ALTER TABLE public.imap_messages VALIDATE CONSTRAINT imap_messages_deleted_reason_check;
