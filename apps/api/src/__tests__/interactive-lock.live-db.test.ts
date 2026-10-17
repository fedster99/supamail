import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool, type PgClient } from "../db.js";
import { INTERACTIVE_LOCK_WAIT_MS, withInteractiveAccountLock } from "../interactive-lock.js";
import { withAccountLock } from "../locks.js";

/**
 * Live-DB coverage for the bounded account-lock wait that orders direct mailbox
 * writes against sync. Postgres semantics are the point: a waiting writer gets
 * the lock when the holder releases it, the wait is bounded, and the wait leaves
 * no statement timeout on the session. Runs only under test:db:live.
 */

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

liveDb("interactive account lock (live DB)", () => {
  let pool: ReturnType<typeof getPool>;
  let account: { id: string; lock_id: string };

  beforeAll(async () => {
    pool = getPool();
    const result = await pool.query<{ id: string; lock_id: string }>(
      `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
       VALUES ($1, 'imap.example.test', 993, $1, $2) RETURNING id, lock_id::text`,
      [`interactive-lock-${process.pid}@example.test`, Buffer.from([0])]
    );
    account = result.rows[0];
  });

  afterAll(async () => {
    if (account) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [account.id]);
    await closePool();
  });

  async function holdLock(): Promise<PgClient> {
    const holder = await pool.connect();
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [account.lock_id]);
    return holder;
  }

  async function release(holder: PgClient): Promise<void> {
    await holder.query("SELECT pg_advisory_unlock_all()");
    holder.release();
  }

  async function tryLock(): Promise<boolean> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
        [account.lock_id]
      );
      if (result.rows[0]?.locked) await client.query("SELECT pg_advisory_unlock($1::bigint)", [account.lock_id]);
      return result.rows[0]?.locked === true;
    } finally {
      client.release();
    }
  }

  it("runs a waiting writer once the holder releases, and holds off sync while it writes", async () => {
    expect(INTERACTIVE_LOCK_WAIT_MS).toBe(25_000);
    const holder = await holdLock();
    let syncTookTheLock: boolean | null = null;
    const write = withInteractiveAccountLock(pool, account, async () => {
      // While the writer holds the lock, a sync's try-lock fails.
      syncTookTheLock = await tryLock();
      return "written";
    });
    // Let the writer queue on the lock, then release the holder.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await release(holder);

    await expect(write).resolves.toBe("written");
    expect(syncTookTheLock).toBe(false);
    expect(await tryLock()).toBe(true);
  });

  it("gives up after the wait and leaves the lock with its holder", async () => {
    const holder = await holdLock();
    try {
      const startedAt = Date.now();
      await expect(withAccountLock(pool, account.lock_id, async () => "unsafe", { waitMs: 300 })).resolves.toBeNull();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      const held = await pool.query<{ held: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks
           WHERE locktype = 'advisory' AND granted AND objid::bigint = $1::bigint AND pid <> pg_backend_pid()
         ) AS held`,
        [account.lock_id]
      );
      expect(held.rows[0].held).toBe(true);
    } finally {
      await release(holder);
    }
  });

  it("leaves no statement timeout on the session after the wait", async () => {
    const timeout = await withAccountLock(pool, account.lock_id, async (lock) => {
      const result = await lock.client.query<{ statement_timeout: string }>("SHOW statement_timeout");
      return result.rows[0].statement_timeout;
    }, { waitMs: 5_000 });
    expect(timeout).toBe("0");
  });
});
