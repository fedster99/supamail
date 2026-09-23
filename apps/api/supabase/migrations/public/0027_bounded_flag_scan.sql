-- A resumable no-MODSEQ flag sweep uses the existing folder and scheduler.
-- No new relation, role, policy, or queue. Existing folder RLS still applies.
ALTER TABLE public.imap_folders
  ADD COLUMN IF NOT EXISTS flag_scan_after_uid bigint,
  ADD COLUMN IF NOT EXISTS flag_scan_through_uid bigint,
  ADD COLUMN IF NOT EXISTS flag_scan_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS flag_scan_updated_at timestamptz;
