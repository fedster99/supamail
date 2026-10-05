import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";
import { describe, expect, it, vi } from "vitest";

function selectedClient(): ImapFlow {
  const client = new ImapFlow({
    host: "imap.example.test",
    port: 993,
    secure: true,
    auth: { user: "test", pass: "test" },
    logger: false
  });
  const internal = client as unknown as { states: { SELECTED: string } };
  Object.assign(client, {
    usable: true,
    socket: { destroyed: false },
    state: internal.states.SELECTED,
    mailbox: {
      path: "Archive",
      readOnly: false,
      uidValidity: 7n,
      highestModseq: 10n
    }
  });
  return client;
}

describe("patched ImapFlow QRESYNC mailbox lock", () => {
  it("forces SELECT when the same mailbox is open and a replay cursor is supplied", async () => {
    const client = selectedClient();
    const mailboxOpen = vi.spyOn(client, "mailboxOpen").mockResolvedValue(client.mailbox as never);

    const lock = await client.getMailboxLock("Archive", {
      uidValidity: 7n,
      changedSince: 10n
    });
    lock.release();

    expect(mailboxOpen).toHaveBeenCalledWith("Archive", {
      uidValidity: 7n,
      changedSince: 10n
    });
  });

  it("keeps the existing fast path when no replay cursor is supplied", async () => {
    const client = selectedClient();
    const mailboxOpen = vi.spyOn(client, "mailboxOpen").mockResolvedValue(client.mailbox as never);

    const lock = await client.getMailboxLock("Archive");
    lock.release();

    expect(mailboxOpen).not.toHaveBeenCalled();
  });

  it.each([
    "1:10001",
    "1:6000,7000:11000"
  ])("rejects an oversized VANISHED sequence before emitting per-UID events: %s", async (range) => {
    const client = selectedClient();
    const expunge = vi.fn();
    client.on("expunge", expunge);
    const internal = client as unknown as {
      untaggedVanished(
        response: { attributes: Array<{ value: string }> },
        mailbox: Record<string, unknown>
      ): Promise<void>;
    };

    await expect(internal.untaggedVanished(
      { attributes: [{ value: range }] },
      client.mailbox as unknown as Record<string, unknown>
    )).rejects.toThrow(/exceeds 10000 entries/i);
    expect(expunge).not.toHaveBeenCalled();
  });
});

describe("patched ImapFlow message count", () => {
  it("drops EXISTS for a VANISHED report, but not for VANISHED (EARLIER)", async () => {
    const client = selectedClient();
    const mailbox = client.mailbox as unknown as Record<string, unknown>;
    mailbox.exists = 10;
    const internal = client as unknown as {
      untaggedVanished(
        response: { attributes: unknown[] },
        mailbox: Record<string, unknown>
      ): Promise<void>;
    };

    await internal.untaggedVanished({ attributes: [{ value: "3:5,9" }] }, mailbox);
    expect(mailbox.exists).toBe(6);

    await internal.untaggedVanished(
      { attributes: [[{ type: "ATOM", value: "EARLIER" }], { value: "1:2" }] },
      mailbox
    );
    expect(mailbox.exists).toBe(6);
  });
});

describe("patched ImapFlow SEARCH", () => {
  const search = createRequire(import.meta.url)("imapflow/lib/commands/search.js") as (
    connection: unknown,
    query: unknown,
    options: { uid: boolean }
  ) => Promise<number[] | false>;

  function esearchConnection(all: string, exists: number) {
    const states = { SELECTED: "SELECTED" };
    return {
      state: states.SELECTED,
      states,
      mailbox: { exists },
      capabilities: new Map(),
      log: { warn: vi.fn() },
      async exec(_command: string, _attributes: unknown, opts: {
        untagged: { ESEARCH(untagged: unknown): Promise<void> };
      }) {
        await opts.untagged.ESEARCH({
          attributes: [
            [{ type: "ATOM", value: "TAG" }, { type: "STRING", value: "A1" }],
            { type: "ATOM", value: "UID" },
            { type: "ATOM", value: "ALL" },
            { type: "SEQUENCE", value: all }
          ]
        });
        return { next: () => undefined };
      }
    };
  }

  it("expands an exact ESEARCH ALL set", async () => {
    await expect(search(esearchConnection("1:3,7", 4), { all: true }, { uid: true }))
      .resolves.toEqual([1, 2, 3, 7]);
  });

  it("fails rather than truncate an ESEARCH ALL set larger than EXISTS", async () => {
    // A server that compresses UID ranges across gaps cannot be expanded exactly.
    await expect(search(esearchConnection("1:100", 4), { all: true }, { uid: true }))
      .resolves.toBe(false);
  });
});
