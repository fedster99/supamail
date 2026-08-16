import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { EphemeralPostgresResources } from "./ephemeral-postgres.js";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(scriptDir, "ephemeral-postgres-fixture.ts");
const testGroup = randomUUID();
const groupFilter = `label=io.supamail.lifecycle-test=${testGroup}`;
const activeChildren = new Set<ChildProcess>();

type Snapshot = {
  containers: string[];
  volumes: string[];
};

type Fixture = {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  ready: Promise<EphemeralPostgresResources>;
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

function launchFixture(mode: "success" | "failure" | "hold"): Fixture {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode], {
    cwd: resolve(scriptDir, ".."),
    env: { ...process.env, SUPAMAIL_EPHEMERAL_TEST_GROUP: testGroup },
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeChildren.add(child);

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

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
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

  return { child, exit, ready, stderr: () => stderrBuffer };
}

async function assertScenario(
  name: string,
  mode: "success" | "failure" | "hold",
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

async function main(): Promise<void> {
  await docker(["version", "--format", "{{.Server.Version}}"]);
  try {
    await assertScenario("success", "success", 0);
    await assertScenario("failure", "failure", 1);
    await assertScenario("SIGINT", "hold", 130, "SIGINT");
    await assertScenario("SIGTERM", "hold", 143, "SIGTERM");
    await assertParallelIsolation();
  } finally {
    for (const child of activeChildren) child.kill("SIGTERM");
    await Promise.allSettled([...activeChildren].map((child) => new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolvePromise();
        return;
      }
      child.once("exit", () => resolvePromise());
    })));
    await cleanupTestGroup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
