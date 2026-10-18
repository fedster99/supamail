import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BodyDownloadTimeoutError,
  isConnectionLostError,
  isMissingMailboxError,
  MirrorEngine
} from "../sync-engine.js";

describe("sync engine safety", () => {
  it("closes only the body connection at the download deadline and backs that message off", async () => {
    vi.useFakeTimers();
    try {
      const message = {
        id: "message-1",
        account_id: "account-1",
        folder_path: "INBOX",
        uidvalidity: "7",
        uid: "5",
        size_bytes: "81920"
      };
      const repository = {
        getAccount: vi.fn(async () => ({
          id: "account-1",
          lock_id: "42",
          sync_state: "HEALTHY",
          historical_backfill_mode: "off"
        })),
        getBodyBacklog: vi.fn(async (_account: unknown, _limit: number, options: { excludeIds?: string[] }) =>
          options.excludeIds?.includes(message.id) ? [] : [message])
      };
      let rejectFetch: (error: Error) => void = () => undefined;
      const client = {
        mailbox: { path: "INBOX", uidValidity: 7 },
        getMailboxLock: vi.fn(async () => ({ release: () => undefined })),
        // A trickling provider: the FETCH ends only when the socket closes.
        fetchOne: vi.fn(() => new Promise((_, reject) => { rejectFetch = reject; })),
        close: vi.fn(() => rejectFetch(new Error("Connection closed"))),
        logout: vi.fn(async () => undefined)
      };
      const engine = new MirrorEngine({
        pool: {} as never,
        config: {
          BODY_STORAGE_MODE: "raw_mime",
          BODY_RAW_MAX_BYTES: 1_000_000,
          BODY_BACKFILL_BATCH_SIZE: 10,
          MAX_BODY_BATCHES_PER_TICK: 4
        } as never,
        repository: repository as never,
        clientFactory: async () => client as never
      });

      const run = engine.syncBodies("account-1", { client: client as never });
      const settled = expect(run).rejects.toBeInstanceOf(BodyDownloadTimeoutError);
      // 60 s plus 8 KiB/s of the declared 80 KiB.
      await vi.advanceTimersByTimeAsync(69_999);
      expect(client.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(client.close).toHaveBeenCalledTimes(1);
      // A host-owned session is never logged out by the engine.
      expect(client.logout).not.toHaveBeenCalled();

      // The next run skips the message while it backs off, and needs no connection.
      expect(await engine.syncBodies("account-1", { client: client as never }))
        .toEqual({ committed: 0, gone: 0, skipped: 0, remaining: false });
      expect(repository.getBodyBacklog.mock.calls[1][2]).toEqual({
        includeArchive: false,
        excludeIds: [message.id]
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records no run when account-lock acquisition throws", async () => {
    const repository = {
      getAccount: vi.fn(async () => ({ id: "account-1", lock_id: "42" })),
      startSyncRun: vi.fn(async () => "run-1"),
      finishSyncRun: vi.fn(async () => undefined)
    };
    const pool = {
      connect: vi.fn(async () => {
        throw new Error("timeout exceeded when trying to connect");
      })
    };
    const engine = new MirrorEngine({
      pool: pool as never,
      config: {} as never,
      repository: repository as never
    });

    await expect(engine.syncAccount("account-1", "scheduled"))
      .rejects.toThrow("timeout exceeded when trying to connect");

    // The run row is created only once the pass holds the lock.
    expect(repository.startSyncRun).not.toHaveBeenCalled();
    expect(repository.finishSyncRun).not.toHaveBeenCalled();
  });

  it.each([
    ["a full pass", {}],
    ["a live pass", { liveInboxOnly: true }]
  ])("defers %s while another session holds the account lock, recording nothing", async (_name, options) => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ locked: false }] })),
      release: vi.fn()
    };
    const repository = {
      getAccount: vi.fn(async () => ({ id: "account-1", lock_id: "42" })),
      startSyncRun: vi.fn(async () => "run-1"),
      finishSyncRun: vi.fn(async () => undefined),
      markAccountSyncStarted: vi.fn(async () => undefined),
      markAccountSyncYielded: vi.fn(async () => undefined),
      markAccountSyncFailed: vi.fn(async () => undefined)
    };
    const clientFactory = vi.fn();
    const engine = new MirrorEngine({
      pool: { connect: vi.fn(async () => client) } as never,
      config: {} as never,
      repository: repository as never,
      clientFactory
    });

    const result = await engine.syncAccount("account-1", "scheduled", options);

    expect(result).toMatchObject({ runId: null, outcome: "deferred", errors: [] });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(repository.startSyncRun).not.toHaveBeenCalled();
    expect(repository.finishSyncRun).not.toHaveBeenCalled();
    expect(repository.markAccountSyncStarted).not.toHaveBeenCalled();
    expect(repository.markAccountSyncYielded).not.toHaveBeenCalled();
    expect(repository.markAccountSyncFailed).not.toHaveBeenCalled();
  });

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

  it("handles a moved-out body-fetch UID with a recoverable tombstone instead of bricking the account", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    // A UID gone from its folder at body-fetch time is a benign MessageMovedError.
    // The commit tombstones the row only while it is still at that UID, so a
    // confirmed move keeps it live; the next reconcile revives a UID still listed.
    expect(source).toContain("error instanceof MessageMovedError");
    expect(source).toContain("markMessageGone(message)");
    expect(source).toContain("row.uid !== String(message.uid)");
  });

  it("commits the search extract and threading evidence before handing off the body payload", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");
    const evidenceWrite = source.indexOf("await this.repository.storeBodyEvidence(body)");
    const payloadWrite = source.indexOf("await this.bodyStore.store(body)");
    const completionWrite = source.indexOf("await this.repository.completeBodyStorage(body.messageId)");

    expect(evidenceWrite).toBeGreaterThan(-1);
    expect(payloadWrite).toBeGreaterThan(evidenceWrite);
    expect(completionWrite).toBeGreaterThan(payloadWrite);

    const batchEvidenceWrite = source.indexOf("await this.repository.storeBodyEvidenceBatch(");
    const batchPayloadWrite = source.indexOf("await this.bodyStore.store(body)", batchEvidenceWrite);
    expect(batchEvidenceWrite).toBeGreaterThan(-1);
    expect(batchPayloadWrite).toBeGreaterThan(batchEvidenceWrite);
  });

  it("reconciles the complete folder and fetches only the live window", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("searchMailboxUids(client, { all: true })");
    expect(source).toContain("searchMailboxUids(client, { since: windowCutoff })");
    expect(source).toContain("this.repository.reconcileFolderUids(");
    expect(source).toContain("expectedCount: client.mailbox ? client.mailbox.exists : undefined");
    expect(source).toContain("error instanceof IncompleteUidListError");
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

    // The transient description keeps the server's classification for local
    // troubleshooting. Durable state reduces it to a fixed operational code.
    const { diagnosticErrorCode, sanitizeErrorReason } = await import("../repository.js");
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
    expect(diagnosticErrorCode(described)).toBe("AUTH_ERROR");

    class ProviderFailure extends Error {}
    expect(describeSyncError(new ProviderFailure("provider exploded"))).toContain("[ProviderFailure]");

    // Wiring: classify on the ERROR OBJECT and persist the enriched description.
    expect(source).toContain("isAuthError(error)");
    expect(source).toContain("const message = describeSyncError(error)");
    expect(source).toContain("markAccountSyncAuthFailed");
  });

  it("classifies durable sync diagnostics without retaining provider text", async () => {
    const { diagnosticErrorCode } = await import("../repository.js");

    expect(diagnosticErrorCode("provider timed out while reading INBOX/private"))
      .toBe("SYNC_TIMEOUT");
    expect(diagnosticErrorCode("LOGIN failed for owner@example.test"))
      .toBe("AUTH_ERROR");
    expect(diagnosticErrorCode("[Error] [code=ELOGIN] [AUTH] Command failed"))
      .toBe("AUTH_ERROR");
    expect(diagnosticErrorCode("server said too many requests for user@example.test"))
      .toBe("RATE_LIMITED");
    expect(diagnosticErrorCode("certificate verify failed for mail.example.test"))
      .toBe("TLS_ERROR");
    expect(diagnosticErrorCode("No such mailbox: Private Clients"))
      .toBe("MAILBOX_MISSING");
    expect(diagnosticErrorCode("Mailbox Private Clients is missing"))
      .toBe("MAILBOX_MISSING");
    expect(diagnosticErrorCode("ECONNRESET from mail.example.test"))
      .toBe("CONNECTION_ERROR");
    expect(diagnosticErrorCode("provider transient disconnect in Private Clients"))
      .toBe("CONNECTION_ERROR");
    expect(diagnosticErrorCode("subject leaked in an unknown provider response"))
      .toBe("SYNC_ERROR");
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
    expect(isMissingMailboxError(
      new Error("Command failed — NO Mailbox doesn't exist: Project-Alpha")
    )).toBe(true);
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
    // The history lane stops once the client is dead; the live wake skips it.
    expect(source).toContain(`} else if (!options.sentOnly
          && !options.liveInboxOnly
          && !connectionLost) {`);
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

  it("puts total deadlines around flag scan streams and reconcile searches", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("FLAG_SCAN_TOTAL_TIMEOUT_MS");
    expect(source).toContain("RECONCILE_TOTAL_TIMEOUT_MS");
    expect(source).toContain("withAsyncIterableDeadline");
    expect(source).toContain("reconcile UID SEARCH");
  });

  it("runs history after the hot lane and fetches bodies only beside the lock", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source.indexOf("getFoldersDueForSync")).toBeLessThan(source.indexOf("runHistoryLane"));
    // ADR 0044: one body path, downloaded beside the lock and committed under it.
    expect(source.match(/fetchFullMessageBody\(/g)).toHaveLength(1);
    expect(source.match(/fetchFullMessageBodyBatch\(/g)).toHaveLength(1);
    expect(source).toContain("withInteractiveAccountLock(this.pool, account, async () => {");
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
    expect(source.indexOf("isWithinBackfillWindow(this.config)")).toBeLessThan(source.indexOf("getHistoryBacklog(account, 1)"));
  });
});
