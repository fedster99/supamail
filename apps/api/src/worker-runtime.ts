import type { AppConfig } from "./config.js";
import { getConfig } from "./config.js";
import { closePool, getPool, type PgPool } from "./db.js";
import { clearOrphanedLocks, runLockSelfTestWithRetry } from "./locks.js";
import { MirrorRepository, sanitizeErrorReason } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";

export interface WorkerSyncResult {
  runId: string;
  outcome: string;
  foldersProcessed: number;
  messagesUpserted: number;
  bodiesFetched: number;
  errors: string[];
}

interface WorkerEngine {
  syncDueAccounts(limit?: number, options?: { signal?: AbortSignal }): Promise<WorkerSyncResult[]>;
  syncDueSentFolders(limit?: number, options?: { signal?: AbortSignal }): Promise<WorkerSyncResult[]>;
}

type SyncCadence = Pick<AppConfig, "SYNC_INTERVAL_MS" | "SENT_SYNC_INTERVAL_MS">;

export function workerPollIntervalMs(config: SyncCadence): number {
  return Math.min(config.SYNC_INTERVAL_MS, config.SENT_SYNC_INTERVAL_MS);
}

export function selectSyncLane(
  nowMs: number,
  lastFullSyncStartedAtMs: number | null,
  config: SyncCadence
): "full" | "sent" {
  if (lastFullSyncStartedAtMs === null) return "full";
  return nowMs - lastFullSyncStartedAtMs >= config.SYNC_INTERVAL_MS ? "full" : "sent";
}

export interface WorkerLogSink {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
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

function loggedOutcome(result: WorkerSyncResult) {
  return {
    runId: result.runId,
    outcome: result.outcome,
    foldersProcessed: result.foldersProcessed,
    messagesUpserted: result.messagesUpserted,
    bodiesFetched: result.bodiesFetched,
    errors: result.errors.map(sanitizeErrorReason)
  };
}

/**
 * Emit severity-correct per-account outcomes for log backends such as Render while
 * retaining the aggregate tick event used for throughput and duration analysis.
 * Sanitize again at the logging boundary so an injected/alternate WorkerEngine cannot
 * bypass the same credential and control-character policy used by MirrorEngine.
 */
export function logSyncTick(
  results: WorkerSyncResult[],
  durationMs: number,
  sink: WorkerLogSink = console
): void {
  const outcomes = results.map(loggedOutcome);

  for (const outcome of outcomes) {
    if (outcome.outcome === "failed") {
      sink.error(JSON.stringify({ event: "sync.account.failed", ...outcome }));
    } else if (outcome.outcome === "partial_success") {
      sink.warn(JSON.stringify({ event: "sync.account.partial_success", ...outcome }));
    }
  }

  sink.log(JSON.stringify({
    event: "sync.tick.completed",
    accounts: outcomes.length,
    durationMs,
    outcomes
  }));
}

export async function startWorkerRuntime(options: WorkerRuntimeOptions = {}): Promise<WorkerRuntime> {
  const config = options.config ?? getConfig();
  const pool = options.pool ?? getPool();
  const repository = options.repository ?? new MirrorRepository(pool, config);
  const engine = options.engine ?? new MirrorEngine({ pool, config, repository });
  const abort = new AbortController();
  let stopping = false;
  let wakeSleep: (() => void) | null = null;
  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  let lastFullSyncStartedAtMs: number | null = null;

  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (retentionTimer) clearInterval(retentionTimer);
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
    const lane = selectSyncLane(startedAt, lastFullSyncStartedAtMs, config);
    if (lane === "full") lastFullSyncStartedAtMs = startedAt;
    const results = lane === "full"
      ? await engine.syncDueAccounts(undefined, { signal: abort.signal })
      : await engine.syncDueSentFolders(undefined, { signal: abort.signal });
    logSyncTick(results, Date.now() - startedAt);
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
      await sleep(workerPollIntervalMs(config));
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

  const logRetention = (r: { expired: number; purged: number; prunedEvents: number }) =>
    console.log(JSON.stringify({
      event: "worker.retention.completed",
      expired: r.expired,
      purged: r.purged,
      prunedEvents: r.prunedEvents
    }));

  logRetention(await repository.runRetentionJobs());
  // Re-run retention daily: it was boot-only, so on a long-lived process expiry/purge
  // and the (previously unbounded) sync-event prune silently stopped after startup.
  retentionTimer = setInterval(() => {
    repository
      .runRetentionJobs()
      .then(logRetention)
      .catch((error) =>
        console.error(JSON.stringify({
          event: "worker.retention.failed",
          error: error instanceof Error ? error.message : String(error)
        }))
      );
  }, 24 * 60 * 60_000);
  retentionTimer.unref?.();

  const done = loop().finally(async () => {
    if (options.closePoolOnStop) {
      await closePool();
    }
  });

  return { stop, done };
}
