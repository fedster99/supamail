import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The one shared IMAP connect prelude (CC-1, ADR 0022). This test pins the
 * security-load-bearing behavior that used to be copied four times and had drifted:
 * if `connect()` throws (an auth/TLS failure), the socket is CLOSED before the error
 * is rethrown, so it cannot leak. Because every IMAP client now obtains its socket
 * from `connectImap`, this single Seam protects all four — the read-sync
 * ThrottledImapClient, the append-only SentFolderAppender, the mutation
 * MailboxMutator, and the download/fetch ContentImapClient — uniformly.
 *
 * It also pins that the SSRF guard and credential decrypt run before construction,
 * and the shared UIDVALIDITY fail-closed comparison used by the mutate + fetch
 * paths. imapflow, crypto, and host-validation are mocked so nothing connects.
 */

const fake = vi.hoisted(() => ({
  connectImpl: vi.fn(async () => undefined),
  close: vi.fn(),
  lastClient: undefined as { emit(event: string, error: Error): boolean } | undefined,
  lastOptions: undefined as unknown
}));

vi.mock("imapflow", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ImapFlow: class extends EventEmitter {
      constructor(options: unknown) {
        super();
        fake.lastClient = this;
        fake.lastOptions = options;
      }
      connect = fake.connectImpl;
      close = fake.close;
    }
  };
});

const assertSafe = vi.hoisted(() => vi.fn(async () => undefined));
const decrypt = vi.hoisted(() => vi.fn(async () => "secret"));

vi.mock("../host-validation.js", () => ({
  assertSafeImapTarget: assertSafe,
  HostValidationError: class extends Error {}
}));

vi.mock("../crypto.js", () => ({
  decryptPassword: decrypt
}));

const { connectImap, uidValidityMatches, uidValidityMismatchMessage } = await import("../imap-connect.js");

const config = {
  IMAP_ENCRYPTION_KEY: "0123456789abcdef",
  IMAP_ALLOW_PRIVATE_HOSTS: false,
  CONNECT_TIMEOUT_MS: 15000,
  IMAP_COMMAND_TIMEOUT_MS: 30000,
  IMAP_IDLE_MAX_TIME_MS: 1_500_000,
  IMAP_IDLE_SOCKET_TIMEOUT_MS: 1_800_000
} as never;

const account = {
  id: "acc-1",
  host: "imap.example.test",
  port: 993,
  secure: true,
  username: "user@example.test",
  encrypted_password: Buffer.from("x")
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  fake.connectImpl.mockResolvedValue(undefined);
  assertSafe.mockResolvedValue(undefined);
  decrypt.mockResolvedValue("secret");
});

describe("connectImap (the one shared connect prelude)", () => {
  it("closes the socket when connect() throws (no leak — the drift fix, now uniform)", async () => {
    fake.connectImpl.mockRejectedValue(new Error("TLS handshake failed"));
    await expect(connectImap({} as never, config, account)).rejects.toThrow(/TLS handshake/);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("returns the connected client and never closes it on success", async () => {
    const client = await connectImap({} as never, config, account);
    expect(client).toBeTruthy();
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("closes a pending connection when its scheduler signal aborts", async () => {
    fake.connectImpl.mockImplementation(async () => await new Promise(() => undefined));
    const abort = new AbortController();
    const connecting = connectImap({} as never, config, account, { signal: abort.signal });

    await vi.waitFor(() => expect(fake.connectImpl).toHaveBeenCalledTimes(1));
    abort.abort();

    await expect(connecting).rejects.toThrow(/interrupted/);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("does not crash when ImapFlow emits its late logged-out error after an intentional connect abort", async () => {
    fake.connectImpl.mockImplementation(async () => await new Promise(() => undefined));
    const abort = new AbortController();
    const connecting = connectImap({} as never, config, account, { signal: abort.signal });

    await vi.waitFor(() => expect(fake.connectImpl).toHaveBeenCalledTimes(1));
    abort.abort();
    await expect(connecting).rejects.toThrow(/interrupted/);

    const lateError = Object.assign(new Error("Already logged out"), {
      name: "AuthenticationFailure",
      authenticationFailed: true
    });
    expect(() => fake.lastClient?.emit("error", lateError)).not.toThrow();
  });

  it("reports unrelated ImapFlow lifecycle errors without logging their message", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await connectImap({} as never, config, account);

    const lifecycleError = Object.assign(new Error("LOGIN user@example.test super-secret"), {
      name: "ProviderFailure",
      code: "EPROTO",
      responseStatus: "NO"
    });
    expect(() => fake.lastClient?.emit("error", lifecycleError)).not.toThrow();

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorLog.mock.calls[0][0])).toEqual({
      event: "imap.client.error",
      error: { name: "ProviderFailure", code: "EPROTO", responseStatus: "NO" }
    });
    expect(errorLog.mock.calls[0][0]).not.toContain("super-secret");
  });

  it("never starts a connection when its scheduler signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(connectImap({} as never, config, account, { signal: abort.signal })).rejects.toThrow(/interrupted/);
    expect(fake.connectImpl).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("runs the SSRF guard and decrypts the password before constructing the client", async () => {
    await connectImap({} as never, config, account);
    expect(assertSafe).toHaveBeenCalledWith("imap.example.test", 993, true, { allowPrivateHosts: false });
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it("wires the exact timeout options onto ImapFlow", async () => {
    await connectImap({} as never, config, account);
    expect(fake.lastOptions).toMatchObject({
      host: "imap.example.test",
      port: 993,
      secure: true,
      auth: { user: "user@example.test", pass: "secret" },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000
    });
  });

  it("uses idle-safe timeouts and explicit IDLE control for a watcher socket", async () => {
    await connectImap({} as never, config, account, { purpose: "idle" });
    expect(fake.lastOptions).toMatchObject({
      socketTimeout: 1_800_000,
      maxIdleTime: 1_500_000,
      disableAutoIdle: true
    });
  });

  it("does not decrypt or construct when the SSRF guard rejects", async () => {
    assertSafe.mockRejectedValueOnce(new Error("private_host_denied"));
    await expect(connectImap({} as never, config, account)).rejects.toThrow(/private_host_denied/);
    expect(decrypt).not.toHaveBeenCalled();
    expect(fake.connectImpl).not.toHaveBeenCalled();
  });
});

describe("shared UIDVALIDITY fail-closed comparison (CC-4)", () => {
  it("matches when no mailbox is selected (cannot prove a mismatch → allow)", () => {
    expect(uidValidityMatches(false, 100)).toBe(true);
    expect(uidValidityMatches(null, 100)).toBe(true);
    expect(uidValidityMatches(undefined, 100)).toBe(true);
  });

  it("matches when the live UIDVALIDITY equals the mirrored value", () => {
    expect(uidValidityMatches({ uidValidity: 100 }, 100)).toBe(true);
    expect(uidValidityMatches({ uidValidity: 100n }, 100)).toBe(true);
  });

  it("does NOT match when the live UIDVALIDITY differs (fail closed)", () => {
    expect(uidValidityMatches({ uidValidity: 101 }, 100)).toBe(false);
  });

  it("builds the same mismatch message the mutate and fetch paths use verbatim", () => {
    expect(uidValidityMismatchMessage("INBOX", 100, 101, "mutate")).toBe(
      "UIDVALIDITY changed for INBOX (mirror 100 != server 101); refusing to mutate by stale UID"
    );
    expect(uidValidityMismatchMessage("INBOX", 100, 101, "fetch")).toBe(
      "UIDVALIDITY changed for INBOX (mirror 100 != server 101); refusing to fetch by stale UID"
    );
  });
});
