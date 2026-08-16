import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  EphemeralPostgres,
  type EphemeralPostgresResources
} from "./ephemeral-postgres.js";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(scriptDir, "ephemeral-postgres-fixture.ts");
const runnerMode = process.argv[2];
const testGroup = process.env.SUPAMAIL_EPHEMERAL_TEST_GROUP ?? randomUUID();
const groupFilter = `label=io.supamail.lifecycle-test=${testGroup}`;
const activeChildren = new Map<ChildProcess, Promise<ProcessExit>>();

type FixtureMode = "success" | "failure" | "port-failure" | "hold";

type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type Snapshot = {
  containers: string[];
  volumes: string[];
};

type Fixture = {
  child: ChildProcess;
  exit: Promise<ProcessExit>;
  ready: Promise<EphemeralPostgresResources>;
  stderr: () => string;
};

type RunnerFixture = {
  child: ChildProcess;
  exit: Promise<ProcessExit>;
  ready: Promise<void>;
  stderr: () => string;
};

async function docker(args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, { encoding: "utf8" });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

async function snapshot(): Promise<Snapshot> {
  const [containers, volumes] = await Promise.all([
    docker(["ps", "-a", "--filter", groupFilter, "--format", "{{.Names}}"]),
    docker(["volume", "ls", "--filter", groupFilter, "--format", "{{.Name}}"])
  ]);
  return {
    containers: containers.split("\n").filter(Boolean).sort(),
    volumes: volumes.split("\n").filter(Boolean).sort()
  };
}

function launchFixture(mode: FixtureMode): Fixture {
  if (runnerCleanupPromise) {
    throw new Error("Cannot launch a lifecycle fixture after runner cleanup has begun");
  }
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode], {
    cwd: resolve(scriptDir, ".."),
    env: { ...process.env, SUPAMAIL_EPHEMERAL_TEST_GROUP: testGroup },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let resolveReady: (resources: EphemeralPostgresResources) => void;
  let rejectReady: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<EphemeralPostgresResources>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const readyTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error(`Fixture ${mode} did not become ready. stderr:\n${stderrBuffer}`));
  }, 45_000);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    for (const line of stdoutBuffer.split("\n")) {
      if (!line.startsWith("SUPAMAIL_FIXTURE_READY ") || readySettled) continue;
      readySettled = true;
      clearTimeout(readyTimer);
      resolveReady(JSON.parse(line.slice("SUPAMAIL_FIXTURE_READY ".length)) as EphemeralPostgresResources);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrBuffer += chunk;
  });

  const exit = new Promise<ProcessExit>((resolvePromise) => {
    child.once("exit", (code, signal) => {
      activeChildren.delete(child);
      if (!readySettled) {
        readySettled = true;
        clearTimeout(readyTimer);
        rejectReady(new Error(`Fixture ${mode} exited before ready. stderr:\n${stderrBuffer}`));
      }
      resolvePromise({ code, signal });
    });
  });
  activeChildren.set(child, exit);

  return { child, exit, ready, stderr: () => stderrBuffer };
}

function launchRunnerFixture(): RunnerFixture {
  if (runnerCleanupPromise) {
    throw new Error("Cannot launch a nested lifecycle runner after cleanup has begun");
  }
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "hold-runner"], {
    cwd: resolve(scriptDir, ".."),
    env: { ...process.env, SUPAMAIL_EPHEMERAL_TEST_GROUP: testGroup },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const readyTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error(`Lifecycle runner did not become ready. stderr:\n${stderrBuffer}`));
  }, 45_000);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    if (!stdoutBuffer.includes("SUPAMAIL_RUNNER_READY") || readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    resolveReady();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrBuffer += chunk;
  });

  const exit = new Promise<ProcessExit>((resolvePromise) => {
    child.once("exit", (code, signal) => {
      activeChildren.delete(child);
      if (!readySettled) {
        readySettled = true;
        clearTimeout(readyTimer);
        rejectReady(new Error(`Lifecycle runner exited before ready. stderr:\n${stderrBuffer}`));
      }
      resolvePromise({ code, signal });
    });
  });
  activeChildren.set(child, exit);

  return { child, exit, ready, stderr: () => stderrBuffer };
}

async function assertScenario(
  name: string,
  mode: Exclude<FixtureMode, "port-failure">,
  expectedCode: number,
  signal?: NodeJS.Signals
): Promise<void> {
  const before = await snapshot();
  const fixture = launchFixture(mode);
  await fixture.ready;
  if (signal) fixture.child.kill(signal);
  const result = await fixture.exit;
  assert.equal(
    result.code,
    expectedCode,
    `${name} exit mismatch (signal=${result.signal}, stderr=${fixture.stderr()})`
  );
  assert.deepEqual(await snapshot(), before, `${name} leaked a labeled container or volume`);
  console.log(`[docker-lifecycle] ${name}: passed`);
}

