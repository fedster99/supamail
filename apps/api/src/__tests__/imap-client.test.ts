import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import {
  fetchFullMessageBody,
  fetchMessageMetadata,
  searchAllUids,
  searchUidsBefore,
  searchUidsSince,
  type FetchMessage,
  type MirrorImapClient
} from "../imap-client.js";
import { FixtureImapClient, makeTextMessage } from "../smoke/fixture-imap.js";
import type { ImapMessage } from "../types.js";

describe("fetchMessageMetadata", () => {
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
    headers: Buffer.alloc(0)
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
});
