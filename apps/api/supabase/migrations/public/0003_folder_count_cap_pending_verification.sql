ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS folder_count_cap_override integer
    CHECK (folder_count_cap_override IS NULL OR folder_count_cap_override > 0);

ALTER TABLE public.imap_folders
  DROP CONSTRAINT IF EXISTS imap_folders_status_check;

ALTER TABLE public.imap_folders
  ADD CONSTRAINT imap_folders_status_check
  CHECK (status IN ('PENDING', 'SYNCING', 'ACTIVE', 'NEEDS_FULL_RESYNC', 'MISSING', 'PENDING_VERIFICATION'));
