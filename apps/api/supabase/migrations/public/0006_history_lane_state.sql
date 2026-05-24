ALTER TABLE public.imap_folders
  ADD COLUMN IF NOT EXISTS last_archive_refresh_at timestamptz;
