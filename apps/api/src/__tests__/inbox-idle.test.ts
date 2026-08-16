import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openInboxIdleSession, waitForInboxIdleWake } from "../inbox-idle.js";
import type { ImapAccount } from "../types.js";

class FakeIdleClient extends EventEmitter {
  capabilities = new Map<string, boolean | number>([["IDLE", true]]);
  enabled = new Set<string>();
  usable = true;
  mailboxOpen = vi.fn(async () => ({}));
  logout = vi.fn(async () => undefined);
  close = vi.fn(() => this.emit("close"));
  idleStarted = false;
  finishIdle: ((value: boolean) => void) | null = null;
  statuses = new Map<string, {
    path: string;
    uidValidity: bigint;
    uidNext: number;
    messages: number;
    unseen: number;
    highestModseq?: bigint;
  }>();
  status = vi.fn(async (path: string) => this.statuses.get(path)!);

  async idle(): Promise<boolean> {
    this.idleStarted = true;
    return await new Promise<boolean>((resolve) => {
      this.finishIdle = resolve;
    });
  }
}

const account = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as ImapAccount;
const config = {
  IMAP_MAX_COMMANDS_PER_MINUTE: 200,
  IMAP_COMMAND_TIMEOUT_MS: 1_000,
  MAX_PRIORITY_FOLDERS_PER_CYCLE: 10,
  MAX_RR_FOLDERS_PER_CYCLE: 5,
  IMAP_FOLDER_STATUS_INTERVAL_MS: 60_000
} as never;
const fastStatusConfig = Object.assign({}, config, {
  IMAP_FOLDER_STATUS_INTERVAL_MS: 1
}) as never;
const pool = {} as never;

async function startedAttempt(client: FakeIdleClient, now: () => Date = () => new Date()) {
  const attempt = waitForInboxIdleWake(pool, config, account, {
    now,
    clientFactory: async () => client
  });
  await vi.waitFor(() => expect(client.idleStarted).toBe(true));
  return { attempt };
}

