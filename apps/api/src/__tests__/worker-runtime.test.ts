import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";

const defaultThreading = vi.hoisted(() => ({
  constructed: vi.fn(),
  assertRolloutCompatibility: vi.fn(async () => undefined),
  listAccountsNeedingWork: vi.fn(async () => [] as string[]),
  drainAccount: vi.fn(),
  pruneTerminalRuns: vi.fn(async () => ({ runsDeleted: 0, assignmentsDeleted: 0 }))
}));

const lockRuntime = vi.hoisted(() => ({
  clearOrphanedLocks: vi.fn(async () => ({
    terminatedBackends: 0,
    accountsReset: 0,
    runsClosed: 0
  })),
  runLockSelfTestWithRetry: vi.fn(async (
    _pool: unknown,
    _options?: { signal?: AbortSignal }
  ) => undefined)
}));

vi.mock("../locks.js", () => lockRuntime);

vi.mock("../threading-repository.js", () => ({
  ThreadingRepository: class {
    constructor(...args: unknown[]) {
      defaultThreading.constructed(...args);
    }

    listAccountsNeedingWork = defaultThreading.listAccountsNeedingWork;
    assertRolloutCompatibility = defaultThreading.assertRolloutCompatibility;
    drainAccount = defaultThreading.drainAccount;
    pruneTerminalRuns = defaultThreading.pruneTerminalRuns;
  }
}));

const {
  logSyncTick,
  handleFatalProcessEvent,
  selectSyncLane,
  startWorkerRuntime,
  workerPollIntervalMs
} = await import("../worker-runtime.js");

describe("worker fatal-process handling", () => {
  it("preserves a failing exit status and invokes the owning runtime shutdown", () => {
    const shutdown = vi.fn();
    const sink = { error: vi.fn() };
    const processState: { exitCode?: number } = {};

    handleFatalProcessEvent(
      "uncaughtException",
      new Error("boom"),
      shutdown,
      sink,
      processState
    );

    expect(processState.exitCode).toBe(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.error.mock.calls[0][0])).toMatchObject({
      event: "process.uncaughtException",
      error: { code: "SYNC_ERROR" }
    });
  });

  it("aborts startup and skips maintenance when the process is asked to stop", async () => {
    const ownerStop = vi.fn();
    const processEvents = new EventEmitter();
    const pool = { query: vi.fn() };
    const repository = { runRetentionJobs: vi.fn() };
    lockRuntime.clearOrphanedLocks.mockClear();
    lockRuntime.runLockSelfTestWithRetry.mockImplementationOnce(async (_pool, options) => {
      const signal = options?.signal;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    });

    const starting = startWorkerRuntime({
      config: {
        SYNC_INTERVAL_MS: 60_000,
        SENT_SYNC_INTERVAL_MS: 30_000,
        STALE_HEARTBEAT_MS: 300_000,
        SYNC_MAX_ACCOUNTS: 40
      } as AppConfig,
      pool: pool as never,
      engine: { syncDueAccounts: vi.fn(), syncDueSentFolders: vi.fn() },
      threading: null,
      repository: repository as never,
      installProcessHandlers: true,
      processEvents: processEvents as never,
      onStop: ownerStop
    });

    await vi.waitFor(() => expect(lockRuntime.runLockSelfTestWithRetry).toHaveBeenCalled());
    processEvents.emit("SIGTERM");
    const runtime = await starting;
    await runtime.done;

    expect(ownerStop).toHaveBeenCalledTimes(1);
    expect(lockRuntime.clearOrphanedLocks).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(repository.runRetentionJobs).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("worker Sent polling cadence", () => {
  const config = { SYNC_INTERVAL_MS: 60_000, SENT_SYNC_INTERVAL_MS: 30_000 };

  it("interleaves a lightweight Sent pass between full mailbox sweeps", () => {
    expect(selectSyncLane(0, null, config)).toBe("full");
    expect(selectSyncLane(30_000, 0, config)).toBe("sent");
    expect(selectSyncLane(60_000, 0, config)).toBe("full");
    expect(workerPollIntervalMs(config)).toBe(30_000);
  });

  it("never lets a slower Sent setting delay the full sweep", () => {
    const slowerSent = { SYNC_INTERVAL_MS: 60_000, SENT_SYNC_INTERVAL_MS: 120_000 };

    expect(workerPollIntervalMs(slowerSent)).toBe(60_000);
  });

  it("interrupts a slow Sent pass when the next Inbox-first full sweep is due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const syncDueAccounts = vi.fn(async () => []);
    const syncDueSentFolders = vi.fn(async (_limit, options?: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return [];
    });
    const runtime = await startWorkerRuntime({
      config: {
        SYNC_INTERVAL_MS: 60_000,
        SENT_SYNC_INTERVAL_MS: 30_000,
        STALE_HEARTBEAT_MS: 300_000,
        SYNC_MAX_ACCOUNTS: 40
      } as AppConfig,
      pool: {
        query: vi.fn(async () => ({ rows: [{ count: "0" }] }))
      } as never,
      engine: { syncDueAccounts, syncDueSentFolders },
      repository: {
        runRetentionJobs: vi.fn(async () => ({ expired: 0, purged: 0, prunedEvents: 0 }))
      } as never
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(syncDueAccounts).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(syncDueSentFolders).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(1);
      expect(syncDueAccounts).toHaveBeenCalledTimes(2);
    } finally {
      runtime.stop();
      await runtime.done;
    }
  });

  it("runs the due full sweep immediately when an interrupted Sent pass rejects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const syncDueAccounts = vi.fn(async () => []);
    const syncDueSentFolders = vi.fn(async (_limit, options?: { signal?: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("deadline cleanup failed")), { once: true });
      });
      return [];
    });
    const runtime = await startWorkerRuntime({
      config: {
        SYNC_INTERVAL_MS: 60_000,
        SENT_SYNC_INTERVAL_MS: 30_000,
        STALE_HEARTBEAT_MS: 300_000,
        SYNC_MAX_ACCOUNTS: 40
      } as AppConfig,
      pool: { query: vi.fn(async () => ({ rows: [{ count: "0" }] })) } as never,
      engine: { syncDueAccounts, syncDueSentFolders },
      repository: {
        runRetentionJobs: vi.fn(async () => ({ expired: 0, purged: 0, prunedEvents: 0 }))
      } as never
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(syncDueSentFolders).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_001);
      expect(syncDueAccounts).toHaveBeenCalledTimes(2);
    } finally {
      runtime.stop();
      await runtime.done;
    }
  });
});

