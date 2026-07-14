import { describe, expect, it, vi } from "vitest";
import { isTransientStartupDbError, runLockSelfTestWithRetry } from "../locks.js";

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
