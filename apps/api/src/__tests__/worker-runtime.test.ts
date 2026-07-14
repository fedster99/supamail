import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";

const defaultThreading = vi.hoisted(() => ({
  constructed: vi.fn(),
  assertRolloutCompatibility: vi.fn(async () => undefined),
  listAccountsNeedingWork: vi.fn(async () => [] as string[]),
  drainAccount: vi.fn(),
  pruneTerminalRuns: vi.fn(async () => ({ runsDeleted: 0, assignmentsDeleted: 0 }))
}));

vi.mock("../locks.js", () => ({
  clearOrphanedLocks: vi.fn(async () => ({
    terminatedBackends: 0,
    accountsReset: 0,
    runsClosed: 0
  })),
  runLockSelfTestWithRetry: vi.fn(async () => undefined)
}));

vi.mock("../threading-repository.js", () => ({
  ThreadingRepository: class {
    constructor() {
      defaultThreading.constructed();
    }

    listAccountsNeedingWork = defaultThreading.listAccountsNeedingWork;
    assertRolloutCompatibility = defaultThreading.assertRolloutCompatibility;
    drainAccount = defaultThreading.drainAccount;
    pruneTerminalRuns = defaultThreading.pruneTerminalRuns;
  }
}));

const {
  logSyncTick,
  selectSyncLane,
  startWorkerRuntime,
  workerPollIntervalMs
} = await import("../worker-runtime.js");

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
        bodiesFetched: 1,
        errors: []
      },
      {
        runId: "run-partial",
        outcome: "partial_success",
        foldersProcessed: 1,
        messagesUpserted: 0,
        bodiesFetched: 0,
        errors: ["[ProviderFailure] Archive: provider exploded"]
      },
      {
        runId: "run-failed",
        outcome: "failed",
        foldersProcessed: 0,
        messagesUpserted: 0,
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
      bodiesFetched: 0,
      errors: [
        "[Error] [AUTHENTICATIONFAILED] [AUTH] Command failed",
        "LOGIN [REDACTED]"
      ]
    });
    expect(sink.error.mock.calls[0][0]).not.toContain("super-secret");
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.warn.mock.calls[0][0])).toMatchObject({
      event: "sync.account.partial_success",
      runId: "run-partial",
      errors: ["[ProviderFailure] Archive: provider exploded"]
    });
    expect(sink.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.log.mock.calls[0][0])).toMatchObject({
      event: "sync.tick.completed",
      accounts: 3,
      durationMs: 42
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
      repository: {
        runRetentionJobs: vi.fn(async () => ({ expired: 0, purged: 0, prunedEvents: 0 }))
      } as never
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(defaultThreading.constructed).toHaveBeenCalledTimes(1);
      expect(defaultThreading.assertRolloutCompatibility).toHaveBeenCalledTimes(1);
      expect(defaultThreading.listAccountsNeedingWork).toHaveBeenCalledWith(40);
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
      expect(drainAccount).toHaveBeenCalledWith("account-1", { requestedBy: "worker" });
    } finally {
      runtime.stop();
      await runtime.done;
    }
  });
});
