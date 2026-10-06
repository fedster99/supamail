-- 0030_window_from_message_date.sql
--
-- The live window is a cost limit computed from each message's date and the
-- Mailbox Account's live_window_days, never a stored per-row lane (ADR 0039). A
-- stored lane goes stale as time passes unless a job rewrites it, and stale lanes
-- hid mail that was still in the provider. imap_messages.window_status,
-- imap_folders.last_archive_refresh_at, and imap_accounts.archive_refresh_interval
-- and archive_flag_sync are no longer read or written. A later migration drops
-- them together with the two lane-predicated indexes from 0001 and 0021: those
-- files are re-applied on every migrate, so dropping the indexes here would make
-- each migrate rebuild them. This file is re-applied on every migrate too, so each
-- statement is idempotent.

-- New mail is every UID above the live head, whatever its date. Under the old
-- date-filtered incremental, a completed folder's head could sit far below
-- UIDNEXT over archive mail the history lane owns; start it at UIDNEXT so that
-- archive is never fetched again as new mail. A live-window UID the old code had
-- left unfetched is still repaired by reconcile. Current code stores only the
-- UIDNEXT a pass reached, so re-applying this changes nothing.
UPDATE public.imap_folders
SET last_uid = uid_next - 1
WHERE initial_sync_complete = true
  AND uid_next IS NOT NULL
  AND COALESCE(last_uid, 0) < uid_next - 1;

-- The old date-filtered incremental also skipped old mail moved into a folder
-- after its history snapshot; only the removed archive refresh found it. Re-take
-- each completed history snapshot once to recover it: the walk fetches only UIDs
-- without a live row, and the folder keeps its history progress meanwhile. The
-- obsolete refresh stamp marks folders not yet re-run; it is then cleared on
-- every folder and never written again.
UPDATE public.imap_folders f
SET backfill_in_progress = true,
    backfill_target_max_uid = NULL,
    backfill_oldest_uid_synced = NULL
FROM public.imap_accounts a
WHERE a.id = f.account_id
  AND a.historical_backfill_mode <> 'off'
  AND f.last_archive_refresh_at IS NOT NULL
  AND f.historical_target_count IS NOT NULL
  AND f.backfill_in_progress = false;

UPDATE public.imap_folders
SET last_archive_refresh_at = NULL
WHERE last_archive_refresh_at IS NOT NULL;

-- A body fetch that finds its UID gone now writes the recoverable
-- RECONCILE_MISSING, which reconcile revives while the UID is still listed. Give
-- earlier body-lane tombstones the same recovery instead of the 30-day purge.
-- Nothing writes MOVED_OUT any more.
UPDATE public.imap_messages
SET deleted_reason = 'RECONCILE_MISSING'
WHERE deleted_reason = 'MOVED_OUT';

-- Current live body coverage counts rows inside the account's window by date.
-- The per-account LATERAL lets the cutoff bound the date index scan.
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
LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS live_bodies_target_count,
      count(*) FILTER (
        WHERE m.body_fetched_at IS NOT NULL
          AND body.message_id IS NOT NULL
          AND NOT body.raw_truncated
      )::int AS live_bodies_fetched_count,
      count(*) FILTER (
        WHERE f.sync_priority <= 10
      )::int AS priority_bodies_target_count,
      count(*) FILTER (
        WHERE f.sync_priority <= 10
          AND m.body_fetched_at IS NOT NULL
          AND body.message_id IS NOT NULL
          AND NOT body.raw_truncated
      )::int AS priority_bodies_fetched_count
    FROM public.imap_messages m
    JOIN public.imap_folders f
      ON f.account_id = m.account_id
     AND f.path = m.folder_path
    LEFT JOIN public.imap_message_bodies body
      ON body.message_id = m.id
    WHERE f.tracked = true
      AND f.missing_since IS NULL
      AND f.status NOT IN ('MISSING', 'PENDING_VERIFICATION')
      AND m.deleted_in_provider = false
      AND m.account_id = a.id
      AND m.internal_date >= now() - make_interval(hours => 24 * a.live_window_days)
) b ON true;
