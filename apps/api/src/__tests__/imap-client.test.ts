import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import {
  fetchFullMessageBody,
  fetchFullMessageBodyBatch,
  fetchChangedMessageFlags,
  fetchMessageFlags,
  fetchMessageMetadata,
  MessageMovedError,
  parseMessageMetadata,
  providerObjectIdNamespace,
  searchAllUids,
  searchUidsBefore,
  searchUidsSince,
  ThrottledImapClient,
  type FetchMessage,
  type MirrorImapClient
} from "../imap-client.js";
import { FixtureImapClient, makeTextMessage } from "../smoke/fixture-imap.js";
import { MAX_SYNC_METADATA_FETCH_BYTES } from "../sync-limits.js";
import type { ImapMessage } from "../types.js";

describe("fetchMessageMetadata", () => {
  it("keeps provider delivery/thread ids with explicit capability provenance", () => {
    expect(providerObjectIdNamespace(new Map([["OBJECTID", true]]))).toBe("objectid");
    expect(providerObjectIdNamespace(new Map([["X-GM-EXT-1", true]]))).toBe("gmail");
    expect(providerObjectIdNamespace(new Map())).toBeNull();

    const parsed = parseMessageMetadata(
      {
        uid: 7,
        emailId: "provider-message-7",
        threadId: "provider-thread-2",
        envelope: { messageId: "<m7@example.test>" },
        internalDate: new Date("2026-01-01T00:00:00.000Z")
      },
      "objectid"
    );

    expect(parsed).toMatchObject({
      providerMessageId: "provider-message-7",
      providerMessageIdNamespace: "objectid",
      providerThreadId: "provider-thread-2",
      providerThreadIdNamespace: "objectid"
    });
  });

  it("stores embedded-message MIME dates as exact JSON text", () => {
    const internalDate = new Date("2026-08-12T17:00:00.123Z");
    const embeddedDate = new Date("2026-08-11T09:08:07.654Z");
    const parsed = parseMessageMetadata({
      uid: 8,
      internalDate,
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          { type: "text/plain" },
          {
            type: "message/rfc822",
            envelope: { date: embeddedDate }
          }
        ]
      }
    });

    expect(parsed.internalDate).toBe(internalDate);
    expect(parsed.mimeStructure).toEqual({
      type: "multipart/mixed",
      childNodes: [
        { type: "text/plain" },
        {
          type: "message/rfc822",
          envelope: { date: "2026-08-11T09:08:07.654Z" }
        }
      ]
    });
    expect(embeddedDate).toEqual(new Date("2026-08-11T09:08:07.654Z"));
  });

  it("rejects MIME metadata that cannot be stored as JSON", () => {
    expect(() => parseMessageMetadata({
      uid: 9,
      bodyStructure: { parameters: new Map([["charset", "utf-8"]]) }
    })).toThrow("IMAP MIME metadata contains a non-JSON object");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseMessageMetadata({ uid: 10, bodyStructure: cyclic }))
      .toThrow("IMAP MIME metadata contains a cycle");
  });

  it("fails instead of advancing past a partial UID batch", async () => {
    const client = new FixtureImapClient([
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 1,
        messages: [
          makeTextMessage({ uid: 1, subject: "a", from: "a@example.test", to: "b@example.test", body: "a" })
        ]
      }
    ]);
    const lock = await client.getMailboxLock("INBOX");
    try {
      await expect(fetchMessageMetadata(client, [1, 2], 50)).rejects.toThrow(/missing 2/);
    } finally {
      lock.release();
    }
  });

  it("enforces per-command IMAP timeouts by closing the client", async () => {
    const source = await readFile(resolve(process.cwd(), "src/imap-client.ts"), "utf8");

    expect(source).toContain("withCommandTimeout");
    expect(source).toContain("IMAP_COMMAND_TIMEOUT_MS exceeded");
    expect(source).toContain("this.client.close()");
  });

  it("marks a command-timed-out client unusable", async () => {
    vi.useFakeTimers();
    try {
      const rawClient = Object.assign(new EventEmitter(), {
        mailbox: false,
        usable: true,
        capabilities: new Map<string, boolean | number>(),
        close: vi.fn(() => undefined),
        getMailboxLock: vi.fn(async () => await new Promise<never>(() => undefined))
      });
      const client = new ThrottledImapClient(rawClient as never, 60, 10);
      const pending = client.getMailboxLock("INBOX");
      const rejected = expect(pending).rejects.toThrow(
        "IMAP_COMMAND_TIMEOUT_MS exceeded during getMailboxLock"
      );

      await vi.advanceTimersByTimeAsync(11);

      await rejected;
      expect(rawClient.close).toHaveBeenCalledTimes(1);
      expect(client.usable).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send LOGOUT after a command timeout invalidated the client", async () => {
    vi.useFakeTimers();
    try {
      const rawClient = Object.assign(new EventEmitter(), {
        mailbox: false,
        usable: true,
        capabilities: new Map<string, boolean | number>(),
        close: vi.fn(() => undefined),
        logout: vi.fn(async () => await new Promise<never>(() => undefined)),
        getMailboxLock: vi.fn(async () => await new Promise<never>(() => undefined))
      });
      const client = new ThrottledImapClient(rawClient as never, 60, 10);
      const timedOut = client.getMailboxLock("INBOX").catch(() => undefined);
      await vi.advanceTimersByTimeAsync(11);
      await timedOut;

      let loggedOut = false;
      const logout = client.logout().then(
        () => { loggedOut = true; },
        () => { loggedOut = false; }
      );
      await Promise.resolve();

      expect(loggedOut).toBe(true);
      expect(rawClient.logout).not.toHaveBeenCalled();
      await logout;
    } finally {
      await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();
    }
  });

  it("handles non-contiguous UID search results across date boundaries", async () => {
    const client = new FixtureImapClient([
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 1,
        messages: [
          makeTextMessage({
            uid: 1,
            subject: "old",
            from: "a@example.test",
            to: "b@example.test",
            body: "old",
            internalDate: new Date("2026-01-01T00:00:00.000Z")
          }),
          makeTextMessage({
            uid: 7,
            subject: "middle",
            from: "a@example.test",
            to: "b@example.test",
            body: "middle",
            internalDate: new Date("2026-02-01T00:00:00.000Z")
          }),
          makeTextMessage({
            uid: 42,
            subject: "new",
            from: "a@example.test",
            to: "b@example.test",
            body: "new",
            internalDate: new Date("2026-03-01T00:00:00.000Z")
          })
        ]
      }
    ]);
    const lock = await client.getMailboxLock("INBOX");
    try {
      await expect(searchAllUids(client)).resolves.toEqual([1, 7, 42]);
      await expect(searchUidsSince(client, new Date("2026-02-01T00:00:00.000Z"))).resolves.toEqual([7, 42]);
      await expect(searchUidsBefore(client, new Date("2026-02-01T00:00:00.000Z"))).resolves.toEqual([1]);
      await expect(searchUidsSince(client, new Date("2026-01-01T00:00:00.000Z"), "2:40")).resolves.toEqual([7]);
    } finally {
      lock.release();
    }
  });
});

