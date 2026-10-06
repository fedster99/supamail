-- 0030_window_from_message_date.sql
--
-- The live window is a cost limit computed from each message's date and the
-- Mailbox Account's live_window_days, never a stored per-row lane. A stored lane
-- goes stale as time passes unless a job rewrites it, and stale lanes hid mail
-- that was still in the provider. Live-window readers now compare internal_date
-- with the account cutoff; imap_messages.window_status is no longer read or
-- written and is removed by a later migration once every host stops reading it.

-- One unfetched-body index serves the live and the history body backlogs: a
-- date range per folder selects either side of the cutoff, and a backward scan
-- returns the newest old mail first. The two lane-predicated indexes it replaces
-- are only as correct as the lane.
CREATE INDEX IF NOT EXISTS imap_messages_unfetched_body_idx
  ON public.imap_messages (account_id, folder_path, internal_date, uid)
  WHERE deleted_in_provider = false
    AND body_fetched_at IS NULL;

DROP INDEX IF EXISTS public.imap_messages_body_backlog_idx;
DROP INDEX IF EXISTS public.imap_messages_live_body_progress_idx;

-- Current live body coverage counts rows inside the account's window by date.
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
  JOIN public.imap_accounts account
    ON account.id = m.account_id
  LEFT JOIN public.imap_message_bodies b
    ON b.message_id = m.id
  WHERE f.tracked = true
    AND f.missing_since IS NULL
    AND f.status NOT IN ('MISSING', 'PENDING_VERIFICATION')
    AND m.deleted_in_provider = false
    AND m.internal_date >= now() - account.live_window_days * interval '1 day'
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
      THEN LEAST(100, round((b.priority_bodies_fetched_count::numeric / b.priority_bodies_target_count::numeric) * 100)::int)
    WHEN COALESCE(ab.priority_live_window_known_folder_count, 0) > 0 THEN 100
    ELSE 0
  END AS priority_bodies_complete_pct,
  COALESCE(b.live_bodies_fetched_count, 0) AS live_bodies_fetched_count,
  COALESCE(b.live_bodies_target_count, 0) AS live_bodies_target_count,
  CASE
    WHEN COALESCE(b.live_bodies_target_count, 0) > 0
      THEN LEAST(100, round((b.live_bodies_fetched_count::numeric / b.live_bodies_target_count::numeric) * 100)::int)
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
