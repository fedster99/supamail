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
});