describe("fetchFullMessageBody mailbox locking", () => {
  const bodyConfig = { BODY_RAW_MAX_BYTES: 25 * 1024 * 1024 } as unknown as AppConfig;
  const notesMessage = {
    id: "m1",
    account_id: "a1",
    uid: 1273,
    folder_path: "INBOX.Notes",
    uidvalidity: 1,
    mime_structure: null,
    headers_json: {}
  } as unknown as ImapMessage;

  const notesClient = () =>
    new FixtureImapClient([
      {
        path: "INBOX.Notes",
        delimiter: ".",
        specialUse: undefined,
        uidValidity: 1,
        messages: [
          makeTextMessage({ uid: 1273, subject: "Open AI", from: "a@example.test", to: "b@example.test", body: "note" })
        ]
      }
    ]);

  const countLocks = (client: FixtureImapClient) => {
    let calls = 0;
    const original = client.getMailboxLock.bind(client);
    client.getMailboxLock = async (path: string) => {
      calls += 1;
      return original(path);
    };
    return () => calls;
  };

  it("acquires the mailbox lock by default", async () => {
    const client = notesClient();
    const locks = countLocks(client);
    const body = await fetchFullMessageBody(client, bodyConfig, notesMessage);
    expect(locks()).toBe(1);
    expect(body.rawBytes).toBeGreaterThan(0);
  });

  it("marks structured evidence incomplete instead of trusting a truncated MIME fetch", async () => {
    const client = notesClient();
    const body = await fetchFullMessageBody(
      client,
      { BODY_RAW_MAX_BYTES: 64 } as unknown as AppConfig,
      notesMessage
    );

    expect(body.rawTruncated).toBe(true);
    expect(body.evidence).toEqual([]);
    expect(body.parserWarnings).toContain("artifact_evidence_omitted_raw_truncated");
  });

  it("streams parsed-only MIME without requesting or retaining a source buffer", async () => {
    const fixture = makeTextMessage({
      uid: 1273,
      subject: "Stream me",
      from: "a@example.test",
      to: "b@example.test",
      body: "parsed-only body"
    });
    const client = new FixtureImapClient([{
      path: "INBOX.Notes",
      delimiter: ".",
      uidValidity: 1,
      messages: [fixture]
    }]);
    const fetchOne = vi.spyOn(client, "fetchOne");
    const download = vi.spyOn(client, "download");

    const body = await fetchFullMessageBody(
      client,
      {
        BODY_RAW_MAX_BYTES: 25 * 1024 * 1024,
        BODY_STORAGE_MODE: "parsed_only"
      } as unknown as AppConfig,
      notesMessage
    );

    expect(fetchOne).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith("1273", undefined, {
      uid: true,
      maxBytes: 25 * 1024 * 1024,
      chunkSize: 1024 * 1024
    });
    expect(body.rawMime).toHaveLength(0);
    expect(body.rawBytes).toBe(fixture.raw.length);
    expect(body.rawMimeSha256).toBe(createHash("sha256").update(fixture.raw).digest("hex"));
    expect(body.bodyText).toContain("parsed-only body");
  });

  it("treats a known complete parsed-only source at the byte cap consistently", async () => {
    const fixtures = [1273, 1274].map((uid) => makeTextMessage({
      uid,
      subject: "Exact cap",
      from: "a@example.test",
      to: "b@example.test",
      body: "exact-cap-body"
    }));
    const rows = fixtures.map((fixture) => ({
      ...notesMessage,
      id: `m${fixture.uid}`,
      uid: String(fixture.uid),
      size_bytes: fixture.raw.length,
      mime_structure: fixture.bodyStructure
    }));
    const config = {
      BODY_RAW_MAX_BYTES: fixtures[0].raw.length,
      BODY_STORAGE_MODE: "parsed_only"
    } as unknown as AppConfig;

    const individual = await fetchFullMessageBody(
      new FixtureImapClient([{
        path: "INBOX.Notes",
        delimiter: ".",
        uidValidity: 1,
        messages: [fixtures[0]]
      }]),
      config,
      rows[0]
    );
    const batch = await fetchFullMessageBodyBatch(
      new FixtureImapClient([{
        path: "INBOX.Notes",
        delimiter: ".",
        uidValidity: 1,
        messages: fixtures
      }]),
      config,
      rows
    );

    expect(individual.rawTruncated).toBe(false);
    expect(batch.bodies.map(({ body }) => body.rawTruncated)).toEqual([false, false]);
  });

  it("reuses the selected mailbox without re-locking when skipMailboxLock is set (no nested-lock deadlock)", async () => {
    const client = notesClient();
    await client.getMailboxLock("INBOX.Notes"); // caller already holds the lock
    const locks = countLocks(client);
    const body = await fetchFullMessageBody(client, bodyConfig, notesMessage, { skipMailboxLock: true });
    expect(locks()).toBe(0);
    expect(body.messageId).toBe("m1");
    expect(body.rawBytes).toBeGreaterThan(0);
  });

  it("throws when skipMailboxLock is set but the wrong folder is selected", async () => {
    const client = new FixtureImapClient([
      {
        path: "INBOX",
        delimiter: ".",
        specialUse: "\\Inbox",
        uidValidity: 1,
        messages: [makeTextMessage({ uid: 1, subject: "x", from: "a@example.test", to: "b@example.test", body: "x" })]
      },
      {
        path: "INBOX.Notes",
        delimiter: ".",
        specialUse: undefined,
        uidValidity: 1,
        messages: [makeTextMessage({ uid: 1273, subject: "n", from: "a@example.test", to: "b@example.test", body: "n" })]
      }
    ]);
    await client.getMailboxLock("INBOX"); // wrong folder selected
    await expect(
      fetchFullMessageBody(client, bodyConfig, notesMessage, { skipMailboxLock: true })
    ).rejects.toThrow(/expected INBOX\.Notes to be selected/);
  });

  it("throws MessageMovedError when the UID is gone from the folder (moved/deleted)", async () => {
    // INBOX.Notes is still present and selectable, but no longer contains uid 1273 —
    // a filter moved it, or it was deleted, between metadata sync and this body fetch.
    // fetchOne returns false; without the guard the download fallback would stream
    // `false.content` and crash, bricking the account. It must be a benign MovedError.
    const client = new FixtureImapClient([
      {
        path: "INBOX.Notes",
        delimiter: ".",
        specialUse: undefined,
        uidValidity: 1,
        messages: [
          makeTextMessage({ uid: 9999, subject: "other", from: "a@example.test", to: "b@example.test", body: "x" })
        ]
      }
    ]);
    await expect(
      fetchFullMessageBody(client, bodyConfig, notesMessage)
    ).rejects.toBeInstanceOf(MessageMovedError);
  });

  it("throws MessageMovedError for a gone parsed-only UID without a preflight FETCH", async () => {
    const client = new FixtureImapClient([{
      path: "INBOX.Notes",
      delimiter: ".",
      uidValidity: 1,
      messages: []
    }]);

    await expect(fetchFullMessageBody(
      client,
      {
        BODY_RAW_MAX_BYTES: 25 * 1024 * 1024,
        BODY_STORAGE_MODE: "parsed_only"
      } as unknown as AppConfig,
      notesMessage
    )).rejects.toBeInstanceOf(MessageMovedError);
  });
});

