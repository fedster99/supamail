-- 0011_webhook_emit_indexes.sql
--
-- BYO Supabase webhook emit support for the hosted product. SupaMail Cloud is the
-- webhook emitter for both managed and BYO lanes, but BYO targets receive only this
-- public mirror schema. The worker scans new/changed mirror rows by `(created_at,id)`
-- and `(updated_at,id)` high-water cursors, so customer targets need the same serving
-- indexes the managed overlay carries with tenant_id.
--
-- Additive + idempotent. Do not use CREATE INDEX CONCURRENTLY: public migrations run
-- inside the migration transaction.

CREATE INDEX IF NOT EXISTS imap_messages_created_emit_idx
  ON public.imap_messages (created_at, id)
  WHERE deleted_in_provider = false;

CREATE INDEX IF NOT EXISTS imap_messages_updated_emit_idx
  ON public.imap_messages (updated_at, id)
  WHERE deleted_in_provider = false;
