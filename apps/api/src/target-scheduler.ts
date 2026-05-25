export type RuntimeTargetStatus = "active" | "paused" | "needs_attention";

export type RuntimeTargetSkipReason =
  | "target_paused"
  | "target_needs_attention"
  | "stale_migration"
  | "scheduler_aborted";

export interface RuntimeTargetTask<T = unknown> {
  targetId: string;
  taskId: string;
  status?: RuntimeTargetStatus;
  currentSchemaVersion: string;
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
  if (task.currentSchemaVersion !== requiredSchemaVersion) return "stale_migration";
  return null;
}
