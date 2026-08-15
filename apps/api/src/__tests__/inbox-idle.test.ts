import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openInboxIdleSession, waitForInboxIdleWake } from "../inbox-idle.js";
import type { ImapAccount } from "../types.js";

class FakeIdleClient extends EventEmitter {
  capabilities = new Map<string, boolean | number>([["IDLE", true]]);
  enabled = new Set<string>();
  mailboxOpen = vi.fn(async () => ({}));
  logout = vi.fn(async () => undefined);
  close = vi.fn(() => this.emit("close"));
  idleStarted = false;
  finishIdle: ((value: boolean) => void) | null = null;

  async idle(): Promise<boolean> {
    this.idleStarted = true;
    return await new Promise<boolean>((resolve) => {
      this.finishIdle = resolve;
    });
  }
}

const account = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as ImapAccount;
const config = {} as never;
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
    client.emit("exists", { path: "INBOX", count: 2, prevCount: 1 });

    await expect(wait).resolves.toMatchObject({ status: "wake" });
    expect(client.close).not.toHaveBeenCalled();
    expect(opened.session.syncClient).toBeDefined();
    client.emit("flags", { path: "INBOX", seq: 2, uid: 20 });
    client.emit("flags", { path: "INBOX", seq: 3, uid: 21 });
    await expect(opened.session.wait()).resolves.toMatchObject({
      status: "wake",
      wake: { kind: "flags", sequence: 3, uid: 21 }
    });
    opened.session.close();
    expect(client.close).toHaveBeenCalledTimes(1);
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
