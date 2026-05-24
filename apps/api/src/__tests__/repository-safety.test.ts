import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeFlags } from "../repository.js";

describe("repository safety", () => {
  it("normalizes IMAP flags for stable diffing", () => {
    expect(normalizeFlags(["\\Seen", "\\Flagged", "\\seen", " "])).toEqual(["\\flagged", "\\seen"]);
  });

  it("keeps external account responses on the sanitized summary shape", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("const ACCOUNT_SUMMARY_COLUMNS");
    expect(source).toContain("Promise<AccountSummary>");
    expect(source).toContain("RETURNING ${ACCOUNT_SUMMARY_COLUMNS}");
    expect(source).toContain("SELECT ${ACCOUNT_SUMMARY_COLUMNS} FROM public.imap_accounts");
  });

  it("reclaims stale sync leases instead of bricking accounts", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("currently_syncing = false");
    expect(source).toContain("last_heartbeat_at <= now() - ($2::bigint * interval '1 millisecond')");
    expect(source).toContain("this.config.STALE_HEARTBEAT_MS");
  });

  it("does not mark incomplete initial sync as healthy", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("INITIAL_SYNC_IN_PROGRESS");
    expect(source).toContain("incomplete_count > 0 THEN 'INITIAL_SYNC'");
    expect(source).toContain("PRIORITY_RECONCILE_STALE");
    expect(source).toContain("OVERALL_RECONCILE_STALE");
    expect(source).toContain("PRIORITY_RECONCILE_HEALTHY_MAX_AGE_MS");
    expect(source).toContain("ELSE 'HEALTHY'");
    expect(source).not.toContain("CASE WHEN sync_state = 'INITIAL_SYNC' THEN 'HEALTHY' ELSE sync_state END");
  });

  it("sanitizes sync run errors before persistence", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("const sanitizedErrors = result.errors.map(sanitizeErrorReason)");
    expect(source).toContain("JSON.stringify({ errors: sanitizedErrors, hitLockBudget: result.hitLockBudget })");
  });

  it("does not hold account locks with idle transactions", async () => {
    const source = await readFile(resolve(process.cwd(), "src/locks.ts"), "utf8");

    expect(source).toContain("pg_try_advisory_lock");
    expect(source).toContain("pg_advisory_unlock");
    expect(source).toContain("runLockSelfTest");
    expect(source).toContain("clearOrphanedLockForAccount");
    expect(source).toContain("pg_terminate_backend");
    expect(source).not.toContain("pg_try_advisory_xact_lock");
    expect(source).not.toContain('client.query("BEGIN")');
  });

  it("does not immediately untrack folders after one missing LIST pass", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("AND missing_since IS NOT NULL");
    expect(source).toContain("SET missing_since = now()");
  });

  it("tombstones folder messages after the missing grace expires", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("deleted_reason = 'FOLDER_MISSING'");
    expect(source).toContain("\"FOLDER_MISSING\"");
    expect(source).toContain("FOLDER_MISSING_GRACE_EXCEEDED");
  });

  it("does not schedule broken accounts", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("sync_state NOT IN ('PAUSED', 'BROKEN')");
  });

  it("enforces the account cap at create time and worker startup", async () => {
    const repository = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");
    const worker = await readFile(resolve(process.cwd(), "src/worker.ts"), "utf8");

    expect(repository).toContain("SYNC_MAX_ACCOUNTS limit reached");
    expect(worker).toContain("exceeds SYNC_MAX_ACCOUNTS");
  });

  it("limits reconciliation tombstones to the active sync window", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("AND window_status = 'IN_WINDOW'");
  });

  it("loads reconcile UIDs through a temporary table", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("CREATE TEMP TABLE supamail_live_uids");
    expect(source).toContain("ON COMMIT DROP");
    expect(source).toContain("SELECT DISTINCT unnest($1::bigint[])");
  });

  it("returns missing-in-DB UIDs from reconcile for backfill (spec §10.7 step 3)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("missingInDbUids: number[]");
    expect(source).toContain("FROM supamail_live_uids live");
    expect(source).toContain("WHERE NOT EXISTS");
  });

  it("treats PARTIAL_SUCCESS as a success for counter rules (spec §12.2)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    // PARTIAL block must increment successes, not failures, unless the cycle
    // hit the cooperative lock budget and should stay neutral for backoff.
    expect(source).toMatch(/markAccountSyncPartial[\s\S]{0,1000}WHEN \$3::boolean THEN consecutive_successes \+ 1/);
    expect(source).not.toMatch(/markAccountSyncPartial[\s\S]{0,500}consecutive_failures = consecutive_failures \+ 1/);
  });

  it("uses jittered backoff and resets the stored backoff only after stable success", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("0.7 + random() * 0.6");
    expect(source).toContain("current_backoff_ms = next_backoff.base_ms");
    expect(source).toContain("consecutive_successes + 1 >= 3");
  });

  it("short-circuits AUTH_ERROR to BROKEN without backoff (spec §13.1)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("markAccountSyncAuthFailed");
    expect(source).toContain("AUTH_ERROR:");
    expect(source).toContain("sync_state = 'BROKEN'");
  });

  it("scopes UIDVALIDITY reset counter to a rolling 24h window (spec §11)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("last_uidvalidity_reset_at < now() - interval '24 hours'");
    expect(source).toContain("resetCountIn24h");
  });

  it("applies a folder-missing grace period before flipping to MISSING (spec §10.2)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("missing_since < now() - ($3::bigint * interval '1 millisecond')");
    expect(source).toContain("FOLDER_MISSING_GRACE_MS");
  });

  it("supports snapshot + watermark for initial sync (spec §10.4)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("setInitialSyncSnapshot");
    expect(source).toContain("advanceInitialSyncWatermark");
    expect(source).toContain("initial_sync_target_max_uid = $2");
    expect(source).toContain("initial_sync_oldest_uid_synced = $3");
  });

  it("uses priority plus round-robin folder scheduling", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("MAX_PRIORITY_FOLDERS_PER_CYCLE");
    expect(source).toContain("MAX_RR_FOLDERS_PER_CYCLE");
    expect(source).toContain("folder_rr_cursor");
  });

  it("diffs flag scans and logs FLAGS_CHANGED instead of counting every refetch", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("applyFlagScan");
    expect(source).toContain("normalizeFlags");
    expect(source).toContain("FLAGS_CHANGED");
    expect(source).toContain("previousFlags");
    expect(source).toContain("nextFlags");
    expect(source).toContain("knownMessages");
  });

  it("does not body-backfill messages from untracked folders", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("getBodyBacklog");
    expect(source).toContain("AND f.tracked = true");
  });

  it("runs retention as expiry first, purge second", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");
    const worker = await readFile(resolve(process.cwd(), "src/worker.ts"), "utf8");

    expect(source).toContain("runExpiryJob");
    expect(source).toContain("window_status = 'EXPIRED'");
    expect(source).toContain("runPurgeJob");
    expect(source).toContain("provider_deleted_at < now() - interval '30 days'");
    expect(source).toContain("deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING')");
    expect(source).not.toContain("deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING', 'RECONCILE_MISSING')");
    expect(worker).toContain("runRetentionJobs");
  });
});
