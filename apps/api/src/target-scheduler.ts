export type RuntimeTargetStatus = "active" | "paused" | "needs_attention";

export type RuntimeTargetSkipReason =
  | "target_paused"
  | "target_needs_attention"
  | "stale_migration"
  | "scheduler_aborted";

export interface SchemaVersionState {
  /** The public migration the target's schema is at: a manifest id such as `0029_...`. */
  currentSchemaVersion: string;
  /**
   * The oldest required version this schema still serves. A host records it
   * in its own schema marker when it applies migrations, from the manifest's
   * `breaksOlderRuntimes` entries: such a migration sets the floor to its own
   * id, any other leaves it. Absent or empty means exact match.
   */
  compatibleSinceSchemaVersion?: string;
}

/** Public migration ids are a four-digit sequence, an underscore, and a name. */
const PUBLIC_MIGRATION_ID = /^(\d{4})_\S+$/;

/** A migration id's position in manifest order, or null when it is not an id. */
export function publicMigrationSequence(id: string): number | null {
  const match = PUBLIC_MIGRATION_ID.exec(id);
  return match ? Number(match[1]) : null;
}

/** The runtime's own required version is not a public migration id. */
export class InvalidSchemaVersionError extends TypeError {
  readonly version: string;

  constructor(version: string) {
    super(`required schema version is not a public migration id: ${JSON.stringify(version)}`);
    this.name = "InvalidSchemaVersionError";
    this.version = version;
  }
}

export interface RuntimeTargetTask<T = unknown> extends SchemaVersionState {
  targetId: string;
  taskId: string;
  status?: RuntimeTargetStatus;
  run(input: { signal?: AbortSignal }): Promise<T>;
}

export interface RuntimeTargetSchedulerOptions {
  requiredSchemaVersion: string;
  globalConcurrency?: number;
  perTargetConcurrency?: number;
  signal?: AbortSignal;
}

export type RuntimeTargetTaskResult<T = unknown> =
  | {
      targetId: string;
      taskId: string;
      status: "fulfilled";
      value: T;
    }
  | {
      targetId: string;
      taskId: string;
      status: "rejected";
      error: unknown;
    }
  | {
      targetId: string;
      taskId: string;
      status: "skipped";
      reason: RuntimeTargetSkipReason;
    };

export const DEFAULT_RUNTIME_TARGET_GLOBAL_CONCURRENCY = 2;
export const DEFAULT_RUNTIME_TARGET_PER_TARGET_CONCURRENCY = 1;

interface RunnableTask<T> {
  task: RuntimeTargetTask<T>;
}

