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
