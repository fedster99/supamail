import { describe, expect, it, vi } from "vitest";
import {
  hashSendRequest, isValidIdempotencyKey, replaySendOperation, runSendOperation,
  sameSendOperation, SendOperationError,
  type SendOperation, type SendOperationIdentity, type SendOperationStatus,
  type SendOperationStore, type StoredSendError,
} from "./send-operations.js";
import { AbortError, AccountBusyError, InvalidInputError, NoRecipientsError, NotFoundError } from "./errors.js";
import { HostValidationError } from "./host-validation.js";
import { SmtpDeliveryError } from "./smtp-client.js";
import { sendMessage } from "./send.js";
import { sendDraft } from "./drafts.js";
import type { AppConfig } from "./config.js";
import type { PgPool } from "./db.js";

type Receipt = { delivered: true; recovered?: boolean };
class MemoryStore implements SendOperationStore<Receipt> {
  rows = new Map<string, SendOperation<Receipt>>();
  async get(key: string) { return this.rows.get(key) ?? null; }
  async refresh(key: string) { return this.rows.get(key)!; }
  async start(input: SendOperationIdentity) {
    const row = this.rows.get(input.operationKey);
    if (row) {
      if (sameSendOperation(row, input) && row.status === "not_delivered") {
        row.status = "submitting";
        return { claimed: true, row };
      }
      return { claimed: false, row };
    }
    const created: SendOperation<Receipt> = { ...input, status: "submitting", result: null, error: null };
    this.rows.set(input.operationKey, created);
    return { claimed: true, row: created };
  }
  async finish(key: string, status: SendOperationStatus, result: Receipt | null, error: StoredSendError | null) {
    const row = this.rows.get(key)!;
    if (row.status !== "succeeded") Object.assign(row, { status, result, error });
    return row;
  }
}
const input = {
  operationKey: "request-1", action: "send_email", accountId: "mailbox-1",
  request: { subject: "Hello", to: ["recipient@example.com"] }, rfcMessageId: "<stable@example.com>",
};
const receipt: Receipt = { delivered: true };
function setup() { return { ...input, store: new MemoryStore(), execute: vi.fn(async () => receipt) }; }
const unavailable = async (): Promise<never> => { throw new Error("storage unavailable"); };

