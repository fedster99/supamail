-- 0020_threading_fingerprint_closure.sql
--
-- Bounded threading rebuilds must be able to rediscover physical copies that
-- share any raw, parsed, authored, or exact-metadata delivery fingerprint.
-- Each physical assignment stores only that row's bounded, namespaced SHA-256
-- hashes. Iterative overlap closes the transitive component without duplicating
-- an entire delivery's token set onto every copy. Messages and bodies remain
-- the evidence source of truth. Existing assignments stay valid and are
-- populated by the next deterministic shadow rebuild or recomputation.

ALTER TABLE public.imap_thread_assignments
  ADD COLUMN IF NOT EXISTS delivery_fingerprint_hashes text[] NOT NULL DEFAULT '{}'::text[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.imap_thread_assignments'::regclass
      AND conname = 'imap_thread_assignments_delivery_fingerprint_hashes_check'
  ) THEN
    ALTER TABLE public.imap_thread_assignments
      ADD CONSTRAINT imap_thread_assignments_delivery_fingerprint_hashes_check
      CHECK (
        cardinality(delivery_fingerprint_hashes) = 0
        OR (
          array_position(delivery_fingerprint_hashes, NULL) IS NULL
          AND array_to_string(delivery_fingerprint_hashes, ',')
            ~ '^([0-9a-f]{64})(,[0-9a-f]{64})*$'
        )
      ) NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS imap_thread_assignments_delivery_fingerprints_gin_idx
  ON public.imap_thread_assignments USING gin (run_id, delivery_fingerprint_hashes);
