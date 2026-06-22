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

    expect(version).toBe("0009_smtp_send");
    expect(manifest).toEqual({
      schemaVersion: "0009_smtp_send",
      migrations: [
        { id: "0001_imap_mirror", file: "0001_imap_mirror.sql" },
        { id: "0002_stuck_degraded_escalation", file: "0002_stuck_degraded_escalation.sql" },
        { id: "0003_folder_count_cap_pending_verification", file: "0003_folder_count_cap_pending_verification.sql" },
        { id: "0004_account_lane_settings", file: "0004_account_lane_settings.sql" },
        { id: "0005_progress_rollup", file: "0005_progress_rollup.sql" },
        { id: "0006_history_lane_state", file: "0006_history_lane_state.sql" },
        { id: "0007_optional_raw_mime", file: "0007_optional_raw_mime.sql" },
        { id: "0008_search_layer", file: "0008_search_layer.sql" },
        { id: "0009_smtp_send", file: "0009_smtp_send.sql" }
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
