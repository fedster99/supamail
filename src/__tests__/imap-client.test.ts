import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchMessageMetadata } from "../imap-client.js";
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
});
