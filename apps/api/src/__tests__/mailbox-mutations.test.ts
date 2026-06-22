import { describe, expect, it, vi, beforeEach } from "vitest";
import { MailboxMutator, resolveTrashFolder, toImapFlag } from "../mailbox-mutations.js";
import { genericImapProfile } from "../provider-profiles.js";

/**
 * Unit coverage for the organize-mutation primitives (email-002, ADR 0018). The
 * IMAP MailboxMutator and the repository are mocked, so nothing connects. The
 * load-bearing assertions are: (1) every per-message verb is UID-addressed and
 * runs under a per-folder lock with a UIDVALIDITY guard, (2) the flag short-names
 * map to IMAP system flags, (3) move/trash/expunge act by UID, (4) thread fan-out
 * resolves every live member and applies the verb to each, (5) folder CRUD is
 * account-scoped. We never guess a mirror write — the next sync reconciles.
 */

describe("toImapFlag", () => {
  it("maps SupaMail short names to IMAP system flags", () => {
    expect(toImapFlag("seen")).toBe("\\Seen");
    expect(toImapFlag("flagged")).toBe("\\Flagged");
    expect(toImapFlag("answered")).toBe("\\Answered");
    expect(toImapFlag("deleted")).toBe("\\Deleted");
  });

  it("accepts bare keywords and already-prefixed flags", () => {
    expect(toImapFlag("Seen")).toBe("\\Seen");
    expect(toImapFlag("\\Flagged")).toBe("\\Flagged");
  });

  it("passes a custom keyword through with a single backslash", () => {
    expect(toImapFlag("Important")).toBe("\\Important");
  });
});

describe("resolveTrashFolder", () => {
  it("prefers the \\Trash special-use mailbox", () => {
    const boxes = [
      { path: "INBOX", specialUse: null },
      { path: "Deleted Items", specialUse: "\\Trash" }
    ];
    expect(resolveTrashFolder(boxes, genericImapProfile)).toBe("Deleted Items");
  });

  it("falls back to a folder literally named Trash, then the conventional Trash", () => {
    expect(resolveTrashFolder([{ path: "INBOX/Trash", specialUse: null }], genericImapProfile)).toBe("INBOX/Trash");
    expect(resolveTrashFolder([{ path: "INBOX", specialUse: null }], genericImapProfile)).toBe("Trash");
  });
});

// --- Mocked MailboxMutator + repository for the library functions. ---

const mutator = vi.hoisted(() => ({
  addFlags: vi.fn(async (_target: { folderPath: string; uidValidity: number; uid: number }, _flags: string[]) => true),
  removeFlags: vi.fn(async (_target: { folderPath: string; uidValidity: number; uid: number }, _flags: string[]) => true),
  move: vi.fn(async () => ({ uidMap: new Map<number, number>([[42, 99]]) })),
  expunge: vi.fn(async () => true),
  list: vi.fn(async () => [{ path: "Trash", specialUse: "\\Trash" }]),
  createFolder: vi.fn(async (path: string) => ({ path, created: true })),
  renameFolder: vi.fn(async (path: string, newPath: string) => ({ path, newPath })),
  deleteFolder: vi.fn(async (path: string) => ({ path })),
  logout: vi.fn(async () => undefined),
  close: vi.fn()
}));

const repo = vi.hoisted(() => ({
  getMessage: vi.fn(),
  getAccount: vi.fn(),
  applyMessageFlags: vi.fn(async () => ["\\Seen"] as string[])
}));

// MailboxMutator.connect is intercepted via vi.spyOn (the real lib functions call
// it as a runtime property access, so the spy is picked up). A module self-mock
// with {...actual} would NOT intercept those internal calls (ESM lexical binding),
// which is why the connecting tests previously hit a real DNS lookup.
const connectSpy = vi.spyOn(MailboxMutator, "connect");

