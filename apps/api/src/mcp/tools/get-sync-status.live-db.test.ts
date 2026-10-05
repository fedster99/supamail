import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../../db.js";
import { runGetSyncStatus } from "./get-sync-status.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;
const ACCOUNT_EMAIL = `sync-status-live-${process.pid}@example.test`;

interface StatusOk {
  summary: string;
  fully_synced: boolean;
  degraded_reasons: string[];
  accounts: Array<{ account_id: string; account_email: string; sync_state: string; initial_sync_in_progress: boolean }>;
}

liveDb("get_sync_status tool live DB", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";

  beforeAll(async () => {
    pool = getPool();
    const account = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
      VALUES ($1, 'imap.example.test', 993, $1, $2)
      RETURNING id
      `,
      [ACCOUNT_EMAIL, Buffer.from([0])]
    );
    accountId = account.rows[0].id;
  });

  afterAll(async () => {
    if (accountId) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    await closePool();
  });

  it("reports a first sync for the scoped account with a one-line summary", async () => {
    const status = (await runGetSyncStatus(pool, { account: accountId })) as StatusOk;
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0]).toMatchObject({
      account_id: accountId,
      account_email: ACCOUNT_EMAIL,
      sync_state: "INITIAL_SYNC",
      initial_sync_in_progress: true
    });
    expect(status.fully_synced).toBe(false);
    expect(status.degraded_reasons).toContain("initial_sync_in_progress");
    expect(status.summary).toContain(`${ACCOUNT_EMAIL}: first sync`);
  });

  it("rejects an account that is not a UUID before querying", async () => {
    const out = await runGetSyncStatus(pool, { account: "not-a-uuid" });
    expect(out).toMatchObject({ error: { code: "invalid_input" } });
  });
});
