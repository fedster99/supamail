import { describe, expect, it } from "vitest";
import { isAuthError } from "../sync-engine.js";

describe("isAuthError (spec §13.1: AUTH_ERROR is non-retryable)", () => {
  it.each([
    "Authentication failed",
    "Invalid credentials",
    "invalid user",
    "invalid username",
    "Login failed",
    "auth failed",
    "AUTHENTICATIONFAILED",
    "NO LOGIN failed",
    "incorrect password",
    "535 5.7.8 Authentication credentials invalid"
  ])("classifies %s as AUTH_ERROR", (message) => {
    expect(isAuthError(message)).toBe(true);
  });

  it.each([
    "connection timeout",
    "network unreachable",
    "ECONNRESET",
    "mailbox does not exist",
    "UIDVALIDITY changed before body fetch",
    "Reconcile returned no UIDs for non-empty mailbox INBOX"
  ])("does NOT classify %s as AUTH_ERROR (transient/protocol, must retry)", (message) => {
    expect(isAuthError(message)).toBe(false);
  });
});
