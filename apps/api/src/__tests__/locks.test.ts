import { describe, expect, it } from "vitest";
import { isTransientStartupDbError } from "../locks.js";

describe("isTransientStartupDbError", () => {
  it("treats deploy-time session-pooler saturation as transient (retryable)", () => {
    // Signatures observed when old + new instances overlap on the session pooler.
    expect(isTransientStartupDbError(Object.assign(new Error("canceling statement"), { code: "57014" }))).toBe(true);
    expect(isTransientStartupDbError(new Error("MaxClientsInSessionMode: max clients reached"))).toBe(true);
    expect(isTransientStartupDbError(new Error("sorry, too many clients already"))).toBe(true);
    expect(isTransientStartupDbError(new Error("unable to check out connection"))).toBe(true);
    expect(isTransientStartupDbError(new Error("ECHECKOUTTIMEOUT: connection checkout"))).toBe(true);
    expect(isTransientStartupDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientStartupDbError(new Error("connection to database closed"))).toBe(true);
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
