-- 0012_sync_events_retention_index.sql
--
-- imap_sync_events is INSERT-only (written on every sync/reset/delete/state event)
-- and is pruned by the daily retention job with a bare `occurred_at < cutoff` range
-- delete (runSyncEventPruneJob). The only pre-existing index leads with account_id
-- (imap_sync_events_account_type_idx), which Postgres cannot use to serve that range,
-- so the prune fell back to a full sequential scan of the largest audit table on every
-- run. This index makes the LIMITed range delete an index scan.
--
-- Additive + idempotent. Do not use CREATE INDEX CONCURRENTLY: public migrations run
-- inside the migration transaction.

CREATE INDEX IF NOT EXISTS imap_sync_events_occurred_at_idx
  ON public.imap_sync_events (occurred_at);
