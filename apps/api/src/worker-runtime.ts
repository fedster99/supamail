import type { AppConfig } from "./config.js";
import { getConfig } from "./config.js";
import { closePool, getPool, type PgPool } from "./db.js";
import { clearOrphanedLocks, runLockSelfTestWithRetry } from "./locks.js";
import { MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";

interface WorkerEngine {
  syncDueAccounts(limit?: number, options?: { signal?: AbortSignal }): Promise<Array<{
    runId: string;
    outcome: string;
    foldersProcessed: number;
    messagesUpserted: number;
    bodiesFetched: number;
    errors: string[];
  }>>;
}

export interface WorkerRuntimeOptions {
  config?: AppConfig;
  pool?: PgPool;
  engine?: WorkerEngine;
  repository?: MirrorRepository;
  installProcessHandlers?: boolean;
  closePoolOnStop?: boolean;
}

export interface WorkerRuntime {
  stop(): void;
  done: Promise<void>;
}

export async function startWorkerRuntime(options: WorkerRuntimeOptions = {}): Promise<WorkerRuntime> {
  const config = options.config ?? getConfig();
  const pool = options.pool ?? getPool();
  const repository = options.repository ?? new MirrorRepository(pool, config);
  const engine = options.engine ?? new MirrorEngine({ pool, config, repository });
  const abort = new AbortController();
  let stopping = false;
  let wakeSleep: (() => void) | null = null;

  const stop = () => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    wakeSleep?.();
  };

  if (options.installProcessHandlers) {
    process.on("uncaughtException", (error) => {
      console.error(JSON.stringify({
        event: "process.uncaughtException",
        error: error instanceof Error
          ? { message: error.message, stack: error.stack }
          : String(error)
      }));
      stop();
    });

    process.on("unhandledRejection", (reason) => {
      console.error(JSON.stringify({
        event: "process.unhandledRejection",
        reason: reason instanceof Error
          ? { message: reason.message, stack: reason.stack }
          : String(reason)
      }));
      stop();
    });

    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }

  async function tick(): Promise<void> {
    const startedAt = Date.now();
    const results = await engine.syncDueAccounts(undefined, { signal: abort.signal });
    console.log(JSON.stringify({
      event: "sync.tick.completed",
      accounts: results.length,
      durationMs: Date.now() - startedAt,
      outcomes: results.map((result) => ({
        runId: result.runId,
        outcome: result.outcome,
        foldersProcessed: result.foldersProcessed,
        messagesUpserted: result.messagesUpserted,
        bodiesFetched: result.bodiesFetched,
        errors: result.errors
      }))
    }));
  }

  async function sleep(ms: number): Promise<void> {
    if (stopping) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        wakeSleep = null;
        resolve();
      }, ms);

      wakeSleep = () => {
        clearTimeout(timeout);
        wakeSleep = null;
        resolve();
      };
    });
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      try {
        await tick();
      } catch (error) {
        console.error(JSON.stringify({
          event: "sync.tick.failed",
          error: error instanceof Error
            ? { message: error.message, stack: error.stack }
            : String(error)
        }));
      }
      if (stopping) break;
      await sleep(config.SYNC_INTERVAL_MS);
    }
  }

  // Retry transient session-pooler saturation (deploy-time instance overlap) instead
  // of crash-looping startup; a real transaction-pooling misconfig stays fatal.
  await runLockSelfTestWithRetry(pool, {
    onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
      console.log(JSON.stringify({
        event: "worker.lock_self_test.retry",
        attempt,
        maxAttempts,
        delayMs,
        error: error instanceof Error ? error.message : String(error)
      }))
  });
  console.log(JSON.stringify({ event: "worker.lock_self_test.passed" }));

  const sweep = await clearOrphanedLocks(pool, config.STALE_HEARTBEAT_MS);
  if (sweep.terminatedBackends > 0 || sweep.accountsReset > 0 || sweep.runsClosed > 0) {
    console.warn(JSON.stringify({
      event: "worker.orphaned_locks_cleared",
      terminatedBackends: sweep.terminatedBackends,
      accountsReset: sweep.accountsReset,
      runsClosed: sweep.runsClosed
    }));
  }

  const accountCount = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM public.imap_accounts"
  );
  const count = Number(accountCount.rows[0]?.count ?? 0);
  if (count > config.SYNC_MAX_ACCOUNTS) {
    throw new Error(`Account count ${count} exceeds SYNC_MAX_ACCOUNTS ${config.SYNC_MAX_ACCOUNTS}`);
  }
  console.log(JSON.stringify({
    event: "worker.account_cap.checked",
    count,
    max: config.SYNC_MAX_ACCOUNTS
  }));

  const retention = await repository.runRetentionJobs();
  console.log(JSON.stringify({
    event: "worker.retention.completed",
    expired: retention.expired,
    purged: retention.purged
  }));

  const done = loop().finally(async () => {
    if (options.closePoolOnStop) {
      await closePool();
    }
  });

  return { stop, done };
}
