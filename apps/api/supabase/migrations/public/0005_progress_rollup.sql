DO $$
DECLARE
  added_progress_columns boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'imap_folders'
      AND column_name = 'headers_synced_count'
  ) THEN
    ALTER TABLE public.imap_folders
      ADD COLUMN headers_synced_count int NOT NULL DEFAULT 0
        CHECK (headers_synced_count >= 0);
    added_progress_columns := true;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'imap_folders'
      AND column_name = 'bodies_fetched_count'
  ) THEN
    ALTER TABLE public.imap_folders
      ADD COLUMN bodies_fetched_count int NOT NULL DEFAULT 0
        CHECK (bodies_fetched_count >= 0);
    added_progress_columns := true;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'imap_folders'
      AND column_name = 'live_window_target_count'
  ) THEN
    ALTER TABLE public.imap_folders
      ADD COLUMN live_window_target_count int
        CHECK (live_window_target_count IS NULL OR live_window_target_count >= 0);
    added_progress_columns := true;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'imap_folders'
      AND column_name = 'historical_target_count'
  ) THEN
    ALTER TABLE public.imap_folders
      ADD COLUMN historical_target_count int
        CHECK (historical_target_count IS NULL OR historical_target_count >= 0);
    added_progress_columns := true;
  END IF;

  IF added_progress_columns THEN
    WITH counts AS (
      SELECT
        f.id,
        count(m.id)::int AS headers_synced_count,
        count(m.id) FILTER (WHERE m.body_fetched_at IS NOT NULL)::int AS bodies_fetched_count,
        CASE
          WHEN f.initial_sync_complete THEN count(m.id) FILTER (WHERE m.window_status = 'IN_WINDOW')::int
          ELSE NULL
        END AS live_window_target_count
      FROM public.imap_folders f
      LEFT JOIN public.imap_messages m
        ON m.account_id = f.account_id
       AND m.folder_path = f.path
       AND m.deleted_in_provider = false
      GROUP BY f.id, f.initial_sync_complete
    )
    UPDATE public.imap_folders f
    SET headers_synced_count = counts.headers_synced_count,
        bodies_fetched_count = counts.bodies_fetched_count,
        live_window_target_count = counts.live_window_target_count
    FROM counts
    WHERE f.id = counts.id;
  END IF;
END $$;

DROP VIEW IF EXISTS public.imap_account_progress;

CREATE VIEW public.imap_account_progress
WITH (security_invoker = true)
AS
WITH folder_progress AS (
  SELECT
    account_id,
    count(*) FILTER (WHERE live_window_target_count IS NOT NULL)::int AS live_window_known_folder_count,
    count(*) FILTER (
      WHERE sync_priority <= 10
        AND live_window_target_count IS NOT NULL
    )::int AS priority_live_window_known_folder_count,
    count(*) FILTER (WHERE historical_target_count IS NOT NULL)::int AS historical_known_folder_count,
    COALESCE(sum(LEAST(headers_synced_count, COALESCE(live_window_target_count, 0))), 0)::int AS live_headers_synced_count,
    COALESCE(sum(COALESCE(live_window_target_count, 0)), 0)::int AS live_headers_target_count,
    COALESCE(sum(LEAST(bodies_fetched_count, COALESCE(live_window_target_count, 0))), 0)::int AS live_bodies_fetched_count,
    COALESCE(sum(COALESCE(live_window_target_count, 0)), 0)::int AS live_bodies_target_count,
    COALESCE(sum(LEAST(bodies_fetched_count, COALESCE(live_window_target_count, 0))) FILTER (WHERE sync_priority <= 10), 0)::int
      AS priority_bodies_fetched_count,
    COALESCE(sum(COALESCE(live_window_target_count, 0)) FILTER (WHERE sync_priority <= 10), 0)::int
      AS priority_bodies_target_count,
    COALESCE(sum(GREATEST(headers_synced_count - COALESCE(live_window_target_count, 0), 0)), 0)::int
      AS historical_headers_synced_count,
    COALESCE(sum(COALESCE(historical_target_count, 0)), 0)::int AS historical_headers_target_count,
    COALESCE(sum(GREATEST(bodies_fetched_count - COALESCE(live_window_target_count, 0), 0)), 0)::int
      AS historical_bodies_fetched_count,
    COALESCE(sum(COALESCE(historical_target_count, 0)), 0)::int AS historical_bodies_target_count
  FROM public.imap_folders
  WHERE tracked = true
    AND status != 'MISSING'
  GROUP BY account_id
)
SELECT
  a.id AS account_id,
  COALESCE(p.live_headers_synced_count, 0) AS live_headers_synced_count,
  COALESCE(p.live_headers_target_count, 0) AS live_headers_target_count,
  CASE
    WHEN COALESCE(p.live_headers_target_count, 0) > 0
      THEN LEAST(100, round((p.live_headers_synced_count::numeric / p.live_headers_target_count::numeric) * 100)::int)
    WHEN COALESCE(p.live_window_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS live_headers_complete_pct,
  COALESCE(p.priority_bodies_fetched_count, 0) AS priority_bodies_fetched_count,
  COALESCE(p.priority_bodies_target_count, 0) AS priority_bodies_target_count,
  CASE
    WHEN COALESCE(p.priority_bodies_target_count, 0) > 0
      THEN LEAST(100, round((p.priority_bodies_fetched_count::numeric / p.priority_bodies_target_count::numeric) * 100)::int)
    WHEN COALESCE(p.priority_live_window_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS priority_bodies_complete_pct,
  COALESCE(p.live_bodies_fetched_count, 0) AS live_bodies_fetched_count,
  COALESCE(p.live_bodies_target_count, 0) AS live_bodies_target_count,
  CASE
    WHEN COALESCE(p.live_bodies_target_count, 0) > 0
      THEN LEAST(100, round((p.live_bodies_fetched_count::numeric / p.live_bodies_target_count::numeric) * 100)::int)
    WHEN COALESCE(p.live_window_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS live_bodies_complete_pct,
  COALESCE(p.historical_headers_synced_count, 0) AS historical_headers_synced_count,
  COALESCE(p.historical_headers_target_count, 0) AS historical_headers_target_count,
  CASE
    WHEN COALESCE(p.historical_headers_target_count, 0) > 0
      THEN LEAST(100, round((p.historical_headers_synced_count::numeric / p.historical_headers_target_count::numeric) * 100)::int)
    WHEN COALESCE(p.historical_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS historical_headers_complete_pct,
  COALESCE(p.historical_bodies_fetched_count, 0) AS historical_bodies_fetched_count,
  COALESCE(p.historical_bodies_target_count, 0) AS historical_bodies_target_count,
  CASE
    WHEN COALESCE(p.historical_bodies_target_count, 0) > 0
      THEN LEAST(100, round((p.historical_bodies_fetched_count::numeric / p.historical_bodies_target_count::numeric) * 100)::int)
    WHEN COALESCE(p.historical_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS historical_bodies_complete_pct,
  NULL::timestamptz AS estimated_full_sync_at
FROM public.imap_accounts a
LEFT JOIN folder_progress p ON p.account_id = a.id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.imap_account_progress FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.imap_account_progress FROM authenticated;
  END IF;
END $$;