describe("ThrottledImapClient fetch cancellation", () => {
  it("disables ImapFlow's hidden per-mailbox STATUS fallback", async () => {
    const list = vi.fn(async () => [{
      path: "Archive",
      status: {
        path: "Archive",
        uidValidity: 2n,
        uidNext: 11,
        messages: 10,
        unseen: 1
      }
    }]);
    const client = new ThrottledImapClient({ list } as never, 1_000, 1_000);

    await expect(client.listWithStatus({ messages: true }, ["Archive"])).resolves.toHaveLength(1);
    expect(list).toHaveBeenCalledWith({
      statusQuery: { messages: true },
      statusFallback: false,
      mailboxPatterns: ["Archive"],
      statusOnly: true,
      returnOptionFallback: false,
      cache: false
    });
  });

  it("forwards the mailbox-change limit to the durable feed", () => {
    const peek = vi.fn(() => []);
    const client = new ThrottledImapClient(
      {} as never,
      1_000,
      1_000,
      undefined,
      { peek, acknowledge: vi.fn() }
    );

    expect(client.peekMailboxChanges(2)).toEqual([]);
    expect(peek).toHaveBeenCalledWith(2);
  });

  it("forwards an early consumer return to the underlying IMAP iterator", async () => {
    const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }));
    const rawIterator = {
      next: vi.fn(async () => ({ done: false, value: { uid: 1 } })),
      return: iteratorReturn,
      [Symbol.asyncIterator]() {
        return this;
      }
    };
    const rawClient = {
      fetch: vi.fn(() => rawIterator),
      close: vi.fn()
    };
    const client = new ThrottledImapClient(
      rawClient as never,
      1_000,
      1_000
    );

    for await (const _message of client.fetch([1, 2], { source: true }, { uid: true })) {
      break;
    }

    expect(iteratorReturn).toHaveBeenCalledOnce();
    expect(rawClient.close).not.toHaveBeenCalled();
  });

  it("closes the connection when the underlying iterator cannot cancel", async () => {
    const rawIterator = {
      next: vi.fn(async () => ({ done: false, value: { uid: 1 } })),
      return: vi.fn(async () => {
        throw new Error("cancel failed");
      }),
      [Symbol.asyncIterator]() {
        return this;
      }
    };
    const rawClient = {
      fetch: vi.fn(() => rawIterator),
      close: vi.fn()
    };
    const client = new ThrottledImapClient(
      rawClient as never,
      1_000,
      1_000
    );

    for await (const _message of client.fetch([1, 2], { source: true }, { uid: true })) {
      break;
    }

    expect(rawClient.close).toHaveBeenCalledOnce();
  });

  it("does not wait for iterator cancellation after the fetch command timed out", async () => {
    vi.useFakeTimers();
    const rawIterator = {
      next: vi.fn(async () => await new Promise<never>(() => undefined)),
      return: vi.fn(async () => await new Promise<never>(() => undefined)),
      [Symbol.asyncIterator]() {
        return this;
      }
    };
    const rawClient = {
      usable: true,
      fetch: vi.fn(() => rawIterator),
      close: vi.fn()
    };
    const client = new ThrottledImapClient(rawClient as never, 1_000, 10);
    let outcome: string | undefined;
    const next = client.fetch([1], { source: true }, { uid: true })
      [Symbol.asyncIterator]().next()
      .then(
        () => { outcome = "resolved"; },
        (error: Error) => { outcome = error.message; }
      );

    try {
      await vi.advanceTimersByTimeAsync(11);

      expect(outcome).toBe("IMAP_COMMAND_TIMEOUT_MS exceeded during fetch");
      expect(rawIterator.return).not.toHaveBeenCalled();
      expect(rawClient.close).toHaveBeenCalledOnce();
    } finally {
      await vi.advanceTimersByTimeAsync(20);
      await next;
      vi.useRealTimers();
    }
  });
});

