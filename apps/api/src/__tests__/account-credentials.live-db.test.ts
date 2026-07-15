import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { decryptPassword, encryptPassword } from "../crypto.js";
import { closePool, getPool } from "../db.js";
import { AccountBusyError } from "../errors.js";
import { MirrorRepository } from "../repository.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const ENCRYPTION_KEY = "local-live-db-credential-test-key";
const config = {
  IMAP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  IMAP_ALLOW_PRIVATE_HOSTS: false
} as AppConfig;
const ACCOUNT_EMAIL = `credentials-live-${process.pid}@example.test`;

liveDb("account credential replacement (live DB)", () => {
  let pool: ReturnType<typeof getPool>;
  let repository: MirrorRepository;
  let accountId = "";

  beforeAll(async () => {
    pool = getPool();
    repository = new MirrorRepository(pool, config);
    const encrypted = await encryptPassword(pool, "rejected-password", ENCRYPTION_KEY);
    const account = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_accounts (
         email_address, host, port, username, encrypted_password,
         sync_state, sync_state_reason, consecutive_failures
       )
       VALUES ($1, 'imap.example.test', 993, $1, $2, 'BROKEN', 'AUTH_ERROR: rejected', 69)
       RETURNING id`,
      [ACCOUNT_EMAIL, encrypted]
    );
    accountId = account.rows[0].id;
  });

  afterAll(async () => {
    if (accountId) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    await closePool();
  });

  it("stores the replacement secret and makes an auth-broken account schedulable", async () => {
    const updated = await repository.updateAccountCredentials(accountId, {
      password: "replacement-app-password"
    });

    expect(updated).toMatchObject({
      id: accountId,
      sync_state: "DEGRADED",
      sync_state_reason: "CREDENTIALS_UPDATED_PENDING_SYNC",
      consecutive_failures: 0,
      consecutive_successes: 0,
      backoff_until: null
    });

    const stored = await pool.query<{ encrypted_password: Buffer }>(
      "SELECT encrypted_password FROM public.imap_accounts WHERE id = $1",
      [accountId]
    );
    await expect(
      decryptPassword(pool, stored.rows[0].encrypted_password, ENCRYPTION_KEY)
    ).resolves.toBe("replacement-app-password");
  });

  it("does not replace credentials while another session owns the account lock", async () => {
    const lock = await pool.connect();
    const current = await pool.query<{ lock_id: string }>(
      "SELECT lock_id FROM public.imap_accounts WHERE id = $1",
      [accountId]
    );
    await lock.query("SELECT pg_advisory_lock($1::bigint)", [current.rows[0].lock_id]);

    try {
      await expect(
        repository.updateAccountCredentials(accountId, { password: "must-not-be-stored" })
      ).rejects.toBeInstanceOf(AccountBusyError);
    } finally {
      await lock.query("SELECT pg_advisory_unlock($1::bigint)", [current.rows[0].lock_id]);
      lock.release();
    }

    const stored = await pool.query<{ encrypted_password: Buffer }>(
      "SELECT encrypted_password FROM public.imap_accounts WHERE id = $1",
      [accountId]
    );
    await expect(
      decryptPassword(pool, stored.rows[0].encrypted_password, ENCRYPTION_KEY)
    ).resolves.toBe("replacement-app-password");
  });
});
