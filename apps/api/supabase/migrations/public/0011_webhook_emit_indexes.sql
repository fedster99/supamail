-- 0011_webhook_emit_indexes.sql
--
-- Event-consumer indexes for incremental scans of new or changed mirror rows.
-- Consumers can advance stable `(created_at,id)` and `(updated_at,id)` high-water
-- cursors without coupling deployment-specific event delivery to the core schema.
--
-- Additive + idempotent. Do not use CREATE INDEX CONCURRENTLY: public migrations run
-- inside the migration transaction.

CREATE INDEX IF NOT EXISTS imap_messages_created_emit_idx
  ON public.imap_messages (created_at, id)
  WHERE deleted_in_provider = false;

CREATE INDEX IF NOT EXISTS imap_messages_updated_emit_idx
  ON public.imap_messages (updated_at, id)
  WHERE deleted_in_provider = false;