async function assertPortDiscoveryFailure(): Promise<void> {
  const before = await snapshot();
  const fixture = launchFixture("port-failure");
  const readyFailure = assert.rejects(fixture.ready, /exited before ready/);
  const result = await fixture.exit;
  await readyFailure;
  assert.equal(result.code, 1, fixture.stderr());
  assert.deepEqual(await snapshot(), before, "port discovery failure leaked labeled resources");
  console.log("[docker-lifecycle] port discovery failure: passed");
}

async function assertNoStartAfterCleanup(): Promise<void> {
  const before = await snapshot();
  const database = new EphemeralPostgres({
    image: process.env.LIVE_DB_POSTGRES_IMAGE ?? "postgres:16-alpine",
    namePrefix: "supamail-lifecycle",
    purpose: "docker-lifecycle-regression",
    testGroup
  });
  await database.cleanup("shutdown before startup");
  await assert.rejects(
    database.start(),
    /Cannot start disposable Postgres after cleanup has begun/
  );
  assert.deepEqual(await snapshot(), before, "startup after cleanup created labeled resources");
  console.log("[docker-lifecycle] startup blocked after cleanup: passed");
}

async function assertRunnerSignal(signal: "SIGINT" | "SIGTERM", expectedCode: number): Promise<void> {
  const before = await snapshot();
  const runner = launchRunnerFixture();
  await runner.ready;
  runner.child.kill(signal);
  const result = await runner.exit;
  assert.equal(result.code, expectedCode, runner.stderr());
  assert.deepEqual(await snapshot(), before, `lifecycle runner ${signal} leaked labeled resources`);
  console.log(`[docker-lifecycle] runner ${signal}: passed`);
}

async function assertParallelIsolation(): Promise<void> {
  const before = await snapshot();
  const first = launchFixture("hold");
  const second = launchFixture("hold");
  const [firstResources, secondResources] = await Promise.all([first.ready, second.ready]);
  assert.notEqual(firstResources.volumeName, secondResources.volumeName);
  assert.notEqual(firstResources.containerName, secondResources.containerName);

  const both = await snapshot();
  assert.deepEqual(
    both.containers,
    [firstResources.containerName, secondResources.containerName].sort()
  );
  assert.deepEqual(both.volumes, [firstResources.volumeName, secondResources.volumeName].sort());

  first.child.kill("SIGTERM");
  assert.equal((await first.exit).code, 143, first.stderr());
  assert.deepEqual(await snapshot(), {
    containers: [secondResources.containerName],
    volumes: [secondResources.volumeName]
  }, "one run removed the other run's resources");

  second.child.kill("SIGINT");
  assert.equal((await second.exit).code, 130, second.stderr());
  assert.deepEqual(await snapshot(), before, "parallel runs leaked labeled resources");
  console.log("[docker-lifecycle] parallel isolation: passed");
}

async function cleanupTestGroup(): Promise<void> {
  const resources = await snapshot();
  if (resources.containers.length > 0) {
    await docker(["rm", "-f", ...resources.containers], true);
  }
  for (const volume of resources.volumes) await docker(["volume", "rm", volume], true);
}

let runnerCleanupPromise: Promise<void> | null = null;
function cleanupRunner(): Promise<void> {
  if (runnerCleanupPromise) return runnerCleanupPromise;
  runnerCleanupPromise = (async () => {
    const children = [...activeChildren.entries()];
    for (const [child] of children) child.kill("SIGTERM");
    await Promise.allSettled(children.map(([, exit]) => exit));
    await cleanupTestGroup();
  })();
  return runnerCleanupPromise;
}

function installRunnerSignalHandlers(): void {
  const exitCodes = { SIGINT: 130, SIGTERM: 143 } as const;
  let shuttingDown = false;
  for (const signal of Object.keys(exitCodes) as Array<keyof typeof exitCodes>) {
    process.once(signal, () => {
      if (shuttingDown) process.exit(exitCodes[signal]);
      shuttingDown = true;
      void cleanupRunner()
        .catch((error) => {
          console.error(error instanceof Error ? error.message : error);
        })
        .finally(() => process.exit(exitCodes[signal]));
    });
  }
}

async function main(): Promise<void> {
  installRunnerSignalHandlers();
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
    if (runnerMode === "hold-runner") {
      const fixture = launchFixture("hold");
      await fixture.ready;
      console.log("SUPAMAIL_RUNNER_READY");
      await new Promise(() => {
        setInterval(() => undefined, 60_000);
      });
      return;
    }
    if (runnerMode) throw new Error(`Unknown lifecycle runner mode: ${runnerMode}`);

    await assertScenario("success", "success", 0);
    await assertScenario("failure", "failure", 1);
    await assertPortDiscoveryFailure();
    await assertNoStartAfterCleanup();
    await assertScenario("SIGINT", "hold", 130, "SIGINT");
    await assertScenario("SIGTERM", "hold", 143, "SIGTERM");
    await assertParallelIsolation();
    await assertRunnerSignal("SIGINT", 130);
    await assertRunnerSignal("SIGTERM", 143);
  } finally {
    await cleanupRunner();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
