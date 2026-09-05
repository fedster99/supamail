import { describe, expect, it, vi, beforeEach } from "vitest";
import { MailboxMutator, toImapFlag } from "../mailbox-mutations.js";

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

// Trash-folder resolution (special-use → leaf-name → conventional) is covered by
// special-use-folder.test.ts; the per-module wrapper was inlined at its call site
// (review maintainability finding), so its redundant test was removed here.

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
  applyMessageFlags: vi.fn(async () => ["\\Seen"] as string[]),
  markFoldersForReconcile: vi.fn(async () => undefined)
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
    markFoldersForReconcile = repo.markFoldersForReconcile;
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
  it("marks the known folders durable before moving by UID", async () => {
    repo.getMessage.mockResolvedValue(message());
    const { moveMessage } = await import("../mailbox-mutations.js");
    const result = await moveMessage({} as never, config, "msg-1", "Archive");
    expect(repo.markFoldersForReconcile).toHaveBeenCalledWith(
      "acc-1",
      ["INBOX", "Archive"]
    );
    expect(repo.markFoldersForReconcile.mock.invocationCallOrder[0]).toBeLessThan(
      mutator.move.mock.invocationCallOrder[0]
    );
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

// ── Review PR-A: thread fan-out cap + interleaved write-through ────────────
describe("setThreadFlags / moveThread fan-out", () => {
  const seedRow = {
    id: "msg-1",
    provider_thread_id: "thread-1",
    rfc_message_id: "<m1@x>",
    message_id_normalized: "m1@x",
    in_reply_to: null,
    references_header: null,
    account_id: "acc-1",
    conversation_id: null
  };

  /** A pool whose first query returns the seed row and whose second returns the
   * supplied member rows (the LIMIT is applied client-side by resolveThreadTargets,
   * so we hand back exactly what a `LIMIT n` would). */
  function poolReturningMembers(members: Array<Record<string, unknown>>): never {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        return sql.includes("WHERE m.id = $1") ? { rows: [seedRow] } : { rows: members };
      }),
      release: vi.fn()
    };
    return { connect: vi.fn(async () => client) } as unknown as never;
  }

  function members(n: number): Array<Record<string, unknown>> {
    return Array.from({ length: n }, (_, i) => ({
      id: `msg-${i + 1}`,
      account_id: "acc-1",
      folder_path: "INBOX",
      uidvalidity: "100",
      uid: String(i + 1)
    }));
  }

  it("caps the fan-out at 100 members and flags the result truncated when the thread is larger", async () => {
    // resolveThreadTargets fetches MAX+1 (101) to detect truncation, then slices to 100.
    const pool = poolReturningMembers(members(101));
    const { setThreadFlags } = await import("../mailbox-mutations.js");
    const result = await setThreadFlags(pool, config, "msg-1", { add: ["seen"] });

    expect(result.messageCount).toBe(100);
    expect(result.truncated).toBe(true);
    // One STORE per acted-on member (interleaved with the write-through).
    expect(mutator.addFlags).toHaveBeenCalledTimes(100);
    expect(repo.applyMessageFlags).toHaveBeenCalledTimes(100);
  });

  it("does not truncate a small thread and applies the verb to every member", async () => {
    const pool = poolReturningMembers(members(3));
    const { setThreadFlags } = await import("../mailbox-mutations.js");
    const result = await setThreadFlags(pool, config, "msg-1", { add: ["seen"] });
    expect(result.messageCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(mutator.addFlags).toHaveBeenCalledTimes(3);
  });

  it("uses a stored conversation assignment and mutates every physical delivery copy", async () => {
    const assignedSeed = { ...seedRow, conversation_id: "conversation-1" };
    const physicalCopies = [
      {
        id: "msg-inbox",
        account_id: "acc-1",
        folder_path: "INBOX",
        uidvalidity: "100",
        uid: "11"
      },
      {
        id: "msg-sent",
        account_id: "acc-1",
        folder_path: "Sent",
        uidvalidity: "200",
        uid: "22"
      }
    ];
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      return sql.includes("WHERE m.id = $1") ? { rows: [assignedSeed] } : { rows: physicalCopies };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as never;

    const { setThreadFlags } = await import("../mailbox-mutations.js");
    const result = await setThreadFlags(pool, config, "msg-1", { add: ["seen"] });

    expect(result.messageIds).toEqual(["msg-inbox", "msg-sent"]);
    expect(query.mock.calls.some(([sql]) =>
      sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    )).toBe(true);
    expect(mutator.addFlags).toHaveBeenCalledTimes(2);
    expect(mutator.addFlags.mock.calls.map(([target]) => target.folderPath)).toEqual(["INBOX", "Sent"]);
    const seedCall = query.mock.calls.find(([sql]) => String(sql).includes("WHERE m.id = $1"));
    const membersCall = query.mock.calls.find(([sql]) => String(sql).includes("assignment.conversation_id = $2"));
    expect(String(seedCall?.[0])).toContain("public.imap_thread_active_assignments assignment");
    expect(String(membersCall?.[0])).toContain("public.imap_thread_active_assignments assignment");
    expect(String(membersCall?.[0])).not.toContain("message_id_normalized");
    expect(membersCall?.[1]).toEqual(["acc-1", "conversation-1", 101]);
  });

  it("interleaves the write-through so an earlier member's mirror write persists before a mid-thread STORE failure", async () => {
    const pool = poolReturningMembers(members(3));
    // The 2nd member's STORE fails — the 1st member's write-through must already
    // have run (interleaved), unlike the old STORE-all-then-write-all shape.
    mutator.addFlags
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("STORE failed"));
    const { setThreadFlags } = await import("../mailbox-mutations.js");
    await expect(setThreadFlags(pool, config, "msg-1", { add: ["seen"] })).rejects.toThrow(/STORE failed/);
    // Member 1's mirror write-through ran before the member-2 failure aborted the loop.
    expect(repo.applyMessageFlags).toHaveBeenCalledTimes(1);
    expect(repo.applyMessageFlags).toHaveBeenCalledWith("msg-1", "acc-1", { add: ["\\Seen"], remove: [] });
  });

  it("surfaces a mirrorWriteThroughStale count when a member's write-through fails", async () => {
    const pool = poolReturningMembers(members(2));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    repo.applyMessageFlags.mockResolvedValueOnce(["\\Seen"]).mockResolvedValueOnce(null as never);
    const { setThreadFlags } = await import("../mailbox-mutations.js");
    const result = await setThreadFlags(pool, config, "msg-1", { add: ["seen"] });
    expect(result.messageCount).toBe(2);
    expect(result.mirrorWriteThroughStale).toBe(1);
    warn.mockRestore();
  });

  it("moveThread caps fan-out at 100 and reports truncated", async () => {
    const pool = poolReturningMembers(members(101));
    const { moveThread } = await import("../mailbox-mutations.js");
    const result = await moveThread(pool, config, "msg-1", "Archive");
    expect(result.truncated).toBe(true);
    // Every capped member is in INBOX, none already in Archive, so all 100 move.
    expect(mutator.move).toHaveBeenCalledTimes(100);
    expect(result.messageCount).toBe(100);
  });
});
