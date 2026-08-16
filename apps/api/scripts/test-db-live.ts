import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  EphemeralPostgres,
  installEphemeralPostgresSignalHandlers
} from "./ephemeral-postgres.js";

const execFileAsync = promisify(execFile);
const dockerImage = process.env.LIVE_DB_POSTGRES_IMAGE ?? "postgres:16-alpine";
const keepDb = process.env.KEEP_DB === "1";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const database = new EphemeralPostgres({
  image: dockerImage,
  namePrefix: process.env.LIVE_DB_CONTAINER ?? "supamail-db-live",
  purpose: "live-db-test",
  keep: keepDb
});

let currentChild: ReturnType<typeof spawn> | null = null;

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

async function printContainerLogs(reason: string): Promise<void> {
  const logs = await database.logs();
  if (!logs) return;
  console.error(`[test:db:live] container logs after ${reason}:\n${logs}`);
}

async function main(): Promise<void> {
  installEphemeralPostgresSignalHandlers(database, {
    logPrefix: "[test:db:live]",
    onSignal: (signal) => currentChild?.kill(signal)
  });
  await assertDockerAvailable();

  try {
    console.log(
      `[test:db:live] starting ${dockerImage} as ${database.resources.containerName}`
      + ` with volume ${database.resources.volumeName}`
    );
    const databaseUrl = await database.start();
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      IMAP_ALLOW_PRIVATE_HOSTS: "true",
      IMAP_ENCRYPTION_KEY: process.env.IMAP_ENCRYPTION_KEY ?? "local-live-db-test-encryption-key",
      LIVE_DB_TESTS: "1",
      SKIP_TEST_MIGRATION: "1"
    };

    console.log(`[test:db:live] DATABASE_URL=${databaseUrl.replace(/:[^@:]*@/, ":***@")}`);
    console.log("[test:db:live] testing populated pre-0014 threading upgrade");
    await run(pnpm, ["test:migration:threading-upgrade"], env);
    console.log("[test:db:live] applying migration twice");
    await run(pnpm, ["migrate"], env);
    await run(pnpm, ["migrate"], env);

    console.log("[test:db:live] running live DB integration suites");
    // These files share one Postgres and some exercise global recovery scans
    // (pg_locks, clearOrphanedLocks). Run files sequentially so cross-file
    // shared-state cannot cause order-dependent flakes.
    await run(pnpm, [
      "exec",
      "vitest",
      "run",
      "--no-file-parallelism",
      "src/__tests__/provider-compatibility.integration.test.ts",
      "src/__tests__/sync-engine.integration.test.ts",
      "src/__tests__/sync-engine.live-db.test.ts",
      "src/__tests__/threading-repository.live-db.test.ts",
      "src/__tests__/repository-threading-headers.live-db.test.ts",
      "src/__tests__/metadata-protection.live-db.test.ts",
      "src/__tests__/search.live-db.test.ts",
      "src/__tests__/search-quality.live-db.test.ts",
      "src/__tests__/search-eval-threading.live-db.test.ts",
      "src/__tests__/content.live-db.test.ts",
      "src/__tests__/account-credentials.live-db.test.ts",
      "src/__tests__/mailbox-mutations.live-db.test.ts",
      "src/__tests__/drafts.live-db.test.ts",
      "src/__tests__/send.live-db.test.ts",
      "src/mcp/tools/read-message.live-db.test.ts",
      "src/mcp/tools/read-thread.live-db.test.ts",
      "src/mcp/tools/list-folders.live-db.test.ts",
      "src/mcp/tools/draft-reply.live-db.test.ts"
    ], env);

    console.log("[test:db:live] running spec conformance");
    await run(pnpm, ["spec-conformance"], env);
  } catch (error) {
    await printContainerLogs("failure");
    throw error;
  } finally {
    await database.cleanup("completion");
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
