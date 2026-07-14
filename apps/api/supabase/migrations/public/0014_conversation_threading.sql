-- 0014_conversation_threading.sql
--
-- Durable, versioned conversation threading. Raw mirror rows remain the source
-- of truth. A new algorithm builds into an isolated run; readers switch only by
-- changing one account-scoped active-run pointer after review. Backfills and
-- body-evidence upgrades are performed by bounded workers, never by this
-- migration transaction.

ALTER TABLE public.imap_messages
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS provider_message_id_namespace text,
  ADD COLUMN IF NOT EXISTS provider_thread_id_namespace text;

ALTER TABLE public.imap_message_bodies
  ADD COLUMN IF NOT EXISTS raw_mime_sha256 text;

-- Both provider-message columns are new, so equality is safe for every legacy
-- row. provider_thread_id predates its namespace; retain those legacy values but
-- never permit a namespace without its raw provider value. NOT VALID avoids a
-- table scan and still enforces the contracts for new/updated rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.imap_messages'::regclass
      AND conname = 'imap_messages_provider_message_identity_check'
  ) THEN
    ALTER TABLE public.imap_messages
      ADD CONSTRAINT imap_messages_provider_message_identity_check
      CHECK ((provider_message_id IS NULL) = (provider_message_id_namespace IS NULL))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.imap_messages'::regclass
      AND conname = 'imap_messages_provider_thread_namespace_check'
  ) THEN
    ALTER TABLE public.imap_messages
      ADD CONSTRAINT imap_messages_provider_thread_namespace_check
      CHECK (provider_thread_id_namespace IS NULL OR provider_thread_id IS NOT NULL)
      NOT VALID;
  END IF;
END
$$;

