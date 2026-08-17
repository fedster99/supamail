import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const requireFromTest = createRequire(import.meta.url);
const imapflowEntry = requireFromTest.resolve("imapflow");
const runListCommand = requireFromTest(
  resolve(dirname(imapflowEntry), "commands/list.js")
) as (
  connection: Record<string, unknown>,
  reference: string,
  mailboxes: string[],
  options: Record<string, unknown>
) => Promise<Array<{ path: string; status?: Record<string, unknown> }>>;

function listStatusConnection(exec: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return {
    capabilities: new Map([
      ["IMAP4rev1", true],
      ["LIST-STATUS", true],
      ["XLIST", true]
    ]),
    enabled: new Set(),
    namespace: { delimiter: "/", prefix: "" },
    skipListSubscribedArg: false,
    skipListStatusArgs: false,
    skipListAuxArgs: false,
    skipLsub: false,
    id: "list-status-patch-test",
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn()
    },
    run: vi.fn(async () => {
      throw new Error("unexpected per-mailbox command");
    }),
    exec
  };
}

const strictOptions = {
  statusQuery: {
    messages: true,
    uidNext: true,
    uidValidity: true,
    unseen: true
  },
  statusFallback: false,
  statusOnly: true,
  returnOptionFallback: false
};

describe("patched ImapFlow LIST-STATUS command", () => {
  it("uses one LIST command even when the server also advertises XLIST", async () => {
    const exec = vi.fn(async (
      command: string,
      _attributes: unknown[],
      options: { untagged: Record<string, (response: unknown) => Promise<void>> }
    ) => {
      await options.untagged.LIST?.({
        attributes: [[], { value: "/" }, { value: "Archive" }]
      });
      await options.untagged.STATUS?.({
        attributes: [
          { value: "Archive" },
          [
            { value: "MESSAGES" }, { value: "10" },
            { value: "UIDNEXT" }, { value: "11" },
            { value: "UIDVALIDITY" }, { value: "2" },
            { value: "UNSEEN" }, { value: "1" }
          ]
        ]
      });
      return { next: vi.fn() };
    });
    const connection = listStatusConnection(exec);

    const result = await runListCommand(connection, "", ["Archive"], strictOptions);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[0]).toBe("LIST");
    expect(connection.run).not.toHaveBeenCalled();
    expect(result).toMatchObject([{
      path: "Archive",
      status: { messages: 10, uidNext: 11, uidValidity: 2n, unseen: 1 }
    }]);
  });

  it("does not retry a rejected strict LIST-STATUS command", async () => {
    const rejection = Object.assign(new Error("RETURN STATUS rejected"), {
      responseStatus: "BAD"
    });
    const exec = vi.fn(async () => {
      throw rejection;
    });

    await expect(runListCommand(
      listStatusConnection(exec),
      "",
      ["Archive"],
      strictOptions
    )).rejects.toBe(rejection);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
