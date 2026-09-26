-- 0027_folder_unchanged_proof.sql
--
-- Record when a scheduled sync proved that a folder did not change on the
-- provider: its UIDVALIDITY, UIDNEXT, and HIGHESTMODSEQ still equal the stored
-- deletion-complete QRESYNC cursor. Health may count this proof as current for
-- non-priority folders. It never replaces last_synced_at,
-- last_full_reconcile_at, or the due-based schedule of the exact audit.

ALTER TABLE public.imap_folders
  ADD COLUMN IF NOT EXISTS last_verified_unchanged_at timestamptz;
