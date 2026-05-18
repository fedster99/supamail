import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const dockerImage = process.env.LIVE_DB_POSTGRES_IMAGE ?? "postgres:16-alpine";
const containerName = process.env.LIVE_DB_CONTAINER
  ?? `supamail-db-live-${process.pid}-${randomUUID().slice(0, 8)}`;
const keepDb = process.env.KEEP_DB === "1";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const signalExitCodes: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 130,
  SIGTERM: 143
};

let containerStarted = false;
let cleanedUp = false;
let currentChild: ReturnType<typeof spawn> | null = null;
let shuttingDown = false;

async function docker(args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      maxBuffer: 10 * 1024 * 1024
    });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (allowFailure) return "";
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`docker ${args.join(" ")} failed: ${details}`);
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit"
    });
    currentChild = child;
    child.on("error", reject);
    child.on("close", (code) => {
      if (currentChild === child) currentChild = null;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function assertDockerAvailable(): Promise<void> {
  await docker(["version", "--format", "{{.Server.Version}}"]);
}

async function mappedPort(name: string): Promise<string> {
  const output = await docker(["port", name, "5432/tcp"]);
  const match = output.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/) ?? output.match(/:(\d+)/);
  if (!match) throw new Error(`Could not parse mapped Postgres port from: ${output}`);
  return match[1];
}

async function waitForPostgres(name: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const output = await docker(["exec", name, "pg_isready", "-U", "postgres", "-d", "postgres"], true);
    if (output.includes("accepting connections")) return;
    await delay(500);
  }

  const logs = await docker(["logs", name], true);
  throw new Error(`Postgres did not become ready. Container logs:\n${logs}`);
}

async function printContainerLogs(reason: string): Promise<void> {
  if (!containerStarted) return;
  const logs = await docker(["logs", "--tail", "200", containerName], true);
  if (!logs) return;
  console.error(`[test:db:live] container logs after ${reason}:\n${logs}`);
}

async function cleanup(reason: string): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  if (!containerStarted) return;

  if (keepDb) {
    const port = await mappedPort(containerName).catch(() => "unknown");
    console.log(`[test:db:live] KEEP_DB=1, leaving ${containerName} running on port ${port} after ${reason}`);
    return;
  }

  console.log(`[test:db:live] removing ${containerName} after ${reason}`);
  await docker(["rm", "-f", containerName], true);
}

function installShutdownHandlers(): void {
  for (const signal of Object.keys(signalExitCodes) as NodeJS.Signals[]) {
    process.once(signal, () => {
      if (shuttingDown) {
        process.exit(signalExitCodes[signal] ?? 1);
      }
      shuttingDown = true;
      console.warn(`[test:db:live] received ${signal}; stopping active step and cleaning up`);
      currentChild?.kill(signal);
      cleanup(signal)
        .catch((error) => {
          console.error(error instanceof Error ? error.message : error);
        })
        .finally(() => process.exit(signalExitCodes[signal] ?? 1));
    });
  }
}

async function main(): Promise<void> {
  installShutdownHandlers();
  await assertDockerAvailable();

  try {
    console.log(`[test:db:live] starting ${dockerImage} as ${containerName}`);
    await docker([
      "run",
      "-d",
      ...(keepDb ? [] : ["--rm"]),
      "--name",
      containerName,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=postgres",
      "-p",
      "127.0.0.1::5432",
      dockerImage
    ]);
    containerStarted = true;

    await waitForPostgres(containerName);
    const port = await mappedPort(containerName);
    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      IMAP_ALLOW_PRIVATE_HOSTS: "true",
      IMAP_ENCRYPTION_KEY: process.env.IMAP_ENCRYPTION_KEY ?? "local-live-db-test-encryption-key",
      LIVE_DB_TESTS: "1",
      SKIP_TEST_MIGRATION: "1"
    };

    console.log(`[test:db:live] DATABASE_URL=${databaseUrl.replace(/:[^@:]*@/, ":***@")}`);
    console.log("[test:db:live] applying migration twice");
    await run(pnpm, ["migrate"], env);
    await run(pnpm, ["migrate"], env);

    console.log("[test:db:live] running live DB integration suites");
    await run(pnpm, [
      "exec",
      "vitest",
      "run",
      "src/__tests__/sync-engine.integration.test.ts",
      "src/__tests__/sync-engine.live-db.test.ts"
    ], env);

    console.log("[test:db:live] running spec conformance");
    await run(pnpm, ["spec-conformance"], env);
  } catch (error) {
    await printContainerLogs("failure");
    throw error;
  } finally {
    await cleanup("completion");
  }
}

main()
  .then(() => {
    console.log("[test:db:live] completed successfully");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
