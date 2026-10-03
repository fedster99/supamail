import { AsyncLocalStorage } from "node:async_hooks";
import type { PgClient, PgPool } from "./db.js";

export interface AccountLock {
  lockId: string | number;
  client: PgClient;
  /** Persist a fresh heartbeat and prove this exact Postgres session still owns
   * the advisory lock. Throws before an irreversible boundary when liveness is
   * unknown or lost. */
  assertLive(): Promise<void>;
  /** Mark that an irreversible provider action has been confirmed. From this
   * point, liveness/unlock failures are diagnostics, never retry signals. */
  confirmIrreversible(): void;
}

export interface AccountLockOptions {
  /** Refresh cadence for `imap_accounts.last_heartbeat_at` while the lock is held.
   * Required for operations that can approach the stale-reaper threshold; bounded
   * operations and callers that persist their own heartbeat may omit it. */
  heartbeatIntervalMs?: number;
  /** Receive a diagnostic that happened only after an irreversible action was
   * confirmed. Callers should add it to their success warnings. */
  onPostIrreversibleWarning?: (warning: string) => void;
  /** Run `fn` so that every query issued through `lockedSessionPool` uses the
   * lock's own session. Writes then share fate with the lock: once that session
   * ends, the holder cannot write anything else, however long it was frozen. */
  fenceWrites?: boolean;
}

export class AccountLockLivenessError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "AccountLockLivenessError";
  }
}

/**
 * The lock's own session presented as a pool. Work runs one at a time, so a
 * transaction never interleaves with other queries, as on a real pool. After the
 * lock ends it refuses all work. A lease released with an error (a cancelled or
 * failed transaction) abandons the session: it is ended from another connection,
 * which stops any query still waiting on it and releases the lock, and the lock
 * client is then destroyed rather than returned to the pool.
 */
class LockedSession {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  abandoned = false;
  backendPid: number | null = null;

  constructor(
    private readonly client: PgClient,
    private readonly lockId: string | number,
    private readonly basePool: PgPool
  ) {}

  abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    if (this.backendPid !== null) {
      void this.basePool.query("SELECT pg_terminate_backend($1)", [this.backendPid]).catch(() => undefined);
    }
  }

  private async turn(): Promise<() => void> {
    const previous = this.tail;
    let done!: () => void;
    this.tail = new Promise<void>((resolve) => {
      done = resolve;
    });
    await previous;
    return done;
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const done = await this.turn();
    try {
      return await work();
    } finally {
      done();
    }
  }

  assertUsable(): void {
    if (this.closed || this.abandoned) {
      throw new AccountLockLivenessError(
        `Account lock session for lock ${this.lockId} is no longer usable`,
        false
      );
    }
  }

  close(): void {
    this.closed = true;
  }

  readonly pool = {
    query: async (...args: unknown[]) => {
      this.assertUsable();
      return await this.exclusive(async () => {
        this.assertUsable();
        return await (this.client.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
      });
    },
    connect: async () => {
      this.assertUsable();
      const done = await this.turn();
      try {
        this.assertUsable();
      } catch (error) {
        done();
        throw error;
      }
      let released = false;
      return {
        query: async (...args: unknown[]) => {
          if (released) throw new Error("Locked session lease was already released");
          return await (this.client.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
        },
        release: (discard?: Error | boolean) => {
          if (released) return;
          released = true;
          if (discard) this.abandon();
          done();
        }
      };
    }
  } as unknown as PgPool;
}

const lockedSessionContext = new AsyncLocalStorage<LockedSession>();

function ignoreLockedSessionError(): void {
  // The failure surfaces on the next query through the session.
}

/**
 * Inside a `fenceWrites` account lock, the lock's own session; otherwise
 * `fallback`. Repositories resolve their pool through this on every query.
 */
export function lockedSessionPool(fallback: PgPool): PgPool {
  return lockedSessionContext.getStore()?.pool ?? fallback;
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

/** Keep at least three heartbeat opportunities inside the stale threshold, capped
 * at one minute so ordinary five-minute production thresholds stay fresh. */
export function accountLockHeartbeatIntervalMs(staleThresholdMs: number): number {
  const threshold = Number.isFinite(staleThresholdMs) && staleThresholdMs > 0
    ? staleThresholdMs
    : 5 * 60_000;
  return Math.max(1, Math.min(60_000, Math.floor(threshold / 3)));
}

async function persistAndValidateAccountLock(
  client: PgClient,
  lockId: string | number
): Promise<void> {
  let result: { rows: Array<{ heartbeat_persisted: boolean; lock_held: boolean }> };
  try {
    result = await client.query(
      `
      WITH refreshed AS (
        UPDATE public.imap_accounts
        SET last_heartbeat_at = now()
        WHERE lock_id = $1
        RETURNING 1
      )
      SELECT
        EXISTS (SELECT 1 FROM refreshed) AS heartbeat_persisted,
        EXISTS (
          SELECT 1
          FROM pg_locks pl
          JOIN public.imap_accounts account
            ON pl.classid::bigint = 0
           AND pl.objid::bigint = account.lock_id
          WHERE account.lock_id = $1
            AND pl.locktype = 'advisory'
            AND pl.granted = true
            AND pl.pid = pg_backend_pid()
        ) AS lock_held
      `,
      [lockId]
    );
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new AccountLockLivenessError(
      `Account lock heartbeat query failed for lock ${lockId}: ${details}`,
      isTransientStartupDbError(error)
    );
  }

  const row = result.rows[0];
  if (!row?.heartbeat_persisted) {
    throw new AccountLockLivenessError(
      `Account lock heartbeat persistence failed for lock ${lockId}: account row not found`,
      false
    );
  }
  if (!row.lock_held) {
    throw new AccountLockLivenessError(
      `Account lock liveness failed for lock ${lockId}: current session no longer owns the advisory lock`,
      false
    );
  }
}

async function persistAndValidateAccountLockWithRetry(
  client: PgClient,
  lockId: string | number,
  maxAttempts = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await persistAndValidateAccountLock(client, lockId);
      return;
    } catch (error) {
      const retryable = error instanceof AccountLockLivenessError && error.retryable;
      if (!retryable || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

function asError(error: unknown, prefix: string): Error {
  const details = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix}: ${details}`);
}

function postIrreversibleWarning(message: string): string {
  return `The provider already accepted the change; ${message}`;
}

async function validateAccountUnlock(
  client: PgClient,
  lockId: string | number
): Promise<void> {
  const result = await client.query<{ unlocked: boolean }>(
    "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
    [lockId]
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new Error(`Postgres reported advisory unlock=false for lock ${lockId}`);
  }
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
 * Close a fenced session to further work, wait for queued work, then unlock.
 * Returns false for an abandoned session: it was already ended (which released
 * the lock) and may hold an open transaction, so the caller must destroy the
 * client instead of returning it to the pool.
 */
async function unlockSession(
  client: PgClient,
  lockId: string | number,
  session: LockedSession | null
): Promise<boolean> {
  if (!session) {
    await validateAccountUnlock(client, lockId);
    return true;
  }
  session.close();
  return await session.exclusive(async () => {
    if (session.abandoned) return false;
    await validateAccountUnlock(client, lockId);
    return true;
  });
}

const abandonedSessionError = (lockId: string | number) =>
  new Error(`Account lock session for lock ${lockId} was abandoned and ended`);

/**
 * Run `fn` while holding a Postgres advisory lock on a dedicated connection.
 * The lock is released explicitly before the connection returns to the pool;
 * if the process exits, Postgres releases it when the session closes.
 * The initial account heartbeat must persist before `fn` runs. Callers whose
 * operation can approach the stale-reaper threshold must supply
 * `heartbeatIntervalMs` so that heartbeat remains fresh for the full lock lifetime.
 *
 * Returns `null` when the lock is held by another session.
 */
export async function withAccountLock<T>(
  pool: PgPool,
  lockId: string | number,
  fn: (lock: AccountLock) => Promise<T>,
  options: AccountLockOptions = {}
): Promise<T | null> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    let result: { rows: Array<{ locked: boolean }> };
    try {
      result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
        [lockId]
      );
    } catch (error) {
      releaseError = asError(error, `Account lock acquisition failed for lock ${lockId}`);
      throw releaseError;
    }
    if (!result.rows[0]?.locked) {
      return null;
    }

    let irreversibleConfirmed = false;
    const emittedWarnings = new Set<string>();
    const warnAfterIrreversible = (message: string) => {
      const warning = postIrreversibleWarning(message);
      if (emittedWarnings.has(warning)) return;
      emittedWarnings.add(warning);
      options.onPostIrreversibleWarning?.(warning);
    };

    const session = options.fenceWrites ? new LockedSession(client, lockId, pool) : null;
    if (session) {
      // Writes are fenced by this session, so losing it must fail this operation,
      // not crash the process through an unhandled client error.
      client.on?.("error", ignoreLockedSessionError);
      try {
        const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        session.backendPid = backend.rows[0]?.pid ?? null;
      } catch (error) {
        try {
          await validateAccountUnlock(client, lockId);
        } catch (unlockError) {
          releaseError = asError(unlockError, `Account lock release failed for lock ${lockId}`);
        }
        throw asError(error, `Account lock session setup failed for lock ${lockId}`);
      }
    }
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatPending: Promise<void> | null = null;
    let lastHeartbeatError: unknown = null;
    const refreshHeartbeat = async (): Promise<void> => {
      if (heartbeatPending) return await heartbeatPending;
      const persist = () => persistAndValidateAccountLockWithRetry(client, lockId);
      const pending = (session
        ? session.exclusive(async () => {
            session.assertUsable();
            await persist();
          })
        : persist())
        .then(() => {
          lastHeartbeatError = null;
        })
        .catch((error) => {
          lastHeartbeatError = error;
          throw error;
        })
        .finally(() => {
          if (heartbeatPending === pending) heartbeatPending = null;
        });
      heartbeatPending = pending;
      return await pending;
    };

    const lock: AccountLock = {
      lockId,
      client,
      assertLive: refreshHeartbeat,
      confirmIrreversible: () => {
        irreversibleConfirmed = true;
      }
    };

    let callbackValue: T | undefined;
    let callbackError: unknown;
    let callbackFailed = false;
    let unlockAttempted = false;
    try {
      // Fail closed before any provider operation: stale-lock recovery relies on
      // both the persisted heartbeat and this session's actual lock ownership.
      await refreshHeartbeat();

      const intervalMs = options.heartbeatIntervalMs;
      if (intervalMs !== undefined) {
        heartbeatTimer = setInterval(() => {
          // Keep retrying on later ticks. A transient failure does not permanently
          // disable refresh; phase-boundary assertLive() will synchronously retry.
          void refreshHeartbeat().catch(() => undefined);
        }, intervalMs);
        heartbeatTimer.unref?.();
      }

      try {
        callbackValue = session
          ? await lockedSessionContext.run(session, () => fn(lock))
          : await fn(lock);
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        const pendingHeartbeat = heartbeatPending as Promise<void> | null;
        if (pendingHeartbeat) await pendingHeartbeat.catch(() => undefined);
      }

      if (!callbackFailed && (options.heartbeatIntervalMs !== undefined || lastHeartbeatError)) {
        try {
          // Final synchronous proof catches a periodic failure that raced the end
          // of the callback. Before confirmation it is fail-closed; after
          // confirmation it is diagnostic only.
          await refreshHeartbeat();
        } catch (error) {
          if (irreversibleConfirmed) {
            warnAfterIrreversible(
              `account-lock liveness could not be revalidated: ${error instanceof Error ? error.message : String(error)}`
            );
          } else {
            callbackFailed = true;
            callbackError = error;
          }
        }
      } else if (irreversibleConfirmed && lastHeartbeatError) {
        warnAfterIrreversible(
          `account-lock heartbeat failed after confirmation: ${lastHeartbeatError instanceof Error ? lastHeartbeatError.message : String(lastHeartbeatError)}`
        );
      }

      try {
        unlockAttempted = true;
        if (!(await unlockSession(client, lockId, session))) releaseError = abandonedSessionError(lockId);
      } catch (error) {
        releaseError = asError(error, `Account lock release failed for lock ${lockId}`);
        if (irreversibleConfirmed) {
          warnAfterIrreversible(`the database lock client was evicted after unlock failed: ${releaseError.message}`);
        } else if (!callbackFailed) {
          callbackFailed = true;
          callbackError = releaseError;
        }
      }

      if (callbackFailed) throw callbackError;
      return callbackValue as T;
    } catch (error) {
      // Initial heartbeat/liveness failure still needs an unlock attempt. If that
      // attempt also fails, evict the session but preserve the original failure.
      if (!unlockAttempted) {
        try {
          unlockAttempted = true;
          if (!(await unlockSession(client, lockId, session))) releaseError = abandonedSessionError(lockId);
        } catch (unlockError) {
          releaseError = asError(unlockError, `Account lock release failed for lock ${lockId}`);
        }
      }
      throw error;
    }
  } finally {
    if (options.fenceWrites) client.removeListener?.("error", ignoreLockedSessionError);
    // Passing an error makes pg.Pool destroy this session. That is mandatory when
    // unlock is false/throws: returning a possibly lock-owning client to the pool
    // could deadlock later work on an invisible re-entrant lock.
    client.release(releaseError);
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
    // Session-pooler-backed deployments (for example PgBouncer or Supavisor).
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

function startupAbortError(): Error {
  return Object.assign(new Error("Startup lock self-test interrupted"), { name: "AbortError" });
}

function throwIfStartupAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw startupAbortError();
}

async function waitForStartupRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfStartupAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, delayMs);
    const abort = () => finish(startupAbortError());

    function finish(error?: Error): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
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
    signal?: AbortSignal;
    onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
  }
): Promise<void> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  const baseDelayMs = opts?.baseDelayMs ?? 1_000;
  const maxDelayMs = opts?.maxDelayMs ?? 8_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfStartupAborted(opts?.signal);
    try {
      await runLockSelfTest(pool);
      throwIfStartupAborted(opts?.signal);
      return;
    } catch (error) {
      throwIfStartupAborted(opts?.signal);
      if (attempt >= maxAttempts || !isTransientStartupDbError(error)) {
        throw error;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      opts?.onRetry?.({ attempt, maxAttempts, delayMs, error });
      await waitForStartupRetry(delayMs, opts?.signal);
    }
  }
}

/**
 * Stale-heartbeat takeover for session-pooler deployments only
 * (`isSupabaseSessionPoolerUrl`). There, server-side TCP probes reach the pooler,
 * not the worker, so this is the only recovery for a vanished worker's lock. It
 * cannot tell a dead worker from a frozen one; direct connections never use it.
 */
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
      sync_started_by: string | null;
    }>(
      `
      SELECT pl.pid,
             account.email_address,
             account.last_heartbeat_at,
             account.sync_started_by
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
        AND sync_started_by IS NOT DISTINCT FROM $2::text
      `,
      [lockId, row.sync_started_by]
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
          error = COALESCE(r.error, 'WORKER_REAPED')
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
  /** Stale advisory-lock backends terminated (session-pooler takeover only). */
  terminatedBackends: number;
  /** Accounts whose currently_syncing flag was reset. */
  accountsReset: number;
  /** Open imap_sync_runs rows force-closed as failed (reaped). */
  runsClosed: number;
}

/**
 * Reset sync state left by workers that no longer hold their account lock.
 *
 * On direct connections this never terminates a lock-holding session. A stale
 * heartbeat cannot tell a dead worker from a frozen one, and a frozen worker that
 * resumes after losing its lock could write stale mailbox state. Sessions of
 * vanished workers are released by the server-side TCP settings in `createPool`;
 * until then the account stays busy and only its own worker can write. Session
 * pooler deployments keep the stale-heartbeat takeover (`takeOverStaleHolders`).
 */
export async function clearOrphanedLocks(
  pool: PgPool,
  staleThresholdMs: number,
  options: { takeOverStaleHolders?: boolean } = {}
): Promise<OrphanedLockSweep> {
  if (options.takeOverStaleHolders) return await clearOrphanedLocksWithTakeover(pool, staleThresholdMs);
  const unlocked = `NOT EXISTS (
          SELECT 1
          FROM pg_locks pl
          WHERE pl.locktype = 'advisory'
            AND pl.granted = true
            AND pl.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND pl.classid::bigint = 0
            AND pl.objid::bigint = a.lock_id
            AND pl.objsubid = 1
        )`;
  try {
    const reset = await pool.query(
      `
      UPDATE public.imap_accounts a
      SET currently_syncing = false,
          sync_started_by = NULL
      WHERE a.currently_syncing = true
        AND (
          a.last_heartbeat_at IS NULL
          OR a.last_heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
        )
        AND ${unlocked}
      `,
      [staleThresholdMs]
    );

    // Close the sync runs those orphaned accounts left open. A SIGKILL/OOM leaves the
    // run row at status='running' forever, so any sync_runs-based UI/metrics show a
    // phantom perpetually-active run. The started_at guard ensures a run a concurrent
    // worker just opened (before it refreshed the heartbeat) is not mistaken for a
    // dead worker's orphan.
    const closed = await pool.query(
      `
      UPDATE public.imap_sync_runs r
      SET status = 'failed',
          finished_at = now(),
          error = COALESCE(r.error, 'WORKER_REAPED')
      FROM public.imap_accounts a
      WHERE r.account_id = a.id
        AND r.status = 'running'
        AND r.finished_at IS NULL
        AND r.started_at < now() - ($1::bigint * interval '1 millisecond')
        AND (
          a.last_heartbeat_at IS NULL
          OR a.last_heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
        )
        AND ${unlocked}
      `,
      [staleThresholdMs]
    );

    return {
      terminatedBackends: 0,
      accountsReset: reset.rowCount ?? 0,
      runsClosed: closed.rowCount ?? 0
    };
  } catch {
    return { terminatedBackends: 0, accountsReset: 0, runsClosed: 0 };
  }
}

async function clearOrphanedLocksWithTakeover(
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
          error = COALESCE(r.error, 'WORKER_REAPED')
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