-- The digest column is NULL for pre-existing rows. parsed_only storage may retain
-- the digest while discarding raw_mime; the digest still proves the bytes fetched
-- before parsing. NOT VALID avoids scanning the large body table while enforcing
-- complete, lowercase SHA-256 evidence for every new or updated row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.imap_message_bodies'::regclass
      AND conname = 'imap_message_bodies_raw_mime_sha256_check'
  ) THEN
    ALTER TABLE public.imap_message_bodies
      ADD CONSTRAINT imap_message_bodies_raw_mime_sha256_check
      CHECK (
        raw_mime_sha256 IS NULL
        OR (
          raw_mime_sha256 ~ '^[0-9a-f]{64}$'
          AND NOT raw_truncated
        )
      ) NOT VALID;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.imap_thread_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  mode text NOT NULL CHECK (mode IN ('initial', 'upgrade', 'rebuild')),
  status text NOT NULL DEFAULT 'building' CHECK (
    status IN ('building', 'ready', 'active', 'standby', 'archived', 'failed', 'rolled_back')
  ),
  stage text NOT NULL DEFAULT 'body_evidence' CHECK (
    stage IN ('body_evidence', 'strong', 'subject', 'catchup', 'ready')
  ),
  source_run_id uuid
    REFERENCES public.imap_thread_runs(id) ON DELETE SET NULL,
  cursor_folder_path text,
  cursor_uidvalidity bigint,
  cursor_uid bigint,
  requested_by text,
  reason text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(summary) = 'object'),
  caught_up_revision bigint NOT NULL DEFAULT 0 CHECK (caught_up_revision >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  activated_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  active_account_id uuid GENERATED ALWAYS AS (
    CASE WHEN status = 'active' THEN account_id ELSE NULL END
  ) STORED,
  CHECK (source_run_id IS NULL OR source_run_id <> id),
  CHECK (mode <> 'initial' OR source_run_id IS NULL),
  CHECK (
    status = 'failed'
    OR (status = 'building' AND stage <> 'ready')
    OR (status IN ('ready', 'active', 'standby', 'archived', 'rolled_back') AND stage = 'ready')
  ),
  CHECK ((status = 'building') = (completed_at IS NULL)),
  CHECK (status <> 'active' OR activated_at IS NOT NULL),
  CHECK (
    (cursor_folder_path IS NULL AND cursor_uidvalidity IS NULL AND cursor_uid IS NULL)
    OR
    (cursor_folder_path IS NOT NULL AND cursor_uidvalidity IS NOT NULL AND cursor_uid IS NOT NULL)
  ),
  CONSTRAINT imap_thread_runs_one_active_per_account
    UNIQUE (active_account_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS imap_thread_runs_account_status_version_idx
  ON public.imap_thread_runs (account_id, status, algorithm_version, available_at, created_at, id);
CREATE INDEX IF NOT EXISTS imap_thread_runs_source_idx
  ON public.imap_thread_runs (source_run_id)
  WHERE source_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS imap_thread_runs_one_candidate_uidx
  ON public.imap_thread_runs (account_id)
  WHERE status IN ('building', 'ready');

DROP TRIGGER IF EXISTS imap_thread_runs_set_updated_at ON public.imap_thread_runs;
CREATE TRIGGER imap_thread_runs_set_updated_at
  BEFORE UPDATE ON public.imap_thread_runs
  FOR EACH ROW EXECUTE FUNCTION public.imap_mirror_set_updated_at();

-- Threading state is isolated from imap_accounts so a long backfill never
-- contends with sync health/heartbeat updates on the hot account row.
CREATE TABLE IF NOT EXISTS public.imap_thread_state (
  account_id uuid PRIMARY KEY
    REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  active_run_id uuid
    REFERENCES public.imap_thread_runs(id) ON DELETE SET NULL,
  previous_run_id uuid
    REFERENCES public.imap_thread_runs(id) ON DELETE SET NULL,
  building_run_id uuid
    REFERENCES public.imap_thread_runs(id) ON DELETE SET NULL,
  -- Durable weighted round-robin position. Persisting this on the account state
  -- prevents every worker restart from returning to active-first scheduling.
  scheduler_cursor integer NOT NULL DEFAULT 0
    CHECK (scheduler_cursor BETWEEN 0 AND 4),
  paused_at timestamptz,
  pause_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((paused_at IS NULL) = (pause_reason IS NULL)),
  CHECK (active_run_id IS NULL OR active_run_id IS DISTINCT FROM previous_run_id),
  CHECK (active_run_id IS NULL OR active_run_id IS DISTINCT FROM building_run_id),
  CHECK (previous_run_id IS NULL OR previous_run_id IS DISTINCT FROM building_run_id)
);

CREATE INDEX IF NOT EXISTS imap_thread_state_building_idx
  ON public.imap_thread_state (building_run_id, account_id)
  WHERE building_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS imap_thread_state_active_idx
  ON public.imap_thread_state (active_run_id, account_id)
  WHERE active_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS imap_thread_state_previous_idx
  ON public.imap_thread_state (previous_run_id, account_id)
  WHERE previous_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS imap_thread_state_set_updated_at ON public.imap_thread_state;
CREATE TRIGGER imap_thread_state_set_updated_at
  BEFORE UPDATE ON public.imap_thread_state
  FOR EACH ROW EXECUTE FUNCTION public.imap_mirror_set_updated_at();

-- A monotonic account clock makes "fully caught up" explicit. It is separate
-- from imap_thread_state so concurrent mirror writers can all hold the state
-- row FOR SHARE without deadlocking while atomically advancing the clock.
CREATE TABLE IF NOT EXISTS public.imap_thread_evidence_clock (
  account_id uuid PRIMARY KEY
    REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS imap_thread_evidence_clock_set_updated_at ON public.imap_thread_evidence_clock;
CREATE TRIGGER imap_thread_evidence_clock_set_updated_at
  BEFORE UPDATE ON public.imap_thread_evidence_clock
  FOR EACH ROW EXECUTE FUNCTION public.imap_mirror_set_updated_at();

-- One row per physical mirror occurrence per run. All indexed evidence is a
-- fixed-size digest; raw RFC/provider values remain inspectable but unindexed so
-- a pathological header cannot exceed PostgreSQL's btree tuple limit.
CREATE TABLE IF NOT EXISTS public.imap_thread_assignments (
  run_id uuid NOT NULL
    REFERENCES public.imap_thread_runs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL
    REFERENCES public.imap_messages(id) ON DELETE CASCADE,
  account_id uuid NOT NULL
    REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  delivery_key text NOT NULL CHECK (delivery_key ~ '^[0-9a-f]{64}$'),
  strict_message_id text,
  strict_message_id_hash text
    CHECK (strict_message_id_hash IS NULL OR strict_message_id_hash ~ '^[0-9a-f]{64}$'),
  conversation_id text NOT NULL CHECK (conversation_id ~ '^thread_[0-9a-f]{32}$'),
  root_reference text,
  root_reference_hash text
    CHECK (root_reference_hash IS NULL OR root_reference_hash ~ '^[0-9a-f]{64}$'),
  parent_reference text,
  parent_reference_hash text
    CHECK (parent_reference_hash IS NULL OR parent_reference_hash ~ '^[0-9a-f]{64}$'),
  parent_delivery_key text
    CHECK (parent_delivery_key IS NULL OR parent_delivery_key ~ '^[0-9a-f]{64}$'),
  reference_ids text[] NOT NULL DEFAULT '{}'::text[],
  reference_hashes text[] NOT NULL DEFAULT '{}'::text[],
  subject_base text,
  subject_key text CHECK (subject_key IS NULL OR subject_key ~ '^[0-9a-f]{64}$'),
  participant_edge_hashes text[] NOT NULL DEFAULT '{}'::text[],
  provider_thread_key text,
  provider_thread_hash text
    CHECK (provider_thread_hash IS NULL OR provider_thread_hash ~ '^[0-9a-f]{64}$'),
  assignment_method text NOT NULL CHECK (
    assignment_method IN ('references', 'in_reply_to', 'provider_thread', 'subject_fallback', 'standalone')
  ),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  is_provisional boolean NOT NULL DEFAULT false,
  subject_fallback_eligible boolean NOT NULL DEFAULT false,
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object'),
  computed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, message_id),
  CHECK ((strict_message_id IS NULL) = (strict_message_id_hash IS NULL)),
  CHECK ((root_reference IS NULL) = (root_reference_hash IS NULL)),
  CHECK ((parent_reference IS NULL) = (parent_reference_hash IS NULL)),
  CHECK ((subject_base IS NULL) = (subject_key IS NULL)),
  CHECK ((provider_thread_key IS NULL) = (provider_thread_hash IS NULL)),
  CHECK (cardinality(reference_ids) = cardinality(reference_hashes)),
  CHECK (
    cardinality(reference_hashes) = 0
    OR (
      array_position(reference_hashes, NULL) IS NULL
      AND array_to_string(reference_hashes, ',') ~ '^([0-9a-f]{64})(,[0-9a-f]{64})*$'
    )
  ),
  CHECK (
    cardinality(participant_edge_hashes) = 0
    OR (
      array_position(participant_edge_hashes, NULL) IS NULL
      AND array_to_string(participant_edge_hashes, ',') ~ '^([0-9a-f]{64})(,[0-9a-f]{64})*$'
    )
  ),
  CHECK (parent_delivery_key IS NULL OR parent_reference IS NOT NULL),
  CHECK (NOT is_provisional OR confidence = 'low'),
  CHECK (assignment_method <> 'subject_fallback' OR confidence = 'low'),
  CHECK (assignment_method <> 'provider_thread' OR confidence IN ('medium', 'low'))
);

CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_conversation_idx
  ON public.imap_thread_assignments (run_id, conversation_id, message_id);
CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_delivery_idx
  ON public.imap_thread_assignments (run_id, delivery_key, message_id);
CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_strict_id_idx
  ON public.imap_thread_assignments (run_id, strict_message_id_hash, message_id)
  WHERE strict_message_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_root_idx
  ON public.imap_thread_assignments (run_id, root_reference_hash, message_id)
  WHERE root_reference_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_parent_idx
  ON public.imap_thread_assignments (run_id, parent_reference_hash, message_id)
  WHERE parent_reference_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_parent_delivery_idx
  ON public.imap_thread_assignments (run_id, parent_delivery_key, message_id)
  WHERE parent_delivery_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_provider_idx
  ON public.imap_thread_assignments (run_id, provider_thread_hash, message_id)
  WHERE provider_thread_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_subject_idx
  ON public.imap_thread_assignments (
    run_id, subject_key, subject_fallback_eligible, assignment_method, message_id
  ) WHERE subject_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_generation_idx
  ON public.imap_thread_assignments (run_id, generation DESC, message_id);
CREATE INDEX IF NOT EXISTS imap_thread_assignments_account_run_idx
  ON public.imap_thread_assignments (account_id, run_id, message_id);
CREATE INDEX IF NOT EXISTS imap_thread_assignments_message_run_idx
  ON public.imap_thread_assignments (message_id, run_id);
CREATE INDEX IF NOT EXISTS imap_thread_assignments_run_references_gin_idx
  ON public.imap_thread_assignments USING gin (run_id, reference_hashes);
CREATE INDEX IF NOT EXISTS imap_thread_assignments_participant_edges_gin_idx
  ON public.imap_thread_assignments USING gin (run_id, participant_edge_hashes);

DROP TRIGGER IF EXISTS imap_thread_assignments_set_updated_at ON public.imap_thread_assignments;
CREATE TRIGGER imap_thread_assignments_set_updated_at
  BEFORE UPDATE ON public.imap_thread_assignments
  FOR EACH ROW EXECUTE FUNCTION public.imap_mirror_set_updated_at();

-- A message is independently dirty for every active/building run. This prevents
-- an active v1 worker from consuming the evidence a shadow v2 build still needs.
CREATE TABLE IF NOT EXISTS public.imap_thread_work_queue (
  run_id uuid NOT NULL
    REFERENCES public.imap_thread_runs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL
    REFERENCES public.imap_messages(id) ON DELETE CASCADE,
  account_id uuid NOT NULL
    REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, message_id)
);

CREATE INDEX IF NOT EXISTS imap_thread_work_queue_run_available_idx
  ON public.imap_thread_work_queue (run_id, available_at, enqueued_at, message_id);
CREATE INDEX IF NOT EXISTS imap_thread_work_queue_account_available_idx
  ON public.imap_thread_work_queue (account_id, available_at, enqueued_at, run_id, message_id);
CREATE INDEX IF NOT EXISTS imap_thread_work_queue_message_run_idx
  ON public.imap_thread_work_queue (message_id, run_id);

DROP TRIGGER IF EXISTS imap_thread_work_queue_set_updated_at ON public.imap_thread_work_queue;
CREATE TRIGGER imap_thread_work_queue_set_updated_at
  BEFORE UPDATE ON public.imap_thread_work_queue
  FOR EACH ROW EXECUTE FUNCTION public.imap_mirror_set_updated_at();

-- Weak subject evidence is evaluated one fixed-size subject bucket at a time.
-- Buckets over the runtime cap are recorded/skipped as ambiguous instead of
-- materializing an unbounded closure or blocking protocol threading.
CREATE TABLE IF NOT EXISTS public.imap_thread_subject_work (
  run_id uuid NOT NULL
    REFERENCES public.imap_thread_runs(id) ON DELETE CASCADE,
  account_id uuid NOT NULL
    REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  subject_key text NOT NULL CHECK (subject_key ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, subject_key)
);

CREATE INDEX IF NOT EXISTS imap_thread_subject_work_run_available_idx
  ON public.imap_thread_subject_work (run_id, available_at, enqueued_at, subject_key);
CREATE INDEX IF NOT EXISTS imap_thread_subject_work_account_run_idx
  ON public.imap_thread_subject_work (account_id, run_id, subject_key);

DROP TRIGGER IF EXISTS imap_thread_subject_work_set_updated_at ON public.imap_thread_subject_work;
CREATE TRIGGER imap_thread_subject_work_set_updated_at
  BEFORE UPDATE ON public.imap_thread_subject_work
  FOR EACH ROW EXECUTE FUNCTION public.imap_mirror_set_updated_at();

CREATE TABLE IF NOT EXISTS public.imap_thread_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deliberately not an FK: audit operations outlive purged projection runs.
  -- imap_thread_assert_scope verifies that the run exists and matches at write time.
  run_id uuid NOT NULL,
  account_id uuid NOT NULL
    REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  operation_type text NOT NULL CHECK (
    operation_type IN ('build_batch', 'incremental', 'activate', 'rollback', 'failure')
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'rolled_back')
  ),
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  from_generation bigint CHECK (from_generation IS NULL OR from_generation >= 0),
  to_generation bigint CHECK (to_generation IS NULL OR to_generation > 0),
  reverses_operation_id uuid
    REFERENCES public.imap_thread_operations(id) ON DELETE SET NULL,
  requested_by text,
  reason text,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(parameters) = 'object'),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(summary) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  rolled_back_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reverses_operation_id IS NULL OR reverses_operation_id <> id),
  CHECK (operation_type <> 'rollback' OR reverses_operation_id IS NOT NULL),
  CHECK (operation_type <> 'failure' OR status = 'failed'),
  CHECK (to_generation IS NULL OR from_generation IS NOT NULL),
  CHECK (to_generation IS NULL OR to_generation > from_generation),
  CHECK (
    (status = 'pending' AND started_at IS NULL AND completed_at IS NULL AND rolled_back_at IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL AND rolled_back_at IS NULL)
    OR (status IN ('succeeded', 'failed') AND started_at IS NOT NULL AND completed_at IS NOT NULL AND rolled_back_at IS NULL)
    OR (status = 'rolled_back' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND rolled_back_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS imap_thread_operations_account_created_idx
  ON public.imap_thread_operations (account_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS imap_thread_operations_run_created_idx
  ON public.imap_thread_operations (run_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS imap_thread_operations_reverses_idx
  ON public.imap_thread_operations (reverses_operation_id)
  WHERE reverses_operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS imap_thread_operations_run_generation_uidx
  ON public.imap_thread_operations (run_id, to_generation)
  WHERE to_generation IS NOT NULL;

DROP TRIGGER IF EXISTS imap_thread_operations_set_updated_at ON public.imap_thread_operations;
CREATE TRIGGER imap_thread_operations_set_updated_at
  BEFORE UPDATE ON public.imap_thread_operations
  FOR EACH ROW EXECUTE FUNCTION public.imap_mirror_set_updated_at();

-- A quality review is a durable certificate for one exact baseline/candidate
-- generation at one exact mirror-evidence revision. Activation rejects it as
-- soon as either projection or the mirror changes.
CREATE TABLE IF NOT EXISTS public.imap_thread_run_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  baseline_run_id uuid NOT NULL,
  candidate_run_id uuid NOT NULL,
  baseline_algorithm_version integer NOT NULL CHECK (baseline_algorithm_version > 0),
  candidate_algorithm_version integer NOT NULL CHECK (candidate_algorithm_version > 0),
  baseline_generation bigint NOT NULL CHECK (baseline_generation >= 0),
  candidate_generation bigint NOT NULL CHECK (candidate_generation >= 0),
  evidence_revision bigint NOT NULL CHECK (evidence_revision >= 0),
  passed boolean NOT NULL,
  thresholds jsonb NOT NULL CHECK (jsonb_typeof(thresholds) = 'object'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  requested_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (baseline_run_id <> candidate_run_id)
);

CREATE INDEX IF NOT EXISTS imap_thread_run_comparisons_candidate_created_idx
  ON public.imap_thread_run_comparisons (candidate_run_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS imap_thread_run_comparisons_account_created_idx
  ON public.imap_thread_run_comparisons (account_id, created_at DESC, id);

-- Audit snapshots intentionally outlive a hard-retained message row. If the
-- message no longer exists, rollback refuses rather than silently applying a
-- partial history.
CREATE TABLE IF NOT EXISTS public.imap_thread_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL
    REFERENCES public.imap_thread_operations(id) ON DELETE CASCADE,
  -- Raw run/message identities intentionally survive projection/message purge.
  -- Their scope is checked against the operation while the history is written.
  run_id uuid NOT NULL,
  account_id uuid NOT NULL
    REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('insert', 'update', 'delete')),
  previous_assignment jsonb,
  next_assignment jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, message_id),
  CHECK (
    (change_type = 'insert' AND previous_assignment IS NULL AND next_assignment IS NOT NULL)
    OR (change_type = 'update' AND previous_assignment IS NOT NULL AND next_assignment IS NOT NULL)
    OR (change_type = 'delete' AND previous_assignment IS NOT NULL AND next_assignment IS NULL)
  ),
  CHECK (previous_assignment IS NULL OR jsonb_typeof(previous_assignment) = 'object'),
  CHECK (next_assignment IS NULL OR jsonb_typeof(next_assignment) = 'object')
);

CREATE INDEX IF NOT EXISTS imap_thread_assignment_history_account_recorded_idx
  ON public.imap_thread_assignment_history (account_id, recorded_at DESC, id);
CREATE INDEX IF NOT EXISTS imap_thread_assignment_history_message_idx
  ON public.imap_thread_assignment_history (message_id, recorded_at DESC, id);
CREATE INDEX IF NOT EXISTS imap_thread_assignment_history_run_idx
  ON public.imap_thread_assignment_history (run_id, recorded_at DESC, id);

CREATE OR REPLACE VIEW public.imap_thread_active_assignments
WITH (security_invoker = true, security_barrier = true)
AS
SELECT assignment.*
FROM public.imap_thread_state state
JOIN public.imap_thread_runs run
  ON run.id = state.active_run_id
 AND run.account_id = state.account_id
 AND run.status = 'active'
JOIN public.imap_thread_assignments assignment
  ON assignment.run_id = run.id
 AND assignment.account_id = state.account_id;

-- Database-owned write barrier/outbox. This is intentionally below the
-- repository layer: during a rolling deploy, an older sync worker does not know
-- how to fan evidence changes out to shadow/rollback runs. The trigger takes the
-- same small state-row SHARE lock as new workers, advances a monotonic clock,
-- and idempotently queues every state-referenced run.
CREATE OR REPLACE FUNCTION public.imap_thread_capture_evidence_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  scoped_account uuid;
  scoped_message uuid;
  state_active uuid;
  state_previous uuid;
  state_building uuid;
  run_ids uuid[];
BEGIN
  IF TG_TABLE_NAME = 'imap_messages' THEN
    scoped_account := CASE WHEN TG_OP = 'DELETE' THEN OLD.account_id ELSE NEW.account_id END;
    scoped_message := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;

    IF TG_OP = 'UPDATE' AND ROW(
      OLD.account_id, OLD.folder_path, OLD.uidvalidity, OLD.uid,
      OLD.rfc_message_id, OLD.references_header, OLD.in_reply_to,
      OLD.provider_message_id, OLD.provider_message_id_namespace,
      OLD.provider_thread_id, OLD.provider_thread_id_namespace,
      OLD.internal_date, OLD.size_bytes, OLD.subject, OLD.from_email,
      OLD.to_emails, OLD.cc_emails, OLD.bcc_emails, OLD.headers_json
    ) IS NOT DISTINCT FROM ROW(
      NEW.account_id, NEW.folder_path, NEW.uidvalidity, NEW.uid,
      NEW.rfc_message_id, NEW.references_header, NEW.in_reply_to,
      NEW.provider_message_id, NEW.provider_message_id_namespace,
      NEW.provider_thread_id, NEW.provider_thread_id_namespace,
      NEW.internal_date, NEW.size_bytes, NEW.subject, NEW.from_email,
      NEW.to_emails, NEW.cc_emails, NEW.bcc_emails, NEW.headers_json
    ) THEN
      RETURN NEW;
    END IF;
  ELSE
    scoped_message := CASE WHEN TG_OP = 'DELETE' THEN OLD.message_id ELSE NEW.message_id END;
    IF TG_OP = 'UPDATE' AND ROW(OLD.raw_mime_sha256, OLD.headers_json)
      IS NOT DISTINCT FROM ROW(NEW.raw_mime_sha256, NEW.headers_json) THEN
      RETURN NEW;
    END IF;
    SELECT message.account_id INTO scoped_account
    FROM public.imap_messages message WHERE message.id = scoped_message;
    IF scoped_account IS NULL THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  -- Account deletion cascades through messages after the parent is no longer a
  -- valid queue target. There is no surviving reader projection to repair.
  IF NOT EXISTS (
    SELECT 1 FROM public.imap_accounts account WHERE account.id = scoped_account
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.imap_thread_state (account_id)
  SELECT account.id FROM public.imap_accounts account WHERE account.id = scoped_account
  ON CONFLICT (account_id) DO NOTHING;
  INSERT INTO public.imap_thread_evidence_clock (account_id)
  SELECT account.id FROM public.imap_accounts account WHERE account.id = scoped_account
  ON CONFLICT (account_id) DO NOTHING;

  SELECT state.active_run_id, state.previous_run_id, state.building_run_id
  INTO state_active, state_previous, state_building
  FROM public.imap_thread_state state
  WHERE state.account_id = scoped_account
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  UPDATE public.imap_thread_evidence_clock
  SET revision = revision + 1
  WHERE account_id = scoped_account;
  run_ids := array_remove(ARRAY[state_active, state_previous, state_building]::uuid[], NULL);

  IF TG_TABLE_NAME = 'imap_messages' AND TG_OP = 'DELETE' THEN
    -- One surviving seed per affected stored component is enough: bounded
    -- closure expansion will recover the rest. This avoids an unbounded delete
    -- trigger while still repairing roots, copies, provider groups, and parents.
    WITH affected AS (
      SELECT assignment.run_id, assignment.account_id,
             assignment.conversation_id, assignment.subject_key
      FROM public.imap_thread_assignments assignment
      WHERE assignment.message_id = scoped_message
        AND assignment.run_id = ANY(run_ids)
    ), seeds AS (
      SELECT affected.run_id, affected.account_id,
             min(candidate.message_id::text)::uuid AS message_id
      FROM affected
      JOIN public.imap_thread_assignments candidate
        ON candidate.run_id = affected.run_id
       AND candidate.conversation_id = affected.conversation_id
       AND candidate.message_id <> scoped_message
      GROUP BY affected.run_id, affected.account_id
    )
    INSERT INTO public.imap_thread_work_queue (
      run_id, message_id, account_id, reason, attempts, available_at,
      last_error, enqueued_at, updated_at
    )
    SELECT seed.run_id, seed.message_id, seed.account_id,
           'message_deleted', 0, now(), NULL, now(), now()
    FROM seeds seed
    ON CONFLICT (run_id, message_id) DO UPDATE SET
      reason = EXCLUDED.reason, attempts = 0, available_at = now(),
      last_error = NULL, enqueued_at = now(), updated_at = now();

    INSERT INTO public.imap_thread_subject_work (
      run_id, account_id, subject_key, attempts, available_at,
      last_error, enqueued_at, updated_at
    )
    SELECT DISTINCT assignment.run_id, assignment.account_id,
           assignment.subject_key, 0, now(), NULL, now(), now()
    FROM public.imap_thread_assignments assignment
    WHERE assignment.message_id = scoped_message
      AND assignment.run_id = ANY(run_ids)
      AND assignment.subject_key IS NOT NULL
    ON CONFLICT (run_id, subject_key) DO UPDATE SET
      attempts = 0, available_at = now(), last_error = NULL,
      enqueued_at = now(), updated_at = now();

    -- Even deleting the only subjectless message advances the evidence clock.
    -- A compact no-member sentinel gives every referenced run one bounded turn
    -- to acknowledge that revision; otherwise it could remain permanently
    -- "stale" with no queue item to consume.
    INSERT INTO public.imap_thread_subject_work (
      run_id, account_id, subject_key, attempts, available_at,
      last_error, enqueued_at, updated_at
    )
    SELECT run_id, scoped_account, repeat('0', 64),
           0, now(), NULL, now(), now()
    FROM unnest(run_ids) AS run_id
    ON CONFLICT (run_id, subject_key) DO UPDATE SET
      attempts = 0, available_at = now(), last_error = NULL,
      enqueued_at = now(), updated_at = now();
    RETURN OLD;
  END IF;

  INSERT INTO public.imap_thread_work_queue (
    run_id, message_id, account_id, reason, attempts, available_at,
    last_error, enqueued_at, updated_at
  )
  SELECT run_id, scoped_message, scoped_account,
         CASE WHEN TG_TABLE_NAME = 'imap_message_bodies'
              THEN 'body_evidence_changed' ELSE 'message_evidence_changed' END,
         0, now(), NULL, now(), now()
  FROM unnest(run_ids) AS run_id
  ON CONFLICT (run_id, message_id) DO UPDATE SET
    reason = EXCLUDED.reason, attempts = 0, available_at = now(),
    last_error = NULL, enqueued_at = now(), updated_at = now();

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS imap_messages_capture_thread_evidence ON public.imap_messages;
CREATE TRIGGER imap_messages_capture_thread_evidence
  AFTER INSERT OR UPDATE OF
    account_id, folder_path, uidvalidity, uid, rfc_message_id,
    references_header, in_reply_to, provider_message_id,
    provider_message_id_namespace, provider_thread_id,
    provider_thread_id_namespace, internal_date, size_bytes, subject,
    from_email, to_emails, cc_emails, bcc_emails, headers_json
  ON public.imap_messages
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_capture_evidence_change();

DROP TRIGGER IF EXISTS imap_messages_capture_thread_delete ON public.imap_messages;
CREATE TRIGGER imap_messages_capture_thread_delete
  BEFORE DELETE ON public.imap_messages
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_capture_evidence_change();

DROP TRIGGER IF EXISTS imap_message_bodies_capture_thread_evidence ON public.imap_message_bodies;
CREATE TRIGGER imap_message_bodies_capture_thread_evidence
  AFTER INSERT OR UPDATE OF raw_mime_sha256, headers_json OR DELETE
  ON public.imap_message_bodies
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_capture_evidence_change();

-- Enforce every denormalized account key and cross-run pointer at the database
-- boundary without building another large composite index on imap_messages.
CREATE OR REPLACE FUNCTION public.imap_thread_assert_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  scoped_account uuid;
  scoped_run uuid;
  scoped_algorithm_version integer;
  source_algorithm_version integer;
  active_algorithm_version integer;
  building_algorithm_version integer;
BEGIN
  IF TG_TABLE_NAME = 'imap_thread_runs' THEN
    IF NEW.source_run_id IS NOT NULL THEN
      SELECT r.account_id, r.algorithm_version
      INTO scoped_account, source_algorithm_version
      FROM public.imap_thread_runs r
      WHERE r.id = NEW.source_run_id;
      IF scoped_account IS DISTINCT FROM NEW.account_id THEN
        RAISE EXCEPTION 'thread source run belongs to another account';
      END IF;
      IF source_algorithm_version > NEW.algorithm_version THEN
        RAISE EXCEPTION 'thread source run uses a newer algorithm version';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'imap_thread_state' THEN
    IF NEW.active_run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.imap_thread_runs r
      WHERE r.id = NEW.active_run_id
        AND r.account_id = NEW.account_id
        AND r.status = 'active'
    ) THEN RAISE EXCEPTION 'active thread run belongs to another account'; END IF;
    IF NEW.previous_run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.imap_thread_runs r
      WHERE r.id = NEW.previous_run_id
        AND r.account_id = NEW.account_id
        AND r.status IN ('standby', 'rolled_back', 'archived')
    ) THEN RAISE EXCEPTION 'previous thread run belongs to another account'; END IF;
    IF NEW.building_run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.imap_thread_runs r
      WHERE r.id = NEW.building_run_id
        AND r.account_id = NEW.account_id
        AND r.status IN ('building', 'ready')
    ) THEN RAISE EXCEPTION 'building thread run belongs to another account'; END IF;
    IF NEW.active_run_id IS NOT NULL AND NEW.building_run_id IS NOT NULL THEN
      SELECT algorithm_version INTO active_algorithm_version
      FROM public.imap_thread_runs WHERE id = NEW.active_run_id;
      SELECT algorithm_version INTO building_algorithm_version
      FROM public.imap_thread_runs WHERE id = NEW.building_run_id;
      IF building_algorithm_version < active_algorithm_version THEN
        RAISE EXCEPTION 'building thread run uses an older algorithm than the active run';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME IN ('imap_thread_assignments', 'imap_thread_work_queue') THEN
    SELECT r.account_id, r.algorithm_version
    INTO scoped_account, scoped_algorithm_version
    FROM public.imap_thread_runs r WHERE r.id = NEW.run_id;
    IF scoped_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'thread row run belongs to another account';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.imap_messages m
      WHERE m.id = NEW.message_id AND m.account_id = NEW.account_id
    ) THEN RAISE EXCEPTION 'thread row message belongs to another account'; END IF;
    IF TG_TABLE_NAME = 'imap_thread_assignments' THEN
      IF NEW.algorithm_version IS DISTINCT FROM scoped_algorithm_version THEN
        RAISE EXCEPTION 'thread assignment algorithm version differs from its run';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'imap_thread_subject_work' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.imap_thread_runs r
      WHERE r.id = NEW.run_id AND r.account_id = NEW.account_id
    ) THEN RAISE EXCEPTION 'thread subject work run belongs to another account'; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'imap_thread_operations' THEN
    SELECT r.account_id, r.algorithm_version
    INTO scoped_account, scoped_algorithm_version
    FROM public.imap_thread_runs r WHERE r.id = NEW.run_id;
    IF scoped_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'thread operation run belongs to another account';
    END IF;
    IF NEW.algorithm_version IS DISTINCT FROM scoped_algorithm_version THEN
      RAISE EXCEPTION 'thread operation algorithm version differs from its run';
    END IF;
    IF NEW.reverses_operation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.imap_thread_operations o
      WHERE o.id = NEW.reverses_operation_id
        AND o.account_id = NEW.account_id
        AND o.run_id = NEW.run_id
        AND o.algorithm_version = NEW.algorithm_version
    ) THEN RAISE EXCEPTION 'reversed thread operation scope mismatch'; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'imap_thread_run_comparisons' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.imap_thread_runs baseline
      WHERE baseline.id = NEW.baseline_run_id
        AND baseline.account_id = NEW.account_id
        AND baseline.algorithm_version = NEW.baseline_algorithm_version
    ) THEN RAISE EXCEPTION 'thread comparison baseline scope mismatch'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.imap_thread_runs candidate
      WHERE candidate.id = NEW.candidate_run_id
        AND candidate.account_id = NEW.account_id
        AND candidate.algorithm_version = NEW.candidate_algorithm_version
    ) THEN RAISE EXCEPTION 'thread comparison candidate scope mismatch'; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'imap_thread_assignment_history' THEN
    SELECT o.account_id, o.run_id, o.algorithm_version
    INTO scoped_account, scoped_run, scoped_algorithm_version
    FROM public.imap_thread_operations o WHERE o.id = NEW.operation_id;
    IF scoped_account IS DISTINCT FROM NEW.account_id OR scoped_run IS DISTINCT FROM NEW.run_id THEN
      RAISE EXCEPTION 'thread history operation scope mismatch';
    END IF;
    IF EXISTS (SELECT 1 FROM public.imap_messages m WHERE m.id = NEW.message_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.imap_messages m
        WHERE m.id = NEW.message_id AND m.account_id = NEW.account_id
      ) THEN RAISE EXCEPTION 'thread history message belongs to another account'; END IF;
    IF NEW.previous_assignment IS NOT NULL AND (
      NEW.previous_assignment->>'run_id' IS DISTINCT FROM NEW.run_id::text
      OR NEW.previous_assignment->>'message_id' IS DISTINCT FROM NEW.message_id::text
      OR NEW.previous_assignment->>'account_id' IS DISTINCT FROM NEW.account_id::text
      OR NEW.previous_assignment->>'algorithm_version' IS DISTINCT FROM scoped_algorithm_version::text
    ) THEN RAISE EXCEPTION 'previous thread assignment snapshot scope mismatch'; END IF;
    IF NEW.next_assignment IS NOT NULL AND (
      NEW.next_assignment->>'run_id' IS DISTINCT FROM NEW.run_id::text
      OR NEW.next_assignment->>'message_id' IS DISTINCT FROM NEW.message_id::text
      OR NEW.next_assignment->>'account_id' IS DISTINCT FROM NEW.account_id::text
      OR NEW.next_assignment->>'algorithm_version' IS DISTINCT FROM scoped_algorithm_version::text
    ) THEN RAISE EXCEPTION 'next thread assignment snapshot scope mismatch'; END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS imap_thread_runs_assert_scope ON public.imap_thread_runs;
