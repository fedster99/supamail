import { closePool } from "./db.js";
import { startWorkerRuntime } from "./worker-runtime.js";

try {
  const runtime = await startWorkerRuntime({ installProcessHandlers: true, closePoolOnStop: true });
  await runtime.done;
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
