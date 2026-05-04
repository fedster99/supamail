import type { PgClient, PgPool } from "./db.js";

export interface AccountLock {
  lockId: string | number;
  client: PgClient;
  release(): Promise<void>;
}

export async function acquireAccountLock(pool: PgPool, lockId: string | number): Promise<AccountLock | null> {
  const client = await pool.connect();
  let released = false;

  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [lockId]
    );

    if (!result.rows[0]?.locked) {
      client.release();
      return null;
    }

    return {
      lockId,
      client,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);
        } finally {
          client.release();
        }
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function withAccountLock<T>(
  pool: PgPool,
  lockId: string | number,
  fn: (lock: AccountLock) => Promise<T>
): Promise<T | null> {
  const lock = await acquireAccountLock(pool, lockId);
  if (!lock) return null;

  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
