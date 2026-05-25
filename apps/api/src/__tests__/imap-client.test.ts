import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchMessageMetadata, searchAllUids, searchUidsBefore, searchUidsSince } from "../imap-client.js";
import { FixtureImapClient, makeTextMessage } from "../smoke/fixture-imap.js";

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
