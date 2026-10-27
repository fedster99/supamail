import { expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { buildRawMime } from "../smtp-client.js";
import { fileSentCopy, mirrorFiledMessage } from "../filed-message.js";

const account = { id: "11111111-1111-4111-8111-111111111111", provider_profile: "generic-imap" };
const rowId = "22222222-2222-4222-8222-222222222222";
const folder = { path: "Sent", uidvalidity: "100" };
const config = {
  IMAP_MAX_COMMANDS_PER_MINUTE: 1_000, IMAP_COMMAND_TIMEOUT_MS: 5_000,
  BODY_RAW_MAX_BYTES: 25 * 1024 * 1024, BODY_STORAGE_MODE: "parsed_only"
} as AppConfig;

async function fixture(text = "The filed bytes.") {
  const { raw } = await buildRawMime({ accountId: account.id, to: [{ email: "rcpt@example.test" }],
    subject: "Filed body", body: { format: "plain", text } }, { email: "sender@example.test" });
  const server = { uidValidity: 100n, size: raw.length };
  const client = {
    usable: true, capabilities: new Map(),
    mailbox: { path: "Sent", uidValidity: 100n },
    append: vi.fn(async () => ({ uid: 7, uidValidity: 100n })),
    list: async () => [{ path: "Sent", specialUse: "\\Sent" }],
    mailboxOpen: async () => { client.mailbox = { path: "Sent", uidValidity: server.uidValidity }; },
    getMailboxLock: async () => ({ release() {} }),
    fetch: vi.fn(async function* () {
      yield { uid: 7, flags: new Set(["\\Seen"]), internalDate: new Date(), size: server.size,
        envelope: { subject: "Server subject", messageId: "<server@example.test>" },
        headers: Buffer.from("Message-ID: <server@example.test>\r\n\r\n"),
        bodyStructure: { type: "text/plain", part: "1" } };
    })
  };
  const repository = {
    getFoldersForWake: vi.fn(async (): Promise<unknown[]> => [folder]),
    upsertMessages: vi.fn(async () => [{ id: rowId, body_fetched_at: null as Date | null, headers_json: {} }]),
    storeBodyEvidence: vi.fn(async () => {}),
    completeBodyStorage: vi.fn(async () => {})
  };
  const store = { store: vi.fn(async (_body: unknown) => {}) };
  const warn = vi.fn();
  const socket = { client, abort: { run: <T>(fn: () => Promise<T>) => fn() } };
  return { raw, server, client, repository, store, warn,
    mirror: (settings = config, filedRaw: Buffer | null = raw) => mirrorFiledMessage(repository as never, settings,
      store, socket as never, account.id, { folderPath: "Sent", appended: { uid: 7, uidValidity: 100 }, raw: filedRaw }, warn),
    sent: () => fileSentCopy(repository as never, config, store, account as never,
      { get: async () => socket } as never, raw, warn) };
}

it("stores the filed body as the body lane does: evidence, host store, then readable", async () => {
  const f = await fixture();
  expect(await f.mirror()).toBe(rowId);
  expect(f.store.store).toHaveBeenCalledWith(expect.objectContaining({ messageId: rowId,
    bodyText: expect.stringContaining("The filed bytes."), rawTruncated: false }));
  expect(f.repository.completeBodyStorage).toHaveBeenCalledWith(rowId);
  const order = [f.repository.storeBodyEvidence, f.store.store, f.repository.completeBodyStorage]
    .map((step) => step.mock.invocationCallOrder[0]);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(f.warn).not.toHaveBeenCalled();
});

it("never writes a row without matching tracked and provider folder identities", async () => {
  for (const folders of [[], [{ ...folder, uidvalidity: null }], [{ ...folder, uidvalidity: "99" }]]) {
    const f = await fixture();
    f.repository.getFoldersForWake.mockResolvedValue(folders);
    expect(await f.mirror()).toBeNull();
    expect(f.repository.upsertMessages).not.toHaveBeenCalled();
  }
  const f = await fixture();
  f.server.uidValidity = 101n;
  expect(await f.mirror()).toBeNull();
  expect(f.repository.upsertMessages).not.toHaveBeenCalled();
});

it("keeps the row but leaves unsafe or already stored bodies alone", async () => {
  for (const reason of ["size changed", "at cap", "already stored", "no filed bytes", "over batch bound"]) {
    const f = reason === "over batch bound" ? await fixture("x".repeat(4 * 1024 * 1024)) : await fixture();
    if (reason === "size changed") f.server.size++;
    if (reason === "already stored") {
      f.repository.upsertMessages.mockResolvedValue([{ id: rowId, body_fetched_at: new Date(), headers_json: {} }]);
    }
    expect(await f.mirror(reason === "at cap" ? { ...config, BODY_RAW_MAX_BYTES: f.raw.length } : config,
      reason === "no filed bytes" ? null : f.raw)).toBe(rowId);
    expect(f.store.store).not.toHaveBeenCalled();
    expect(f.repository.completeBodyStorage).not.toHaveBeenCalled();
  }
});

it("returns the row id after a storage failure without claiming the body is readable", async () => {
  const f = await fixture();
  f.store.store.mockRejectedValue(new Error("storage unavailable"));
  expect(await f.mirror()).toBe(rowId);
  expect(f.repository.completeBodyStorage).not.toHaveBeenCalled();
  expect(f.warn).toHaveBeenCalled();
});

it("preserves confirmed Sent filing when the mirror write fails", async () => {
  const f = await fixture();
  f.repository.upsertMessages.mockRejectedValue(new Error("database unavailable"));
  expect(await f.sent()).toMatchObject({ appendedToSent: true, appendedUid: 7, messageId: null });
  expect(f.warn).toHaveBeenCalled();
  expect(f.client.append).toHaveBeenCalledTimes(1);
});
