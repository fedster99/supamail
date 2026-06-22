import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Direct unit coverage for the MailboxMutator IMAP verbs (email-002, ADR 0018),
 * exercising the safety guards that the library-function tests can't reach because
 * they mock the mutator wholesale:
 *
 *  - B1: hard delete (EXPUNGE) REFUSES when the server lacks UIDPLUS, and move
 *    REFUSES when the server lacks BOTH MOVE and UIDPLUS — never falling through to
 *    imapflow's blanket EXPUNGE that would purge unrelated \Deleted messages.
 *  - M2: STORE / MOVE / DELETE that return `false`/empty (imapflow's silent
 *    server-side failure signal) THROW instead of reporting success.
 *  - m4: a connect() that throws closes the socket (no leak).
 *
 * imapflow, crypto, and host-validation are mocked so nothing connects.
 */

// --- Fake ImapFlow whose capabilities/results we control per test. ---

interface FakeLock {
  release: () => void;
}

const fake = vi.hoisted(() => {
  return {
    capabilities: new Map<string, boolean>(),
    mailbox: { uidValidity: 100 } as { uidValidity: number } | false,
    connectImpl: vi.fn(async () => undefined),
    close: vi.fn(),
    logout: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async (_path: string): Promise<FakeLock> => ({ release: vi.fn() })),
    messageFlagsAdd: vi.fn(async () => true),
    messageFlagsRemove: vi.fn(async () => true),
    messageMove: vi.fn(async () => ({ uidMap: new Map<number, number>([[42, 99]]) })),
    messageDelete: vi.fn(async () => true)
  };
});

vi.mock("imapflow", () => ({
  ImapFlow: class {
    capabilities = fake.capabilities;
    get mailbox() {
      return fake.mailbox;
    }
    connect = fake.connectImpl;
    close = fake.close;
    logout = fake.logout;
    getMailboxLock = fake.getMailboxLock;
    messageFlagsAdd = fake.messageFlagsAdd;
    messageFlagsRemove = fake.messageFlagsRemove;
    messageMove = fake.messageMove;
    messageDelete = fake.messageDelete;
  }
}));

vi.mock("../crypto.js", () => ({
  decryptPassword: vi.fn(async () => "secret")
}));

vi.mock("../host-validation.js", () => ({
  assertSafeImapTarget: vi.fn(async () => undefined),
  HostValidationError: class extends Error {}
}));

const { MailboxMutator, MailboxCapabilityError, MailboxMutationError } = await import("../mailbox-mutations.js");

const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;
const account = {
  id: "acc-1",
  host: "imap.example.test",
  port: 993,
  secure: true,
  username: "user@example.test",
  encrypted_password: Buffer.from("x")
} as never;

const target = { messageId: "m1", accountId: "acc-1", folderPath: "INBOX", uidValidity: 100, uid: 42 };

beforeEach(() => {
  vi.clearAllMocks();
  fake.capabilities = new Map<string, boolean>();
  fake.mailbox = { uidValidity: 100 };
  fake.connectImpl.mockResolvedValue(undefined);
  fake.getMailboxLock.mockImplementation(async () => ({ release: vi.fn() }));
  fake.messageFlagsAdd.mockResolvedValue(true);
  fake.messageFlagsRemove.mockResolvedValue(true);
  fake.messageMove.mockResolvedValue({ uidMap: new Map<number, number>([[42, 99]]) });
  fake.messageDelete.mockResolvedValue(true);
});

describe("B1: capability gates refuse rather than risk a blanket EXPUNGE", () => {
  it("expunge() throws when the server lacks UIDPLUS and never STOREs \\Deleted or EXPUNGEs", async () => {
    fake.capabilities = new Map([["MOVE", true]]); // MOVE present, UIDPLUS absent
    const mutator = await MailboxMutator.connect({} as never, config, account);
    await expect(mutator.expunge(target)).rejects.toBeInstanceOf(MailboxCapabilityError);
    await expect(mutator.expunge(target)).rejects.toThrow(/UIDPLUS/);
    expect(fake.messageDelete).not.toHaveBeenCalled();
    expect(fake.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("expunge() proceeds when UIDPLUS is advertised", async () => {
    fake.capabilities = new Map([["UIDPLUS", true]]);
    const mutator = await MailboxMutator.connect({} as never, config, account);
    await expect(mutator.expunge(target)).resolves.toBe(true);
    expect(fake.messageFlagsAdd).toHaveBeenCalledWith("42", ["\\Deleted"], { uid: true });
    expect(fake.messageDelete).toHaveBeenCalledWith("42", { uid: true });
  });

  it("move() throws when the server lacks BOTH MOVE and UIDPLUS and never MOVEs", async () => {
    fake.capabilities = new Map(); // neither
    const mutator = await MailboxMutator.connect({} as never, config, account);
    await expect(mutator.move(target, "Archive")).rejects.toBeInstanceOf(MailboxCapabilityError);
    await expect(mutator.move(target, "Archive")).rejects.toThrow(/MOVE or UIDPLUS/);
    expect(fake.messageMove).not.toHaveBeenCalled();
  });

  it("move() proceeds with MOVE present", async () => {
    fake.capabilities = new Map([["MOVE", true]]);
    const mutator = await MailboxMutator.connect({} as never, config, account);
    const result = await mutator.move(target, "Archive");
    expect(result.uidMap?.get(42)).toBe(99);
    expect(fake.messageMove).toHaveBeenCalledWith("42", "Archive", { uid: true });
  });

  it("move() proceeds with UIDPLUS present (MOVE absent)", async () => {
    fake.capabilities = new Map([["UIDPLUS", true]]);
    const mutator = await MailboxMutator.connect({} as never, config, account);
    await expect(mutator.move(target, "Archive")).resolves.toMatchObject({});
    expect(fake.messageMove).toHaveBeenCalledTimes(1);
  });
});

describe("M2: a false/empty server result throws instead of reporting success", () => {
  it("addFlags throws when STORE returns false", async () => {
    fake.messageFlagsAdd.mockResolvedValue(false);
    const mutator = await MailboxMutator.connect({} as never, config, account);
    await expect(mutator.addFlags(target, ["\\Seen"])).rejects.toBeInstanceOf(MailboxMutationError);
  });

  it("removeFlags throws when STORE returns false", async () => {
    fake.messageFlagsRemove.mockResolvedValue(false);
    const mutator = await MailboxMutator.connect({} as never, config, account);
    await expect(mutator.removeFlags(target, ["\\Flagged"])).rejects.toBeInstanceOf(MailboxMutationError);
  });

  it("move throws when MOVE returns false", async () => {
    fake.capabilities = new Map([["MOVE", true]]);
    fake.messageMove.mockResolvedValue(false as never);
    const mutator = await MailboxMutator.connect({} as never, config, account);
    await expect(mutator.move(target, "Archive")).rejects.toBeInstanceOf(MailboxMutationError);
  });

  it("expunge throws when DELETE returns false", async () => {
    fake.capabilities = new Map([["UIDPLUS", true]]);
    fake.messageDelete.mockResolvedValue(false);
    const mutator = await MailboxMutator.connect({} as never, config, account);
    await expect(mutator.expunge(target)).rejects.toBeInstanceOf(MailboxMutationError);
  });
});

describe("m4: connect closes the socket on failure", () => {
  it("closes the client when connect() throws", async () => {
    fake.connectImpl.mockRejectedValue(new Error("TLS handshake failed"));
    await expect(MailboxMutator.connect({} as never, config, account)).rejects.toThrow(/TLS handshake/);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
