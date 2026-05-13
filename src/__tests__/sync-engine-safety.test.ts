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
});