describe("fetchFullMessageBodyBatch", () => {
  const rawByUid = new Map([
    [1273, makeTextMessage({
      uid: 1273,
      subject: "First",
      from: "a@example.test",
      to: "b@example.test",
      body: "first body"
    }).raw],
    [1274, makeTextMessage({
      uid: 1274,
      subject: "Second",
      from: "a@example.test",
      to: "b@example.test",
      body: "second body"
    }).raw]
  ]);
  const messages = [1273, 1274].map((uid) => ({
    id: `m${uid}`,
    account_id: "a1",
    uid,
    folder_path: "INBOX.Notes",
    uidvalidity: 1,
    size_bytes: rawByUid.get(uid)?.length ?? 0,
    mime_structure: { part: "1", type: "text/plain" },
    headers_json: {}
  })) as unknown as ImapMessage[];

  function batchClient(returnedUids = [1273, 1274]) {
    const fetchCalls: Array<{
      range: string | number[] | Record<string, unknown>;
      query: Record<string, unknown>;
      options?: Record<string, unknown>;
    }> = [];
    let lockCalls = 0;
    let releaseCalls = 0;
    let mailbox: MirrorImapClient["mailbox"] = null;
    const client = {
      get mailbox() {
        return mailbox;
      },
      async getMailboxLock(path: string) {
        lockCalls += 1;
        mailbox = { path, uidValidity: 1 };
        return {
          release() {
            releaseCalls += 1;
          }
        };
      },
      async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>,
        options?: Record<string, unknown>
      ) {
        fetchCalls.push({ range, query, options });
        for (const uid of returnedUids) {
          yield { uid, source: rawByUid.get(uid) };
        }
      }
    } as unknown as MirrorImapClient;
    return {
      client,
      fetchCalls,
      lockCalls: () => lockCalls,
      releaseCalls: () => releaseCalls
    };
  }

  it("uses one UID FETCH and yields independently parsed bodies", async () => {
    const { client, fetchCalls, lockCalls, releaseCalls } = batchClient();
    const result = await fetchFullMessageBodyBatch(
      client,
      {
        BODY_RAW_MAX_BYTES: 4 * 1024 * 1024,
        BODY_STORAGE_MODE: "parsed_only"
      } as unknown as AppConfig,
      messages
    );
    const bodies = result.bodies;

    expect(lockCalls()).toBe(1);
    expect(releaseCalls()).toBe(1);
    expect(fetchCalls).toEqual([{
      range: [1273, 1274],
      query: {
        source: {
          start: 0,
          maxLength: 4 * 1024 * 1024
        }
      },
      options: { uid: true }
    }]);
    expect(bodies.map(({ message }) => message.id)).toEqual(["m1273", "m1274"]);
    expect(bodies.map(({ body }) => body.bodyText)).toEqual([
      expect.stringContaining("first body"),
      expect.stringContaining("second body")
    ]);
    expect(bodies.every(({ body }) => body.rawMime.length === 0)).toBe(true);
    expect(result.missingMessages).toEqual([]);
  });

  it("returns the exact missing UID set alongside the fetched bodies", async () => {
    const { client } = batchClient([1273]);
    const result = await fetchFullMessageBodyBatch(
      client,
      {
        BODY_RAW_MAX_BYTES: 4 * 1024 * 1024,
        BODY_STORAGE_MODE: "parsed_only"
      } as unknown as AppConfig,
      messages
    );

    expect(result.bodies.map(({ message }) => message.id)).toEqual(["m1273"]);
    expect(result.missingMessages.map((message) => message.id)).toEqual(["m1274"]);
  });

  it("returns a source-size mismatch for individual streaming retry", async () => {
    const { client } = batchClient();
    const mismatched = messages.map((message, index) => (
      index === 0 ? { ...message, size_bytes: Number(message.size_bytes) - 1 } : message
    ));
    const result = await fetchFullMessageBodyBatch(
      client,
      {
        BODY_RAW_MAX_BYTES: 4 * 1024 * 1024,
        BODY_STORAGE_MODE: "parsed_only"
      } as unknown as AppConfig,
      mismatched
    );

    expect(result.bodies.map(({ message }) => message.id)).toEqual(["m1274"]);
    expect(result.missingMessages.map((message) => message.id)).toEqual(["m1273"]);
  });

  it("rejects an unsafe source size before acquiring the mailbox lock", async () => {
    const { client, lockCalls } = batchClient();
    const oversized = messages.map((message, index) => (
      index === 0 ? { ...message, size_bytes: 4 * 1024 * 1024 + 1 } : message
    ));

    await expect(fetchFullMessageBodyBatch(
      client,
      {
        BODY_RAW_MAX_BYTES: 25 * 1024 * 1024,
        BODY_STORAGE_MODE: "parsed_only"
      } as unknown as AppConfig,
      oversized
    )).rejects.toThrow("body batch UID 1273 has unsafe source size");
    expect(lockCalls()).toBe(0);
  });
});