export async function runRuntimeTargetTasks<T>(
  tasks: RuntimeTargetTask<T>[],
  options: RuntimeTargetSchedulerOptions
): Promise<Array<RuntimeTargetTaskResult<T>>> {
  const globalConcurrency = options.globalConcurrency ?? DEFAULT_RUNTIME_TARGET_GLOBAL_CONCURRENCY;
  const perTargetConcurrency = options.perTargetConcurrency ?? DEFAULT_RUNTIME_TARGET_PER_TARGET_CONCURRENCY;

  if (!Number.isInteger(globalConcurrency) || globalConcurrency < 1) {
    throw new Error("globalConcurrency must be a positive integer");
  }
  if (!Number.isInteger(perTargetConcurrency) || perTargetConcurrency < 1) {
    throw new Error("perTargetConcurrency must be a positive integer");
  }
  if (publicMigrationSequence(options.requiredSchemaVersion) === null) {
    throw new InvalidSchemaVersionError(options.requiredSchemaVersion);
  }

  const results: Array<RuntimeTargetTaskResult<T>> = [];
  const pending: Array<RunnableTask<T>> = [];

  for (const task of tasks) {
    const skipReason = getSkipReason(task, options.requiredSchemaVersion);
    if (skipReason) {
      results.push({
        targetId: task.targetId,
        taskId: task.taskId,
        status: "skipped",
        reason: skipReason
      });
      continue;
    }
    pending.push({ task });
  }

  if (pending.length === 0) return results;

  const totalRunnable = pending.length;
  const runningByTarget = new Map<string, number>();
  let running = 0;
  let completed = 0;

  return new Promise((resolve) => {
    let settled = false;

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", skipPendingForAbort);
      resolve(results);
    };

    const maybeResolve = () => {
      if (completed === totalRunnable) {
        resolveOnce();
      }
    };

    function skipPendingForAbort(): void {
      while (pending.length > 0) {
        const [{ task }] = pending.splice(0, 1);
        completed += 1;
        results.push({
          targetId: task.targetId,
          taskId: task.taskId,
          status: "skipped",
          reason: "scheduler_aborted"
        });
      }
      maybeResolve();
    }

    const pump = () => {
      if (options.signal?.aborted) {
        skipPendingForAbort();
        return;
      }

      while (running < globalConcurrency) {
        if (options.signal?.aborted) {
          skipPendingForAbort();
          return;
        }

        const nextIndex = pending.findIndex(({ task }) => {
          const targetRunning = runningByTarget.get(task.targetId) ?? 0;
          return targetRunning < perTargetConcurrency;
        });

        if (nextIndex === -1) break;

        const [{ task }] = pending.splice(nextIndex, 1);
        running += 1;
        runningByTarget.set(task.targetId, (runningByTarget.get(task.targetId) ?? 0) + 1);

        Promise.resolve()
          .then(() => task.run({ signal: options.signal }))
          .then((value) => {
            results.push({
              targetId: task.targetId,
              taskId: task.taskId,
              status: "fulfilled",
              value
            });
          })
          .catch((error) => {
            results.push({
              targetId: task.targetId,
              taskId: task.taskId,
              status: "rejected",
              error
            });
          })
          .finally(() => {
            running -= 1;
            completed += 1;
            const targetRunning = (runningByTarget.get(task.targetId) ?? 1) - 1;
            if (targetRunning <= 0) {
              runningByTarget.delete(task.targetId);
            } else {
              runningByTarget.set(task.targetId, targetRunning);
            }
            if (options.signal?.aborted) {
              skipPendingForAbort();
            } else {
              pump();
            }
          });
      }
      maybeResolve();
    };

    options.signal?.addEventListener("abort", skipPendingForAbort, { once: true });
    pump();
  });
}

function getSkipReason(task: RuntimeTargetTask, requiredSchemaVersion: string): RuntimeTargetSkipReason | null {
  if (task.status === "paused") return "target_paused";
  if (task.status === "needs_attention") return "target_needs_attention";
  if (!isSchemaVersionReady(task, requiredSchemaVersion)) return "stale_migration";
  return null;
}

/**
 * Whether a runtime that requires `requiredSchemaVersion` can run against this
 * schema. Ids order by their four-digit prefix. The schema must be at or after
 * the required version, and the required version must not be older than the
 * schema's compatibility floor. So a host may apply a compatible migration
 * before it deploys the runtime that needs it, and the running runtime keeps
 * serving; a migration the running runtime cannot work with moves the floor
 * and stops it. Two ids with one sequence number must be the same id. A
 * missing or malformed schema version is not ready; a malformed required
 * version is the runtime's own error and throws.
 */
export function isSchemaVersionReady(state: SchemaVersionState, requiredSchemaVersion: string): boolean {
  const required = publicMigrationSequence(requiredSchemaVersion);
  if (required === null) throw new InvalidSchemaVersionError(requiredSchemaVersion);
  const floorId = state.compatibleSinceSchemaVersion || state.currentSchemaVersion;
  const current = publicMigrationSequence(state.currentSchemaVersion);
  const floor = publicMigrationSequence(floorId);
  if (current === null || floor === null) return false;
  if (current === required && state.currentSchemaVersion !== requiredSchemaVersion) return false;
  if (floor === required && floorId !== requiredSchemaVersion) return false;
  return floor <= required && required <= current;
}
