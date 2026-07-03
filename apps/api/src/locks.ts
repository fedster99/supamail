import type { PgClient, PgPool } from "./db.js";

export interface AccountLock {
  lockId: string | number;
  client: PgClient;
}

const LOCK_SELF_TEST_TIMEOUT_MS = 5_000;
const LOCK_SELF_TEST_MAX_RETRIES = 3;
const LOCK_SELF_TEST_LOCK_ID_MIN = 2_000_000_000;
const LOCK_SELF_TEST_LOCK_ID_MAX = 2_100_000_000;

function generateTestLockId(): number {
  return Math.floor(
    Math.random() * (LOCK_SELF_TEST_LOCK_ID_MAX - LOCK_SELF_TEST_LOCK_ID_MIN)
      + LOCK_SELF_TEST_LOCK_ID_MIN
  );
}

async function queryWithTimeout<T>(
  client: PgClient,
  query: string,
  params: unknown[],
  timeoutMs: number
): Promise<T> {
  await client.query("SELECT set_config('statement_timeout', $1, false)", [String(timeoutMs)]);
  try {
    return (await client.query(query, params)) as T;
  } finally {
    await client.query("SELECT set_config('statement_timeout', '0', false)").catch(() => undefined);
  }
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
      await client.query(
        "UPDATE public.imap_accounts SET last_heartbeat_at = now() WHERE lock_id = $1",
        [lockId]
      ).catch(() => undefined);
      return await fn({ lockId, client });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * Startup self-test for session-scoped advisory locks.
 * If this fails, the worker is probably behind a transaction pooler and cannot
 * safely serialize IMAP access.
 */
export async function runLockSelfTest(pool: PgPool): Promise<void> {
  let clientA: PgClient | null = null;
  let clientB: PgClient | null = null;
  let testLockId = 0;
  let acquired = false;

  try {
    for (let attempt = 0; attempt < LOCK_SELF_TEST_MAX_RETRIES; attempt += 1) {
      testLockId = generateTestLockId();
      clientA = await pool.connect();

      const resultA = await queryWithTimeout<{ rows: Array<{ acquired: boolean }> }>(
        clientA,
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [testLockId],
        LOCK_SELF_TEST_TIMEOUT_MS
      );

      if (resultA.rows[0]?.acquired) {
        acquired = true;
        break;
      }

      clientA.release();
      clientA = null;
    }

    if (!acquired || !clientA) {
      throw new Error(
        `Lock self-test failed: could not acquire test lock after ${LOCK_SELF_TEST_MAX_RETRIES} attempts`
      );
    }

    clientB = await pool.connect();
    const resultB = await queryWithTimeout<{ rows: Array<{ acquired: boolean }> }>(
      clientB,
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [testLockId],
      LOCK_SELF_TEST_TIMEOUT_MS
    );

    if (resultB.rows[0]?.acquired) {
      throw new Error(
        "Lock self-test failed: second connection acquired an already-held advisory lock. Use a direct/session-affine Postgres connection, not transaction pooling."
      );
    }

    await queryWithTimeout(
      clientA,
      "SELECT pg_advisory_unlock($1::bigint)",
      [testLockId],
      LOCK_SELF_TEST_TIMEOUT_MS
    );
    clientA.release();
    clientA = null;

    const resultB2 = await queryWithTimeout<{ rows: Array<{ acquired: boolean }> }>(
      clientB,
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [testLockId],
      LOCK_SELF_TEST_TIMEOUT_MS
    );

    if (!resultB2.rows[0]?.acquired) {
      throw new Error("Lock self-test failed: second connection could not acquire after release");
    }

    await queryWithTimeout(
      clientB,
      "SELECT pg_advisory_unlock($1::bigint)",
      [testLockId],
      LOCK_SELF_TEST_TIMEOUT_MS
    );
    clientB.release();
    clientB = null;
  } finally {
    if (clientA) {
      await clientA.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      clientA.release();
    }
    if (clientB) {
      await clientB.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      clientB.release();
    }
  }
}

/**
 * Transient startup DB failures that should be RETRIED, not treated as fatal. During a
 * deploy the old + new instances overlap on the (small) session pooler, so a fresh
 * instance can briefly fail to check out a session connection: "max clients reached",
 * checkout timeout, statement_timeout (57014), dropped/closed connections.
 *
 * This deliberately does NOT match the pooling-detection failure ("second connection
 * acquired an already-held advisory lock") — that is a real correctness signal
 * (transaction pooling breaks advisory locks) and must stay fatal.
 */
export function isTransientStartupDbError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "57014") return true; // canceling statement due to statement timeout
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    // Raw node-postgres pg.Pool — supamail's default stack. This is the exact string
    // pg-pool throws on a checkout timeout (`connectionTimeoutMillis`), and the one a
    // saturated pool surfaces; keep it first so the default deployment is covered.
    msg.includes("timeout exceeded when trying to connect") ||
    msg.includes("connection terminated") ||
    msg.includes("connection to database closed") ||
    // Session-pooler-backed deployments (PgBouncer / Supavisor — e.g. cloud, BYO).
    msg.includes("maxclientsinsessionmode") ||
    msg.includes("max clients reached") ||
    msg.includes("too many clients") ||
    msg.includes("edbhandlerexited") ||
    // Generic transient network / statement signatures.
    msg.includes("statement timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout")
  );
}

