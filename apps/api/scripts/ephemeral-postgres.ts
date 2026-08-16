import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const EPHEMERAL_LABEL = "io.supamail.ephemeral";
const RUN_ID_LABEL = "io.supamail.run-id";
const PURPOSE_LABEL = "io.supamail.purpose";
const CREATED_AT_LABEL = "io.supamail.created-at";
const TEST_GROUP_LABEL = "io.supamail.lifecycle-test";

export type EphemeralPostgresOptions = {
  image: string;
  namePrefix: string;
  purpose: string;
  keep?: boolean;
  testGroup?: string;
};

export type EphemeralPostgresResources = {
  containerName: string;
  volumeName: string;
  runId: string;
};

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

function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

export class EphemeralPostgres {
  readonly resources: EphemeralPostgresResources;

  private readonly image: string;
  private readonly keep: boolean;
  private readonly labels: Record<string, string>;
  private containerStarted = false;
  private provisioningPromise: Promise<void> | null = null;
  private cleanupPromise: Promise<void> | null = null;

  constructor(options: EphemeralPostgresOptions) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(options.namePrefix)) {
      throw new Error(`Invalid Docker resource prefix: ${options.namePrefix}`);
    }

    const runId = `${process.pid}-${randomUUID().slice(0, 12)}`;
    this.resources = {
      containerName: `${options.namePrefix}-${runId}`,
      volumeName: `${options.namePrefix}-data-${runId}`,
      runId
    };
    this.image = options.image;
    this.keep = options.keep ?? false;
    this.labels = {
      [EPHEMERAL_LABEL]: "true",
      [RUN_ID_LABEL]: runId,
      [PURPOSE_LABEL]: options.purpose,
      [CREATED_AT_LABEL]: new Date().toISOString()
    };
    if (options.testGroup) this.labels[TEST_GROUP_LABEL] = options.testGroup;
  }

  async start(): Promise<string> {
    if (this.cleanupPromise) {
      throw new Error("Cannot start disposable Postgres after cleanup has begun");
    }
    try {
      this.provisioningPromise = this.provision();
      await this.provisioningPromise;

      for (let attempt = 0; attempt < 60; attempt += 1) {
        const output = await docker([
          "exec", this.resources.containerName, "pg_isready", "-U", "postgres", "-d", "postgres"
        ], true);
        if (output.includes("accepting connections")) return await this.databaseUrl();
        await delay(500);
      }

      const logs = await this.logs();
      throw new Error(`Postgres did not become ready. Container logs:\n${logs}`);
    } catch (error) {
      await this.cleanup("startup failure");
      throw error;
    }
  }

  async databaseUrl(): Promise<string> {
    const output = await docker(["port", this.resources.containerName, "5432/tcp"]);
    const match = output.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/)
      ?? output.match(/:(\d+)/);
    if (!match) throw new Error(`Could not parse mapped Postgres port from: ${output}`);
    return `postgresql://postgres:postgres@127.0.0.1:${match[1]}/postgres`;
  }

  async logs(): Promise<string> {
    return docker(["logs", "--tail", "200", this.resources.containerName], true);
  }

  cleanup(reason: string): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.removeResources(reason);
    return this.cleanupPromise;
  }

  private async removeResources(reason: string): Promise<void> {
    const { containerName, volumeName } = this.resources;
    await this.provisioningPromise?.catch(() => undefined);
    if (this.keep && this.containerStarted) {
      const url = await this.databaseUrl().catch(() => "unknown");
      console.log(
        `[ephemeral-postgres] KEEP_DB=1, leaving container ${containerName} and volume ${volumeName}`
        + ` at ${url} after ${reason}`
      );
      return;
    }

    // Always target both exact randomized names. This closes the small window
    // where Docker created a resource but the client process had not yet
    // recorded the successful command result when a signal arrived.
    await docker(["rm", "-f", containerName], true);
    await docker(["volume", "rm", volumeName], true);

    const remainingContainer = await docker(["container", "inspect", containerName], true);
    const remainingVolume = await docker(["volume", "inspect", volumeName], true);
    if (remainingContainer || remainingVolume) {
      throw new Error(
        `Cleanup left Docker resources after ${reason}:`
        + `${remainingContainer ? ` container ${containerName}` : ""}`
        + `${remainingVolume ? ` volume ${volumeName}` : ""}`
      );
    }
  }

  private async provision(): Promise<void> {
    const { containerName, volumeName } = this.resources;
    await docker(["volume", "create", ...labelArgs(this.labels), volumeName]);
    await docker([
      "run",
      "-d",
      "--name",
      containerName,
      ...labelArgs(this.labels),
      "--mount",
      `type=volume,src=${volumeName},dst=/var/lib/postgresql/data`,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=postgres",
      "-p",
      "127.0.0.1::5432",
      this.image
    ]);
    this.containerStarted = true;
  }
}

export function installEphemeralPostgresSignalHandlers(
  database: EphemeralPostgres,
  options: {
    onSignal?: (signal: NodeJS.Signals) => void;
    logPrefix: string;
  }
): () => void {
  const exitCodes: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 130,
    SIGTERM: 143
  };
  const handlers = new Map<NodeJS.Signals, () => void>();
  let shuttingDown = false;

  for (const signal of Object.keys(exitCodes) as NodeJS.Signals[]) {
    const handler = (): void => {
      if (shuttingDown) {
        process.exit(exitCodes[signal] ?? 1);
      }
      shuttingDown = true;
      console.warn(`${options.logPrefix} received ${signal}; cleaning up disposable Postgres`);
      options.onSignal?.(signal);
      database.cleanup(signal)
        .catch((error) => {
          console.error(error instanceof Error ? error.message : error);
        })
        .finally(() => process.exit(exitCodes[signal] ?? 1));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}