describe("fetchMessageMetadata uid guard", () => {
  // Minimal client that yields a controlled fetch sequence (FixtureImapClient can't
  // inject a UID-less message). Only `fetch` is exercised by fetchMessageMetadata.
  const metadataStub = (yielded: Array<Partial<FetchMessage>>): MirrorImapClient =>
    ({
      mailbox: { path: "INBOX", uidValidity: 1 },
      async *fetch() {
        for (const msg of yielded) yield msg as FetchMessage;
      }
    }) as unknown as MirrorImapClient;

  const real = (uid: number): Partial<FetchMessage> => ({
    uid,
    flags: new Set<string>(),
    internalDate: new Date("2026-01-01T00:00:00.000Z"),
    size: 10,
    envelope: {},
    headers: Buffer.alloc(0),
    bodyStructure: null
  });

  it("skips an unsolicited FETCH response with no UID without dropping the requested ones", async () => {
    const client = metadataStub([
      real(100),
      { flags: new Set(["\\Seen"]), envelope: {} }, // unsolicited push, no uid
      real(101)
    ]);
    const result = await fetchMessageMetadata(client, [100, 101], 50);
    expect(result.map((m) => m.uid)).toEqual([100, 101]);
  });

  it("still throws when a requested UID is genuinely missing", async () => {
    const client = metadataStub([real(100)]);
    await expect(fetchMessageMetadata(client, [100, 101], 50)).rejects.toThrow(/missing 101/);
  });

  it("ignores unexpected responses and returns each requested UID once in request order", async () => {
    const client = metadataStub([
      real(999),
      { uid: 100, flags: new Set(["\\Seen"]) },
      real(101),
      real(100),
      { ...real(100), flags: new Set(["\\Flagged"]) }
    ]);
    const result = await fetchMessageMetadata(client, [100, 101, 100], 50);
    expect(result.map((message) => message.uid)).toEqual([100, 101]);
    expect(result[0].flags).toEqual(["\\Flagged"]);
  });

  it("fails closed before retaining an unbounded metadata fetch", async () => {
    const subject = "x".repeat(Math.floor(MAX_SYNC_METADATA_FETCH_BYTES / 5) + 1);
    const responses = Array.from({ length: 5 }, (_, index) => ({
      ...real(index + 1),
      envelope: { subject }
    }));

    await expect(fetchMessageMetadata(
      metadataStub(responses),
      [1, 2, 3, 4, 5],
      50
    )).rejects.toThrow(/aggregate memory budget/);
  });

  it("fails closed when overwrite-critical metadata fields are omitted", async () => {
    const complete = real(100);
    for (const field of ["envelope", "headers", "bodyStructure"] as const) {
      const partial = { ...complete };
      delete partial[field];
      await expect(fetchMessageMetadata(metadataStub([partial]), [100], 50)).rejects.toThrow(/missing 100/);
    }
  });

  it("fails closed when a provider returns an unsafe message size", async () => {
    for (const size of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(
        fetchMessageMetadata(metadataStub([{ ...real(100), size }]), [100], 50)
      ).rejects.toThrow(/missing 100/);
    }
  });
});

