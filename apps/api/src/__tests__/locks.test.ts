import { describe, expect, it, vi } from "vitest";
import {
  accountLockHeartbeatIntervalMs,
  isTransientStartupDbError,
  runLockSelfTestWithRetry,
  withAccountLock
} from "../locks.js";

describe("withAccountLock heartbeat", () => {
  it("fails closed before callback work when the initial heartbeat cannot persist", async () => {
    const callback = vi.fn(async () => "unsafe");
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }], rowCount: 1 })
        .mockRejectedValueOnce(new Error("heartbeat write failed"))
        .mockResolvedValueOnce({ rows: [{ unlocked: true }], rowCount: 1 }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    await expect(withAccountLock(pool, "42", callback)).rejects.toThrow(/heartbeat write failed/i);
    expect(callback).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock($1::bigint) AS unlocked", ["42"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the heartbeat update finds no account row", async () => {
    const callback = vi.fn(async () => "unsafe");
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }], rowCount: 1 }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    await expect(withAccountLock(pool, "42", callback)).rejects.toThrow(/account row not found/i);
    expect(callback).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("derives a refresh cadence safely inside the stale threshold", () => {
    expect(accountLockHeartbeatIntervalMs(300_000)).toBe(60_000);
    expect(accountLockHeartbeatIntervalMs(900)).toBe(300);
    expect(accountLockHeartbeatIntervalMs(Number.NaN)).toBe(60_000);
  });

  it("retries a transient heartbeat error while the session remains valid", async () => {
    const transient = Object.assign(new Error("canceling statement due to timeout"), { code: "57014" });
    const callback = vi.fn(async () => "safe");
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce({ rows: [{ heartbeat_persisted: true, lock_held: true }] })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    await expect(withAccountLock(pool, "42", callback)).resolves.toBe("safe");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("rejects and evicts the client when advisory unlock returns false before confirmation", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockResolvedValueOnce({ rows: [{ heartbeat_persisted: true, lock_held: true }] })
        .mockResolvedValueOnce({ rows: [{ unlocked: false }] }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    await expect(withAccountLock(pool, "42", async () => "done")).rejects.toThrow(/unlock=false/i);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rejects and evicts the client when advisory unlock throws", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockResolvedValueOnce({ rows: [{ heartbeat_persisted: true, lock_held: true }] })
        .mockRejectedValueOnce(new Error("unlock connection failure")),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    await expect(withAccountLock(pool, "42", async () => "done")).rejects.toThrow(/unlock connection failure/i);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("warns instead of rejecting after confirmation when unlock fails, while still evicting", async () => {
    const warning = vi.fn();
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockResolvedValueOnce({ rows: [{ heartbeat_persisted: true, lock_held: true }] })
        .mockResolvedValueOnce({ rows: [{ unlocked: false }] }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    await expect(withAccountLock(pool, "42", async (lock) => {
      lock.confirmIrreversible();
      return "delivered";
    }, { onPostIrreversibleWarning: warning })).resolves.toBe("delivered");
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/already confirmed.*unlock failed/i));
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("isTransientStartupDbError", () => {
  it("treats deploy-time pool/pooler saturation as transient (retryable)", () => {
    // Raw pg.Pool (supamail's default stack) — the EXACT strings node-postgres emits
    // on a checkout timeout / dropped connection. Regression-critical: an earlier port
    // asserted strings the driver never produces while missing this real one.
    expect(isTransientStartupDbError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isTransientStartupDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientStartupDbError(new Error("connection to database closed"))).toBe(true);
    // Session-pooler-backed deployments (PgBouncer / Supavisor).
    expect(isTransientStartupDbError(Object.assign(new Error("canceling statement"), { code: "57014" }))).toBe(true);
    expect(isTransientStartupDbError(new Error("MaxClientsInSessionMode: max clients reached"))).toBe(true);
    expect(isTransientStartupDbError(new Error("sorry, too many clients already"))).toBe(true);
    // Generic transient network signatures.
    expect(isTransientStartupDbError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(true);
    expect(isTransientStartupDbError(new Error("read ETIMEDOUT"))).toBe(true);
  });

  it("keeps the transaction-pooling detection failure FATAL (never retried)", () => {
    // A second connection acquiring an already-held advisory lock means the pool is a
    // transaction pooler — advisory locks are broken. That is a correctness signal and
    // must NOT be swallowed as transient, or startup would loop past a real misconfig.
    expect(
      isTransientStartupDbError(
        new Error(
          "Lock self-test failed: second connection acquired an already-held advisory lock. " +
            "Use a direct/session-affine Postgres connection, not transaction pooling."
        )
      )
    ).toBe(false);
  });

  it("does not treat arbitrary or unrelated errors as transient", () => {
    expect(isTransientStartupDbError(new Error("Lock self-test failed: could not acquire test lock after 3 attempts"))).toBe(false);
    expect(isTransientStartupDbError(new Error("syntax error at or near"))).toBe(false);
    expect(isTransientStartupDbError(new Error("permission denied for table imap_messages"))).toBe(false);
    expect(isTransientStartupDbError(null)).toBe(false);
    expect(isTransientStartupDbError(undefined)).toBe(false);
    expect(isTransientStartupDbError("just a string")).toBe(false);
  });
});

describe("runLockSelfTestWithRetry cancellation", () => {
  it("does not begin a startup lock check when shutdown was already requested", async () => {
    const abort = new AbortController();
    abort.abort();
    const pool = { connect: vi.fn() };

    await expect(runLockSelfTestWithRetry(pool as never, { signal: abort.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("interrupts the retry delay instead of waiting out the deployment budget", async () => {
    const abort = new AbortController();
    const pool = {
      connect: vi.fn(async () => {
        throw new Error("timeout exceeded when trying to connect");
      })
    };

    await expect(runLockSelfTestWithRetry(pool as never, {
      signal: abort.signal,
      onRetry: () => abort.abort()
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });
});
