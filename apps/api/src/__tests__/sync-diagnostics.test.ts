import { describe, expect, it, vi } from "vitest";
import { recordSyncFailure, safeSyncFailures, syncFailureCode, SyncDeadlineError, SYNC_FAILURE_STAGES, type SyncFailure } from "../sync-diagnostics.js";

import { MirrorRepository } from "../repository.js";
import type { SyncResult } from "../types.js";

const privateText = "LOGIN owner@example.test secret-password Private Folder";

describe("structured sync failures", () => {
  it.each([
    [{ code: "ECONNRESET" }, "ECONNRESET"],
    [{ code: "NoConnection" }, "CONNECTION_CLOSED"],
    [{ code: "57014" }, "DB_QUERY_CANCELED"],
    [{ code: "40P01" }, "DB_DEADLOCK"],
    [{ authenticationFailed: true }, "LOGIN_REFUSED"],
    [{ code: "ELOGIN", serverResponseCode: "UNAVAILABLE", authenticationFailed: true }, "IMAP_UNAVAILABLE"],
    [{ code: "NoConnection", authenticationFailed: true }, "CONNECTION_CLOSED"],
    [{ serverResponseCode: "AUTHENTICATIONFAILED", authenticationFailed: true }, "IMAP_AUTHENTICATIONFAILED"],
    [{ serverResponseCode: "UNAVAILABLE", responseStatus: "NO" }, "IMAP_UNAVAILABLE"],
    [{ responseCode: "OVERQUOTA" }, "IMAP_OVERQUOTA"],
    [{ responseStatus: "NO" }, "IMAP_NO"],
    [{ responseStatus: "BAD" }, "IMAP_BAD"],
    [{ name: "AccountLockLivenessError" }, "ACCOUNT_LOCK_LIVENESS_FAILED"],
    [{ name: "IncompleteUidListError" }, "INCOMPLETE_UID_LIST"]
  ])("classifies structured fields %j without reading prose", (properties, expected) => {
    expect(syncFailureCode(Object.assign(new Error(privateText), properties))).toBe(expected);
  });

  it("recognizes the engine's own deadlines without interpreting their message", () => {
    expect(syncFailureCode(new SyncDeadlineError(privateText))).toBe("SYNC_DEADLINE_EXCEEDED");
  });

  it("never stores arbitrary properties, free text, or nested causes", () => {
    const failures: SyncFailure[] = [];
    recordSyncFailure(failures, "connect", Object.assign(new Error(privateText), {
      code: privateText, name: privateText, responseCode: privateText,
      serverResponseCode: privateText, responseStatus: privateText,
      cause: new Error(privateText), responseText: privateText
    }));
    recordSyncFailure(failures, "connect", privateText);
    expect(failures).toEqual([{ stage: "connect", code: "SYNC_ERROR" }]);
    expect(syncFailureCode({ code: "__proto__", name: "toString" })).toBe("SYNC_ERROR");
  });

  it("keeps different causes/stages, deduplicates repeats, and bounds retained detail", () => {
    const failures: SyncFailure[] = [];
    for (const stage of SYNC_FAILURE_STAGES) {
      for (const code of ["ECONNRESET", "ETIMEDOUT", "EPIPE", "57014"]) {
        for (let i = 0; i < 10; i++) recordSyncFailure(failures, stage, { code });
      }
    }
    expect(failures).toHaveLength(SYNC_FAILURE_STAGES.length * 4);
    expect(new Set(failures.map(f => JSON.stringify(f))).size).toBe(failures.length);
    expect(failures).toContainEqual({ stage: "run_finish", code: "DB_QUERY_CANCELED" });
    expect(failures.slice(0, 2)).toEqual([
      { stage: "account_start", code: "ECONNRESET" },
      { stage: "account_start", code: "ETIMEDOUT" }
    ]);
  });

  it("writes only validated failure fields alongside the unchanged health summary", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = new MirrorRepository({ query } as never, {} as never);
    await repository.finishSyncRun({
      runId: "00000000-0000-4000-8000-000000000001", outcome: "failed",
      foldersProcessed: 0, messagesUpserted: 0, bodiesFetched: 0,
      flagsUpdated: 0, reconcileGapsFound: 0, hitLockBudget: false,
      errors: ["an unrecognized provider failure"],
      failures: [
        { stage: "connect", code: "ECONNRESET", secret: privateText },
        { stage: "connect", code: privateText }
      ]
    } as SyncResult);
    const args = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(args[7]).toBe("SYNC_ERROR");
    const metadata = JSON.parse(args[8] as string);
    expect(metadata.errors).toEqual(["SYNC_ERROR"]);
    expect(metadata.failures).toEqual([{ stage: "connect", code: "ECONNRESET" }]);
    expect(JSON.stringify(args)).not.toContain(privateText);
  });

  it("validates and projects only fixed pairs at the storage boundary", () => {
    expect(safeSyncFailures([
      null, privateText, { stage: privateText, code: "ECONNRESET" },
      { stage: "connect", code: privateText },
      { stage: "connect", code: "ECONNRESET", message: privateText },
      { stage: "connect", code: "ECONNRESET" }
    ])).toEqual([{ stage: "connect", code: "ECONNRESET" }]);
    expect(safeSyncFailures(undefined)).toEqual([]);
    const many = SYNC_FAILURE_STAGES.flatMap(stage =>
      ["ECONNRESET", "ETIMEDOUT", "EPIPE", "DB_QUERY_CANCELED"].map(code => ({ stage, code })));
    expect(safeSyncFailures([...many, ...many])).toEqual(many);
  });
});