describe("worker runtime logging", () => {
  it("emits failed and partial account outcomes at Render-queryable severities", () => {
    const sink = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const results = [
      {
        runId: "run-success",
        outcome: "success",
        foldersProcessed: 2,
        messagesUpserted: 3,
        metadataRowsCommitted: 3,
        metadataWriteDurationMs: 150,
        metadataWriteBatchesAttempted: 1,
        metadataWriteBatchesFailed: 0,
        metadataWriteServiceRowsPerSecond: 999,
        bodiesFetched: 1,
        errors: []
      },
      {
        runId: "run-partial",
        outcome: "partial_success",
        foldersProcessed: 1,
        messagesUpserted: 0,
        metadataRowsCommitted: 0,
        metadataWriteDurationMs: 0,
        metadataWriteBatchesAttempted: 0,
        metadataWriteBatchesFailed: 0,
        metadataWriteServiceRowsPerSecond: null,
        bodiesFetched: 0,
        errors: ["[ProviderFailure] Archive: provider exploded"]
      },
      {
        runId: "run-failed",
        outcome: "failed",
        foldersProcessed: 0,
        messagesUpserted: 0,
        metadataRowsCommitted: 0,
        metadataWriteDurationMs: 250,
        metadataWriteBatchesAttempted: 1,
        metadataWriteBatchesFailed: 1,
        metadataWriteServiceRowsPerSecond: 0,
        bodiesFetched: 0,
        errors: [
          "[Error] [AUTHENTICATIONFAILED] [AUTH] Command failed",
          "LOGIN mailbox@example.com super-secret"
        ]
      }
    ];

    logSyncTick(results, 42, sink);

    expect(sink.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.error.mock.calls[0][0])).toEqual({
      event: "sync.account.failed",
      runId: "run-failed",
      outcome: "failed",
      foldersProcessed: 0,
      messagesUpserted: 0,
      metadataRowsCommitted: 0,
      metadataWriteDurationMs: 250,
      metadataWriteBatchesAttempted: 1,
      metadataWriteBatchesFailed: 1,
      metadataTelemetryComplete: true,
      metadataWriteServiceRowsPerSecond: 0,
      bodiesFetched: 0,
      errors: ["AUTH_ERROR", "SYNC_ERROR"]
    });
    expect(sink.error.mock.calls[0][0]).not.toContain("super-secret");
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.warn.mock.calls[0][0])).toMatchObject({
      event: "sync.account.partial_success",
      runId: "run-partial",
      errors: ["SYNC_ERROR"]
    });
    expect(sink.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.log.mock.calls[0][0])).toMatchObject({
      event: "sync.tick.completed",
      accounts: 3,
      durationMs: 42,
      metadataRowsCommitted: 3,
      metadataWriteDurationMs: 400,
      metadataWriteBatchesAttempted: 2,
      metadataWriteBatchesFailed: 1,
      metadataTelemetryComplete: true,
      metadataWriteServiceRowsPerSecond: 7.5,
      metadataThroughputRowsPerSecond: 71.43
    });
    const tick = JSON.parse(sink.log.mock.calls[0][0]);
    expect(tick.outcomes[1]).toMatchObject({
      metadataRowsCommitted: 0,
      metadataWriteDurationMs: 0,
      metadataWriteBatchesAttempted: 0,
      metadataWriteBatchesFailed: 0,
      metadataTelemetryComplete: true,
      metadataWriteServiceRowsPerSecond: null
    });
  });

  it("marks legacy or impossible telemetry incomplete instead of publishing a partial rate", () => {
    const sink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    logSyncTick([{
      runId: "legacy-run",
      outcome: "success",
      foldersProcessed: 1,
      messagesUpserted: 2,
      bodiesFetched: 0,
      errors: []
    }], 100, sink);

    expect(JSON.parse(sink.log.mock.calls[0][0])).toMatchObject({
      metadataTelemetryComplete: false,
      metadataWriteServiceRowsPerSecond: null,
      metadataThroughputRowsPerSecond: null
    });

    sink.log.mockClear();
    logSyncTick([{
      runId: "impossible-run",
      outcome: "success",
      foldersProcessed: 1,
      messagesUpserted: 3,
      metadataRowsCommitted: 3,
      metadataWriteDurationMs: 0,
      metadataWriteBatchesAttempted: 1,
      metadataWriteBatchesFailed: 0,
      bodiesFetched: 0,
      errors: []
    }], 100, sink);

    expect(JSON.parse(sink.log.mock.calls[0][0])).toMatchObject({
      metadataTelemetryComplete: false,
      metadataWriteServiceRowsPerSecond: null,
      metadataThroughputRowsPerSecond: null
    });

    sink.log.mockClear();
    logSyncTick([{
      runId: "missing-successful-rows",
      outcome: "failed",
      foldersProcessed: 1,
      messagesUpserted: 0,
      metadataRowsCommitted: 0,
      metadataWriteDurationMs: 20,
      metadataWriteBatchesAttempted: 2,
      metadataWriteBatchesFailed: 1,
      bodiesFetched: 0,
      errors: ["one batch failed"]
    }], 100, sink);

    expect(JSON.parse(sink.log.mock.calls[0][0])).toMatchObject({
      metadataTelemetryComplete: false,
      metadataWriteServiceRowsPerSecond: null,
      metadataThroughputRowsPerSecond: null
    });
  });
});