CREATE TRIGGER imap_thread_runs_assert_scope
  BEFORE INSERT OR UPDATE ON public.imap_thread_runs
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_assert_scope();
DROP TRIGGER IF EXISTS imap_thread_state_assert_scope ON public.imap_thread_state;
CREATE TRIGGER imap_thread_state_assert_scope
  BEFORE INSERT OR UPDATE ON public.imap_thread_state
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_assert_scope();
DROP TRIGGER IF EXISTS imap_thread_assignments_assert_scope ON public.imap_thread_assignments;
CREATE TRIGGER imap_thread_assignments_assert_scope
  BEFORE INSERT OR UPDATE ON public.imap_thread_assignments
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_assert_scope();
DROP TRIGGER IF EXISTS imap_thread_work_queue_assert_scope ON public.imap_thread_work_queue;
CREATE TRIGGER imap_thread_work_queue_assert_scope
  BEFORE INSERT OR UPDATE ON public.imap_thread_work_queue
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_assert_scope();
DROP TRIGGER IF EXISTS imap_thread_subject_work_assert_scope ON public.imap_thread_subject_work;
CREATE TRIGGER imap_thread_subject_work_assert_scope
  BEFORE INSERT OR UPDATE ON public.imap_thread_subject_work
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_assert_scope();
DROP TRIGGER IF EXISTS imap_thread_operations_assert_scope ON public.imap_thread_operations;
CREATE TRIGGER imap_thread_operations_assert_scope
  BEFORE INSERT OR UPDATE ON public.imap_thread_operations
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_assert_scope();
DROP TRIGGER IF EXISTS imap_thread_assignment_history_assert_scope ON public.imap_thread_assignment_history;
CREATE TRIGGER imap_thread_assignment_history_assert_scope
  BEFORE INSERT OR UPDATE ON public.imap_thread_assignment_history
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_assert_scope();
DROP TRIGGER IF EXISTS imap_thread_run_comparisons_assert_scope ON public.imap_thread_run_comparisons;
CREATE TRIGGER imap_thread_run_comparisons_assert_scope
  BEFORE INSERT OR UPDATE ON public.imap_thread_run_comparisons
  FOR EACH ROW EXECUTE FUNCTION public.imap_thread_assert_scope();

