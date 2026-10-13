-- 0036_drop_updated_emit_index.sql
--
-- A reviewed removal (ADR 0040). Public 0011 indexed imap_messages
-- (updated_at, id) for consumers that scan for changed mail. Every update sets
-- updated_at, so that index kept every update of imap_messages from being
-- heap-only (HOT). Consumers now read the trigger-written imap_message_changes
-- outbox (0035, ADR 0046). Apply only after every host's consumer reads the
-- outbox; updated_at itself stays.
--
-- Not CREATE/DROP INDEX CONCURRENTLY: public migrations run inside the
-- migration transaction.

DROP INDEX IF EXISTS public.imap_messages_updated_emit_idx;
