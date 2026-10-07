import { createHash } from "node:crypto";
import { AccountBusyError, InvalidInputError, NoRecipientsError, NotFoundError } from "./errors.js";
import { HostValidationError } from "./host-validation.js";
import { SmtpDeliveryError } from "./smtp-client.js";

export type SendOperationStatus = "submitting" | "succeeded" | "not_delivered" | "unknown";
export type SendOperationCode = "idempotency_required" | "idempotency_conflict" | "operation_in_progress" | "delivery_unknown";
export interface SendOperationIdentity {
  operationKey: string;
  action: string;
  accountId: string;
  requestHash: string;
  rfcMessageId: string | null;
}
export interface StoredSendError { name: string; outcome: string | null }
export interface SendOperation<T> extends SendOperationIdentity {
  status: SendOperationStatus;
  result: T | null;
  error: StoredSendError | null;
}
/** Durable, caller-scoped storage. A claim must commit before returning true.
 * start atomically claims only absent or proven not_delivered operations, and
 * must reject changed identity without changing the row. Expired submitting
 * rows become unknown, never retryable. finish must preserve succeeded rows.
 * Keep records for as long as callers may retry; deletion removes protection.
 */
export interface SendOperationStore<T> {
  get(key: string): Promise<SendOperation<T> | null>;
  start(input: SendOperationIdentity): Promise<{ claimed: boolean; row: SendOperation<T> }>;
  refresh(key: string): Promise<SendOperation<T>>;
  finish(key: string, status: SendOperationStatus, result: T | null, error: StoredSendError | null): Promise<SendOperation<T> | null>;
}
export type SendTransition = "claimed" | "replayed" | "reconciled" | "provider_started" | "provider_accepted" | "provider_not_delivered" | "provider_unknown";
interface ExistingOptions<T> {
  store: SendOperationStore<T>;
  row: SendOperation<T>;
  operationKey: string;
  reconcile?: (row: SendOperationIdentity) => Promise<T | null>;
  onTransition?: (stage: SendTransition) => void;
}
export interface ReplaySendOptions<T> {
  store: SendOperationStore<T>;
  operationKey: string;
  action: string;
  request: unknown;
  reconcile?: (row: SendOperationIdentity) => Promise<T | null>;
}
export interface RunSendOptions<T> extends ReplaySendOptions<T> {
  accountId: string;
  rfcMessageId: string | null;
  execute: () => Promise<T>;
  onTransition?: (stage: SendTransition) => void;
}

export class SendOperationError extends Error {
  constructor(readonly code: SendOperationCode, message: string, readonly nextStep: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "SendOperationError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) =>
      item === undefined ? "null" : canonicalJson(item)
    ).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// The one rule for an idempotency key: not blank and at most 200 characters,
// counted as Postgres counts them (operation_key is checked the same way).
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && key.trim() !== "" && [...key].length <= 200;
}

export function hashSendRequest(request: unknown): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

export function sameSendOperation(row: SendOperationIdentity, input: SendOperationIdentity) {
  return (
    row.action === input.action &&
    row.accountId === input.accountId &&
    row.requestHash === input.requestHash &&
    row.rfcMessageId === input.rfcMessageId
  );
}

function sameIntent(row: SendOperationIdentity, action: string, requestHash: string) {
  return row.action === action && row.requestHash === requestHash;
}

function conflict() {
  return new SendOperationError(
    "idempotency_conflict",
    "This idempotency key belongs to a different email.",
    "Use the original email details, or use a new idempotency_key."
  );
}

function inProgress() {
  return new SendOperationError(
    "operation_in_progress",
    "This email is still being sent.",
    "Wait, then retry with the same idempotency_key."
  );
}

function unknown(cause: unknown) {
  return new SendOperationError(
    "delivery_unknown",
    "The mail server may have accepted this email.",
    "Do not send it again. You can retry with the same idempotency_key to check for a later result. Some IMAP providers cannot confirm it.",
    { cause }
  );
}

function safeFailure(error: unknown): boolean {
  if (error instanceof SmtpDeliveryError) return error.outcome === "not_delivered";
  return error instanceof AccountBusyError
    || error instanceof HostValidationError
    || error instanceof InvalidInputError
    || error instanceof NoRecipientsError
    || error instanceof NotFoundError;
}

function storedError(error: unknown): StoredSendError {
  const outcome = error instanceof Error && "outcome" in error ? error.outcome : null;
  return { name: error instanceof Error ? error.name : "Error", outcome: typeof outcome === "string" ? outcome : null };
}

function notifyTransition(callback: ExistingOptions<unknown>["onTransition"], stage: SendTransition) {
  try {
    callback?.(stage);
  } catch {
    /* diagnostics must never change a send result */
  }
}

async function reconcileOperation<T>({ store, row, operationKey, reconcile }: ExistingOptions<T>): Promise<T | null> {
  if (!reconcile || !row.rfcMessageId) return null;
  const recovered = await reconcile(row);
  if (!recovered) return null;
  try {
    const finished = await store.finish(operationKey, "succeeded", recovered, null);
    return finished?.result ?? recovered;
  } catch {
    // Sent evidence proves delivery. A ledger outage must not hide that result.
    return recovered;
  }
}

