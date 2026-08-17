import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { ImapFlow } from "imapflow";
import { describe, expect, it, vi } from "vitest";

const requireFromTest = createRequire(import.meta.url);
const imapflowEntry = requireFromTest.resolve("imapflow");
const runNotifyCommand = requireFromTest(
  resolve(dirname(imapflowEntry), "commands/notify.js")
) as (
  connection: Record<string, unknown>,
  mailboxes: string[]
) => Promise<Array<Record<string, unknown>> | false>;
const runStatusCommand = requireFromTest(
  resolve(dirname(imapflowEntry), "commands/status.js")
) as (
  connection: Record<string, unknown>,
  path: string,
  query: Record<string, boolean>
) => Promise<Record<string, unknown> | false>;
const runFetchCommand = requireFromTest(
  resolve(dirname(imapflowEntry), "commands/fetch.js")
) as (
  connection: Record<string, unknown>,
  range: string,
  query: Record<string, unknown>,
  options: Record<string, unknown>
) => Promise<{ count: number; list: Array<Record<string, unknown>> }>;
const { compiler, parser } = requireFromTest(
  resolve(dirname(imapflowEntry), "handler/imap-handler.js")
) as {
  compiler(value: unknown): Promise<Buffer>;
  parser(value: string, options?: { literals?: Buffer[] }): Promise<unknown>;
};

function notifyConnection(exec: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return {
    states: { AUTHENTICATED: "AUTHENTICATED", SELECTED: "SELECTED" },
    state: "AUTHENTICATED",
    capabilities: new Map([["NOTIFY", true], ["IMAP4rev1", true]]),
    enabled: new Set(),
    namespace: { delimiter: "/", prefix: "" },
    exec
  };
}

