import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isConnectionLostError, isMissingMailboxError, MirrorEngine } from "../sync-engine.js";

describe("sync engine safety", () => {
  it("passes the worker shutdown signal into an in-flight full sync", async () => {
    const abort = new AbortController();
    const repository = {
      getRunnableAccounts: vi.fn(async () => [{ id: "account-1" }])
    };
    const engine = new MirrorEngine({
      pool: {} as never,
      config: {} as never,
      repository: repository as never
    });
    let releaseSync!: () => void;
    const syncAccount = vi.spyOn(engine, "syncAccount").mockImplementation(
      async (_accountId, _triggerType, options) => {
        await new Promise<void>((resolve) => {
          releaseSync = resolve;
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {} as never;
      }
    );

    const sync = engine.syncDueAccounts(1, { signal: abort.signal });
    await vi.waitFor(() => expect(syncAccount).toHaveBeenCalledOnce());
    abort.abort();

    const stoppedPromptly = await Promise.race([
      sync.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
    ]);
    if (!stoppedPromptly) {
      // Let the deliberately blocked test double finish so a failing regression
      // test does not leave an unresolved sync behind.
      releaseSync();
      await sync;
    }

    expect(stoppedPromptly).toBe(true);
    expect(syncAccount).toHaveBeenCalledWith("account-1", "scheduled", {
      signal: abort.signal
    });
  });

  it("does not treat partial folder failures as healthy account syncs", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain('result.outcome === "partial_success"');
    expect(source).toContain("markAccountSyncPartial");
  });

  it("handles a moved-out body-fetch UID by window instead of bricking the account", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    // A UID gone from its folder at body-fetch time must be caught as a benign
    // MessageMovedError and taken out of the backlog — NOT re-thrown into the
    // account-level catch, which bricks the account to BROKEN and re-loops every
    // backfill. Scope the response by window: IN_WINDOW rows self-heal (safe to
    // tombstone MOVED_OUT); HISTORICAL/EXPIRED rows never re-observe, so tombstoning
    // would be unrecoverable — mark the fetch attempted instead.
    expect(source).toContain("error instanceof MessageMovedError");
    expect(source).toContain('message.window_status === "IN_WINDOW"');
    expect(source).toContain("markMessageMovedOut(message.id)");
    expect(source).toContain("markBodyFetchAttempted(message.id)");
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

  it("classifies auth errors from imapflow's structured error, not just the message (spec §13.1)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");
    const { isAuthError, describeSyncError } = await import("../sync-engine.js");

    // The okano incident: imapflow login failures throw message "Command failed" with
    // the real signal in structured props. A message-only regex classified a bad
    // credential as a generic failure → hourly retry hammering instead of terminal
    // AUTH_ERROR, and 67 runs persisted the useless reason "Command failed".
    expect(isAuthError(Object.assign(new Error("Command failed"), { authenticationFailed: true }))).toBe(true);
    expect(isAuthError(Object.assign(new Error("Command failed"), { serverResponseCode: "AUTHENTICATIONFAILED" }))).toBe(true);
    expect(isAuthError(Object.assign(new Error("Command failed"), { response: "LOGIN failed." }))).toBe(true);
    // A bare "Command failed" carries no auth signal — it must NOT classify as auth
    // (it is imapflow's generic command error; over-matching it would make every
    // failure terminal).
    expect(isAuthError(new Error("Command failed"))).toBe(false);
    expect(isAuthError(new Error("read ETIMEDOUT"))).toBe(false);
    // imapflow tags ANY login-exec error with authenticationFailed=true, including
    // transient server conditions and dead connections — those must NOT go terminal.
    expect(isAuthError(Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      serverResponseCode: "UNAVAILABLE",
      response: "Temporary System Problem"
    }))).toBe(false);
    expect(isAuthError(Object.assign(new Error("Connection not available"), {
      authenticationFailed: true,
      code: "NoConnection"
    }))).toBe(false);
    // Back-compat: plain strings still pattern-match.
    expect(isAuthError("535 5.7.8 authentication failed")).toBe(true);

    // The persisted reason keeps the server's why, not just "Command failed" — and it
    // must SURVIVE sanitizeErrorReason, whose credential redaction truncates from the
    // first LOGIN/AUTHENTICATE token onward (markers must precede the server text).
    const { sanitizeErrorReason } = await import("../repository.js");
    const described = describeSyncError(Object.assign(new Error("Command failed"), {
      code: "ELOGIN",
      authenticationFailed: true,
      serverResponseCode: "AUTHENTICATIONFAILED",
      responseStatus: "NO",
      response: "LOGIN failed."
    }));
    expect(described).toContain("[Error]");
    expect(described).toContain("[code=ELOGIN]");
    expect(described).toContain("[status=NO]");
    expect(described).toContain("Command failed");
    expect(described).toContain("LOGIN failed.");
    const sanitized = sanitizeErrorReason(described);
    expect(sanitized).toContain("[Error]");
    expect(sanitized).toContain("[code=ELOGIN]");
    expect(sanitized).toContain("[AUTHENTICATIONFAILED]");
    expect(sanitized).toContain("[status=NO]");
    expect(sanitized).toContain("[AUTH]");
    expect(sanitized).not.toContain("LOGIN failed.");

    class ProviderFailure extends Error {}
    expect(describeSyncError(new ProviderFailure("provider exploded"))).toContain("[ProviderFailure]");

    // Wiring: classify on the ERROR OBJECT and persist the enriched description.
    expect(source).toContain("isAuthError(error)");
    expect(source).toContain("const message = describeSyncError(error)");
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
    // Both the body backlog and the history lane are skipped for a fast Sent pass
    // and once the client is dead.
    expect(source.match(/} else if \(!options\.sentOnly && !connectionLost\) \{/g)).toHaveLength(2);
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

  it("gates only the history lane behind BACKFILL_WINDOW_*", async () => {
    const config = await readFile(resolve(process.cwd(), "src/config.ts"), "utf8");
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(config).toContain("BACKFILL_WINDOW_START_HOUR");
    expect(config).toContain("BACKFILL_WINDOW_END_HOUR");
    expect(config).toContain("BACKFILL_WINDOW_TIMEZONE");
    expect(source).toContain("isWithinBackfillWindow(this.config)");
    expect(source.indexOf("fetchBodyBacklog")).toBeLessThan(source.indexOf("runHistoryLane"));
    expect(source.indexOf("isWithinBackfillWindow(this.config)")).toBeLessThan(source.indexOf("getHistoryBacklog(account, 1)"));
  });
});
