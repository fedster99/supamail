import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openInboxIdleSession, waitForInboxIdleWake } from "../inbox-idle.js";
import type { ImapAccount } from "../types.js";

class FakeIdleClient extends EventEmitter {
  capabilities = new Map<string, boolean | number>([["IDLE", true]]);
  enabled = new Set<string>();
  usable = true;
  mailbox: Record<string, unknown> | false = false;
  skipListStatusArgs = false;
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
  list = vi.fn(async () => [...this.statuses.values()].map((status) => ({
    path: status.path,
    status
  })));
  status = vi.fn(async (path: string) => this.statuses.get(path)!);
  notify = vi.fn(async (paths: string[]) => paths.flatMap((path) => {
    const status = this.statuses.get(path);
    return status ? [status] : [];
  }));
  getMailboxLock = vi.fn(async (path: string, options?: { uidValidity?: bigint; changedSince?: bigint }) => {
    this.mailbox = {
      path,
      uidValidity: options?.uidValidity ?? 1n,
      highestModseq: 12n,
      qresync: Boolean(options?.uidValidity && options.changedSince)
    };
    if (options?.uidValidity && options.changedSince) {
      this.emit("flags", { path, seq: 1, uid: 9, flags: new Set(["\\Seen"]), modseq: 11n });
      this.emit("expunge", { path, uid: 8, vanished: true, earlier: true });
    }
    return { release: vi.fn() };
  });

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

  it("does not enqueue QRESYNC replay events as new IDLE wakes", async () => {
    const client = new FakeIdleClient();
    const opened = await openInboxIdleSession(pool, config, account, {
      clientFactory: async () => client
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");

    const lock = await opened.session.syncClient.getMailboxLock("INBOX", {
      qresync: { uidValidity: 1n, changedSince: 10n }
    });
    expect(lock.qresync).toMatchObject({
      accepted: true,
      complete: true,
      vanishedUids: [8],
      changedFlags: [{ uid: 9, flags: ["\\Seen"] }]
    });
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([]);

    const wait = opened.session.wait();
    await vi.waitFor(() => expect(client.idleStarted).toBe(true));
    client.finishIdle!(true);
    await expect(wait).resolves.toEqual({ status: "renew" });
    opened.session.close();
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

  it("uses one LIST-STATUS command for all tracked folders when enabled", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("LIST-STATUS", true);
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
    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive", "Projects"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("list_status");
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.status).not.toHaveBeenCalled();

    client.statuses.set("Projects", {
      path: "Projects",
      uidValidity: 3n,
      uidNext: 6,
      messages: 5,
      unseen: 1,
      highestModseq: 9n
    });

    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Projects" }
    });
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(client.status).not.toHaveBeenCalled();
    opened.session.close();
  });

  it("uses NOTIFY as the primary all-folder wake signal when enabled", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.capabilities.set("LIST-STATUS", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true,
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("notify");
    expect(client.notify).toHaveBeenCalledWith(["Archive"]);
    expect(client.list).not.toHaveBeenCalled();
    expect(client.status).not.toHaveBeenCalled();

    const wait = opened.session.wait();
    await vi.waitFor(() => expect(client.idleStarted).toBe(true));
    client.emit("status", {
      path: "Archive",
      highestModseq: 21n,
      unseen: 2
    });

    await expect(wait).resolves.toMatchObject({
      status: "wake",
      wake: { kind: "flags", folderPath: "Archive" }
    });
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([
      expect.objectContaining({
        path: "Archive",
        forceReconcile: false,
        forceFlagScan: true,
        observed: expect.objectContaining({
          uidValidity: 2n,
          uidNext: 11,
          messages: 10,
          highestModseq: 21n
        })
      })
    ]);
    opened.session.close();
  });

