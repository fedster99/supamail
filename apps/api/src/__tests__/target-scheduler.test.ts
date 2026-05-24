import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_TARGET_PER_TARGET_CONCURRENCY,
  runRuntimeTargetTasks,
  type RuntimeTargetTask
} from "../target-scheduler.js";

const requiredSchemaVersion = "0002_stuck_degraded_escalation";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runtime target scheduler", () => {
  it("enforces a global concurrency cap across active targets", async () => {
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 5 }, (_, index): RuntimeTargetTask<number> => ({
      targetId: `target-${index}`,
      taskId: `task-${index}`,
      currentSchemaVersion: requiredSchemaVersion,
      async run() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(5);
        active -= 1;
        return index;
      }
    }));

    const results = await runRuntimeTargetTasks(tasks, {
      requiredSchemaVersion,
      globalConcurrency: 2
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
  });

  it("defaults to one concurrent task per target", async () => {
    const activeByTarget = new Map<string, number>();
    let targetMax = 0;
    const tasks = Array.from({ length: 3 }, (_, index): RuntimeTargetTask<number> => ({
      targetId: "target-a",
      taskId: `task-${index}`,
      currentSchemaVersion: requiredSchemaVersion,
      async run() {
        const active = (activeByTarget.get("target-a") ?? 0) + 1;
        activeByTarget.set("target-a", active);
        targetMax = Math.max(targetMax, active);
        await delay(5);
        activeByTarget.set("target-a", (activeByTarget.get("target-a") ?? 1) - 1);
        return index;
      }
    }));

    const results = await runRuntimeTargetTasks(tasks, {
      requiredSchemaVersion,
      globalConcurrency: 3
    });

    expect(DEFAULT_RUNTIME_TARGET_PER_TARGET_CONCURRENCY).toBe(1);
    expect(targetMax).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
  });

  it("skips paused, needs-attention, and stale-migration targets", async () => {
    let runCount = 0;
    const tasks: Array<RuntimeTargetTask<string>> = [
      {
        targetId: "active",
        taskId: "active",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          runCount += 1;
          return "ok";
        }
      },
      {
        targetId: "paused",
        taskId: "paused",
        status: "paused",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          throw new Error("paused target should not run");
        }
      },
      {
        targetId: "needs-attention",
        taskId: "needs-attention",
        status: "needs_attention",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          throw new Error("needs-attention target should not run");
        }
      },
      {
        targetId: "stale",
        taskId: "stale",
        currentSchemaVersion: "0000_old",
        async run() {
          throw new Error("stale target should not run");
        }
      }
    ];

    const results = await runRuntimeTargetTasks(tasks, { requiredSchemaVersion });

    expect(runCount).toBe(1);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "paused", status: "skipped", reason: "target_paused" }),
      expect.objectContaining({ targetId: "needs-attention", status: "skipped", reason: "target_needs_attention" }),
      expect.objectContaining({ targetId: "stale", status: "skipped", reason: "stale_migration" }),
      expect.objectContaining({ targetId: "active", status: "fulfilled", value: "ok" })
    ]));
  });

  it("isolates target failures from other runnable targets", async () => {
    const results = await runRuntimeTargetTasks([
      {
        targetId: "failing",
        taskId: "failing",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          throw new Error("boom");
        }
      },
      {
        targetId: "healthy",
        taskId: "healthy",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          return "ok";
        }
      }
    ], { requiredSchemaVersion, globalConcurrency: 2 });

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "failing", status: "rejected" }),
      expect.objectContaining({ targetId: "healthy", status: "fulfilled", value: "ok" })
    ]));
  });

  it("isolates synchronous target failures from other runnable targets", async () => {
    const results = await runRuntimeTargetTasks([
      {
        targetId: "failing",
        taskId: "sync-throw",
        currentSchemaVersion: requiredSchemaVersion,
        run() {
          throw new Error("sync boom");
        }
      },
      {
        targetId: "healthy",
        taskId: "healthy",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          return "ok";
        }
      }
    ], { requiredSchemaVersion, globalConcurrency: 2 });

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "failing", taskId: "sync-throw", status: "rejected" }),
      expect.objectContaining({ targetId: "healthy", status: "fulfilled", value: "ok" })
    ]));
  });

  it("does not start work when the scheduler signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    let runCount = 0;

    const results = await runRuntimeTargetTasks([
      {
        targetId: "target-a",
        taskId: "task-a",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          runCount += 1;
          return "a";
        }
      },
      {
        targetId: "target-b",
        taskId: "task-b",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          runCount += 1;
          return "b";
        }
      }
    ], { requiredSchemaVersion, signal: abort.signal });

    expect(runCount).toBe(0);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "target-a", status: "skipped", reason: "scheduler_aborted" }),
      expect.objectContaining({ targetId: "target-b", status: "skipped", reason: "scheduler_aborted" })
    ]));
  });

  it("does not start queued work after the scheduler signal aborts", async () => {
    const abort = new AbortController();
    const started: string[] = [];

    const results = await runRuntimeTargetTasks([
      {
        targetId: "target-a",
        taskId: "task-a",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          started.push("task-a");
          abort.abort();
          return "a";
        }
      },
      {
        targetId: "target-b",
        taskId: "task-b",
        currentSchemaVersion: requiredSchemaVersion,
        async run() {
          started.push("task-b");
          return "b";
        }
      }
    ], { requiredSchemaVersion, globalConcurrency: 1, signal: abort.signal });

    expect(started).toEqual(["task-a"]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "target-a", status: "fulfilled", value: "a" }),
      expect.objectContaining({ targetId: "target-b", status: "skipped", reason: "scheduler_aborted" })
    ]));
  });
});
