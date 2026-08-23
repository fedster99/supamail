-- 0026_threading_closure_edges.sql
--
-- Closure expansion used to rebuild the relationship lookup from several
-- assignment columns and arrays on every read. Store the same evidence once as
-- normalized edges so expansion is one indexed join. The assignment row remains
-- authoritative. Statement triggers refresh its edges in the same transaction.

CREATE TABLE IF NOT EXISTS public.imap_thread_closure_edges (
  run_id uuid NOT NULL,
  message_id uuid NOT NULL,
  edge_kind text NOT NULL CHECK (
    edge_kind IN (
      'conversation',
      'delivery',
      'reference',
      'provider_thread',
      'delivery_fingerprint'
    )
  ),
  edge_key text NOT NULL CHECK (length(edge_key) BETWEEN 1 AND 128),
  PRIMARY KEY (run_id, message_id, edge_kind, edge_key),
  FOREIGN KEY (run_id, message_id)
    REFERENCES public.imap_thread_assignments(run_id, message_id)
    ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION public.imap_thread_refresh_closure_edges()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.imap_thread_closure_edges (
      run_id, message_id, edge_kind, edge_key
    )
    SELECT DISTINCT
      assignment.run_id,
      assignment.message_id,
      evidence.edge_kind,
      evidence.edge_key
    FROM changed_assignments assignment
    CROSS JOIN LATERAL (
      SELECT 'conversation'::text, assignment.conversation_id
      UNION ALL
      SELECT 'delivery'::text, assignment.delivery_key
      UNION ALL
      SELECT 'reference'::text, reference_hash
      FROM unnest(
        array_remove(
          ARRAY[
            assignment.strict_message_id_hash,
            assignment.root_reference_hash,
            assignment.parent_reference_hash
          ] || assignment.reference_hashes,
          NULL
        )
      ) AS reference_hash
      UNION ALL
      SELECT 'provider_thread'::text, assignment.provider_thread_hash
      WHERE assignment.provider_thread_hash IS NOT NULL
      UNION ALL
      SELECT 'delivery_fingerprint'::text, fingerprint_hash
      FROM unnest(assignment.delivery_fingerprint_hashes) AS fingerprint_hash
    ) AS evidence(edge_kind, edge_key)
    WHERE evidence.edge_key IS NOT NULL
    ON CONFLICT (run_id, message_id, edge_kind, edge_key) DO NOTHING;

    RETURN NULL;
  END IF;

  DELETE FROM public.imap_thread_closure_edges edge
  USING changed_assignments assignment
  JOIN prior_assignments prior
    ON prior.run_id = assignment.run_id
   AND prior.message_id = assignment.message_id
  WHERE edge.run_id = assignment.run_id
    AND edge.message_id = assignment.message_id
    AND CASE edge.edge_kind
      WHEN 'conversation' THEN edge.edge_key IS DISTINCT FROM assignment.conversation_id
      WHEN 'delivery' THEN edge.edge_key IS DISTINCT FROM assignment.delivery_key
      WHEN 'reference' THEN NOT edge.edge_key = ANY(
        array_remove(
          ARRAY[
            assignment.strict_message_id_hash,
            assignment.root_reference_hash,
            assignment.parent_reference_hash
          ] || assignment.reference_hashes,
          NULL
        )
      )
      WHEN 'provider_thread' THEN edge.edge_key IS DISTINCT FROM assignment.provider_thread_hash
      WHEN 'delivery_fingerprint' THEN NOT edge.edge_key = ANY(
        assignment.delivery_fingerprint_hashes
      )
    END
    AND ROW(
      assignment.conversation_id,
      assignment.delivery_key,
      assignment.strict_message_id_hash,
      assignment.root_reference_hash,
      assignment.parent_reference_hash,
      assignment.reference_hashes,
      assignment.delivery_fingerprint_hashes,
      assignment.provider_thread_hash
    ) IS DISTINCT FROM ROW(
      prior.conversation_id,
      prior.delivery_key,
      prior.strict_message_id_hash,
      prior.root_reference_hash,
      prior.parent_reference_hash,
      prior.reference_hashes,
      prior.delivery_fingerprint_hashes,
      prior.provider_thread_hash
    );

  INSERT INTO public.imap_thread_closure_edges (
    run_id, message_id, edge_kind, edge_key
  )
  SELECT DISTINCT
    assignment.run_id,
    assignment.message_id,
    evidence.edge_kind,
    evidence.edge_key
  FROM changed_assignments assignment
  JOIN prior_assignments prior
    ON prior.run_id = assignment.run_id
   AND prior.message_id = assignment.message_id
  CROSS JOIN LATERAL (
    SELECT 'conversation'::text, assignment.conversation_id
    UNION ALL
    SELECT 'delivery'::text, assignment.delivery_key
    UNION ALL
    SELECT 'reference'::text, reference_hash
    FROM unnest(
      array_remove(
        ARRAY[
          assignment.strict_message_id_hash,
          assignment.root_reference_hash,
          assignment.parent_reference_hash
        ] || assignment.reference_hashes,
        NULL
      )
    ) AS reference_hash
    UNION ALL
    SELECT 'provider_thread'::text, assignment.provider_thread_hash
    WHERE assignment.provider_thread_hash IS NOT NULL
    UNION ALL
    SELECT 'delivery_fingerprint'::text, fingerprint_hash
    FROM unnest(assignment.delivery_fingerprint_hashes) AS fingerprint_hash
  ) AS evidence(edge_kind, edge_key)
  WHERE evidence.edge_key IS NOT NULL
    AND ROW(
      assignment.conversation_id,
      assignment.delivery_key,
      assignment.strict_message_id_hash,
      assignment.root_reference_hash,
      assignment.parent_reference_hash,
      assignment.reference_hashes,
      assignment.delivery_fingerprint_hashes,
      assignment.provider_thread_hash
    ) IS DISTINCT FROM ROW(
      prior.conversation_id,
      prior.delivery_key,
      prior.strict_message_id_hash,
      prior.root_reference_hash,
      prior.parent_reference_hash,
      prior.reference_hashes,
      prior.delivery_fingerprint_hashes,
      prior.provider_thread_hash
    )
  ON CONFLICT (run_id, message_id, edge_kind, edge_key) DO NOTHING;

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS imap_thread_assignments_refresh_closure_edges_after_insert
  ON public.imap_thread_assignments;
CREATE TRIGGER imap_thread_assignments_refresh_closure_edges_after_insert
  AFTER INSERT ON public.imap_thread_assignments
  REFERENCING NEW TABLE AS changed_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION public.imap_thread_refresh_closure_edges();

DROP TRIGGER IF EXISTS imap_thread_assignments_refresh_closure_edges_after_update
  ON public.imap_thread_assignments;
CREATE TRIGGER imap_thread_assignments_refresh_closure_edges_after_update
  AFTER UPDATE ON public.imap_thread_assignments
  REFERENCING OLD TABLE AS prior_assignments NEW TABLE AS changed_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION public.imap_thread_refresh_closure_edges();

-- Existing projections become usable immediately. The insert is idempotent and
-- reads only the replaceable assignment projection, never raw mailbox rows.
INSERT INTO public.imap_thread_closure_edges (
  run_id, message_id, edge_kind, edge_key
)
SELECT DISTINCT
  assignment.run_id,
  assignment.message_id,
  evidence.edge_kind,
  evidence.edge_key
FROM public.imap_thread_assignments assignment
CROSS JOIN LATERAL (
  SELECT 'conversation'::text, assignment.conversation_id
  UNION ALL
  SELECT 'delivery'::text, assignment.delivery_key
  UNION ALL
  SELECT 'reference'::text, reference_hash
  FROM unnest(
    array_remove(
      ARRAY[
        assignment.strict_message_id_hash,
        assignment.root_reference_hash,
        assignment.parent_reference_hash
      ] || assignment.reference_hashes,
      NULL
    )
  ) AS reference_hash
  UNION ALL
  SELECT 'provider_thread'::text, assignment.provider_thread_hash
  WHERE assignment.provider_thread_hash IS NOT NULL
  UNION ALL
  SELECT 'delivery_fingerprint'::text, fingerprint_hash
  FROM unnest(assignment.delivery_fingerprint_hashes) AS fingerprint_hash
) AS evidence(edge_kind, edge_key)
WHERE evidence.edge_key IS NOT NULL
ON CONFLICT (run_id, message_id, edge_kind, edge_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS imap_thread_closure_edges_lookup_idx
  ON public.imap_thread_closure_edges (run_id, edge_kind, edge_key, message_id);

ALTER TABLE public.imap_thread_closure_edges ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.imap_thread_closure_edges FROM PUBLIC;
REVOKE ALL ON FUNCTION public.imap_thread_refresh_closure_edges() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.imap_thread_closure_edges FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.imap_thread_closure_edges FROM authenticated;
  END IF;
END
$$;