describe("fetchMessageFlags payload guard", () => {
  const flagStub = (
    yielded: Array<{ uid: number; flags: Set<string> }>
  ): MirrorImapClient => ({
    mailbox: { path: "INBOX", uidValidity: 1 },
    async *fetch() {
      for (const message of yielded) yield message as FetchMessage;
    }
  }) as unknown as MirrorImapClient;

  it("fails closed before retaining an unbounded aggregate keyword set", async () => {
    const flags = new Set(Array.from({ length: 4_500 }, (_, index) => `keyword-${index}`));
    const messages = Array.from({ length: 5 }, (_, index) => ({ uid: index + 1, flags }));
    await expect(fetchMessageFlags(
      flagStub(messages),
      [1, 2, 3, 4, 5],
      50
    )).rejects.toThrow(/aggregate memory budget/);
  });

  it("accounts for a replacement response instead of double-counting it", async () => {
    const large = new Set(Array.from({ length: 15_000 }, (_, index) => `old-${index}`));
    const replacement = new Set(["\\Seen"]);
    const other = new Set(Array.from({ length: 4_999 }, (_, index) => `new-${index}`));
    const result = await fetchMessageFlags(
      flagStub([
        { uid: 1, flags: large },
        { uid: 1, flags: replacement },
        { uid: 2, flags: other }
      ]),
      [1, 2],
      50
    );
    expect(result).toEqual([
      { uid: 1, flags: ["\\Seen"] },
      { uid: 2, flags: [...other] }
    ]);
  });
});

