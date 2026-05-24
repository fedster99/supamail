import { pathToFileURL } from "node:url";
import { startApiServer } from "./api.js";
import { getConfig } from "./config.js";
import { closePool, getPool } from "./db.js";
import { MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";
import { startWorkerRuntime } from "./worker-runtime.js";

export type SupaMailRuntimeMode = "worker" | "api" | "combined";

interface ClosableServer {
  close(callback?: (error?: Error) => void): void;
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
    const server = startApiServer();
    installApiShutdownHandler(server);
    return;
  }

  const config = getConfig();
  const pool = getPool();
  const repository = new MirrorRepository(pool, config);
  const engine = new MirrorEngine({ pool, config, repository });
  const server = startApiServer({ config, pool, repository, engine });
  const worker = await startWorkerRuntime({ config, pool, repository, engine });

  const shutdown = () => {
    worker.stop();
    closeServer(server);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await worker.done;
  } finally {
    closeServer(server);
    await closePool();
  }
}

function installApiShutdownHandler(server: ClosableServer): void {
  const shutdown = async () => {
    closeServer(server);
    await closePool();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

function closeServer(server: ClosableServer): void {
  server.close((error) => {
    if (error) {
      console.error(JSON.stringify({
        event: "api.close.failed",
        error: { message: error.message, stack: error.stack }
      }));
    }
  });
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
