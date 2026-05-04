import { getConfig } from "./config.js";
import { closePool } from "./db.js";
import { MirrorEngine } from "./sync-engine.js";

const config = getConfig();
const engine = new MirrorEngine();
let stopping = false;

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
    await new Promise((resolve) => setTimeout(resolve, config.SYNC_INTERVAL_MS));
  }
}

process.on("SIGTERM", () => {
  stopping = true;
});

process.on("SIGINT", () => {
  stopping = true;
});

await loop();
await closePool();