describe("fetchMessageFlags", () => {
  const flagsStub = (
    yielded: Array<Partial<FetchMessage>>,
    calls: Array<{ query: Record<string, unknown>; options?: Record<string, unknown> }> = []
  ): MirrorImapClient =>
    ({
      mailbox: { path: "INBOX", uidValidity: 1 },
      async *fetch(
        _range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>,
        options?: Record<string, unknown>
      ) {
        calls.push({ query, options });
        for (const msg of yielded) yield msg as FetchMessage;
      }
    }) as unknown as MirrorImapClient;

  it("requests only UID and FLAGS and skips UID-less unsolicited responses", async () => {
    const calls: Array<{ query: Record<string, unknown>; options?: Record<string, unknown> }> = [];
    const client = flagsStub([
      { uid: 101, flags: new Set() },
      { uid: 999, flags: new Set(["\\Seen"]) },
      { uid: 100, flags: new Set(["\\Seen"]) },
      { uid: 100, flags: new Set(["\\Seen", "\\Flagged"]) },
      { flags: new Set(["\\Seen"]) }
    ], calls);

    await expect(fetchMessageFlags(client, [100, 101, 100], 50)).resolves.toEqual([
      { uid: 100, flags: ["\\Seen", "\\Flagged"] },
      { uid: 101, flags: [] }
    ]);
    expect(calls).toEqual([{
      query: { uid: true, flags: true },
      options: { uid: true }
    }]);
  });

  it("fails instead of advancing past a partial UID batch", async () => {
    const client = flagsStub([{ uid: 100, flags: new Set(["\\Seen"]) }]);
    await expect(fetchMessageFlags(client, [100, 101], 50)).rejects.toThrow(/missing 101/);
  });

  it("fails closed when a requested response omits FLAGS", async () => {
    const client = flagsStub([{ uid: 100 }]);
    await expect(fetchMessageFlags(client, [100], 50)).rejects.toThrow(/omitted FLAGS.*100/i);
  });
});

