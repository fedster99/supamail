import { describe, expect, it } from "vitest";
import { classifyLoginRefusal, isAuthError } from "../sync-engine.js";

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

describe("classifyLoginRefusal (RFC 5530 split for refused LOGINs)", () => {
  const refused = (props: Record<string, unknown>) =>
    Object.assign(new Error("Command failed"), { authenticationFailed: true, ...props });

  it("names a credential verdict only for the RFC 5530 credential codes", () => {
    for (const code of ["AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "EXPIRED"]) {
      expect(classifyLoginRefusal(refused({ serverResponseCode: code }))).toBe("credentials_rejected");
    }
  });

  it("calls a bare NO or an [ALERT] a refusal, not a verdict on the password", () => {
    expect(classifyLoginRefusal(refused({ response: "NO LOGIN failed." }))).toBe("login_refused");
    expect(classifyLoginRefusal(refused({
      serverResponseCode: "ALERT",
      response: "NO [ALERT] Too many simultaneous connections"
    }))).toBe("login_refused");
  });

  it("is not a login refusal for transient codes, dead connections or other errors", () => {
    expect(classifyLoginRefusal(refused({ serverResponseCode: "UNAVAILABLE" }))).toBeNull();
    expect(classifyLoginRefusal(Object.assign(new Error("Connection not available"), { code: "NoConnection" }))).toBeNull();
    expect(classifyLoginRefusal(new Error("Command failed"))).toBeNull();
    expect(classifyLoginRefusal(null)).toBeNull();
  });
});
