import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPublicMigrations,
  getRequiredPublicSchemaVersion,
  readPublicMigrationManifest,
  readPublicMigrations
} from "../db.js";

const publicMigrationPath = resolve(process.cwd(), "supabase/migrations/public/0001_imap_mirror.sql");
const stuckDegradedMigrationPath = resolve(process.cwd(), "supabase/migrations/public/0002_stuck_degraded_escalation.sql");
const folderCapMigrationPath = resolve(process.cwd(), "supabase/migrations/public/0003_folder_count_cap_pending_verification.sql");
const accountSettingsMigrationPath = resolve(process.cwd(), "supabase/migrations/public/0004_account_lane_settings.sql");
const progressRollupMigrationPath = resolve(process.cwd(), "supabase/migrations/public/0005_progress_rollup.sql");
const historyLaneMigrationPath = resolve(process.cwd(), "supabase/migrations/public/0006_history_lane_state.sql");
const optionalRawMimeMigrationPath = resolve(process.cwd(), "supabase/migrations/public/0007_optional_raw_mime.sql");
const searchLayerMigrationPath = resolve(process.cwd(), "supabase/migrations/public/0008_search_layer.sql");
const conversationThreadingMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/public/0014_conversation_threading.sql"
);
const messageEvidenceMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/public/0016_message_evidence.sql"
);
const threadingBodyBackfillIndexMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/public/0017_threading_body_backfill_index.sql"
);