describe("worker conversation-threading lane", () => {
  it("keeps the default threading lane enabled when a shared engine is injected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    defaultThreading.constructed.mockClear();
    defaultThreading.assertRolloutCompatibility.mockClear();
    defaultThreading.listAccountsNeedingWork.mockClear();

    const metadataProtection = {} as never;
    const pool = { query: vi.fn(async () => ({ rows: [{ count: "0" }] })) } as never;
    const runtime = await startWorkerRuntime({
      config: {
        SYNC_INTERVAL_MS: 60_000,
        SENT_SYNC_INTERVAL_MS: 30_000,
        STALE_HEARTBEAT_MS: 300_000,
        SYNC_MAX_ACCOUNTS: 40
      } as AppConfig,
      pool,
      engine: {
        syncDueAccounts: vi.fn(async () => []),
        syncDueSentFolders: vi.fn(async () => [])
      },
      repository: {
        runRetentionJobs: vi.fn(async () => ({ expired: 0, purged: 0, prunedEvents: 0 }))
      } as never,
      metadataProtection
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(defaultThreading.constructed).toHaveBeenCalledTimes(1);
      expect(defaultThreading.constructed).toHaveBeenCalledWith(pool, { metadataProtection });
      expect(defaultThreading.assertRolloutCompatibility).toHaveBeenCalledTimes(1);
      expect(defaultThreading.listAccountsNeedingWork).toHaveBeenCalledWith(40, {
        activateInitial: false
      });
    } finally {
      runtime.stop();
      await runtime.done;
    }
  });

  it("drains durable assignment work after the mailbox sync tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const drainAccount = vi.fn(async () => ({
      accountId: "account-1",
      runId: "run-1",
      runStatus: "active" as const,
      stage: "ready" as const,
      operationId: "operation-1",
      operationType: "incremental" as const,
      generation: "1",
      messagesConsidered: 3,
      assignmentsChanged: 2,
      queueItemsProcessed: 1,
      subjectFallbackEnabled: true,
      busy: false,
      ready: true,
      active: true
    }));
    const listAccountsNeedingWork = vi.fn(async () => ["account-1"]);
    const runtime = await startWorkerRuntime({
      config: {
        SYNC_INTERVAL_MS: 60_000,
        SENT_SYNC_INTERVAL_MS: 30_000,
        STALE_HEARTBEAT_MS: 300_000,
        SYNC_MAX_ACCOUNTS: 40,
        THREADING_AUTO_ACTIVATE_INITIAL: true
      } as AppConfig,
      pool: { query: vi.fn(async () => ({ rows: [{ count: "0" }] })) } as never,
      engine: {
        syncDueAccounts: vi.fn(async () => []),
        syncDueSentFolders: vi.fn(async () => [])
      },
      threading: {
        listAccountsNeedingWork,
        drainAccount
      },
      repository: {
        runRetentionJobs: vi.fn(async () => ({ expired: 0, purged: 0, prunedEvents: 0 }))
      } as never
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(drainAccount).toHaveBeenCalledWith("account-1", {
        requestedBy: "worker",
        activateInitial: true
      });
      expect(listAccountsNeedingWork).toHaveBeenCalledWith(40, {
        activateInitial: true
      });
    } finally {
      runtime.stop();
      await runtime.done;
    }
  });

  it("advances several bounded shadow-build steps per mailbox tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let drainCalls = 0;
    const drainAccount = vi.fn(async () => {
      drainCalls += 1;
      const complete = drainCalls >= 4;
      return {
        accountId: "account-1",
        runId: "run-1",
        runStatus: complete ? "ready" as const : "building" as const,
        stage: complete ? "ready" as const : "strong" as const,
        operationId: `operation-${drainCalls}`,
        operationType: "build_batch" as const,
        generation: String(drainCalls),
        messagesConsidered: 500,
        assignmentsChanged: 500,
        queueItemsProcessed: 0,
        subjectFallbackEnabled: false,
        busy: false,
        ready: complete,
        active: false
      };
    });
    const runtime = await startWorkerRuntime({
      config: {
        SYNC_INTERVAL_MS: 60_000,
        SENT_SYNC_INTERVAL_MS: 30_000,
        STALE_HEARTBEAT_MS: 300_000,
        SYNC_MAX_ACCOUNTS: 40
      } as AppConfig,
      pool: { query: vi.fn(async () => ({ rows: [{ count: "0" }] })) } as never,
      engine: {
        syncDueAccounts: vi.fn(async () => []),
        syncDueSentFolders: vi.fn(async () => [])
      },
      threading: {
        listAccountsNeedingWork: vi.fn(async () => ["account-1"]),
        drainAccount
      },
      repository: {
        runRetentionJobs: vi.fn(async () => ({ expired: 0, purged: 0, prunedEvents: 0 }))
      } as never
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(drainAccount).toHaveBeenCalledTimes(4);
    } finally {
      runtime.stop();
      await runtime.done;
    }
  });

  it("round-robins bounded threading steps across accounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const drainAccount = vi.fn(async (accountId: string) => ({
      accountId,
      runId: `run-${accountId}`,
      runStatus: "building" as const,
      stage: "strong" as const,
      operationId: `operation-${accountId}`,
      operationType: "build_batch" as const,
      generation: "1",
      messagesConsidered: 500,
      assignmentsChanged: 500,
      queueItemsProcessed: 0,
      subjectFallbackEnabled: false,
      busy: false,
      ready: false,
      active: false
    }));
    const runtime = await startWorkerRuntime({
      config: {
        SYNC_INTERVAL_MS: 60_000,
        SENT_SYNC_INTERVAL_MS: 30_000,
        STALE_HEARTBEAT_MS: 300_000,
        SYNC_MAX_ACCOUNTS: 40
      } as AppConfig,
      pool: { query: vi.fn(async () => ({ rows: [{ count: "0" }] })) } as never,
      engine: {
        syncDueAccounts: vi.fn(async () => []),
        syncDueSentFolders: vi.fn(async () => [])
      },
      threading: {
        listAccountsNeedingWork: vi.fn(async () => ["account-1", "account-2"]),
        drainAccount
      },
      repository: {
        runRetentionJobs: vi.fn(async () => ({ expired: 0, purged: 0, prunedEvents: 0 }))
      } as never
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(drainAccount.mock.calls.slice(0, 4).map(([accountId]) => accountId)).toEqual([
        "account-1",
        "account-2",
        "account-1",
        "account-2"
      ]);
    } finally {
      runtime.stop();
      await runtime.done;
    }
  });
});
