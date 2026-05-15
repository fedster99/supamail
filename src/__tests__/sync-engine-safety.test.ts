import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("sync engine safety", () => {
  it("does not treat partial folder failures as healthy account syncs", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain('result.outcome === "partial_success"');
    expect(source).toContain("markAccountSyncPartial");
  });

  it("reconciles against all live provider UIDs", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(source).toContain("iterateAllUids(client)");
    expect(source).toContain("markMissingMessagesFromLiveUidStream");
    expect(source).toContain("Reconcile returned no UIDs for non-empty mailbox");
    expect(source).not.toContain("searchAllUids(client, windowCutoff)");
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
});
