-- 0016_message_evidence.sql
--
-- Persist bounded, source-neutral artifact/resource identities extracted while
-- decoded MIME is available. These rows are evidence only: they deliberately do
-- not assign protocol conversations or semantic work-item clusters.

ALTER TABLE public.imap_message_bodies
  ADD COLUMN IF NOT EXISTS structured_evidence_extractor_version text,
  ADD COLUMN IF NOT EXISTS structured_evidence_sha256 text,
  ADD COLUMN IF NOT EXISTS structured_evidence_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS structured_evidence_extracted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.imap_message_bodies'::regclass
      AND conname = 'imap_message_bodies_structured_evidence_check'
  ) THEN
    ALTER TABLE public.imap_message_bodies
      ADD CONSTRAINT imap_message_bodies_structured_evidence_check
      CHECK (
        (
          NOT structured_evidence_complete
          AND structured_evidence_sha256 IS NULL
          AND (
            (
              structured_evidence_extractor_version IS NULL
              AND structured_evidence_extracted_at IS NULL
            )
            OR (
              structured_evidence_extractor_version IS NOT NULL
              AND length(structured_evidence_extractor_version) BETWEEN 1 AND 64
              AND structured_evidence_extracted_at IS NOT NULL
            )
          )
        )
        OR (
          structured_evidence_complete
          AND structured_evidence_extractor_version IS NOT NULL
          AND length(structured_evidence_extractor_version) BETWEEN 1 AND 64
          AND structured_evidence_sha256 ~ '^[0-9a-f]{64}$'
          AND structured_evidence_extracted_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.imap_message_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.imap_messages(id) ON DELETE CASCADE,
  extractor text NOT NULL CHECK (
    length(extractor) BETWEEN 1 AND 64
    AND extractor ~ '^[a-z0-9_]+$'
  ),
  extractor_version text NOT NULL CHECK (length(extractor_version) BETWEEN 1 AND 64),
  kind text NOT NULL CHECK (kind IN (
    'attachment_content',
    'calendar_instance',
    'provider_resource'
  )),
  namespace text NOT NULL CHECK (
    length(namespace) BETWEEN 1 AND 64
    AND namespace ~ '^[a-z0-9_]+$'
  ),
  evidence_key text NOT NULL CHECK (
    octet_length(evidence_key) > 0
    AND octet_length(evidence_key) <= 2048
  ),
  evidence_key_sha256 text NOT NULL CHECK (evidence_key_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 16384
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, extractor, kind, namespace, evidence_key_sha256)
);

CREATE INDEX IF NOT EXISTS imap_message_evidence_join_idx
  ON public.imap_message_evidence (
    kind,
    namespace,
    evidence_key_sha256,
    extractor_version,
    message_id
  );

CREATE INDEX IF NOT EXISTS imap_message_evidence_message_idx
  ON public.imap_message_evidence (message_id, extractor, extractor_version);

ALTER TABLE public.imap_message_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.imap_message_evidence FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.imap_message_evidence FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.imap_message_evidence FROM authenticated;
  END IF;
END
$$;
