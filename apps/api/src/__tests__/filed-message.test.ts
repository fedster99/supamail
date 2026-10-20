import { describe, expect, it, vi } from "vitest";
import { buildRawMime } from "../smtp-client.js";
import { fileSentCopy, mirrorFiledMessage } from "../filed-message.js";

/**
 * ADR 0046: a message an action files is mirrored at once from the server's
 * APPENDUID. The row comes from the server's own metadata for that UID; the body
 * comes from the filed bytes when the server holds exactly that many bytes.
 */

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "22222222-2222-4222-8222-222222222222";
const sentFolder = { id: "folder-sent", account_id: ACCOUNT_ID, path: "Sent", uidvalidity: "100" };
const account = { id: ACCOUNT_ID, provider_profile: "generic-imap", email_address: "user@example.test" };

function testConfig(overrides: Record<string, unknown> = {}) {
  return {
    IMAP_MAX_COMMANDS_PER_MINUTE: 1_000,
    IMAP_COMMAND_TIMEOUT_MS: 5_000,
    BODY_RAW_MAX_BYTES: 25 * 1024 * 1024,
    BODY_STORAGE_MODE: "parsed_only",
    ...overrides
  } as never;
}

async function filedRaw(): Promise<Buffer> {
  const { raw } = await buildRawMime({
    accountId: ACCOUNT_ID,
    to: [{ email: "rcpt@example.test" }],
    subject: "Quarterly numbers",
    body: { format: "plain", text: "Here are the numbers." }
  }, { email: "user@example.test" });
  return raw;
}

/** One action socket whose server holds `raw` at UID 7 in a folder at UIDVALIDITY 100. */
function fakeSocket(raw: Buffer, { uidValidity = 100n, size = raw.length } = {}) {
  const calls: string[] = [];
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>(),
    mailbox: null as null | { path: string; uidValidity: bigint },
    append: vi.fn(async () => ({ uid: 7, uidValidity: 100n })),
    list: vi.fn(async () => [{ path: "INBOX" }, { path: "Sent", specialUse: "\\Sent" }]),
    mailboxOpen: vi.fn(async (path: string) => {
      calls.push(`reselect ${path}`);
      client.mailbox = { path, uidValidity };
    }),
    getMailboxLock: vi.fn(async (path: string) => {
      calls.push(`select ${path}`);
      client.mailbox = { path, uidValidity };
      return { release: () => calls.push(`release ${path}`) };
    }),
    fetch: vi.fn(async function* (range: number[]) {
      calls.push(`fetch ${range.join(",")}`);
      yield {
        uid: 7,
        flags: new Set(["\\Seen"]),
        internalDate: new Date("2026-10-18T10:00:00Z"),
        size,
        envelope: {
          subject: "Quarterly numbers",
          messageId: "<server@example.test>",
          from: [{ address: "user@example.test", name: "User" }],
          to: [{ address: "rcpt@example.test" }]
        },
        headers: Buffer.from("Message-ID: <server@example.test>\r\n\r\n"),
        bodyStructure: { type: "text/plain", part: "1", size: 21 }
      };
    })
  };
  return { socket: { client, abort: { run: <T>(command: () => Promise<T>) => command() } }, client, calls };
}

function fakeRepository(folders: unknown[] = [sentFolder]) {
  const order: string[] = [];
  return {
    order,
    getFoldersForWake: vi.fn(async () => folders),
    upsertMessages: vi.fn(async (
      _accountId: string,
      _folder: unknown,
      _uidValidity: number,
      messages: Array<{ uid: number; mimeStructure?: unknown }>,
      _options?: { deadlineAt?: number }
    ) => {
      order.push("upsert");
      return messages.map((message) => ({
        id: ROW_ID, uid: String(message.uid), body_fetched_at: null, headers_json: {}, size_bytes: "0"
      }));
    }),
    storeBodyEvidence: vi.fn(async () => { order.push("evidence"); }),
    completeBodyStorage: vi.fn(async () => { order.push("complete"); })
  };
}

function fakeBodyStore(order: string[]) {
  return { store: vi.fn(async () => { order.push("store"); }) };
}