describe("waitForInboxIdleWake", () => {
  it("returns an EXISTS hint and closes the watcher before its owner syncs", async () => {
    const client = new FakeIdleClient();
    const dates = [new Date("2026-08-15T00:00:00Z"), new Date("2026-08-15T00:00:02Z")];
    const { attempt } = await startedAttempt(client, () => dates.shift()!);

    client.emit("exists", { path: "INBOX", count: 4, prevCount: 3 });

    await expect(attempt).resolves.toEqual({
      status: "wake",
      connectedAt: new Date("2026-08-15T00:00:00Z"),
      wake: {
        kind: "exists",
        accountId: account.id,
        folderPath: "INBOX",
        observedAt: new Date("2026-08-15T00:00:02Z"),
        count: 4,
        previousCount: 3
      }
    });
    expect(client.mailboxOpen).toHaveBeenCalledWith("INBOX", { readOnly: true });
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.listenerCount("exists")).toBe(0);
  });

  it.each([
    ["expunge", { path: "INBOX", seq: 2, uid: 22 }, { sequence: 2, uid: 22 }],
    ["flags", { path: "INBOX", seq: 3, uid: 23 }, { sequence: 3, uid: 23 }]
  ] as const)("normalizes an %s hint without treating it as database truth", async (kind, event, expected) => {
    const client = new FakeIdleClient();
    const { attempt } = await startedAttempt(client);
    client.emit(kind, event);
    const result = await attempt;
    expect(result.status).toBe("wake");
    if (result.status === "wake") {
      expect(result.wake).toMatchObject({ kind, folderPath: "INBOX", ...expected });
    }
  });

  it("reports unsupported IDLE without opening a mailbox or entering polling fallback", async () => {
    const client = new FakeIdleClient();
    client.capabilities.clear();

    await expect(waitForInboxIdleWake(pool, config, account, {
      clientFactory: async () => client
    })).resolves.toMatchObject({ status: "unsupported" });
    expect(client.mailboxOpen).not.toHaveBeenCalled();
    expect(client.idleStarted).toBe(false);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.logout).not.toHaveBeenCalled();
  });

  it("keeps the legacy injected-client shape valid when STATUS probing is disabled", async () => {
    const close = vi.fn();
    const client = Object.assign(new EventEmitter(), {
      capabilities: new Map<string, boolean | number>([["IDLE", true]]),
      enabled: new Set<string>(),
      mailboxOpen: vi.fn(async () => ({})),
      idle: vi.fn(async () => true),
      logout: vi.fn(async () => undefined),
      close
    });

    const opened = await openInboxIdleSession(pool, config, account, {
      clientFactory: async () => client
    });
    expect(opened.status).toBe("ready");
    if (opened.status === "ready") opened.session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the provider session when tracked-folder initialization fails", async () => {
    const client = new FakeIdleClient();
    await expect(openInboxIdleSession(pool, config, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => {
        throw new Error("database unavailable");
      }
    })).rejects.toThrow("database unavailable");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("reports an unexpected close so the owner can schedule catch-up and reconnect", async () => {
    const client = new FakeIdleClient();
    const { attempt } = await startedAttempt(client);
    client.emit("close");
    await expect(attempt).resolves.toMatchObject({ status: "disconnected" });
  });

  it("reports a normal IDLE renewal without treating it as a disconnect", async () => {
    const client = new FakeIdleClient();
    const { attempt } = await startedAttempt(client);
    client.finishIdle!(true);
    await expect(attempt).resolves.toMatchObject({ status: "renew" });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("yields immediately when host sync ends IDLE instead of starting a STATUS sweep", async () => {
    const client = new FakeIdleClient();
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const opened = await openInboxIdleSession(pool, config, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(client.status).toHaveBeenCalledTimes(1);

    const wait = opened.session.wait();
    await vi.waitFor(() => expect(client.idleStarted).toBe(true));
    client.finishIdle!(true);

    await expect(wait).resolves.toEqual({ status: "renew" });
    expect(client.status).toHaveBeenCalledTimes(1);
    opened.session.close();
  });

  it("aborts promptly and removes every lifecycle listener", async () => {
    const client = new FakeIdleClient();
    const abort = new AbortController();
    const attempt = waitForInboxIdleWake(pool, config, account, {
      signal: abort.signal,
      clientFactory: async () => client
    });
    await vi.waitFor(() => expect(client.idleStarted).toBe(true));
    abort.abort(new Error("shutdown"));

    await expect(attempt).rejects.toThrow("shutdown");
    expect(client.close).toHaveBeenCalled();
    expect(client.listenerCount("close")).toBe(0);
  });

  it("keeps a reusable session open for the authoritative sync", async () => {
    const client = new FakeIdleClient();
    const opened = await openInboxIdleSession(pool, config, account, {
      clientFactory: async () => client
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    const wait = opened.session.wait();
    await vi.waitFor(() => expect(client.idleStarted).toBe(true));
    client.emit("expunge", { path: "INBOX", seq: 1, uid: 18 });

    await expect(wait).resolves.toMatchObject({ status: "wake" });
    expect(client.close).not.toHaveBeenCalled();
    expect(opened.session.syncClient).toBeDefined();
    client.emit("flags", { path: "Archive", seq: 1, uid: 19 });
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([
      expect.objectContaining({ path: "INBOX", forceFlagScan: false })
    ]);
    client.emit("flags", { path: "INBOX", seq: 2, uid: 20 });
    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "INBOX" }
    });
    const handled = opened.session.syncClient.peekMailboxChanges?.() ?? [];
    opened.session.syncClient.acknowledgeMailboxChanges?.(handled);

    client.finishIdle = null;
    const nextWait = opened.session.wait();
    await vi.waitFor(() => expect(client.finishIdle).not.toBeNull());
    client.emit("flags", { path: "INBOX", seq: 3, uid: 21 });
    client.emit("expunge", { path: "INBOX", seq: 4, uid: 22 });
    await expect(nextWait).resolves.toMatchObject({
      status: "wake",
      wake: { kind: "expunge", sequence: 4, uid: 22 }
    });
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([
      expect.objectContaining({
        path: "INBOX",
        forceReconcile: true,
        forceFlagScan: true
      })
    ]);
    opened.session.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("turns a non-Inbox STATUS change into a durable sync hint on renewal", async () => {
    const client = new FakeIdleClient();
    client.statuses.set("INBOX", {
      path: "INBOX",
      uidValidity: 1n,
      uidNext: 2,
      messages: 1,
      unseen: 0,
      highestModseq: 10n
    });
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const opened = await openInboxIdleSession(pool, fastStatusConfig, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");

    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 12,
      messages: 11,
      unseen: 2,
      highestModseq: 21n
    });
    const wait = opened.session.wait();

    await expect(wait).resolves.toMatchObject({
      status: "wake",
      wake: { kind: "exists", folderPath: "Archive" }
    });
    const changes = opened.session.syncClient.peekMailboxChanges?.() ?? [];
    expect(changes).toEqual([
      expect.objectContaining({
        path: "Archive",
        forceReconcile: true,
        forceFlagScan: true
      })
    ]);
    opened.session.syncClient.acknowledgeMailboxChanges?.(changes);
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([]);
    opened.session.close();
  });

  it("turns a transient STATUS failure into conservative reconcile and flag work", async () => {
    const client = new FakeIdleClient();
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    client.status.mockRejectedValueOnce(new Error("STATUS rejected"));
    const opened = await openInboxIdleSession(pool, fastStatusConfig, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");

    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Archive" }
    });
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([
      expect.objectContaining({
        path: "Archive",
        forceReconcile: true,
        forceFlagScan: true,
        observed: expect.objectContaining({ uidValidity: 2n })
      })
    ]);
    opened.session.close();
  });

  it("closes when STATUS fails after the provider marks the session unusable", async () => {
    const client = new FakeIdleClient();
    client.usable = false;
    client.status.mockRejectedValue(new Error("connection closed"));

    await expect(openInboxIdleSession(pool, config, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    })).rejects.toThrow("connection closed");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("refreshes tracked folders without reconnecting", async () => {
    const client = new FakeIdleClient();
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    client.statuses.set("Projects", {
      path: "Projects",
      uidValidity: 3n,
      uidNext: 5,
      messages: 4,
      unseen: 0,
      highestModseq: 8n
    });
    const tracked = ["Archive"];
    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      MAX_PRIORITY_FOLDERS_PER_CYCLE: 2,
      MAX_RR_FOLDERS_PER_CYCLE: 0
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => [...tracked]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");

    tracked.push("Projects");
    const seedNewFolder = opened.session.wait();
    await expect(seedNewFolder).resolves.toEqual({ status: "renew" });

    client.statuses.set("Projects", {
      path: "Projects",
      uidValidity: 3n,
      uidNext: 6,
      messages: 5,
      unseen: 1,
      highestModseq: 9n
    });
    const detectNewFolder = opened.session.wait();
    await expect(detectNewFolder).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Projects" }
    });
    opened.session.close();
  });

  it("retries an unacknowledged snapshot without letting its old acknowledgement clear a newer one", async () => {
    const client = new FakeIdleClient();
    const status = (uidNext: number) => ({
      path: "Archive",
      uidValidity: 2n,
      uidNext,
      messages: uidNext - 1,
      unseen: 0,
      highestModseq: BigInt(uidNext)
    });
    client.statuses.set("Archive", status(11));
    const opened = await openInboxIdleSession(pool, fastStatusConfig, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");

    client.statuses.set("Archive", status(12));
    const firstWait = opened.session.wait();
    await firstWait;
    const first = opened.session.syncClient.peekMailboxChanges?.() ?? [];

    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Archive" }
    });
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual(first);

    client.statuses.set("Archive", status(13));
    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Archive" }
    });
    opened.session.syncClient.acknowledgeMailboxChanges?.(first);

    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([
      expect.objectContaining({
        path: "Archive",
        observed: expect.objectContaining({ uidNext: 13 })
      })
    ]);
    opened.session.close();
  });

  it("closes a watcher when shutdown interrupts Inbox selection", async () => {
    const client = new FakeIdleClient();
    let releaseOpen!: () => void;
    client.mailboxOpen.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      return {};
    });
    const abort = new AbortController();
    const attempt = waitForInboxIdleWake(pool, config, account, {
      signal: abort.signal,
      clientFactory: async () => client
    });
    await vi.waitFor(() => expect(client.mailboxOpen).toHaveBeenCalledTimes(1));

    abort.abort(new Error("shutdown during select"));
    releaseOpen();

    await expect(attempt).rejects.toThrow("shutdown during select");
    expect(client.close).toHaveBeenCalled();
    expect(client.idleStarted).toBe(false);
  });
});