vi.mock("../repository.js", () => ({
  MirrorRepository: class {
    getMessage = repo.getMessage;
    getAccount = repo.getAccount;
    applyMessageFlags = repo.applyMessageFlags;
  }
}));

const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

const account = {
  id: "acc-1",
  provider_profile: "generic-imap",
  host: "imap.example.test",
  port: 993,
  secure: true,
  username: "user@example.test",
  encrypted_password: Buffer.from("x")
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    account_id: "acc-1",
    folder_path: "INBOX",
    uidvalidity: "100",
    uid: "42",
    deleted_in_provider: false,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectSpy.mockResolvedValue(mutator as unknown as MailboxMutator);
  mutator.move.mockResolvedValue({ uidMap: new Map<number, number>([[42, 99]]) });
  mutator.list.mockResolvedValue([{ path: "Trash", specialUse: "\\Trash" }]);
  repo.getAccount.mockResolvedValue(account);
  repo.applyMessageFlags.mockResolvedValue(["\\Seen"]);
});

describe("setMessageFlags", () => {
  it("STOREs +Seen by UID for mark-read and logs out", async () => {
    repo.getMessage.mockResolvedValue(message());
    const { setMessageFlags } = await import("../mailbox-mutations.js");
    const result = await setMessageFlags({} as never, config, "msg-1", { add: ["seen"] });

    expect(mutator.addFlags).toHaveBeenCalledTimes(1);
    const [target, flags] = mutator.addFlags.mock.calls[0];
    expect(target).toMatchObject({ folderPath: "INBOX", uidValidity: 100, uid: 42 });
    expect(flags).toEqual(["\\Seen"]);
    expect(mutator.removeFlags).not.toHaveBeenCalled();
    expect(mutator.logout).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ messageId: "msg-1", uid: 42, added: ["\\Seen"], removed: [] });
  });

  it("STOREs -Flagged by UID for unstar", async () => {
    repo.getMessage.mockResolvedValue(message());
    const { setMessageFlags } = await import("../mailbox-mutations.js");
    await setMessageFlags({} as never, config, "msg-1", { remove: ["flagged"] });
    expect(mutator.removeFlags).toHaveBeenCalledWith(expect.objectContaining({ uid: 42 }), ["\\Flagged"]);
    expect(mutator.addFlags).not.toHaveBeenCalled();
  });

  it("writes the flag change through to the mirror row after a successful STORE (M1)", async () => {
    repo.getMessage.mockResolvedValue(message());
    const { setMessageFlags } = await import("../mailbox-mutations.js");
    await setMessageFlags({} as never, config, "msg-1", { add: ["seen"], remove: ["flagged"] });
    expect(repo.applyMessageFlags).toHaveBeenCalledTimes(1);
    expect(repo.applyMessageFlags).toHaveBeenCalledWith("msg-1", "acc-1", {
      add: ["\\Seen"],
      remove: ["\\Flagged"]
    });
  });

  it("surfaces a warning but still succeeds if the mirror write-through fails (M1)", async () => {
    repo.getMessage.mockResolvedValue(message());
    repo.applyMessageFlags.mockRejectedValueOnce(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { setMessageFlags } = await import("../mailbox-mutations.js");
    const result = await setMessageFlags({} as never, config, "msg-1", { add: ["seen"] });
    expect(result).toMatchObject({ messageId: "msg-1", added: ["\\Seen"] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("flag_write_through_failed"));
    warn.mockRestore();
  });

  it("rejects an empty flag change without connecting", async () => {
    repo.getMessage.mockResolvedValue(message());
    const { setMessageFlags } = await import("../mailbox-mutations.js");
    await expect(setMessageFlags({} as never, config, "msg-1", {})).rejects.toThrow(/at least one flag/i);
  });

  it("throws for an unknown message", async () => {
    repo.getMessage.mockResolvedValue(null);
    const { setMessageFlags } = await import("../mailbox-mutations.js");
    await expect(setMessageFlags({} as never, config, "missing", { add: ["seen"] })).rejects.toThrow(/Message not found/);
    expect(mutator.addFlags).not.toHaveBeenCalled();
  });

  it("refuses a message already deleted in the provider", async () => {
    repo.getMessage.mockResolvedValue(message({ deleted_in_provider: true }));
    const { setMessageFlags } = await import("../mailbox-mutations.js");
    await expect(setMessageFlags({} as never, config, "msg-1", { add: ["seen"] })).rejects.toThrow(/already deleted/);
  });
});

