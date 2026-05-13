import type { PgClient, PgPool } from "./db.js";

export interface AccountLock {
  lockId: string | number;
  client: PgClient;
}

/**
 * Run `fn` while holding a Postgres advisory lock on a dedicated connection.
 * The lock is released explicitly before the connection returns to the pool;
 * if the process exits, Postgres releases it when the session closes.
 *
 * Returns `null` when the lock is held by another session.
 */
export async function withAccountLock<T>(
  pool: PgPool,
  lockId: string | number,
  fn: (lock: AccountLock) => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [lockId]
    );
    if (!result.rows[0]?.locked) {
      return null;
    }

    try {
      return await fn({ lockId, client });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
