import { getConfig } from "./config.js";
import { closePool, getPool } from "./db.js";
import { clearOrphanedLocks, runLockSelfTest } from "./locks.js";
import { MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";

const config = getConfig();
const engine = new MirrorEngine();
const repository = new MirrorRepository(getPool(), config);
const abort = new AbortController();
let stopping = false;
let wakeSleep: (() => void) | null = null;

// On a fatal error, drain the loop and close the pool rather than crashing
// immediately: this releases the held advisory lock through pg's normal
// session-close, so the next worker that starts up doesn't see a stuck
// account. The supervisor restarts us either way.
process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({
    event: "process.uncaughtException",
    error: error instanceof Error
      ? { message: error.message, stack: error.stack }
      : String(error)
  }));
  shutdown();
});

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({
    event: "process.unhandledRejection",
    reason: reason instanceof Error
      ? { message: reason.message, stack: reason.stack }
      : String(reason)
  }));
  shutdown();
});

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

async function startup(): Promise<void> {
  await runLockSelfTest(getPool());
  console.log(JSON.stringify({ event: "worker.lock_self_test.passed" }));

  const clearedLocks = await clearOrphanedLocks(getPool(), config.STALE_HEARTBEAT_MS);
  if (clearedLocks > 0) {
    console.warn(JSON.stringify({
      event: "worker.orphaned_locks_cleared",
      count: clearedLocks
    }));
  }

  const accountCount = await getPool().query<{ count: string }>(
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
}

function sleep(ms: number): Promise<void> {
  if (stopping) return Promise.resolve();

  return new Promise((resolve) => {
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

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  abort.abort();
  wakeSleep?.();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

try {
  await startup();
} catch (error) {
  console.error(JSON.stringify({
    event: "worker.startup.failed",
    error: error instanceof Error
      ? { message: error.message, stack: error.stack }
      : String(error)
  }));
  await closePool().catch(() => undefined);
  process.exit(1);
}
await loop();
await closePool();
