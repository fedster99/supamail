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

  it("does not immediately untrack folders after one missing LIST pass", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("AND missing_since IS NOT NULL");
    expect(source).toContain("SET missing_since = now()");
  });

  it("limits reconciliation tombstones to the active sync window", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("AND window_status = 'IN_WINDOW'");
  });
});
