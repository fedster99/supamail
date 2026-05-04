import { getConfig } from "./config.js";
import { closePool } from "./db.js";
import { MirrorEngine } from "./sync-engine.js";

const config = getConfig();
const engine = new MirrorEngine();
let stopping = false;
let wakeSleep: (() => void) | null = null;

async function tick(): Promise<void> {
  const startedAt = Date.now();
  const results = await engine.syncDueAccounts();
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
      console.error("sync.tick.failed", error);
    }
    await sleep(config.SYNC_INTERVAL_MS);
  }
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

function stop(): void {
  stopping = true;
  wakeSleep?.();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await loop();
await closePool();