describe("fetchChangedMessageFlags", () => {
  it("uses CONDSTORE CHANGEDSINCE without requiring a complete UID set", async () => {
    const calls: Array<{
      range: unknown;
      query: Record<string, unknown>;
      options?: Record<string, unknown>;
    }> = [];
    const client = {
      mailbox: { path: "Archive", uidValidity: 1, highestModseq: 11n },
      async *fetch(
        range: unknown,
        query: Record<string, unknown>,
        options?: Record<string, unknown>
      ) {
        calls.push({ range, query, options });
        yield { uid: 7, flags: new Set(["\\Seen", "\\Flagged"]) };
      }
    } as unknown as MirrorImapClient;

    await expect(fetchChangedMessageFlags(client, 10n)).resolves.toEqual([
      { uid: 7, flags: ["\\Seen", "\\Flagged"] }
    ]);
    expect(calls).toEqual([{
      range: "1:*",
      query: { uid: true, flags: true },
      options: { uid: true, changedSince: 10n }
    }]);
  });

  it("fails closed when a changed row omits FLAGS", async () => {
    const client = {
      mailbox: { path: "Archive", uidValidity: 1, highestModseq: 11n },
      async *fetch() {
        yield { uid: 7 };
      }
    } as unknown as MirrorImapClient;

    await expect(fetchChangedMessageFlags(client, 10n)).rejects.toThrow(/omitted FLAGS/i);
  });
});

describe("ThrottledImapClient QRESYNC replay", () => {
  it("captures exact changed flags and VANISHED UIDs during mailbox selection", async () => {
    const raw = Object.assign(new EventEmitter(), {
      mailbox: {
        path: "Archive",
        uidValidity: 7n,
        highestModseq: 12n,
        qresync: true
      },
      close: vi.fn(),
      getMailboxLock: vi.fn(async function(this: EventEmitter) {
        this.emit("flags", {
          path: "Archive",
          seq: 2,
          uid: 22,
          modseq: 11n,
          flags: new Set(["\\Seen", "\\Flagged"])
        });
        this.emit("expunge", { path: "Archive", uid: 9, vanished: true, earlier: true });
        return { release: vi.fn() };
      })
    });
    const client = new ThrottledImapClient(raw as never, 200, 5_000);

    const lock = await client.getMailboxLock("Archive", {
      qresync: { uidValidity: 7n, changedSince: 10n }
    });

    expect(raw.getMailboxLock).toHaveBeenCalledWith("Archive", {
      uidValidity: 7n,
      changedSince: 10n
    });
    expect(lock.qresync).toEqual({
      accepted: true,
      complete: true,
      vanishedUids: [9],
      changedFlags: [{ uid: 22, flags: ["\\Seen", "\\Flagged"] }]
    });
    expect(raw.listenerCount("flags")).toBe(0);
    expect(raw.listenerCount("expunge")).toBe(0);
  });

  it("fails closed on a sequence-only EXPUNGE during replay", async () => {
    const raw = Object.assign(new EventEmitter(), {
      mailbox: {
        path: "Archive",
        uidValidity: 7n,
        highestModseq: 12n,
        qresync: true
      },
      close: vi.fn(),
      getMailboxLock: vi.fn(async function(this: EventEmitter) {
        this.emit("expunge", { path: "Archive", seq: 2, vanished: false });
        return { release: vi.fn() };
      })
    });
    const client = new ThrottledImapClient(raw as never, 200, 5_000);

    const lock = await client.getMailboxLock("Archive", {
      qresync: { uidValidity: 7n, changedSince: 10n }
    });

    expect(lock.qresync).toEqual({
      accepted: true,
      complete: false,
      vanishedUids: [],
      changedFlags: []
    });
  });

  it("latches plain mailbox selection after the server declines QRESYNC", async () => {
    const raw = Object.assign(new EventEmitter(), {
      mailbox: {
        path: "Archive",
        uidValidity: 7n,
        highestModseq: 12n,
        qresync: false
      },
      close: vi.fn(),
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() }))
    });
    const client = new ThrottledImapClient(raw as never, 200, 5_000);
    const request = { qresync: { uidValidity: 7n, changedSince: 10n } };

    expect((await client.getMailboxLock("Archive", request)).qresync?.accepted).toBe(false);
    expect((await client.getMailboxLock("Archive", request)).qresync).toBeUndefined();
    expect(raw.getMailboxLock.mock.calls).toEqual([
      ["Archive", { uidValidity: 7n, changedSince: 10n }],
      ["Archive"]
    ]);
  });
});