describe("mirrorFiledMessage", () => {
  it("writes the row from the server's metadata and the body from the filed bytes", async () => {
    const raw = await filedRaw();
    const { socket, calls } = fakeSocket(raw);
    const repository = fakeRepository();
    const bodyStore = fakeBodyStore(repository.order);
    const warn = vi.fn();

    const id = await mirrorFiledMessage(repository as never, testConfig(), bodyStore, socket as never, ACCOUNT_ID,
      { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, warn);

    expect(id).toBe(ROW_ID);
    expect(repository.getFoldersForWake).toHaveBeenCalledWith(ACCOUNT_ID, ["Sent"]);
    // One SELECT and one FETCH of the named UID, on the action's own socket.
    expect(calls).toEqual(["select Sent", "fetch 7", "release Sent"]);
    const [accountId, folder, uidValidity, [metadata], options] = repository.upsertMessages.mock.calls[0];
    expect([accountId, folder, uidValidity]).toEqual([ACCOUNT_ID, sentFolder, 100]);
    // The server's view, not composed values.
    expect(metadata).toMatchObject({
      uid: 7, sizeBytes: raw.length, flags: ["\\Seen"], rfcMessageId: "<server@example.test>", fromName: "User"
    });
    expect(metadata.mimeStructure).not.toBeNull();
    expect(options?.deadlineAt).toBeLessThanOrEqual(Date.now() + 5_000);

    const [body] = repository.storeBodyEvidence.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(body).toMatchObject({
      messageId: ROW_ID, rawBytes: raw.length, rawTruncated: false, selectedTextPart: "1", selectedTextFormat: "plain"
    });
    expect(String(body.bodyText)).toContain("Here are the numbers.");
    // Parsed-only keeps no raw bytes, but still fingerprints them.
    expect((body.rawMime as Buffer).length).toBe(0);
    expect(body.rawMimeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyStore.store).toHaveBeenCalledWith(body);
    expect(repository.completeBodyStorage).toHaveBeenCalledWith(ROW_ID);
    // Evidence, then the store, then the row is marked readable — the body lane's order.
    expect(repository.order).toEqual(["upsert", "evidence", "store", "complete"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("selects the folder again when it is still selected from before the APPEND", async () => {
    const raw = await filedRaw();
    const { socket, client, calls } = fakeSocket(raw);
    // e.g. a draft's idempotency search selected Drafts before the APPEND.
    client.mailbox = { path: "Sent", uidValidity: 100n };
    const repository = fakeRepository();
    await mirrorFiledMessage(repository as never, testConfig(), fakeBodyStore(repository.order), socket as never, ACCOUNT_ID,
      { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, vi.fn());
    expect(calls).toEqual(["reselect Sent", "select Sent", "fetch 7", "release Sent"]);
  });

  it("does not store a body the row already has", async () => {
    const raw = await filedRaw();
    const { socket } = fakeSocket(raw);
    const repository = fakeRepository();
    repository.upsertMessages.mockImplementationOnce(async () => {
      repository.order.push("upsert");
      return [{ id: ROW_ID, uid: "7", body_fetched_at: new Date(), headers_json: {}, size_bytes: "0" }] as never;
    });
    const id = await mirrorFiledMessage(repository as never, testConfig(), fakeBodyStore(repository.order), socket as never,
      ACCOUNT_ID, { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, vi.fn());
    expect(id).toBe(ROW_ID);
    expect(repository.order).toEqual(["upsert"]);
  });

  it("keeps the raw bytes when the host retains raw MIME", async () => {
    const raw = await filedRaw();
    const { socket } = fakeSocket(raw);
    const repository = fakeRepository();
    await mirrorFiledMessage(repository as never, testConfig({ BODY_STORAGE_MODE: "raw_mime" }),
      fakeBodyStore(repository.order), socket as never, ACCOUNT_ID,
      { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, vi.fn());
    const [body] = repository.storeBodyEvidence.mock.calls[0] as unknown as [{ rawMime: Buffer }];
    expect(body.rawMime.equals(raw)).toBe(true);
  });

  it.each([
    ["the folder is not tracked", []],
    ["the mirrored folder has another UIDVALIDITY", [{ ...sentFolder, uidvalidity: "99" }]],
    ["sync has not read the folder yet", [{ ...sentFolder, uidvalidity: null }]]
  ])("leaves the message to sync without a provider read when %s", async (_case, folders) => {
    const raw = await filedRaw();
    const { socket, calls } = fakeSocket(raw);
    const repository = fakeRepository(folders);
    const id = await mirrorFiledMessage(repository as never, testConfig(), fakeBodyStore([]), socket as never, ACCOUNT_ID,
      { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, vi.fn());
    expect(id).toBeNull();
    expect(calls).toEqual([]);
    expect(repository.upsertMessages).not.toHaveBeenCalled();
  });

  it("writes nothing when the selected folder's UIDVALIDITY differs from the APPENDUID's", async () => {
    const raw = await filedRaw();
    const { socket, calls } = fakeSocket(raw, { uidValidity: 101n });
    const repository = fakeRepository();
    const id = await mirrorFiledMessage(repository as never, testConfig(), fakeBodyStore([]), socket as never, ACCOUNT_ID,
      { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, vi.fn());
    expect(id).toBeNull();
    expect(calls).toEqual(["select Sent", "release Sent"]);
    expect(repository.upsertMessages).not.toHaveBeenCalled();
  });

  it("leaves the body to the body lane when the server holds another byte count", async () => {
    const raw = await filedRaw();
    // e.g. the server added a header to the stored copy.
    const { socket } = fakeSocket(raw, { size: raw.length + 40 });
    const repository = fakeRepository();
    const bodyStore = fakeBodyStore(repository.order);
    const id = await mirrorFiledMessage(repository as never, testConfig(), bodyStore, socket as never, ACCOUNT_ID,
      { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, vi.fn());
    expect(id).toBe(ROW_ID);
    expect(repository.order).toEqual(["upsert"]);
  });

  it("leaves the body to the body lane when the bytes reach the body cap", async () => {
    const raw = await filedRaw();
    const { socket } = fakeSocket(raw);
    const repository = fakeRepository();
    const id = await mirrorFiledMessage(repository as never, testConfig({ BODY_RAW_MAX_BYTES: raw.length }),
      fakeBodyStore(repository.order), socket as never, ACCOUNT_ID,
      { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, vi.fn());
    expect(id).toBe(ROW_ID);
    expect(repository.order).toEqual(["upsert"]);
  });

  it("keeps the id and warns when the body store fails", async () => {
    const raw = await filedRaw();
    const { socket } = fakeSocket(raw);
    const repository = fakeRepository();
    const bodyStore = { store: vi.fn(async () => { throw new Error("storage unavailable"); }) };
    const warn = vi.fn();
    const id = await mirrorFiledMessage(repository as never, testConfig(), bodyStore, socket as never, ACCOUNT_ID,
      { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, warn);
    expect(id).toBe(ROW_ID);
    // Not marked readable: the body lane stores it later.
    expect(repository.completeBodyStorage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("Mirrored, but the body is readable only after the next sync: storage unavailable.");
  });

  it("throws when the server returns no metadata for the named UID", async () => {
    const raw = await filedRaw();
    const { socket, client } = fakeSocket(raw);
    client.fetch.mockImplementationOnce(async function* () {});
    const repository = fakeRepository();
    await expect(mirrorFiledMessage(repository as never, testConfig(), fakeBodyStore([]), socket as never, ACCOUNT_ID,
      { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw }, vi.fn())).rejects.toThrow(/missing 7/);
    expect(repository.upsertMessages).not.toHaveBeenCalled();
  });
});

describe("fileSentCopy", () => {
  function connectionOver(socket: unknown) {
    return { get: vi.fn(async () => socket), close: vi.fn() };
  }

  it("files the delivered bytes to Sent with \\Seen and returns the copy's mirror id", async () => {
    const raw = await filedRaw();
    const { socket, client } = fakeSocket(raw);
    const repository = fakeRepository();
    const warn = vi.fn();
    const copy = await fileSentCopy(repository as never, testConfig(), fakeBodyStore(repository.order), account as never,
      connectionOver(socket) as never, raw, warn);
    expect(client.append).toHaveBeenCalledWith("Sent", raw, ["\\Seen"], expect.any(Date));
    expect(copy).toEqual({ appendedToSent: true, appendedUid: 7, sentFolderPath: "Sent", messageId: ROW_ID });
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves the copy to sync when the server returns no APPENDUID", async () => {
    const raw = await filedRaw();
    const { socket, client } = fakeSocket(raw);
    client.append.mockResolvedValueOnce(true as never);
    const repository = fakeRepository();
    const copy = await fileSentCopy(repository as never, testConfig(), fakeBodyStore([]), account as never,
      connectionOver(socket) as never, raw, vi.fn());
    expect(copy).toEqual({ appendedToSent: true, appendedUid: null, sentFolderPath: "Sent", messageId: null });
    expect(repository.getFoldersForWake).not.toHaveBeenCalled();
  });

  it("warns, never throws, when filing fails after delivery", async () => {
    const raw = await filedRaw();
    const { socket, client } = fakeSocket(raw);
    client.append.mockRejectedValueOnce(new Error("NO [OVERQUOTA]"));
    const warn = vi.fn();
    const copy = await fileSentCopy(fakeRepository() as never, testConfig(), fakeBodyStore([]), account as never,
      connectionOver(socket) as never, raw, warn);
    expect(copy).toEqual({ appendedToSent: false, appendedUid: null, sentFolderPath: "Sent", messageId: null });
    expect(warn).toHaveBeenCalledWith(
      "Delivered, but filing to Sent failed: NO [OVERQUOTA]. The next sync will mirror the copy if the provider auto-filed it."
    );
  });

  it("keeps the filed copy and warns when its mirror fails", async () => {
    const raw = await filedRaw();
    const { socket } = fakeSocket(raw);
    const repository = fakeRepository();
    repository.upsertMessages.mockRejectedValueOnce(new Error("database unavailable"));
    const warn = vi.fn();
    const copy = await fileSentCopy(repository as never, testConfig(), fakeBodyStore([]), account as never,
      connectionOver(socket) as never, raw, warn);
    expect(copy).toEqual({ appendedToSent: true, appendedUid: 7, sentFolderPath: "Sent", messageId: null });
    expect(warn).toHaveBeenCalledWith("Delivered, but the sent copy is readable only after the next sync: database unavailable.");
  });
});