/**
 * Run the advisory-lock self-test, retrying transient DB errors with exponential
 * backoff before giving up. The caller still exits if this throws — the retry only
 * rides through deploy-time session-pooler saturation; it never weakens the gate (a
 * definitive pooling failure is not transient and is rethrown immediately).
 *
 * Default budget ~= 39s across 8 attempts (1+2+4+8+8+8+8s), enough to outlast a single
 * deploy's instance overlap.
 */
export async function runLockSelfTestWithRetry(
  pool: PgPool,
  opts?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
  }
): Promise<void> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  const baseDelayMs = opts?.baseDelayMs ?? 1_000;
  const maxDelayMs = opts?.maxDelayMs ?? 8_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runLockSelfTest(pool);
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientStartupDbError(error)) {
        throw error;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      opts?.onRetry?.({ attempt, maxAttempts, delayMs, error });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function clearOrphanedLockForAccount(
  pool: PgPool,
  lockId: string | number,
  staleThresholdMs: number
): Promise<boolean> {
  try {
    const result = await pool.query<{
      pid: number;
      email_address: string;
      last_heartbeat_at: Date | null;
    }>(
      `
      SELECT pl.pid, account.email_address, account.last_heartbeat_at
      FROM pg_locks pl
      JOIN public.imap_accounts account
        ON pl.classid::bigint = 0
       AND pl.objid::bigint = account.lock_id
      WHERE pl.locktype = 'advisory'
        AND pl.objid::bigint = $1::bigint
        AND pl.granted = true
        AND (
          account.last_heartbeat_at IS NULL
          OR account.last_heartbeat_at < now() - ($2::bigint * interval '1 millisecond')
        )
        AND pl.pid != pg_backend_pid()
      LIMIT 1
      `,
      [lockId, staleThresholdMs]
    );

    const row = result.rows[0];
    if (!row) return false;

    await pool.query("SELECT pg_terminate_backend($1)", [row.pid]);
    await pool.query(
      `
      UPDATE public.imap_accounts
      SET currently_syncing = false,
          sync_started_by = NULL
      WHERE lock_id = $1
      `,
      [lockId]
    );
    // Close the sync run the killed process left open, so it stops reading as
    // perpetually 'running' (previously only the account lock was reaped). The
    // started_at guard ensures a run a concurrent worker just opened (before it
    // refreshed the heartbeat) is not mistaken for the dead worker's orphan.
    await pool.query(
      `
      UPDATE public.imap_sync_runs r
      SET status = 'failed',
          finished_at = now(),
          error = COALESCE(r.error, 'reaped: worker stopped without finishing the run')
      FROM public.imap_accounts a
      WHERE r.account_id = a.id
        AND a.lock_id = $1
        AND r.status = 'running'
        AND r.finished_at IS NULL
        AND r.started_at < now() - ($2::bigint * interval '1 millisecond')
      `,
      [lockId, staleThresholdMs]
    );
    return true;
  } catch {
    return false;
  }
}

export interface OrphanedLockSweep {
  /** Stale advisory-lock backends terminated via pg_terminate_backend. */
  terminatedBackends: number;
  /** Accounts whose currently_syncing flag was reset. */
  accountsReset: number;
  /** Open imap_sync_runs rows force-closed as failed (reaped). */
  runsClosed: number;
}

export async function clearOrphanedLocks(
  pool: PgPool,
  staleThresholdMs: number
): Promise<OrphanedLockSweep> {
  try {
    const result = await pool.query<{ pid: number }>(
      `
      SELECT DISTINCT pl.pid
      FROM pg_locks pl
      JOIN public.imap_accounts account
        ON pl.classid::bigint = 0
       AND pl.objid::bigint = account.lock_id
      WHERE pl.locktype = 'advisory'
        AND pl.granted = true
        AND (
          account.last_heartbeat_at IS NULL
          OR account.last_heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
        )
        AND pl.pid != pg_backend_pid()
      `,
      [staleThresholdMs]
    );

    for (const row of result.rows) {
      await pool.query("SELECT pg_terminate_backend($1)", [row.pid]).catch(() => undefined);
    }

    const reset = await pool.query(
      `
      UPDATE public.imap_accounts
      SET currently_syncing = false,
          sync_started_by = NULL
      WHERE currently_syncing = true
        AND (
          last_heartbeat_at IS NULL
          OR last_heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
        )
      `,
      [staleThresholdMs]
    );

    // Close the sync runs those reaped accounts left open. A SIGKILL/OOM leaves the
    // run row at status='running' forever (only the account lock was reaped before),
    // so any sync_runs-based UI/metrics show a phantom perpetually-active run. The
    // started_at guard ensures a run a concurrent worker just opened (before it
    // refreshed the heartbeat) is not mistaken for a dead worker's orphan.
    const closed = await pool.query(
      `
      UPDATE public.imap_sync_runs r
      SET status = 'failed',
          finished_at = now(),
          error = COALESCE(r.error, 'reaped: worker stopped without finishing the run')
      FROM public.imap_accounts a
      WHERE r.account_id = a.id
        AND r.status = 'running'
        AND r.finished_at IS NULL
        AND r.started_at < now() - ($1::bigint * interval '1 millisecond')
        AND (
          a.last_heartbeat_at IS NULL
          OR a.last_heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
        )
      `,
      [staleThresholdMs]
    );

    return {
      terminatedBackends: result.rows.length,
      accountsReset: reset.rowCount ?? 0,
      runsClosed: closed.rowCount ?? 0
    };
  } catch {
    return { terminatedBackends: 0, accountsReset: 0, runsClosed: 0 };
  }
}
