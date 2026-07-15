import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import {
  fetchFullMessageBody,
  fetchMessageFlags,
  fetchMessageMetadata,
  MessageMovedError,
  parseMessageMetadata,
  providerObjectIdNamespace,
  searchAllUids,
  searchUidsBefore,
  searchUidsSince,
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