async function resolveExistingOperation<T>({ store, row, operationKey, reconcile, onTransition }: ExistingOptions<T>): Promise<T | null> {
  if (row.status === "succeeded") return row.result;
  if (row.status === "unknown") {
    try {
      const recovered = await reconcileOperation({
        store,
        row,
        operationKey,
        reconcile,
      });
      if (recovered) {
        notifyTransition(onTransition, "reconciled");
        return recovered;
      }
    } catch {
      // Keep the stored SMTP outcome stable when Sent lookup is unavailable.
    }
    throw unknown(row.error);
  }
  throw inProgress();
}

/**
 * Check an existing operation before dynamic reply composition or draft lookup.
 * A successful replay therefore works after the source message or sent draft is
 * no longer present.
 */
export async function replaySendOperation<T>({
  store,
  operationKey,
  action,
  request,
  reconcile,
}: ReplaySendOptions<T>): Promise<{ found: false; accountId?: string } | { found: true; result: T | null }> {
  assertOperationKey(operationKey);
  let row = await store.get(operationKey);
  if (!row) return { found: false };
  if (!sameIntent(row, action, hashSendRequest(request))) throw conflict();
  if (row.status === "not_delivered") {
    return { found: false, accountId: row.accountId };
  }
  if (row.status === "submitting") {
    row = await store.refresh(operationKey);
    if (row.status === "not_delivered") {
      return { found: false, accountId: row.accountId };
    }
  }
  return {
    found: true,
    result: await resolveExistingOperation({ store, row, operationKey, reconcile }),
  };
}

/**
 * Run one irreversible mail operation.
 *
 * The store claims the key before SMTP. A replay returns stored success, safely
 * retries a proven non-delivery, or checks Sent after an unknown outcome. It never
 * submits again after an unknown outcome.
 */
export async function runSendOperation<T>({
  store,
  operationKey,
  action,
  accountId,
  request,
  rfcMessageId,
  execute,
  reconcile,
  onTransition,
}: RunSendOptions<T>): Promise<T | null> {
  assertOperationKey(operationKey);
  const requestHash = hashSendRequest(request);
  const operation = {
    operationKey,
    action,
    accountId,
    requestHash,
    rfcMessageId,
  };

  // Sent lookup is fallible. Run it before a new or retryable claim so a mirror
  // outage cannot leave an unsent operation in `submitting`.
  const existing = await store.get(operationKey);
  if (existing && !sameSendOperation(existing, operation)) throw conflict();
  if (!existing || existing.status === "not_delivered") {
    const recovered = reconcile && rfcMessageId
      ? await reconcile(existing ?? operation)
      : null;
    if (recovered) {
      const recoveredClaim = await store.start(operation);
      if (!sameSendOperation(recoveredClaim.row, operation)) throw conflict();
      if (!recoveredClaim.claimed) {
        const result = await resolveExistingOperation({
          store,
          row: recoveredClaim.row,
          operationKey,
          reconcile,
          onTransition,
        });
        notifyTransition(onTransition, "replayed");
        return result;
      }
      notifyTransition(onTransition, "claimed");
      const result = await reconcileOperation({
        store,
        row: recoveredClaim.row,
        operationKey,
        reconcile: async () => recovered,
      });
      notifyTransition(onTransition, "reconciled");
      return result;
    }
  }

  const started = await store.start(operation);

  if (!sameSendOperation(started.row, operation)) {
    throw conflict();
  }

  if (!started.claimed) {
    const result = await resolveExistingOperation({
      store,
      row: started.row,
      operationKey,
      reconcile,
      onTransition,
    });
    notifyTransition(onTransition, "replayed");
    return result;
  }

  notifyTransition(onTransition, "claimed");

  let result;
  try {
    notifyTransition(onTransition, "provider_started");
    result = await execute();
    notifyTransition(onTransition, "provider_accepted");
  } catch (error) {
    if (safeFailure(error)) {
      notifyTransition(onTransition, "provider_not_delivered");
      try {
        const finished = await store.finish(
          operationKey,
          "not_delivered",
          null,
          storedError(error)
        );
        if (finished?.status === "succeeded") return finished.result;
      } catch {
        // SMTP proved non-delivery. Keep the provider error, not a storage error.
      }
      throw error;
    }

    notifyTransition(onTransition, "provider_unknown");
    try {
      const finished = await store.finish(
        operationKey,
        "unknown",
        null,
        storedError(error)
      );
      if (finished?.status === "succeeded") return finished.result;
    } catch {
      // The caller still receives the stable unknown outcome below.
    }
    const row: SendOperation<T> = { ...started.row, status: "unknown", error: storedError(error) };
    try {
      const recovered = await reconcileOperation({ store, row, operationKey, reconcile });
      if (recovered) {
        notifyTransition(onTransition, "reconciled");
        return recovered;
      }
    } catch {
      // A mirror outage cannot make an uncertain SMTP result safe to retry.
    }
    throw unknown(error);
  }

  // SMTP returned success. Return that known result even if the ledger write is
  // temporarily unavailable. The existing claim still blocks another submit.
  try {
    const finished = await store.finish(
      operationKey,
      "succeeded",
      result,
      null
    );
    return finished?.result ?? result;
  } catch {
    return result;
  }
}

function assertOperationKey(key: unknown): asserts key is string {
  if (!isValidIdempotencyKey(key)) {
    throw new SendOperationError("idempotency_required", "idempotency_key must be 1 to 200 characters and not blank.", "Provide a unique idempotency_key for this exact send.");
  }
}
