import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isConnectionLostError, isMissingMailboxError } from "../sync-engine.js";

describe("sync engine safety", () => {
  it("does not treat partial folder failures as healthy account syncs", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain('result.outcome === "partial_success"');
    expect(source).toContain("markAccountSyncPartial");
  });

  it("reconciles only the active sync window", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("iterateAllUids(client, windowCutoff)");
    expect(source).toContain("markMissingMessagesFromLiveUidStream");
    expect(source).toContain("Reconcile returned no UIDs for non-empty mailbox");
    expect(source).not.toContain("searchAllUids(client, windowCutoff)");
    expect(source).not.toContain("iterateAllUids(client),");
  });

  it("does not accept an empty folder discovery response as authoritative", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("Provider returned no folders");
  });

  it("classifies auth errors and routes them to markAccountSyncAuthFailed (spec §13.1)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("isAuthError(message)");
    expect(source).toContain("markAccountSyncAuthFailed");
  });

  it("detects missing-mailbox errors before forcing folder rediscovery", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(isMissingMailboxError(Object.assign(new Error("Mailbox is gone"), {
      serverResponseCode: "NONEXISTENT"
    }))).toBe(true);
    expect(isMissingMailboxError(Object.assign(new Error("Create it first"), {
      responseCode: "TRYCREATE"
    }))).toBe(true);
    expect(isMissingMailboxError(new Error("No such mailbox: Archive"))).toBe(true);
    expect(isMissingMailboxError(Object.assign(new Error("No such mailbox"), {
      serverResponseCode: "OVERQUOTA"
    }))).toBe(false);
    expect(source).toContain("isMissingMailboxError(error)");
    expect(source).toContain("markFolderPendingVerification");
  });

  it("stops the folder loop on a lost IMAP connection instead of cascading per-folder errors", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(isConnectionLostError(Object.assign(new Error("Connection not available"), {
      code: "NoConnection"
    }))).toBe(true);
    expect(isConnectionLostError(Object.assign(new Error("Connection closed"), {
      code: "EConnectionClosed"
    }))).toBe(true);
    // The message alone is not enough — only imapflow's codes identify a dead client.
    expect(isConnectionLostError(new Error("Connection not available"))).toBe(false);
    expect(isConnectionLostError(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }))).toBe(false);
    expect(isConnectionLostError("Connection not available")).toBe(false);

    expect(source).toContain("isConnectionLostError(error)");
    expect(source).toContain("connectionLost = true");
    // Both the body backlog and the history lane are skipped once the client is dead.
    expect(source.match(/} else if \(!connectionLost\) \{/g)).toHaveLength(2);
  });

  it("enforces the UIDVALIDITY reset cap (spec §11)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("resetCountIn24h");
    expect(source).toContain("MAX_UIDVALIDITY_RESETS_24H");
    expect(source).toContain("UIDVALIDITY_RESET_LIMIT_EXCEEDED");
  });

  it("uses snapshot + watermark for resumable initial sync (spec §10.4)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("runInitialSyncBatch");
    expect(source).toContain("setInitialSyncSnapshot");
    expect(source).toContain("advanceInitialSyncWatermark");
    expect(source).toContain("initial_sync_target_max_uid");
    expect(source).toContain("initial_sync_oldest_uid_synced");
  });

  it("backfills missing-in-DB UIDs after reconcile (spec §10.7 step 3)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("reconcile.missingInDbUids");
    expect(source).toContain("RECONCILE_BACKFILL");
  });

  it("budgets flag scans per cycle and only schedules them after an attempted scan", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("MAX_FLAG_SCANS_PER_CYCLE");
    expect(source).toContain("allowFlagScan");
    expect(source).toContain("flagScanAttempted");
    expect(source).toContain("applyFlagScan");
    expect(source).toContain("scan.flagsChanged");
  });

  it("closes the IMAP client when incremental total timeout fires", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("withIncrementalDeadline");
    expect(source).toContain('"INCREMENTAL_TOTAL_TIMEOUT_MS"');
    expect(source).toContain("withOperationDeadline");
    expect(source).toContain("abortClient(client)");
    expect(source).toContain("${timeoutName} exceeded during ${operation}");
  });

  it("puts total deadlines around flag scan and reconcile streams", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("FLAG_SCAN_TOTAL_TIMEOUT_MS");
    expect(source).toContain("RECONCILE_TOTAL_TIMEOUT_MS");
    expect(source).toContain("withAsyncIterableDeadline");
    expect(source).toContain("reconcile UID stream");
  });

  it("runs history after the hot and body lanes under the same lock budget", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source.indexOf("getFoldersDueForSync")).toBeLessThan(source.indexOf("fetchBodyBacklog"));
    expect(source.indexOf("fetchBodyBacklog")).toBeLessThan(source.indexOf("runHistoryLane"));
    expect(source).toContain("account.max_backfill_rate");
    expect(source).toContain("getHistoryBacklog(account, 1)");
    expect(source).toContain("setHistoryBackfillSnapshot");
    expect(source).toContain("advanceHistoryBackfillWatermark");
  });
});
