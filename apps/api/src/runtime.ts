import { pathToFileURL } from "node:url";
import { startApiServer } from "./api.js";
import { getConfig } from "./config.js";
import { closePool, getPool, type PgPool } from "./db.js";
import { runLockSelfTestWithRetry } from "./locks.js";
import { MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";
import { startWorkerRuntime } from "./worker-runtime.js";

export type SupaMailRuntimeMode = "worker" | "api" | "combined";

interface ClosableServer {
  close(callback?: (error?: Error) => void): void;
}

interface ErrorLogSink {
  error(message: string): void;
}

export function parseRuntimeMode(env: NodeJS.ProcessEnv = process.env): SupaMailRuntimeMode {
  const mode = env.SUPAMAIL_MODE ?? "worker";
  if (mode === "worker" || mode === "api" || mode === "combined") return mode;
  throw new Error("SUPAMAIL_MODE must be one of: worker, api, combined");
}

export async function startRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const mode = parseRuntimeMode(env);

  if (env.SUPAMAIL_RUNTIME_CHECK === "1") {
    console.log(JSON.stringify({ ok: true, mode }));
    return;
  }

  if (mode === "worker") {
    const runtime = await startWorkerRuntime({ installProcessHandlers: true, closePoolOnStop: true });
    await runtime.done;
    return;
  }

  if (mode === "api") {
    // The API takes the per-account advisory lock (on-demand body fetch, draft APPEND,
    // flag/move mutations), so a standalone API must verify session-affine pooling at
    // startup like the worker — a transaction pooler silently breaks the lock mutex.
    await runApiLockSelfTest(getPool());
    const server = startApiServer();
    installApiShutdownHandler(server);
    return;
  }

  const config = getConfig();
  const pool = getPool();
  // Gate the API on the lock self-test before it starts serving (the worker re-runs
  // its own below; that redundancy is a couple of startup queries).
  await runApiLockSelfTest(pool);
  const repository = new MirrorRepository(pool, config);
  const engine = new MirrorEngine({ pool, config, repository });
  const server = startApiServer({ config, pool, repository, engine });
  const closeApi = createServerCloser(server);
  const worker = await startWorkerRuntime({
    config,
    pool,
    repository,
    engine,
    installProcessHandlers: true, onStop: closeApi
  });

  try {
    await worker.done;
  } finally {
    closeApi();
    await closePool();
  }
}

async function runApiLockSelfTest(pool: PgPool): Promise<void> {
  await runLockSelfTestWithRetry(pool, {
    onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
      console.log(JSON.stringify({
        event: "api.lock_self_test.retry",
        attempt,
        maxAttempts,
        delayMs,
        error: error instanceof Error ? error.message : String(error)
      }))
  });
  console.log(JSON.stringify({ event: "api.lock_self_test.passed" }));
}

function installApiShutdownHandler(server: ClosableServer): void {
  const closeApi = createServerCloser(server);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    closeApi();
    await closePool();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

/**
 * Node returns ERR_SERVER_NOT_RUNNING when close is requested after a server has
 * already stopped. Treat that as successful idempotent shutdown, while preserving
 * genuine teardown failures as error-level structured logs.
 */
export function createServerCloser(
  server: ClosableServer,
  sink: ErrorLogSink = console
): () => void {
  let closeRequested = false;

  return () => {
    if (closeRequested) return;
    closeRequested = true;
    server.close((error) => {
      if (!error) return;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ERR_SERVER_NOT_RUNNING") return;
      sink.error(JSON.stringify({
        event: "api.close.failed",
        error: { message: error.message, code, stack: error.stack }
      }));
    });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await startRuntimeFromEnv();
  } catch (error) {
    console.error(JSON.stringify({
      event: "runtime.startup.failed",
      error: error instanceof Error
        ? { message: error.message, stack: error.stack }
        : String(error)
    }));
    await closePool().catch(() => undefined);
    process.exit(1);
  }
}
