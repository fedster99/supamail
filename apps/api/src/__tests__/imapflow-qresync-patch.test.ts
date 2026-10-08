import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";
import { describe, expect, it, vi } from "vitest";
import { ThrottledImapClient } from "../imap-client.js";

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
  it("captures the newest deletion when an empty folder requires an explicit known-UID range", async () => {
    const raw = selectedClient();
    raw.enabled.add("QRESYNC");
    Object.assign(raw, { folders: new Map([["Archive", { path: "Archive" }]]) });
    const select = createRequire(import.meta.url)("imapflow/lib/commands/select.js");
    const exec = vi.fn(async (_command, attributes, options) => {
      for (const [name, value] of [["UIDVALIDITY", "7"], ["UIDNEXT", "6"], ["HIGHESTMODSEQ", "12"]]) {
        await options.untagged.OK({ attributes: [{ section: [{ type: "ATOM", value: name }, { type: "ATOM", value }] }] });
      }
      await options.untagged.EXISTS({ command: "0" });
      // Reproduce the provider defect: implicit range omits its last deleted UID.
      const range = attributes[1][1][2]?.value === "1:5" ? "1:5" : "1:4";
      await options.untagged.VANISHED({ attributes: [[{ value: "EARLIER" }], { value: range }] });
      return { response: { attributes: [{ section: [{ type: "ATOM", value: "READ-ONLY" }] }] }, next: vi.fn() };
    });
    Object.assign(raw, { exec });
    vi.spyOn(raw, "mailboxOpen").mockImplementation((path, options) => select(raw, path, options));
    const client = new ThrottledImapClient(raw, 200, 5_000);

    const lock = await client.getMailboxLock("Archive", {
      qresync: { uidValidity: 7n, changedSince: 10n, knownUidMax: 5 }
    });
    lock.release();

    expect(lock.qresync).toMatchObject({ accepted: true, complete: true, vanishedUids: [1, 2, 3, 4, 5] });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, 0x100000000, NaN])("rejects an invalid known-UID bound before a command: %s", async (knownUidMax) => {
    const raw = selectedClient();
    const exec = vi.fn();
    Object.assign(raw, { exec });
    const select = createRequire(import.meta.url)("imapflow/lib/commands/select.js");
    await expect(select(raw, "Archive", { uidValidity: 7n, changedSince: 10n, knownUidMax })).rejects.toThrow(TypeError);
    expect(exec).not.toHaveBeenCalled();
  });

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
