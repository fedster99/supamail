import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const move = require("imapflow/lib/commands/move.js") as
  (connection: unknown, range: string, destination: string, options: object) => Promise<unknown>;
const expunge = require("imapflow/lib/commands/expunge.js") as
  (connection: unknown, range: string, options: object) => Promise<unknown>;

function connection() {
  const copied = { uidValidity: 20n, uidMap: new Map([[1, 11], [2, 12]]) };
  return {
    state: 3, states: { SELECTED: 3 }, mailbox: { path: "INBOX" },
    namespace: { prefix: "", delimiter: "/" }, enabled: new Set(),
    capabilities: new Map([["UIDPLUS", true]]),
    messageCopy: vi.fn(async (): Promise<unknown> => copied),
    messageDelete: vi.fn(async (): Promise<unknown> => true),
    messageFlagsAdd: vi.fn(async (): Promise<unknown> => true),
    exec: vi.fn(async () => ({ response: { attributes: [] }, next: vi.fn() })),
  };
}

describe("UIDPLUS move fallback", () => {
  it.each([false, undefined])("never deletes after COPY returns %s", async (result) => {
    const client = connection();
    client.messageCopy.mockResolvedValueOnce(result);
    expect(await move(client, "1,2", "Archive", { uid: true })).toBe(false);
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it("never deletes after COPY throws", async () => {
    const client = connection();
    client.messageCopy.mockRejectedValueOnce(new Error("connection lost"));
    await expect(move(client, "1,2", "Archive", { uid: true })).rejects.toThrow("connection lost");
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it.each([false, undefined, new Error("connection lost")])("reports the partial effect after removal fails: %s", async (failure) => {
    const client = connection();
    if (failure instanceof Error) client.messageDelete.mockRejectedValueOnce(failure);
    else client.messageDelete.mockResolvedValueOnce(failure);
    await expect(move(client, "1,2", "Archive", { uid: true })).rejects.toMatchObject({ code: "MoveIncomplete" });
    expect(client.messageCopy).toHaveBeenCalledTimes(1);
    expect(client.messageDelete).toHaveBeenCalledExactlyOnceWith("1,2", { uid: true, silent: true });
  });

  it("returns COPYUID only after both steps succeed", async () => {
    const client = connection();
    expect(await move(client, "1,2", "Archive", { uid: true })).toEqual({
      uidValidity: 20n, uidMap: new Map([[1, 11], [2, 12]]),
    });
    expect(client.messageCopy.mock.invocationCallOrder[0]).toBeLessThan(client.messageDelete.mock.invocationCallOrder[0]);
  });

  it.each([false, undefined])("does not EXPUNGE after STORE returns %s", async (result) => {
    const client = connection();
    client.messageFlagsAdd.mockResolvedValueOnce(result);
    expect(await expunge(client, "1,2", { uid: true })).toBe(false);
    expect(client.exec).not.toHaveBeenCalled();
  });
});
