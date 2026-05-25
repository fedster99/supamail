ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS live_window_days int NOT NULL DEFAULT 90
    CHECK (live_window_days IN (30, 90, 180)),
  ADD COLUMN IF NOT EXISTS historical_backfill_mode text NOT NULL DEFAULT 'metadata_and_bodies'
    CHECK (historical_backfill_mode IN ('off', 'metadata_only', 'metadata_and_bodies')),
  ADD COLUMN IF NOT EXISTS archive_refresh_interval text NOT NULL DEFAULT 'monthly'
    CHECK (archive_refresh_interval IN ('never', 'monthly', 'weekly')),
  ADD COLUMN IF NOT EXISTS archive_flag_sync boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_backfill_rate text NOT NULL DEFAULT 'normal'
    CHECK (max_backfill_rate IN ('small', 'normal', 'aggressive'));