describe("durable send operations", () => {
  it("keeps existing key and request-hash semantics", () => {
    for (const key of ["k", "😀".repeat(200)]) expect(isValidIdempotencyKey(key)).toBe(true);
    for (const key of [undefined, 42, "", " \t\n", "😀".repeat(201)]) expect(isValidIdempotencyKey(key)).toBe(false);
    expect(hashSendRequest({ subject: "Hello", to: ["recipient@example.com"], cc: undefined }))
      .toBe(hashSendRequest({ to: ["recipient@example.com"], subject: "Hello" }));
    expect(hashSendRequest([undefined])).toBe(hashSendRequest([null]));
  });
  it("rejects invalid keys before storage or provider work", async () => {
    const args = setup();
    const get = vi.spyOn(args.store, "get");
    for (const operationKey of ["", " ", "a".repeat(201)]) {
      await expect(runSendOperation({ ...args, operationKey })).rejects.toMatchObject({ code: "idempotency_required" });
      await expect(replaySendOperation({ ...args, operationKey })).rejects.toBeInstanceOf(SendOperationError);
    }
    expect(get).not.toHaveBeenCalled();
    expect(args.execute).not.toHaveBeenCalled();
  });
  it("replays success across caller restarts, before resolving deleted draft content", async () => {
    const args = setup();
    expect(await runSendOperation(args)).toEqual(receipt);
    expect(await runSendOperation({ ...args, execute: unavailable })).toEqual(receipt);
    expect(await replaySendOperation(args)).toEqual({ found: true, result: receipt });
    expect(args.execute).toHaveBeenCalledTimes(1);
  });
  it("admits only one concurrent submission", async () => {
    const args = setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    args.execute.mockImplementation(async () => { entered(); await blocked; return receipt; });
    const first = runSendOperation(args);
    await started;
    await expect(runSendOperation(args)).rejects.toMatchObject({ code: "operation_in_progress" });
    release();
    await first;
    expect(args.execute).toHaveBeenCalledTimes(1);
  });
  it("rejects changed content, action, mailbox or Message-ID for a used key", async () => {
    const args = setup();
    await runSendOperation(args);
    for (const change of [{ request: {} }, { action: "send_draft" }, { accountId: "other" }, { rfcMessageId: "<other@example.com>" }]) {
      await expect(runSendOperation({ ...args, ...change })).rejects.toMatchObject({ code: "idempotency_conflict" });
    }
    await expect(replaySendOperation({ ...args, request: {} })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(args.execute).toHaveBeenCalledTimes(1);
  });
  it.each([
    new SmtpDeliveryError("not_delivered", "rejected"), new AccountBusyError("busy"),
    new InvalidInputError("invalid"), new NoRecipientsError("empty"), new NotFoundError("missing"),
    new HostValidationError("unsafe_host", "unsafe"),
  ])("retries typed proven non-delivery: $name", async (error) => {
    const args = setup();
    args.execute.mockRejectedValueOnce(error);
    await expect(runSendOperation(args)).rejects.toBe(error);
    expect(await replaySendOperation(args)).toEqual({ found: false, accountId: input.accountId });
    expect(await runSendOperation(args)).toEqual(receipt);
    expect(args.execute).toHaveBeenCalledTimes(2);
  });
  it.each(["send_email", "send_draft"] as const)("retries %s after the real primitive aborts before SMTP", async (action) => {
    // Cancellation must return before either primitive touches these dependencies.
    const query = vi.fn(() => { throw new Error("Unexpected database query"); });
    const connect = vi.fn(() => { throw new Error("Unexpected database connection"); });
    const pool = { query, connect } as unknown as PgPool;
    const config = {} as AppConfig;
    const signal = AbortSignal.abort();
    const request = {
      accountId: "11111111-1111-4111-8111-111111111111",
      to: [{ email: "recipient@example.test" }], subject: "Cancellation fixture",
      body: { format: "plain" as const, text: "Fixture" },
    };
    const execute = vi.fn(async (): Promise<Receipt> => {
      if (action === "send_email") {
        await sendMessage(pool, config, request, undefined, { signal });
      } else {
        await sendDraft(pool, config, "draft-fixture", undefined, { signal });
      }
      return receipt;
    });
    const args = { ...setup(), action, accountId: request.accountId, request, execute };

    await expect(runSendOperation(args)).rejects.toBeInstanceOf(AbortError);
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect((await args.store.get(args.operationKey))?.status).toBe("not_delivered");
    expect(await replaySendOperation(args)).toEqual({ found: false, accountId: request.accountId });

    // The next caller is no longer cancelled. It can claim the SAME key once.
    execute.mockResolvedValue(receipt);
    expect(await runSendOperation(args)).toEqual(receipt);
    expect(await runSendOperation(args)).toEqual(receipt);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each([
    new SmtpDeliveryError("unknown", "response lost"), new Error("unclassified"),
    new SmtpDeliveryError("unknown", "response lost during cancellation", { cause: new AbortError() }),
    Object.assign(new Error("unproven cancellation"), { name: "AbortError" }),
    Object.assign(new Error("forged"), { name: "SmtpDeliveryError", outcome: "not_delivered" }),
  ])("never retries uncertain or untyped errors: $message", async (error) => {
    const args = setup();
    args.execute.mockRejectedValue(error);
    await expect(runSendOperation(args)).rejects.toMatchObject({ code: "delivery_unknown" });
    await expect(runSendOperation(args)).rejects.toMatchObject({ code: "delivery_unknown" });
    await expect(replaySendOperation({ ...args, reconcile: unavailable })).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(args.execute).toHaveBeenCalledTimes(1);
  });
  it("checks Sent before claiming, so a failed lookup does not strand unsent work", async () => {
    const args = setup();
    await expect(runSendOperation({ ...args, reconcile: unavailable })).rejects.toThrow("storage unavailable");
    expect(args.store.rows.size).toBe(0);
    expect(args.execute).not.toHaveBeenCalled();
    expect(await runSendOperation(args)).toEqual(receipt);
  });
  it("recovers from operation-specific Sent evidence without another submission", async () => {
    const args = setup();
    args.execute.mockRejectedValue(new SmtpDeliveryError("unknown", "lost response"));
    await expect(runSendOperation(args)).rejects.toMatchObject({ code: "delivery_unknown" });
    const recovered: Receipt = { delivered: true, recovered: true };
    expect(await runSendOperation({ ...args, reconcile: async () => recovered })).toEqual(recovered);
    expect(await replaySendOperation(args)).toEqual({ found: true, result: recovered });
    expect(args.execute).toHaveBeenCalledTimes(1);
  });
  it("can recover pre-ledger evidence before sending", async () => {
    const args = setup();
    expect(await runSendOperation({ ...args, reconcile: async () => receipt })).toEqual(receipt);
    expect(args.execute).not.toHaveBeenCalled();
  });
  it("does not submit if durable claim storage is unavailable", async () => {
    const args = setup();
    args.store.start = unavailable;
    await expect(runSendOperation(args)).rejects.toThrow("storage unavailable");
    expect(args.execute).not.toHaveBeenCalled();
  });
  it("checks the atomic claim result after a competing request wins", async () => {
    const args = setup();
    args.store.start = async (identity) => ({ claimed: false, row: {
      ...identity, requestHash: "different", status: "submitting", result: null, error: null,
    } });
    await expect(runSendOperation(args)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(args.execute).not.toHaveBeenCalled();
  });
  it("preserves known success when the ledger completion write fails", async () => {
    const args = setup();
    args.store.finish = unavailable;
    expect(await runSendOperation(args)).toEqual(receipt);
    await expect(runSendOperation(args)).rejects.toMatchObject({ code: "operation_in_progress" });
    expect(args.execute).toHaveBeenCalledTimes(1);
  });
  it("preserves uncertainty when the ledger completion write fails", async () => {
    const args = setup();
    args.store.finish = unavailable;
    args.execute.mockRejectedValue(new SmtpDeliveryError("unknown", "lost response"));
    await expect(runSendOperation(args)).rejects.toMatchObject({ code: "delivery_unknown" });
    await expect(runSendOperation(args)).rejects.toMatchObject({ code: "operation_in_progress" });
    expect(args.execute).toHaveBeenCalledTimes(1);
  });
  it("returns proved Sent success despite a ledger write failure", async () => {
    const args = setup();
    args.store.finish = unavailable;
    expect(await runSendOperation({ ...args, reconcile: async () => receipt })).toEqual(receipt);
    expect(args.execute).not.toHaveBeenCalled();
  });
  it("refreshes abandoned submissions without reclaiming them", async () => {
    const args = setup();
    await args.store.start({ ...input, requestHash: hashSendRequest(input.request) });
    args.store.refresh = async (key) => { const row = args.store.rows.get(key)!; row.status = "unknown"; return row; };
    await expect(replaySendOperation(args)).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(args.execute).not.toHaveBeenCalled();
  });
  it("observes non-delivery that finishes during early replay", async () => {
    const args = setup();
    await args.store.start({ ...input, requestHash: hashSendRequest(input.request) });
    args.store.refresh = async (key) => { const row = args.store.rows.get(key)!; row.status = "not_delivered"; return row; };
    expect(await replaySendOperation(args)).toEqual({ found: false, accountId: input.accountId });
  });
  it("does not overwrite reconciled success with a late executor error", async () => {
    const args = setup();
    args.execute.mockImplementation(async () => {
      await args.store.finish(input.operationKey, "succeeded", receipt, null);
      throw new SmtpDeliveryError("not_delivered", "late failure");
    });
    expect(await runSendOperation(args)).toEqual(receipt);
  });
  it("does not let diagnostics change the result", async () => {
    const args = setup();
    expect(await runSendOperation({ ...args, onTransition: () => { throw new Error("diagnostics failed"); } })).toEqual(receipt);
  });
});
