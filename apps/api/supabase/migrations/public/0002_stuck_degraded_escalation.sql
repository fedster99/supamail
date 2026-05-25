ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS last_priority_sync_succeeded_at timestamptz;
