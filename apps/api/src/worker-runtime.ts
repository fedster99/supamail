import { performance } from "node:perf_hooks";
import type { AppConfig } from "./config.js";
import { getConfig } from "./config.js";
import { closePool, getPool, type PgPool } from "./db.js";
import { clearOrphanedLocks, runLockSelfTestWithRetry } from "./locks.js";
import { MirrorRepository, sanitizeErrorReason } from "./repository.js";
import { metadataRowsPerSecond, MirrorEngine } from "./sync-engine.js";

export interface WorkerSyncResult {
  runId: string;
  outcome: string;
  foldersProcessed: number;
  messagesUpserted: number;
  metadataRowsCommitted?: number;
  metadataWriteDurationMs?: number;
  metadataWriteBatchesAttempted?: number;
  metadataWriteBatchesFailed?: number;
  metadataWriteServiceRowsPerSecond?: number | null;
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

function sentLaneSignal(
  parent: AbortSignal,
  timeoutMs: number
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  if (parent.aborted) {
    abort();
  } else {
    parent.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    }
  };
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

function isNonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasCompleteMetadataTelemetry(result: WorkerSyncResult): boolean {
  const rows = result.metadataRowsCommitted;
  const durationMs = result.metadataWriteDurationMs;
  const attempted = result.metadataWriteBatchesAttempted;
  const failed = result.metadataWriteBatchesFailed;
  if (!isNonNegativeCount(rows)
    || !isNonNegativeDuration(durationMs)
    || !isNonNegativeCount(attempted)
    || !isNonNegativeCount(failed)
    || failed > attempted) {
    return false;
  }
  if (attempted === 0) {
    return rows === 0 && durationMs === 0 && failed === 0;
  }
  return durationMs > 0
    && (failed !== attempted || rows === 0)
    && rows >= attempted - failed;
}

function loggedOutcome(result: WorkerSyncResult) {
  const metadataTelemetryComplete = hasCompleteMetadataTelemetry(result);
  const metadataRowsCommitted = isNonNegativeCount(result.metadataRowsCommitted) ? result.metadataRowsCommitted : 0;
  const metadataWriteDurationMs = isNonNegativeDuration(result.metadataWriteDurationMs)
    ? result.metadataWriteDurationMs
    : 0;
  const metadataWriteBatchesAttempted = isNonNegativeCount(result.metadataWriteBatchesAttempted)
    ? result.metadataWriteBatchesAttempted
    : 0;
  const metadataWriteBatchesFailed = isNonNegativeCount(result.metadataWriteBatchesFailed)
    ? result.metadataWriteBatchesFailed
    : 0;
  return {
    runId: result.runId,
    outcome: result.outcome,
    foldersProcessed: result.foldersProcessed,
    messagesUpserted: result.messagesUpserted,
    metadataRowsCommitted,
    metadataWriteDurationMs,
    metadataWriteBatchesAttempted,
    metadataWriteBatchesFailed,
    metadataTelemetryComplete,
    metadataWriteServiceRowsPerSecond: metadataTelemetryComplete && metadataWriteBatchesAttempted > 0
      ? metadataRowsPerSecond(metadataRowsCommitted, metadataWriteDurationMs)
      : null,
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
  const metadataRowsCommitted = outcomes.reduce((sum, outcome) => sum + outcome.metadataRowsCommitted, 0);
  const metadataWriteDurationMs = outcomes.reduce((sum, outcome) => sum + outcome.metadataWriteDurationMs, 0);
  const metadataWriteBatchesAttempted = outcomes.reduce(
    (sum, outcome) => sum + outcome.metadataWriteBatchesAttempted,
    0
  );
  const metadataWriteBatchesFailed = outcomes.reduce(
    (sum, outcome) => sum + outcome.metadataWriteBatchesFailed,
    0
  );
  const metadataTelemetryComplete = outcomes.every((outcome) => outcome.metadataTelemetryComplete);
  const hasMetadataSample = metadataTelemetryComplete && metadataWriteBatchesAttempted > 0;

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
    metadataRowsCommitted,
    metadataWriteDurationMs,
    metadataWriteBatchesAttempted,
    metadataWriteBatchesFailed,
    metadataTelemetryComplete,
    metadataWriteServiceRowsPerSecond: hasMetadataSample
      ? metadataRowsPerSecond(metadataRowsCommitted, metadataWriteDurationMs)
      : null,
    metadataThroughputRowsPerSecond: hasMetadataSample
      ? metadataRowsPerSecond(metadataRowsCommitted, durationMs)
      : null,
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

  async function tick(lane: "full" | "sent", startedAt: number): Promise<void> {
    const tickStartedAt = performance.now();
    if (lane === "full") lastFullSyncStartedAtMs = startedAt;
    if (lane === "full") {
      const results = await engine.syncDueAccounts(undefined, { signal: abort.signal });
      logSyncTick(results, performance.now() - tickStartedAt);
      return;
    }

    const fullSweepDueAt = (lastFullSyncStartedAtMs ?? startedAt) + config.SYNC_INTERVAL_MS;
    const sent = sentLaneSignal(abort.signal, Math.max(1, fullSweepDueAt - startedAt));
    try {
      const results = await engine.syncDueSentFolders(undefined, { signal: sent.signal });
      logSyncTick(results, performance.now() - tickStartedAt);
    } finally {
      sent.dispose();
    }
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
      let lane: "full" | "sent" | null = null;
      try {
        const startedAt = Date.now();
        lane = selectSyncLane(startedAt, lastFullSyncStartedAtMs, config);
        await tick(lane, startedAt);
      } catch (error) {
        console.error(JSON.stringify({
          event: "sync.tick.failed",
          error: error instanceof Error
            ? { message: error.message, stack: error.stack }
            : String(error)
        }));
      }
      if (stopping) break;
      const pollDelay = workerPollIntervalMs(config);
      const delay = lane === "sent" && lastFullSyncStartedAtMs !== null
        ? Math.min(
          pollDelay,
          Math.max(0, lastFullSyncStartedAtMs + config.SYNC_INTERVAL_MS - Date.now())
        )
        : pollDelay;
      await sleep(delay);
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