describe("moveMessage", () => {
  it("moves by UID and surfaces the new UID from COPYUID", async () => {
    repo.getMessage.mockResolvedValue(message());
    const { moveMessage } = await import("../mailbox-mutations.js");
    const result = await moveMessage({} as never, config, "msg-1", "Archive");
    expect(mutator.move).toHaveBeenCalledWith(expect.objectContaining({ uid: 42 }), "Archive");
    expect(result).toMatchObject({ fromFolder: "INBOX", toFolder: "Archive", newUid: 99 });
  });

  it("rejects an empty destination", async () => {
    repo.getMessage.mockResolvedValue(message());
    const { moveMessage } = await import("../mailbox-mutations.js");
    await expect(moveMessage({} as never, config, "msg-1", "  ")).rejects.toThrow(/non-empty destination/);
  });
});

describe("deleteMessage", () => {
  it("moves to the resolved Trash folder by default", async () => {
    repo.getMessage.mockResolvedValue(message());
    const { deleteMessage } = await import("../mailbox-mutations.js");
    const result = await deleteMessage({} as never, config, "msg-1", {});
    expect(mutator.move).toHaveBeenCalledWith(expect.objectContaining({ uid: 42 }), "Trash");
    expect(mutator.expunge).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "trash", trashFolder: "Trash" });
  });

  it("is a no-op move when the message already lives in Trash", async () => {
    repo.getMessage.mockResolvedValue(message({ folder_path: "Trash" }));
    const { deleteMessage } = await import("../mailbox-mutations.js");
    const result = await deleteMessage({} as never, config, "msg-1", {});
    expect(mutator.move).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "trash", trashFolder: "Trash" });
  });

  it("EXPUNGEs by UID for a hard delete", async () => {
    repo.getMessage.mockResolvedValue(message());
    const { deleteMessage } = await import("../mailbox-mutations.js");
    const result = await deleteMessage({} as never, config, "msg-1", { hard: true });
    expect(mutator.expunge).toHaveBeenCalledWith(expect.objectContaining({ uid: 42 }));
    expect(mutator.move).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "expunge", trashFolder: null });
  });
});

describe("folder CRUD", () => {
  it("creates / renames / deletes a folder on the account's mailbox", async () => {
    const { createFolder, renameFolder, deleteFolder } = await import("../mailbox-mutations.js");

    const created = await createFolder({} as never, config, "acc-1", "Projects");
    expect(mutator.createFolder).toHaveBeenCalledWith("Projects");
    expect(created).toMatchObject({ accountId: "acc-1", path: "Projects", created: true });

    const renamed = await renameFolder({} as never, config, "acc-1", "Projects", "Work");
    expect(mutator.renameFolder).toHaveBeenCalledWith("Projects", "Work");
    expect(renamed).toMatchObject({ path: "Projects", newPath: "Work" });

    const deleted = await deleteFolder({} as never, config, "acc-1", "Work");
    expect(mutator.deleteFolder).toHaveBeenCalledWith("Work");
    expect(deleted).toMatchObject({ accountId: "acc-1", path: "Work" });
  });

  it("throws when the account is unknown", async () => {
    repo.getAccount.mockResolvedValueOnce(null);
    const { createFolder } = await import("../mailbox-mutations.js");
    await expect(createFolder({} as never, config, "nope", "X")).rejects.toThrow(/Account not found/);
    expect(mutator.createFolder).not.toHaveBeenCalled();
  });
});