REVOKE ALL ON FUNCTION public.imap_thread_assert_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.imap_thread_capture_evidence_change() FROM PUBLIC;

ALTER TABLE public.imap_thread_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imap_thread_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imap_thread_evidence_clock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imap_thread_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imap_thread_work_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imap_thread_subject_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imap_thread_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imap_thread_run_comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imap_thread_assignment_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.imap_thread_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.imap_thread_state FROM PUBLIC;
REVOKE ALL ON TABLE public.imap_thread_evidence_clock FROM PUBLIC;
REVOKE ALL ON TABLE public.imap_thread_assignments FROM PUBLIC;
REVOKE ALL ON TABLE public.imap_thread_work_queue FROM PUBLIC;
REVOKE ALL ON TABLE public.imap_thread_subject_work FROM PUBLIC;
REVOKE ALL ON TABLE public.imap_thread_operations FROM PUBLIC;
REVOKE ALL ON TABLE public.imap_thread_run_comparisons FROM PUBLIC;
REVOKE ALL ON TABLE public.imap_thread_assignment_history FROM PUBLIC;
REVOKE ALL ON TABLE public.imap_thread_active_assignments FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.imap_thread_runs FROM anon;
    REVOKE ALL ON TABLE public.imap_thread_state FROM anon;
    REVOKE ALL ON TABLE public.imap_thread_evidence_clock FROM anon;
    REVOKE ALL ON TABLE public.imap_thread_assignments FROM anon;
    REVOKE ALL ON TABLE public.imap_thread_work_queue FROM anon;
    REVOKE ALL ON TABLE public.imap_thread_subject_work FROM anon;
    REVOKE ALL ON TABLE public.imap_thread_operations FROM anon;
    REVOKE ALL ON TABLE public.imap_thread_run_comparisons FROM anon;
    REVOKE ALL ON TABLE public.imap_thread_assignment_history FROM anon;
    REVOKE ALL ON TABLE public.imap_thread_active_assignments FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.imap_thread_runs FROM authenticated;
    REVOKE ALL ON TABLE public.imap_thread_state FROM authenticated;
    REVOKE ALL ON TABLE public.imap_thread_evidence_clock FROM authenticated;
    REVOKE ALL ON TABLE public.imap_thread_assignments FROM authenticated;
    REVOKE ALL ON TABLE public.imap_thread_work_queue FROM authenticated;
    REVOKE ALL ON TABLE public.imap_thread_subject_work FROM authenticated;
    REVOKE ALL ON TABLE public.imap_thread_operations FROM authenticated;
    REVOKE ALL ON TABLE public.imap_thread_run_comparisons FROM authenticated;
    REVOKE ALL ON TABLE public.imap_thread_assignment_history FROM authenticated;
    REVOKE ALL ON TABLE public.imap_thread_active_assignments FROM authenticated;
  END IF;
END
$$;
