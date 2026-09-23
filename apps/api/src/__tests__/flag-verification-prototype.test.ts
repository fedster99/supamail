import { describe, expect, it, vi } from "vitest";
import { verifyFlagPage, type FlagCheckpoint } from "./helpers/flag-verification-prototype.js";
import type { MirrorImapClient } from "../imap-client.js";
import type { MessageFlagSnapshot } from "../types.js";

function fixture(uids = [1, 2, 3, 4, 5]) {
  const checkpoint: FlagCheckpoint = {
    accountId: "fixture-account", folderPath: "Archive", uidValidity: 4,
    afterUid: 0, throughUid: 5,
  };
  const mirror = new Map(uids.map(uid => [uid, ["\\Seen"]]));
  const fetch = vi.fn(async function* (requested: number[]) {
    for (const uid of requested) yield { uid, flags: new Set(["\\Seen", "\\Flagged"]) };
  });
  const readPage = vi.fn(async (scope: FlagCheckpoint, limit: number) => {
    expect(scope.accountId).toBe(checkpoint.accountId);
    expect(scope.folderPath).toBe(checkpoint.folderPath);
    return uids.filter(uid => uid > scope.afterUid && uid <= scope.throughUid).slice(0, limit);
  });
  const applyFlags = vi.fn(async (flags: MessageFlagSnapshot[]) => {
    for (const item of flags) mirror.set(item.uid, item.flags);
  });
  return { checkpoint, mirror, fetch, input: {
    checkpoint, currentScope: { accountId: checkpoint.accountId, folderPath: checkpoint.folderPath, uidValidity: 4 },
    batchSize: 2,
    client: { fetch } as unknown as MirrorImapClient, readPage, applyFlags,
  } };
}

describe("experimental bounded stored-UID flag verification", () => {
  it("covers the frozen mirror set in bounded pages without a provider SEARCH", async () => {
    const f = fixture();
    let checkpoint = f.checkpoint;
    let turns = 0;
    while (true) {
      const result = await verifyFlagPage({ ...f.input, checkpoint });
      checkpoint = result.checkpoint;
      turns++;
      expect(result.checked).toBeLessThanOrEqual(2);
      if (result.complete) break;
    }
    expect(turns).toBe(3);
    expect(checkpoint.afterUid).toBe(5);
    expect(f.checkpoint.afterUid).toBe(0);
    expect([...f.mirror.values()].every(flags => flags.includes("\\Flagged"))).toBe(true);
    expect(f.fetch.mock.calls.map(([uids]) => uids)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("does not skip older UIDs when new mail arrives above the frozen upper bound", async () => {
    const f = fixture([1, 2, 3, 4, 5, 6, 7]);
    let result = await verifyFlagPage(f.input);
    result = await verifyFlagPage({ ...f.input, checkpoint: result.checkpoint });
    result = await verifyFlagPage({ ...f.input, checkpoint: result.checkpoint });
    expect(result.complete).toBe(true);
    expect(result.checkpoint.afterUid).toBe(5);
    expect(f.mirror.get(7)).toEqual(["\\Seen"]);
  });

  it("rejects a stale UIDVALIDITY before any provider or database work", async () => {
    const f = fixture();
    await expect(verifyFlagPage({
      ...f.input, currentScope: { ...f.input.currentScope, uidValidity: 6 },
    })).rejects.toThrow("stale UIDVALIDITY");
    expect(f.input.readPage).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["accountId", "folderPath"] as const)("rejects a checkpoint for another %s", async field => {
    const f = fixture();
    await expect(verifyFlagPage({
      ...f.input, currentScope: { ...f.input.currentScope, [field]: "different" },
    })).rejects.toThrow("wrong flag verification scope");
    expect(f.input.readPage).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not commit or advance on an incomplete provider FETCH", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async function* () { yield { uid: 1, flags: new Set(["\\Seen"]) }; });
    await expect(verifyFlagPage(f.input)).rejects.toThrow(/missing 2/);
    expect(f.input.applyFlags).not.toHaveBeenCalled();
    expect(f.checkpoint.afterUid).toBe(0);
  });

  it("does not advance after a failed persistence acknowledgement", async () => {
    const f = fixture();
    f.input.applyFlags.mockRejectedValueOnce(new Error("write failed"));
    await expect(verifyFlagPage(f.input)).rejects.toThrow("write failed");
    expect(f.checkpoint.afterUid).toBe(0);
    expect((await verifyFlagPage(f.input)).checkpoint.afterUid).toBe(2);
  });

  it("replays safely when flag writes succeed but checkpoint persistence is lost", async () => {
    const f = fixture();
    await verifyFlagPage(f.input); // discard returned checkpoint: simulated crash
    const replay = await verifyFlagPage(f.input);
    expect(replay.checkpoint.afterUid).toBe(2);
    expect(f.fetch.mock.calls.map(([uids]) => uids)).toEqual([[1, 2], [1, 2]]);
    expect(f.mirror.get(1)).toEqual(["\\Seen", "\\Flagged"]);
  });

  it("skips deleted mirror rows and sparse UID gaps without scanning UID address space", async () => {
    const f = fixture([1, 5]);
    const result = await verifyFlagPage(f.input);
    expect(result.complete).toBe(true);
    expect(result.checked).toBe(2);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([[2, 1], [1, 1], [1, 6], [1, 2, 3, 4]])("rejects malformed or unbounded page %j", async (...page) => {
    const f = fixture();
    f.input.readPage.mockResolvedValue(page);
    await expect(verifyFlagPage(f.input)).rejects.toThrow("invalid flag verification page");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 501, 1.5])("rejects invalid batch size %s", async batchSize => {
    const f = fixture();
    await expect(verifyFlagPage({ ...f.input, batchSize })).rejects.toThrow("invalid flag verification batch size");
  });
});
