import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("repository safety", () => {
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
    expect(source).toContain("last_heartbeat_at <= now() - ($2 * interval '1 millisecond')");
    expect(source).toContain("this.config.MAX_LOCK_HOLD_MS");
  });

  it("recovers unhealthy accounts after a successful sync", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("sync_state = 'HEALTHY'");
    expect(source).not.toContain("CASE WHEN sync_state = 'INITIAL_SYNC' THEN 'HEALTHY' ELSE sync_state END");
  });

  it("sanitizes sync run errors before persistence", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("const sanitizedErrors = result.errors.map(sanitizeErrorReason)");
    expect(source).toContain("JSON.stringify({ errors: sanitizedErrors })");
  });

  it("does not hold account locks with idle transactions", async () => {
    const source = await readFile(resolve(process.cwd(), "src/locks.ts"), "utf8");

    expect(source).toContain("pg_try_advisory_lock");
    expect(source).toContain("pg_advisory_unlock");
    expect(source).not.toContain("pg_try_advisory_xact_lock");
    expect(source).not.toContain('client.query("BEGIN")');
  });

  it("does not immediately untrack folders after one missing LIST pass", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("AND missing_since IS NOT NULL");
    expect(source).toContain("SET missing_since = now()");
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

    // PARTIAL block must increment successes, not failures.
    expect(source).toMatch(/markAccountSyncPartial[\s\S]{0,800}consecutive_successes = consecutive_successes \+ 1/);
    expect(source).not.toMatch(/markAccountSyncPartial[\s\S]{0,500}consecutive_failures = consecutive_failures \+ 1/);
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

    expect(source).toContain("missing_since < now() - ($3 * interval '1 millisecond')");
    expect(source).toContain("FOLDER_MISSING_GRACE_MS");
  });

  it("supports snapshot + watermark for initial sync (spec §10.4)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("setInitialSyncSnapshot");
    expect(source).toContain("advanceInitialSyncWatermark");
    expect(source).toContain("initial_sync_target_max_uid = $2");
    expect(source).toContain("initial_sync_oldest_uid_synced = $3");
  });
});
