-- A current live body percentage is complete only when its fetched count
-- reaches its target. Floor incomplete ratios so 199/200 cannot round to 100.
CREATE OR REPLACE VIEW public.imap_account_progress
WITH (security_invoker = true)
AS
WITH folder_progress AS (
  SELECT
    f.account_id,
    count(*) FILTER (WHERE f.live_window_target_count IS NOT NULL)::int AS live_window_known_folder_count,
    count(*) FILTER (WHERE f.historical_target_count IS NOT NULL)::int AS historical_known_folder_count,
    COALESCE(sum(LEAST(f.headers_synced_count, COALESCE(f.live_window_target_count, 0))), 0)::int
      AS live_headers_synced_count,
    COALESCE(sum(COALESCE(f.live_window_target_count, 0)), 0)::int AS live_headers_target_count,
    COALESCE(sum(GREATEST(f.headers_synced_count - COALESCE(f.live_window_target_count, 0), 0)), 0)::int
      AS historical_headers_synced_count,
    COALESCE(sum(COALESCE(f.historical_target_count, 0)), 0)::int AS historical_headers_target_count,
    COALESCE(sum(GREATEST(f.bodies_fetched_count - COALESCE(f.live_window_target_count, 0), 0)), 0)::int
      AS historical_bodies_fetched_count,
    COALESCE(sum(COALESCE(f.historical_target_count, 0)), 0)::int AS historical_bodies_target_count
  FROM public.imap_folders f
  WHERE f.tracked = true
    AND f.status != 'MISSING'
  GROUP BY f.account_id
),
active_body_folder_progress AS (
  SELECT
    f.account_id,
    count(*) FILTER (WHERE f.live_window_target_count IS NOT NULL)::int AS live_window_known_folder_count,
    count(*) FILTER (
      WHERE f.sync_priority <= 10
        AND f.live_window_target_count IS NOT NULL
    )::int AS priority_live_window_known_folder_count
  FROM public.imap_folders f
  WHERE f.tracked = true
    AND f.missing_since IS NULL
    AND f.status NOT IN ('MISSING', 'PENDING_VERIFICATION')
  GROUP BY f.account_id
),
current_live_body_progress AS (
  SELECT
    m.account_id,
    count(*)::int AS live_bodies_target_count,
    count(*) FILTER (
      WHERE m.body_fetched_at IS NOT NULL
        AND b.message_id IS NOT NULL
        AND NOT b.raw_truncated
    )::int AS live_bodies_fetched_count,
    count(*) FILTER (
      WHERE f.sync_priority <= 10
    )::int AS priority_bodies_target_count,
    count(*) FILTER (
      WHERE f.sync_priority <= 10
        AND m.body_fetched_at IS NOT NULL
        AND b.message_id IS NOT NULL
        AND NOT b.raw_truncated
    )::int AS priority_bodies_fetched_count
  FROM public.imap_messages m
  JOIN public.imap_folders f
    ON f.account_id = m.account_id
   AND f.path = m.folder_path
  LEFT JOIN public.imap_message_bodies b
    ON b.message_id = m.id
  WHERE f.tracked = true
    AND f.missing_since IS NULL
    AND f.status NOT IN ('MISSING', 'PENDING_VERIFICATION')
    AND m.deleted_in_provider = false
    AND m.window_status = 'IN_WINDOW'
  GROUP BY m.account_id
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
  COALESCE(b.priority_bodies_fetched_count, 0) AS priority_bodies_fetched_count,
  COALESCE(b.priority_bodies_target_count, 0) AS priority_bodies_target_count,
  CASE
    WHEN COALESCE(b.priority_bodies_target_count, 0) > 0
      THEN CASE
        WHEN b.priority_bodies_fetched_count >= b.priority_bodies_target_count THEN 100
        ELSE floor(
          (b.priority_bodies_fetched_count::numeric / b.priority_bodies_target_count::numeric) * 100
        )::int
      END
    WHEN COALESCE(ab.priority_live_window_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS priority_bodies_complete_pct,
  COALESCE(b.live_bodies_fetched_count, 0) AS live_bodies_fetched_count,
  COALESCE(b.live_bodies_target_count, 0) AS live_bodies_target_count,
  CASE
    WHEN COALESCE(b.live_bodies_target_count, 0) > 0
      THEN CASE
        WHEN b.live_bodies_fetched_count >= b.live_bodies_target_count THEN 100
        ELSE floor(
          (b.live_bodies_fetched_count::numeric / b.live_bodies_target_count::numeric) * 100
        )::int
      END
    WHEN COALESCE(ab.live_window_known_folder_count, 0) > 0 THEN 100
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
LEFT JOIN folder_progress p ON p.account_id = a.id
LEFT JOIN active_body_folder_progress ab ON ab.account_id = a.id
LEFT JOIN current_live_body_progress b ON b.account_id = a.id;