describe("initial schema", () => {
  it("contains the neutral mirror tables and raw body storage", async () => {
    const sql = await readFile(publicMigrationPath, "utf8");

    for (const table of [
      "imap_accounts",
      "imap_folders",
      "imap_messages",
      "imap_message_bodies",
      "imap_attachments",
      "imap_sync_runs",
      "imap_sync_events"
    ]) {
      expect(sql).toContain(`public.${table}`);
    }

    expect(sql).toContain("raw_mime bytea NOT NULL");
    expect(sql).toContain("body_fetch_policy");
    expect(sql).toContain("email_address text NOT NULL");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS imap_accounts_email_address_lower_uidx");
  });

  it("keeps repeat local dry runs and Supabase advisors clean", async () => {
    const sql = await readFile(publicMigrationPath, "utf8");

    for (const trigger of [
      "imap_accounts_set_updated_at",
      "imap_folders_set_updated_at",
      "imap_messages_set_updated_at",
      "imap_message_bodies_set_updated_at"
    ]) {
      expect(sql).toContain(`DROP TRIGGER IF EXISTS ${trigger}`);
    }

    expect(sql.match(/SET search_path = ''/g)).toHaveLength(1);
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.imap_encrypt_password");
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.imap_decrypt_password");
    expect(sql).not.toContain("pgp_sym_encrypt");
    expect(sql).not.toContain("pgp_sym_decrypt");
  });

  it("locks down Supabase Data API exposure by default", async () => {
    const sql = await readFile(publicMigrationPath, "utf8");

    for (const table of [
      "imap_accounts",
      "imap_folders",
      "imap_messages",
      "imap_message_bodies",
      "imap_attachments",
      "imap_sync_runs",
      "imap_sync_events"
    ]) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM authenticated`);
    }

    expect(sql).not.toContain("REVOKE EXECUTE ON FUNCTION public.imap_encrypt_password");
    expect(sql).not.toContain("REVOKE EXECUTE ON FUNCTION public.imap_decrypt_password");
  });

  it("deduplicates attachments by stable MIME part number", async () => {
    const sql = await readFile(publicMigrationPath, "utf8");

    expect(sql).toContain("UNIQUE (message_id, part_number)");
    expect(sql).not.toContain("UNIQUE (message_id, part_number, content_id, filename)");
  });

  it("serializes programmatic public migration calls with an advisory lock", async () => {
    expect(applyPublicMigrations.toString()).toContain("pg_advisory_lock(hashtext('supamail.public_migrations'))");
  });

  it("exposes an ordered public migration manifest for hosted deploy gates", async () => {
    const manifest = await readPublicMigrationManifest();
    const version = await getRequiredPublicSchemaVersion();
    const sql = await readPublicMigrations();

    expect(version).toBe("0017_threading_body_backfill_index");
    expect(manifest).toEqual({
      schemaVersion: "0017_threading_body_backfill_index",
      migrations: [
        { id: "0001_imap_mirror", file: "0001_imap_mirror.sql" },
        { id: "0002_stuck_degraded_escalation", file: "0002_stuck_degraded_escalation.sql" },
        { id: "0003_folder_count_cap_pending_verification", file: "0003_folder_count_cap_pending_verification.sql" },
        { id: "0004_account_lane_settings", file: "0004_account_lane_settings.sql" },
        { id: "0005_progress_rollup", file: "0005_progress_rollup.sql" },
        { id: "0006_history_lane_state", file: "0006_history_lane_state.sql" },
        { id: "0007_optional_raw_mime", file: "0007_optional_raw_mime.sql" },
        { id: "0008_search_layer", file: "0008_search_layer.sql" },
        { id: "0009_smtp_send", file: "0009_smtp_send.sql" },
        { id: "0010_search_recipient_indexes", file: "0010_search_recipient_indexes.sql" },
        { id: "0011_webhook_emit_indexes", file: "0011_webhook_emit_indexes.sql" },
        { id: "0012_sync_events_retention_index", file: "0012_sync_events_retention_index.sql" },
        { id: "0013_body_head_trigram_index", file: "0013_body_head_trigram_index.sql" },
        { id: "0014_conversation_threading", file: "0014_conversation_threading.sql" },
        { id: "0015_threading_production_hardening", file: "0015_threading_production_hardening.sql" },
        { id: "0016_message_evidence", file: "0016_message_evidence.sql" },
        { id: "0017_threading_body_backfill_index", file: "0017_threading_body_backfill_index.sql" }
      ]
    });
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.imap_accounts");
    expect(sql).toContain("last_priority_sync_succeeded_at timestamptz");
    expect(sql).toContain("folder_count_cap_override integer");
    expect(sql).toContain("'PENDING_VERIFICATION'");
    expect(sql).toContain("live_window_days int NOT NULL DEFAULT 90");
    expect(sql).toContain("historical_backfill_mode text NOT NULL DEFAULT 'metadata_and_bodies'");
    expect(sql).toContain("CREATE VIEW public.imap_account_progress");
    expect(sql).toContain("headers_synced_count int NOT NULL DEFAULT 0");
    expect(sql).toContain("last_archive_refresh_at timestamptz");
    expect(sql).toContain("ALTER COLUMN raw_mime DROP NOT NULL");
    expect(sql).toContain("imap_message_bodies_body_head_trgm_idx");
    expect(sql).toContain("left(coalesce(body_text, body_plain, selected_text_part, ''), 131072)");
    expect(sql).toContain("parsed_delivery_sha256 text");
    expect(sql).toContain("cursor_message_id uuid");
    expect(sql).toContain("imap_messages_created_emit_idx");
    expect(sql).toContain("imap_messages_updated_emit_idx");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.imap_thread_assignments");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.imap_thread_work_queue");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.imap_thread_operations");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.imap_thread_assignment_history");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.imap_message_evidence");
    expect(sql).toContain("imap_message_bodies_thread_digest_backfill_idx");
  });

  it("keeps sparse legacy body-digest repair on a bounded partial index", async () => {
    const sql = await readFile(threadingBodyBackfillIndexMigrationPath, "utf8");

    expect(sql).toContain("CREATE INDEX IF NOT EXISTS imap_message_bodies_thread_digest_backfill_idx");
    expect(sql).toContain("ON public.imap_message_bodies (message_id)");
    expect(sql).toContain("raw_mime_sha256 IS NULL");
    expect(sql).toContain("parsed_delivery_sha256 IS NULL");
    expect(sql).toContain("NOT raw_truncated");
  });

  it("stores bounded, private, joinable message evidence with extraction coverage", async () => {
    const sql = await readFile(messageEvidenceMigrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.imap_message_evidence");
    expect(sql).toContain("structured_evidence_extractor_version text");
    expect(sql).toContain("structured_evidence_sha256 text");
    expect(sql).toContain("structured_evidence_complete boolean");
    expect(sql).toContain("UNIQUE (message_id, extractor, kind, namespace, evidence_key_sha256)");
    expect(sql).toContain("imap_message_evidence_join_idx");
    expect(sql).toContain("octet_length(evidence_key) <= 2048");
    expect(sql).toContain("octet_length(metadata::text) <= 16384");
    expect(sql).toContain("ALTER TABLE public.imap_message_evidence ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON TABLE public.imap_message_evidence FROM anon");
    expect(sql).toContain("REVOKE ALL ON TABLE public.imap_message_evidence FROM authenticated");
  });

  it("adds safe versioned shadow-run conversation threading", async () => {
    const sql = await readFile(conversationThreadingMigrationPath, "utf8");
    const indexStatements = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]*?;/gi) ?? [];
    const indexedSql = indexStatements.join("\n");
    const operationsDefinition = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS public.imap_thread_operations"),
      sql.indexOf("CREATE INDEX IF NOT EXISTS imap_thread_operations_account_created_idx")
    );
    const historyDefinition = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS public.imap_thread_assignment_history"),
      sql.indexOf("CREATE INDEX IF NOT EXISTS imap_thread_assignment_history_account_recorded_idx")
    );

    // Installing on a populated pre-0014 mirror is metadata-only: nullable
    // columns plus NOT VALID checks, with no large-table index build or DML.
    for (const column of [
      "ADD COLUMN IF NOT EXISTS provider_message_id text",
      "ADD COLUMN IF NOT EXISTS provider_message_id_namespace text",
      "ADD COLUMN IF NOT EXISTS provider_thread_id_namespace text",
      "ADD COLUMN IF NOT EXISTS raw_mime_sha256 text"
    ]) {
      expect(sql).toContain(column);
    }
    for (const constraint of [
      "imap_messages_provider_message_identity_check",
      "imap_messages_provider_thread_namespace_check",
      "imap_message_bodies_raw_mime_sha256_check"
    ]) {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      expect(start).toBeGreaterThan(-1);
      expect(sql.slice(start, sql.indexOf(";", start))).toContain("NOT VALID");
    }
    expect(sql).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
    expect(indexStatements.some((statement) =>
      /ON\s+public\.imap_(?:messages|message_bodies)\b/i.test(statement)
    )).toBe(false);
    expect(sql).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.imap_(?:messages|message_bodies)\b/i);

    // parsed_only may discard raw_mime after hashing. A present digest is still
    // exactly lowercase SHA-256 and can never describe truncated bytes.
    expect(sql).toMatch(/raw_mime_sha256\s+IS\s+NULL[\s\S]*?raw_mime_sha256\s+~\s+'\^\[0-9a-f\]\{64\}\$'[\s\S]*?AND\s+NOT\s+raw_truncated/);
    expect(sql).not.toMatch(/raw_mime\s+IS\s+NOT\s+NULL[\s\S]*?raw_mime_sha256/);
    expect(sql).toContain("(provider_message_id IS NULL) = (provider_message_id_namespace IS NULL)");
    expect(sql).toContain("provider_thread_id_namespace IS NULL OR provider_thread_id IS NOT NULL");

    for (const table of [
      "imap_thread_runs",
      "imap_thread_state",
      "imap_thread_evidence_clock",
      "imap_thread_assignments",
      "imap_thread_work_queue",
      "imap_thread_subject_work",
      "imap_thread_operations",
      "imap_thread_run_comparisons",
      "imap_thread_assignment_history"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM authenticated`);
    }

    // Each run is isolated. Queue/assignment keys cannot be consumed across a
    // rolling algorithm upgrade, and the trigger validates denormalized scope.
    expect(sql).toContain("PRIMARY KEY (run_id, message_id)");
    expect(sql).toContain("PRIMARY KEY (run_id, subject_key)");
    expect(sql).toContain("thread assignment algorithm version differs from its run");
    expect(sql).toContain("thread operation algorithm version differs from its run");
    expect(sql).toContain("building thread run uses an older algorithm than the active run");
    expect(sql).toContain("thread source run uses a newer algorithm version");
    expect(sql).toContain("reversed thread operation scope mismatch");
    expect(sql).toContain("thread history operation scope mismatch");
    expect(sql).toContain("previous thread assignment snapshot scope mismatch");
    expect(sql).toContain("next thread assignment snapshot scope mismatch");
    expect(sql).toContain("thread comparison baseline scope mismatch");
    expect(sql).toContain("thread comparison candidate scope mismatch");
    expect(sql).toContain("CREATE TRIGGER imap_messages_capture_thread_evidence");
    expect(sql).toContain("CREATE TRIGGER imap_message_bodies_capture_thread_evidence");
    expect(sql).toContain("CREATE TRIGGER imap_messages_capture_thread_delete");
    expect(sql).toContain("caught_up_revision bigint NOT NULL DEFAULT 0");
    expect(sql).toContain("evidence_revision bigint NOT NULL");

    // Raw evidence stays inspectable but unindexed. Every indexed identity is a
    // fixed-size digest, including each array member used by GIN.
    for (const rawColumn of [
      "strict_message_id",
      "root_reference",
      "parent_reference",
      "reference_ids",
      "subject_base",
      "provider_thread_key",
      "evidence"
    ]) {
      expect(indexedSql).not.toMatch(new RegExp(`\\b${rawColumn}\\b`));
    }
    for (const fixedHash of [
      "delivery_key text NOT NULL CHECK (delivery_key ~ '^[0-9a-f]{64}$')",
      "strict_message_id_hash text",
      "root_reference_hash text",
      "parent_reference_hash text",
      "parent_delivery_key text",
      "subject_key text",
      "provider_thread_hash text",
      "input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$')"
    ]) {
      expect(sql).toContain(fixedHash);
    }
    expect(sql).toContain("(provider_thread_key IS NULL) = (provider_thread_hash IS NULL)");
    expect(sql).toContain("cardinality(reference_ids) = cardinality(reference_hashes)");
    expect(sql).toContain("array_to_string(reference_hashes, ',') ~ '^([0-9a-f]{64})(,[0-9a-f]{64})*$'");
    expect(sql).toContain("array_to_string(participant_edge_hashes, ',') ~ '^([0-9a-f]{64})(,[0-9a-f]{64})*$'");
    expect(sql).toContain("USING gin (run_id, reference_hashes)");
    expect(sql).toContain("USING gin (run_id, participant_edge_hashes)");

    // The active projection is one account-scoped pointer swap. It fails closed
    // on status drift and remains a security-invoker, service-only view.
    expect(sql).toContain("account_id uuid PRIMARY KEY");
    expect(sql).toContain("scheduler_cursor integer NOT NULL DEFAULT 0");
    expect(sql).toContain("CHECK (scheduler_cursor BETWEEN 0 AND 4)");
    expect(sql).toContain("active_account_id uuid GENERATED ALWAYS AS");
    expect(sql).toContain("UNIQUE (active_account_id) DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("active_run_id IS DISTINCT FROM building_run_id");
    expect(sql).toContain("WITH (security_invoker = true, security_barrier = true)");
    expect(sql).toContain("run.id = state.active_run_id");
    expect(sql).toContain("run.status = 'active'");
    expect(sql).toContain("assignment.run_id = run.id");
    expect(sql).toContain("REVOKE ALL ON TABLE public.imap_thread_active_assignments FROM PUBLIC");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.imap_thread_assert_scope() FROM PUBLIC");

    // Lifecycle checks reject impossible run/operation states while allowing a
    // deferred active-run swap during activation rollback.
    expect(sql).toContain("status = 'building' AND stage <> 'ready'");
    expect(sql).toContain("status IN ('ready', 'active', 'standby', 'archived', 'rolled_back') AND stage = 'ready'");
    expect(sql).toContain("(status = 'building') = (completed_at IS NULL)");
    expect(sql).toContain("status text NOT NULL DEFAULT 'pending'");
    expect(sql).toContain("operation_type <> 'rollback' OR reverses_operation_id IS NOT NULL");
    expect(sql).toContain("to_generation IS NULL OR to_generation > from_generation");
    expect(sql).toContain("status = 'rolled_back' AND started_at IS NOT NULL AND completed_at IS NOT NULL");

    // Assignment/history decisions remain explainable and reversible. Audit
    // operations and snapshots deliberately have no run/message purge FK.
    for (const method of [
      "'references'",
      "'in_reply_to'",
      "'provider_thread'",
      "'subject_fallback'",
      "'standalone'"
    ]) {
      expect(sql).toContain(method);
    }
    expect(sql).toContain("previous_assignment jsonb");
    expect(sql).toContain("next_assignment jsonb");
    expect(sql).toContain("UNIQUE (operation_id, message_id)");
    expect(operationsDefinition).toContain("run_id uuid NOT NULL");
    expect(operationsDefinition).not.toMatch(/run_id uuid NOT NULL\s+REFERENCES public\.imap_thread_runs/);
    expect(historyDefinition).toContain("run_id uuid NOT NULL");
    expect(historyDefinition).toContain("message_id uuid NOT NULL");
    expect(historyDefinition).not.toMatch(/(?:run_id|message_id) uuid NOT NULL\s+REFERENCES/);

    // Replayed public migrations remain transaction-safe and public-core-only.
    expect(sql).not.toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/stripe/i);
    expect(sql).not.toContain("tenant");
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+public\.imap_thread_assignments\b/i);
  });

  it("adds stuck-degraded escalation state without control-plane tables", async () => {
    const sql = await readFile(stuckDegradedMigrationPath, "utf8");

    expect(sql).toContain("ALTER TABLE public.imap_accounts");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS last_priority_sync_succeeded_at timestamptz");
    expect(sql).not.toContain("stripe");
    expect(sql).not.toContain("tenant");
  });

  it("adds folder-count cap override and pending verification state without control-plane tables", async () => {
    const sql = await readFile(folderCapMigrationPath, "utf8");

    expect(sql).toContain("ALTER TABLE public.imap_accounts");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS folder_count_cap_override integer");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS imap_folders_status_check");
    expect(sql).toContain("ADD CONSTRAINT imap_folders_status_check");
    expect(sql).toContain("'PENDING_VERIFICATION'");
    expect(sql).not.toContain("stripe");
    expect(sql).not.toContain("tenant");
  });

  it("adds account lane settings with defaults and checks without control-plane tables", async () => {
    const sql = await readFile(accountSettingsMigrationPath, "utf8");

    expect(sql).toContain("ALTER TABLE public.imap_accounts");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS live_window_days int NOT NULL DEFAULT 90");
    expect(sql).toContain("CHECK (live_window_days IN (30, 90, 180))");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS historical_backfill_mode text NOT NULL DEFAULT 'metadata_and_bodies'");
    expect(sql).toContain("CHECK (historical_backfill_mode IN ('off', 'metadata_only', 'metadata_and_bodies'))");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS archive_refresh_interval text NOT NULL DEFAULT 'monthly'");
    expect(sql).toContain("CHECK (archive_refresh_interval IN ('never', 'monthly', 'weekly'))");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS archive_flag_sync boolean NOT NULL DEFAULT false");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS max_backfill_rate text NOT NULL DEFAULT 'normal'");
    expect(sql).toContain("CHECK (max_backfill_rate IN ('small', 'normal', 'aggressive'))");
    expect(sql).not.toContain("stripe");
    expect(sql).not.toContain("tenant");
  });

  it("adds progress counters and a security-invoker roll-up view without control-plane tables", async () => {
    const sql = await readFile(progressRollupMigrationPath, "utf8");

    expect(sql).toContain("ADD COLUMN headers_synced_count int NOT NULL DEFAULT 0");
    expect(sql).toContain("ADD COLUMN bodies_fetched_count int NOT NULL DEFAULT 0");
    expect(sql).toContain("ADD COLUMN live_window_target_count int");
    expect(sql).toContain("ADD COLUMN historical_target_count int");
    expect(sql).toContain("DROP VIEW IF EXISTS public.imap_account_progress");
    expect(sql).toContain("CREATE VIEW public.imap_account_progress");
    expect(sql).toContain("WITH (security_invoker = true)");
    expect(sql).toContain("live_headers_complete_pct");
    expect(sql).toContain("priority_bodies_complete_pct");
    expect(sql).toContain("historical_bodies_complete_pct");
    expect(sql).toContain("REVOKE ALL ON TABLE public.imap_account_progress FROM anon");
    expect(sql).toContain("REVOKE ALL ON TABLE public.imap_account_progress FROM authenticated");
    expect(sql).not.toContain("stripe");
    expect(sql).not.toContain("tenant");
  });

  it("adds history lane refresh state without control-plane tables", async () => {
    const sql = await readFile(historyLaneMigrationPath, "utf8");

    expect(sql).toContain("ALTER TABLE public.imap_folders");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS last_archive_refresh_at timestamptz");
    expect(sql).not.toContain("stripe");
    expect(sql).not.toContain("tenant");
  });

  it("makes raw_mime optional for parsed-only body storage without control-plane tables", async () => {
    const sql = await readFile(optionalRawMimeMigrationPath, "utf8");

    expect(sql).toContain("ALTER TABLE public.imap_message_bodies");
    expect(sql).toContain("ALTER COLUMN raw_mime DROP NOT NULL");
    expect(sql).not.toContain("stripe");
    expect(sql).not.toContain("tenant");
  });

  it("adds the search layer as an additive, idempotent, pure-core migration", async () => {
    const sql = await readFile(searchLayerMigrationPath, "utf8");

    // Extensions land in the extensions schema, matching the 0001 convention.
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS unaccent  WITH SCHEMA extensions");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm   WITH SCHEMA extensions");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions");

    // IMMUTABLE wrappers are required: unaccent() and array_to_string() are not
    // IMMUTABLE and cannot otherwise live in a generated column / expression index.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.f_unaccent(text)");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.f_array_to_text(text[])");

    // Two STORED generated tsvector columns (header on messages, body on bodies),
    // never a cross-table trigger.
    expect(sql).toContain("header_fts tsvector");
    expect(sql).toContain("body_fts tsvector");
    expect(sql).toContain("GENERATED ALWAYS AS");
    expect(sql).toContain("STORED");
    expect(sql).not.toContain("CREATE TRIGGER");

    // Account-scoped, soft-delete-partial FTS GIN via btree_gin.
    expect(sql).toContain("USING gin (account_id, header_fts)");
    expect(sql).toContain("WHERE deleted_in_provider = false");

    // BLOCKER FIX: the body source is capped at 128KB, not 1,000,000 chars, so a
    // pathological body cannot overflow the output tsvector and ERROR storeBody.
    expect(sql).toContain("131072");
    expect(sql).not.toContain("1000000");

    // BLOCKER FIX: emails are stored verbatim, so raw email-array GINs would
    // silently miss mixed-case addresses. They must not exist; recipient matching
    // goes through lowercased trigram + EXISTS(unnest ...). Only the flags array
    // GIN (case-exact tokens) is legitimate.
    expect(sql).toContain("USING gin (flags)");
    expect(sql).not.toContain("USING gin (to_emails)");
    expect(sql).not.toContain("USING gin (cc_emails)");

    // Tier 2 (pgvector) is opt-in and self-gated: it must no-op when vector is
    // absent and must never install the extension itself.
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.imap_message_embeddings");
    expect(sql).not.toContain("CREATE EXTENSION IF NOT EXISTS vector");

    // Transaction-safe: the whole public set runs in one implicit transaction, so
    // no index may be built CONCURRENTLY (illegal in a transaction block).
    expect(sql).not.toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/i);
    expect(sql).not.toMatch(/REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY/i);

    // Pure core: no control-plane coupling.
    expect(sql).not.toMatch(/stripe/i);
    expect(sql).not.toContain("tenant");
  });

  it("keeps control-plane migrations out of the public core package path", async () => {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {
      files?: string[];
    };
    const loader = await readFile(resolve(process.cwd(), "src/db.ts"), "utf8");

    await expect(access(resolve(process.cwd(), "supabase/migrations/control-plane"))).rejects.toThrow();
    expect(packageJson.files).toContain("supabase/migrations/public");
    expect(packageJson.files).not.toContain("supabase/migrations");
    expect(loader).toContain("../supabase/migrations/public");
    expect(loader).not.toContain("control-plane");
  });
});
