-- 0025_qresync_cursor.sql
--
-- Keep the deletion-complete QRESYNC cursor separate from the flag-only
-- CONDSTORE cursor. A flag scan may advance without an exact UID reconcile;
-- using that cursor for QRESYNC could skip VANISHED history permanently.

ALTER TABLE public.imap_folders
  ADD COLUMN IF NOT EXISTS qresync_highest_modseq numeric;