describe("patched ImapFlow NOTIFY command", () => {
  it("registers selected and explicit mailbox message events with initial STATUS", async () => {
    let wire = "";
    const exec = vi.fn(async (
      command: string,
      attributes: unknown[],
      options: { untagged: { STATUS(response: unknown): Promise<void> } }
    ) => {
      wire = (await compiler({ tag: "A1", command, attributes })).toString();
      await options.untagged.STATUS({
        attributes: [
          { value: "Archive" },
          [
            { value: "UIDVALIDITY" }, { value: "4" },
            { value: "UIDNEXT" }, { value: "10" },
            { value: "MESSAGES" }, { value: "5" },
            { value: "HIGHESTMODSEQ" }, { value: "7" }
          ]
        ]
      });
      return { next: vi.fn() };
    });

    const result = await runNotifyCommand(
      notifyConnection(exec),
      ["Archive", "Projects"]
    );

    expect(wire).toBe(
      "A1 NOTIFY SET STATUS (SELECTED (MessageNew MessageExpunge FlagChange)) "
      + "(MAILBOXES (Archive Projects) (MessageNew MessageExpunge FlagChange))"
    );
    expect(result).toEqual([{
      path: "Archive",
      uidValidity: 4n,
      uidNext: 10,
      messages: 5,
      highestModseq: 7n
    }]);
  });

  it("emits unsolicited STATUS and NOTIFICATIONOVERFLOW events", async () => {
    const client = new ImapFlow({
      host: "imap.example.test",
      port: 993,
      secure: true,
      auth: { user: "test", pass: "test" },
      logger: false
    });
    Object.assign(client, {
      enabled: new Set(),
      namespace: { delimiter: "/", prefix: "" }
    });
    const status = vi.fn();
    const response = vi.fn();
    const overflow = vi.fn();
    const events = client as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): void;
    };
    events.on("status", status);
    events.on("notifyResponse", response);
    events.on("notificationOverflow", overflow);
    const internal = client as unknown as {
      untaggedStatus(response: unknown): Promise<void>;
      sectionNotificationOverflow(): Promise<void>;
    };

    await internal.untaggedStatus({
      attributes: [
        { value: "Archive" },
        [{ value: "UIDNEXT" }, { value: "11" }, { value: "MESSAGES" }, { value: "6" }]
      ]
    });
    await internal.untaggedStatus({
      attributes: [
        { value: "Projects" },
        [{ value: "UIDNEXT" }, { value: "3" }, { value: "MESSAGES" }, { value: "2" }]
      ]
    });
    await internal.sectionNotificationOverflow();

    expect(response).toHaveBeenNthCalledWith(1, {
      sequence: 1,
      receivedAt: expect.any(Date),
      monotonicReceivedAtMs: expect.any(Number),
      eventType: "STATUS",
      connectionState: "NOT_AUTHENTICATED",
      activeCommand: "NONE"
    });
    expect(response).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sequence: 2,
      eventType: "STATUS"
    }));
    expect(response).toHaveBeenNthCalledWith(3, expect.objectContaining({
      sequence: 3,
      eventType: "NOTIFICATIONOVERFLOW"
    }));

    expect(status).toHaveBeenNthCalledWith(1, {
      path: "Archive",
      uidNext: 11,
      messages: 6,
      notifySignal: {
        sequence: 1,
        receivedAt: expect.any(Date),
        monotonicReceivedAtMs: expect.any(Number),
        eventType: "STATUS",
        connectionState: "NOT_AUTHENTICATED",
        activeCommand: "NONE"
      }
    });
    expect(status).toHaveBeenNthCalledWith(2, {
      path: "Projects",
      uidNext: 3,
      messages: 2,
      notifySignal: {
        sequence: 2,
        receivedAt: expect.any(Date),
        monotonicReceivedAtMs: expect.any(Number),
        eventType: "STATUS",
        connectionState: "NOT_AUTHENTICATED",
        activeCommand: "NONE"
      }
    });
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it("classifies raw EXISTS, EXPUNGE, and FETCH-flags responses", async () => {
    const client = new ImapFlow({
      host: "imap.example.test",
      port: 993,
      secure: true,
      auth: { user: "test", pass: "test" },
      logger: false
    });
    Object.assign(client, {
      state: 3,
      mailbox: {
        path: "INBOX",
        exists: 2,
        uidValidity: 1n,
        flags: new Set<string>(),
        permanentFlags: new Set<string>(),
        noModseq: true
      }
    });
    const response = vi.fn();
    (client as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): void;
    }).on("notifyResponse", response);
    const internal = client as unknown as {
      untaggedExists(response: unknown): Promise<void>;
      untaggedExpunge(response: unknown): Promise<void>;
      untaggedFetch(response: unknown): Promise<void>;
    };

    await internal.untaggedExists(await parser("* 3 EXISTS"));
    await internal.untaggedExpunge(await parser("* 2 EXPUNGE"));
    await internal.untaggedFetch(await parser("* 1 FETCH (UID 11 FLAGS (\\Seen))"));
    await internal.untaggedFetch(await parser(
      "* 1 FETCH (UID 11 BODY[] {5}\r\n)",
      { literals: [Buffer.from("HELLO")] }
    ));

    expect(response.mock.calls.map(([signal]) => ({
      sequence: (signal as { sequence: number }).sequence,
      eventType: (signal as { eventType: string }).eventType,
      connectionState: (signal as { connectionState: string }).connectionState
    }))).toEqual([
      { sequence: 1, eventType: "EXISTS", connectionState: "SELECTED" },
      { sequence: 2, eventType: "EXPUNGE", connectionState: "SELECTED" },
      { sequence: 3, eventType: "FETCH_FLAGS", connectionState: "SELECTED" }
    ]);
  });

  it("does not let an unsolicited NOTIFY status corrupt a concurrent STATUS command", async () => {
    const unsolicited = vi.fn(async () => undefined);
    const exec = vi.fn(async (
      _command: string,
      _attributes: unknown[],
      options: { untagged: { STATUS(response: unknown): Promise<void> } }
    ) => {
      await options.untagged.STATUS({
        attributes: [
          { value: "Archive" },
          [{ value: "UIDNEXT" }, { value: "11" }, { value: "MESSAGES" }, { value: "6" }]
        ]
      });
      return { next: vi.fn() };
    });
    const connection = {
      states: { AUTHENTICATED: "AUTHENTICATED", SELECTED: "SELECTED" },
      state: "AUTHENTICATED",
      capabilities: new Map([["IMAP4rev1", true]]),
      enabled: new Set(),
      namespace: { delimiter: "/", prefix: "" },
      mailbox: false,
      exec,
      untaggedStatus: unsolicited,
      log: { warn: vi.fn() }
    };

    const result = await runStatusCommand(connection, "INBOX", { messages: true, uidNext: true });

    expect(result).toEqual({ path: "INBOX" });
    expect(unsolicited).toHaveBeenCalledTimes(1);
  });

  it("routes a flags-only NOTIFY FETCH away from a concurrent content FETCH", async () => {
    const unsolicited = vi.fn(async () => undefined);
    const exec = vi.fn(async (
      _command: string,
      _attributes: unknown[],
      options: { untagged: { FETCH(response: unknown): Promise<void> } }
    ) => {
      await options.untagged.FETCH(await parser("* 2 FETCH (UID 22 FLAGS (\\Seen))"));
      await options.untagged.FETCH(await parser(
        "* 1 FETCH (UID 11 BODY[] {5}\r\n)",
        { literals: [Buffer.from("HELLO")] }
      ));
      return { next: vi.fn() };
    });
    const connection = {
      states: { SELECTED: "SELECTED" },
      state: "SELECTED",
      mailbox: { path: "INBOX", uidValidity: 1n, noModseq: true },
      capabilities: new Map<string, boolean>(),
      enabled: new Set<string>(),
      exec,
      untaggedFetch: unsolicited,
      log: { warn: vi.fn() }
    };

    const result = await runFetchCommand(connection, "11", { source: true }, { uid: true });

    expect(unsolicited).toHaveBeenCalledTimes(1);
    expect(result.count).toBe(1);
    expect(result.list).toEqual([
      expect.objectContaining({ uid: 11, source: Buffer.from("HELLO") })
    ]);
  });

  it("routes a NOTIFY FETCH outside a UID-only command's sequence set", async () => {
    const unsolicited = vi.fn(async () => undefined);
    const exec = vi.fn(async (
      _command: string,
      _attributes: unknown[],
      options: { untagged: { FETCH(response: unknown): Promise<void> } }
    ) => {
      await options.untagged.FETCH(await parser("* 2 FETCH (UID 22 FLAGS (\\Seen))"));
      await options.untagged.FETCH(await parser("* 1 FETCH (UID 11)"));
      return { next: vi.fn() };
    });
    const connection = {
      states: { SELECTED: "SELECTED" },
      state: "SELECTED",
      mailbox: { path: "INBOX", uidValidity: 1n, uidNext: 23, noModseq: true },
      capabilities: new Map<string, boolean>(),
      enabled: new Set<string>(),
      exec,
      untaggedFetch: unsolicited,
      log: { warn: vi.fn() }
    };

    const result = await runFetchCommand(connection, "11", { uid: true }, { uid: true });

    expect(unsolicited).toHaveBeenCalledTimes(1);
    expect(result.list).toEqual([expect.objectContaining({ uid: 11 })]);
  });
});
