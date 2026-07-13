import { describe, expect, it, vi } from "vitest";
import { logSyncTick, selectSyncLane, workerPollIntervalMs } from "../worker-runtime.js";

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