  it.each([
    ["unchanged", { uidValidity: 2n, uidNext: 11, highestModseq: 20n }, null],
    ["UIDNEXT", { uidValidity: 2n, uidNext: 12, highestModseq: 20n }, {
      forceReconcile: true,
      forceFlagScan: false
    }],
    ["HIGHESTMODSEQ", { uidValidity: 2n, uidNext: 11, highestModseq: 21n }, {
      forceReconcile: true,
      forceFlagScan: true
    }],
    ["UIDVALIDITY", { uidValidity: 3n, uidNext: 11, highestModseq: 20n }, {
      forceReconcile: true,
      forceFlagScan: false
    }]
  ] as const)("classifies the persisted %s cursor during reconnect", async (
    _name,
    observed,
    expected
  ) => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.capabilities.set("QRESYNC", true);
    client.capabilities.set("LIST-STATUS", true);
    client.statuses.set("Sent", {
      path: "Sent",
      ...observed,
      messages: 11,
      unseen: 0
    });

    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true,
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Sent"],
      initialFolderStatuses: [{
        path: "Sent",
        uidValidity: 2n,
        uidNext: 11,
        highestModseq: 20n,
        qresyncHighestModseq: 20n
      }]
    });

    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(client.notify).toHaveBeenCalledWith(["Sent"]);
    const changes = opened.session.syncClient.peekMailboxChanges?.() ?? [];
    if (expected === null) expect(changes).toEqual([]);
    else expect(changes).toEqual([expect.objectContaining({ path: "Sent", ...expected })]);
    opened.session.close();
  });

  it("reconciles a no-MODSEQ reconnect once and retains the real provider snapshot", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    const sentStatus = {
      path: "Sent",
      uidValidity: 2n,
      uidNext: 11,
      messages: 9,
      unseen: 0
    };
    client.statuses.set("Sent", sentStatus);

    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Sent"],
      initialFolderStatuses: [{ path: "Sent", uidValidity: 2n, uidNext: 11 }]
    });

    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    const changes = opened.session.syncClient.peekMailboxChanges?.() ?? [];
    expect(changes).toEqual([
      expect.objectContaining({
        path: "Sent",
        forceReconcile: true,
        forceFlagScan: true,
        observed: sentStatus
      })
    ]);
    opened.session.syncClient.acknowledgeMailboxChanges?.(changes);
    client.emit("status", sentStatus);
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([]);
    opened.session.close();
  });

  it("completes a partial reconnect snapshot without letting old work acknowledge a later delete", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.notify.mockResolvedValueOnce([{
      path: "Sent",
      uidValidity: 2n,
      uidNext: 11
    }] as never);
    const completeStatus = {
      path: "Sent",
      uidValidity: 2n,
      uidNext: 11,
      messages: 9,
      unseen: 0
    };
    client.statuses.set("Sent", completeStatus);

    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Sent"],
      initialFolderStatuses: [{ path: "Sent", uidValidity: 2n, uidNext: 11 }]
    });

    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    const changes = opened.session.syncClient.peekMailboxChanges?.() ?? [];
    expect(changes).toEqual([
      expect.objectContaining({ observed: completeStatus })
    ]);

    client.emit("status", { ...completeStatus, messages: 8 });
    opened.session.syncClient.acknowledgeMailboxChanges?.(changes);
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([
      expect.objectContaining({
        path: "Sent",
        forceReconcile: true,
        observed: expect.objectContaining({ messages: 8 })
      })
    ]);
    opened.session.close();
  });

  it("does not use an equal CONDSTORE MODSEQ as proof that no offline delete occurred", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.capabilities.set("CONDSTORE", true);
    client.statuses.set("Sent", {
      path: "Sent",
      uidValidity: 2n,
      uidNext: 11,
      messages: 9,
      unseen: 0,
      highestModseq: 20n
    });

    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Sent"],
      initialFolderStatuses: [{
        path: "Sent",
        uidValidity: 2n,
        uidNext: 11,
        highestModseq: 20n
      }]
    });

    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([
      expect.objectContaining({
        path: "Sent",
        forceReconcile: true,
        forceFlagScan: false
      })
    ]);
    opened.session.close();
  });

  it("requires the deletion-complete QRESYNC cursor to match the provider snapshot", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.capabilities.set("QRESYNC", true);
    client.statuses.set("Sent", {
      path: "Sent",
      uidValidity: 2n,
      uidNext: 11,
      messages: 9,
      unseen: 0,
      highestModseq: 20n
    });

    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Sent"],
      initialFolderStatuses: [{
        path: "Sent",
        uidValidity: 2n,
        uidNext: 11,
        highestModseq: 20n,
        qresyncHighestModseq: 19n
      }]
    });

    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([
      expect.objectContaining({
        path: "Sent",
        forceReconcile: true,
        forceFlagScan: false
      })
    ]);
    opened.session.close();
  });

  it.each(["LIST-STATUS", "STATUS"] as const)(
    "arms NOTIFY before %s reconnect comparison",
    async (fallback) => {
      const client = new FakeIdleClient();
      client.capabilities.set("NOTIFY", true);
      client.capabilities.set("QRESYNC", true);
      if (fallback === "LIST-STATUS") client.capabilities.set("LIST-STATUS", true);
      client.notify.mockResolvedValueOnce([]);
      client.statuses.set("Sent", {
        path: "Sent",
        uidValidity: 2n,
        uidNext: 12,
        messages: 11,
        unseen: 0,
        highestModseq: 21n
      });
      client.statuses.set("Archive", {
        path: "Archive",
        uidValidity: 3n,
        uidNext: 5,
        messages: 4,
        unseen: 0,
        highestModseq: 8n
      });
      const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
        IMAP_NOTIFY_ENABLED: true,
        IMAP_LIST_STATUS_ENABLED: true
      }) as never, account, {
        clientFactory: async () => client,
        folderPathsFactory: async () => ["Sent", "Archive"],
        initialFolderStatuses: [
          {
            path: "Sent",
            uidValidity: 2n,
            uidNext: 11,
            highestModseq: 20n,
            qresyncHighestModseq: 20n
          },
          {
            path: "Archive",
            uidValidity: 3n,
            uidNext: 5,
            highestModseq: 8n,
            qresyncHighestModseq: 8n
          }
        ]
      });

      expect(opened.status).toBe("ready");
      if (opened.status !== "ready") throw new Error("session was not ready");
      const fallbackCall = fallback === "LIST-STATUS" ? client.list : client.status;
      expect(client.notify.mock.invocationCallOrder[0]).toBeLessThan(
        fallbackCall.mock.invocationCallOrder[0]!
      );
      expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([
        expect.objectContaining({ path: "Sent" })
      ]);
      opened.session.close();
    }
  );

  it("reports and carries the parser-root NOTIFY signal without exposing content", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const traces = vi.fn();
    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"],
      onNotifyTrace: traces
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({
      stage: "notify_state",
      reason: "armed",
      notifyArmed: true,
      notifyGeneration: 1,
      observedAt: expect.any(Date),
      monotonicObservedAtMs: expect.any(Number)
    }));

    const wait = opened.session.wait();
    await vi.waitFor(() => expect(client.idleStarted).toBe(true));
    const receivedAt = new Date("2026-08-17T18:00:00.000Z");
    const notifySignal = {
      sequence: 7,
      receivedAt,
      monotonicReceivedAtMs: 12,
      eventType: "STATUS",
      connectionState: "SELECTED",
      activeCommand: "IDLE"
    } as const;
    client.emit("notifyResponse", notifySignal);
    client.emit("status", {
      path: "Archive",
      highestModseq: 21n,
      unseen: 2,
      notifySignal
    });

    await expect(wait).resolves.toMatchObject({
      status: "wake",
      wake: {
        kind: "flags",
        folderPath: "Archive",
        notifySignal
      }
    });
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({
      stage: "response_received",
      signal: notifySignal,
      notifyArmed: true,
      notifyGeneration: 1
    }));
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({
      stage: "imapflow_event_created",
      signal: notifySignal,
      folderPath: "Archive",
    }));
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({
      stage: "handoff",
      signal: notifySignal,
      folderPath: "Archive",
      result: "emitted",
      reason: "wake_delivered"
    }));
    expect(JSON.stringify(traces.mock.calls)).not.toContain("highestModseq");
    opened.session.close();
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({
      stage: "notify_state",
      reason: "closed",
      notifyArmed: false,
      notifyGeneration: 1
    }));
  });

  it("records which NOTIFY signal was coalesced before wake delivery", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const traces = vi.fn();
    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"],
      onNotifyTrace: traces
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");

    const wait = opened.session.wait();
    await vi.waitFor(() => expect(client.idleStarted).toBe(true));
    const signal = (sequence: number) => ({
      sequence,
      receivedAt: new Date("2026-08-17T18:00:00.000Z"),
      monotonicReceivedAtMs: sequence,
      eventType: "STATUS" as const,
      connectionState: "SELECTED",
      activeCommand: "IDLE"
    });
    client.emit("status", {
      path: "Archive",
      unseen: 2,
      highestModseq: 21n,
      notifySignal: signal(10)
    });
    client.emit("status", {
      path: "Archive",
      unseen: 3,
      highestModseq: 22n,
      notifySignal: signal(11)
    });

    await expect(wait).resolves.toMatchObject({
      status: "wake",
      wake: { notifySignal: { sequence: 11 } }
    });
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({
      stage: "handoff",
      signal: expect.objectContaining({ sequence: 10 }),
      result: "coalesced",
      reason: "superseded"
    }));
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({
      stage: "handoff",
      signal: expect.objectContaining({ sequence: 11 }),
      result: "emitted",
      reason: "wake_delivered"
    }));
    opened.session.close();
  });

  it("records a deferred NOTIFY signal that the active sync already reconciled", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
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
      uidNext: 21,
      messages: 20,
      unseen: 2,
      highestModseq: 30n
    });
    const traces = vi.fn();
    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive", "Projects"],
      onNotifyTrace: traces
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    const signal = (sequence: number) => ({
      sequence,
      receivedAt: new Date("2026-08-17T18:00:00.000Z"),
      monotonicReceivedAtMs: sequence,
      eventType: "STATUS" as const,
      connectionState: "SELECTED",
      activeCommand: "IDLE"
    });

    const firstWait = opened.session.wait();
    await vi.waitFor(() => expect(client.idleStarted).toBe(true));
    client.emit("status", {
      path: "Archive",
      unseen: 2,
      highestModseq: 21n,
      notifySignal: signal(20)
    });
    await expect(firstWait).resolves.toMatchObject({ status: "wake" });

    client.emit("status", {
      path: "Projects",
      unseen: 3,
      highestModseq: 31n,
      notifySignal: signal(21)
    });
    const handled = opened.session.syncClient.peekMailboxChanges?.() ?? [];
    opened.session.syncClient.acknowledgeMailboxChanges?.(handled);

    const firstIdleFinish = client.finishIdle;
    const secondWait = opened.session.wait();
    await vi.waitFor(() => expect(traces).toHaveBeenCalledWith(expect.objectContaining({
      stage: "handoff",
      signal: expect.objectContaining({ sequence: 21 }),
      result: "coalesced",
      reason: "covered_by_reconciliation"
    })));
    await vi.waitFor(() => expect(client.finishIdle).not.toBe(firstIdleFinish));
    client.finishIdle!(true);
    await expect(secondWait).resolves.toEqual({ status: "renew" });
    opened.session.close();
  });

  it("records a parser-root NOTIFY signal that does not change the folder snapshot", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const traces = vi.fn();
    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"],
      onNotifyTrace: traces
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    const receivedAt = new Date("2026-08-17T18:00:00.000Z");
    const notifySignal = {
      sequence: 8,
      receivedAt,
      monotonicReceivedAtMs: 13,
      eventType: "STATUS",
      connectionState: "SELECTED",
      activeCommand: "IDLE"
    } as const;

    client.emit("notifyResponse", notifySignal);
    client.emit("status", {
      ...client.statuses.get("Archive"),
      notifySignal
    });

    expect(traces).toHaveBeenCalledWith(expect.objectContaining({
      stage: "handoff",
      signal: notifySignal,
      folderPath: "Archive",
      result: "ignored",
      reason: "unchanged"
    }));
    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([]);
    opened.session.close();
  });

  it("does not let a NOTIFY observer failure block a mailbox wake", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"],
      onNotifyTrace: () => { throw new Error("telemetry failed"); }
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");

    const wait = opened.session.wait();
    await vi.waitFor(() => expect(client.idleStarted).toBe(true));
    client.emit("status", {
      path: "Archive",
      highestModseq: 21n,
      notifySignal: {
        sequence: 9,
        receivedAt: new Date(),
        monotonicReceivedAtMs: 14,
        eventType: "STATUS",
        connectionState: "SELECTED",
        activeCommand: "IDLE"
      }
    });

    await expect(wait).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Archive", notifySignal: { sequence: 9 } }
    });
    opened.session.close();
  });

  it("delivers a NOTIFY status received while Inbox selection is in flight", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    client.mailboxOpen.mockImplementationOnce(async () => {
      client.emit("status", { path: "Archive", highestModseq: 21n });
      return {};
    });

    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { kind: "flags", folderPath: "Archive" }
    });
    expect(client.idleStarted).toBe(false);
    opened.session.close();
  });

  it("ignores NOTIFY status for a path outside the tracked set", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");

    client.emit("status", { path: "Provider/Ghost", uidNext: 2, messages: 1 });

    expect(opened.session.syncClient.peekMailboxChanges?.()).toEqual([]);
    opened.session.close();
  });

  it("aborts a stalled NOTIFY command and closes the provider session", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.notify.mockImplementationOnce(async () => await new Promise<never>(() => undefined));
    const controller = new AbortController();
    const opening = openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true
    }) as never, account, {
      signal: controller.signal,
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    await vi.waitFor(() => expect(client.notify).toHaveBeenCalledTimes(1));

    controller.abort(new DOMException("stop", "AbortError"));

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("falls back after NOTIFICATIONOVERFLOW and marks every tracked folder dirty", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.capabilities.set("LIST-STATUS", true);
    for (const [path, uidValidity] of [["Archive", 2n], ["Projects", 3n]] as const) {
      client.statuses.set(path, {
        path,
        uidValidity,
        uidNext: 11,
        messages: 10,
        unseen: 1,
        highestModseq: 20n
      });
    }
    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true,
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive", "Projects"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");

    client.emit("notificationOverflow");

    expect(opened.session.folderProbeStrategy).toBe("list_status");
    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "INBOX" }
    });
    const overflowChanges = opened.session.syncClient.peekMailboxChanges?.() ?? [];
    expect(overflowChanges).toEqual([
      expect.objectContaining({ path: "INBOX", forceReconcile: true, forceFlagScan: true }),
      expect.objectContaining({ path: "Archive", forceReconcile: true, forceFlagScan: true }),
      expect.objectContaining({ path: "Projects", forceReconcile: true, forceFlagScan: true })
    ]);
    opened.session.syncClient.acknowledgeMailboxChanges?.(overflowChanges.slice(0, 1));
    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Archive" }
    });
    opened.session.syncClient.acknowledgeMailboxChanges?.(overflowChanges.slice(1));
    await expect(opened.session.wait()).resolves.toEqual({ status: "disconnected" });
    expect(client.close).toHaveBeenCalledTimes(1);
    opened.session.close();
  });

  it("falls back to LIST-STATUS when the NOTIFY command is rejected", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("NOTIFY", true);
    client.capabilities.set("LIST-STATUS", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    client.notify.mockRejectedValueOnce(new Error("NOTIFY rejected"));

    const opened = await openInboxIdleSession(pool, Object.assign({}, config, {
      IMAP_NOTIFY_ENABLED: true,
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("list_status");
    expect(client.notify).toHaveBeenCalledTimes(1);
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.status).not.toHaveBeenCalled();
    opened.session.close();
  });

  it("does not enumerate provider folders when no non-Inbox folder is tracked", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("LIST-STATUS", true);
    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => []
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(client.list).not.toHaveBeenCalled();
    expect(client.status).not.toHaveBeenCalled();
    opened.session.close();
  });

  it("uses LIST-STATUS when IMAP4rev2 is the base protocol", async () => {
    const client = new FakeIdleClient();
    client.capabilities.delete("IDLE");
    client.capabilities.set("IMAP4rev2", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("list_status");
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.status).not.toHaveBeenCalled();
    opened.session.close();
  });

  it("rejects incomplete LIST-STATUS fields and latches bounded STATUS", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("LIST-STATUS", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    client.list.mockResolvedValueOnce([{
      path: "Archive",
      status: { path: "Archive", uidValidity: 2n }
    }] as never);
    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("status");
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.status).toHaveBeenCalledTimes(1);
    opened.session.close();
  });

  it("falls back to bounded STATUS when LIST-STATUS omits a tracked snapshot", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("LIST-STATUS", true);
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
    const partial = [{
      path: "Archive",
      status: client.statuses.get("Archive")!
    }];
    client.list.mockResolvedValueOnce(partial).mockResolvedValueOnce(partial);
    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive", "Projects"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("status");
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(client.status).toHaveBeenCalledTimes(1);

    client.statuses.set("Projects", {
      path: "Projects",
      uidValidity: 3n,
      uidNext: 6,
      messages: 5,
      unseen: 1,
      highestModseq: 9n
    });
    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Projects" }
    });
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(client.status).toHaveBeenCalledTimes(3);
    opened.session.close();
  });

  it("retries a partial exact-pattern LIST-STATUS response with one wildcard command", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("LIST-STATUS", true);
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
    client.list.mockResolvedValueOnce([{
      path: "Archive",
      status: client.statuses.get("Archive")!
    }]);
    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive", "Projects"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("list_status");
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(client.list).toHaveBeenNthCalledWith(2, expect.objectContaining({
      mailboxPatterns: ["*"]
    }));
    expect(client.status).not.toHaveBeenCalled();
    opened.session.close();
  });

  it("uses bounded STATUS when a legal mailbox name contains a LIST wildcard", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("LIST-STATUS", true);
    client.statuses.set("Project *", {
      path: "Project *",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1
    });
    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Project *"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("status");
    expect(client.list).not.toHaveBeenCalled();
    expect(client.status).toHaveBeenCalledWith("Project *", expect.any(Object));
    opened.session.close();
  });

  it("latches bounded STATUS after ImapFlow falls back from rejected LIST-STATUS", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("LIST-STATUS", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    client.list.mockImplementationOnce(async () => {
      client.skipListStatusArgs = true;
      return [...client.statuses.values()].map((status) => ({ path: status.path, status }));
    });

    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("status");
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.status).toHaveBeenCalledTimes(1);

    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 12,
      messages: 11,
      unseen: 2,
      highestModseq: 21n
    });
    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Archive" }
    });
    expect(client.list).toHaveBeenCalledTimes(1);
    opened.session.close();
  });

  it("latches bounded STATUS after a transient LIST-STATUS failure", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("LIST-STATUS", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    client.list.mockRejectedValueOnce(new Error("LIST-STATUS rejected"));

    const opened = await openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("session was not ready");
    expect(opened.session.folderProbeStrategy).toBe("status");
    expect(client.list).toHaveBeenCalledTimes(1);

    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 12,
      messages: 11,
      unseen: 2,
      highestModseq: 21n
    });
    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { folderPath: "Archive" }
    });
    expect(client.list).toHaveBeenCalledTimes(1);
    opened.session.close();
  });

  it("rejects initialization when LIST-STATUS leaves the connection unusable", async () => {
    const client = new FakeIdleClient();
    client.capabilities.set("LIST-STATUS", true);
    client.statuses.set("Archive", {
      path: "Archive",
      uidValidity: 2n,
      uidNext: 11,
      messages: 10,
      unseen: 1,
      highestModseq: 20n
    });
    client.list.mockImplementationOnce(async () => {
      client.usable = false;
      throw new Error("connection closed during LIST-STATUS");
    });

    await expect(openInboxIdleSession(pool, Object.assign({}, fastStatusConfig, {
      IMAP_LIST_STATUS_ENABLED: true
    }) as never, account, {
      clientFactory: async () => client,
      folderPathsFactory: async () => ["Archive"]
    })).rejects.toThrow("connection closed during LIST-STATUS");
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.status).not.toHaveBeenCalled();
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
