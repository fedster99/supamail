import { SEND_REQUEST_SCHEMA, parseInput } from "./compose-schema.js";
import type { AppConfig } from "./config.js";
import type { PgPool } from "./db.js";
import { NotFoundError, throwIfAborted } from "./errors.js";
import { assertSafeSmtpTarget } from "./host-validation.js";
import { actionBodyStore, fileSentCopy, type SentCopy } from "./filed-message.js";
import { ActionConnection } from "./imap-connect.js";
import { withInteractiveAccountLock } from "./interactive-lock.js";
import { accountLockHeartbeatIntervalMs } from "./locks.js";
import type { MailboxActionOptions } from "./mailbox-mutations.js";
import { MirrorRepository } from "./repository.js";
import {
  buildRawMime,
  buildSendEnvelope,
  deliverSmtp,
  resolveSmtpCreds,
  SmtpDeliveryError
} from "./smtp-client.js";
import type { SendRequest, SendResult } from "./types.js";
import {
  plaintextMetadataProtection,
  type MetadataProtectionAdapter
} from "./metadata-protection.js";

/**
 * The send/reply primitive (email-001, ADR 0017). Loads the account, validates
 * the SMTP target (SSRF guard), composes deterministic RFC-822 bytes, then holds
 * the account advisory lock across SMTP submission and APPEND of the SAME bytes
 * to the Sent folder. When the server answers the APPEND with APPENDUID, the copy
 * is mirrored at once from that UID (ADR 0046), when the folder identity checks pass; otherwise the next sync mirrors it. Identity is never guessed.
 *
 * This lives OUTSIDE src/mcp/ on purpose: the agent surface stays zero-send. The
 * caller (CLI with --confirm, the single-account HTTP API, or a remote runtime)
 * is the human-in-the-loop gate.
 *
 * Failure ordering is deliberate: an SMTP failure throws BEFORE any APPEND, so a
 * failed send files nothing. An APPEND failure after a successful delivery does
 * NOT roll back the delivered mail (irreversible) — it is recorded as a warning
 * and the next sync still mirrors the Sent copy if the provider auto-filed it.
 *
 * IDEMPOTENCY: this primitive does not retry and is not retry-safe on its own.
 * A stable `req.messageId` gives a caller a reconciliation key, but it does not
 * stop SMTP from accepting the same bytes twice. `deliverSmtp` therefore returns
 * the provider receipt or throws `SmtpDeliveryError` with `not_delivered` or
 * `unknown`. A durable caller may retry only `not_delivered`; it must reconcile
 * `unknown` and never submit it again. Use core `runSendOperation` for that
 * policy; hosts provide durable storage.
 *
 * INPUT: the request is parsed first. Malformed input throws `InvalidInputError`
 * before any provider work, never `SmtpDeliveryError`, so a caller fixes it
 * instead of retrying it.
 *
 * ABORT: an optional AbortSignal stops the send before SMTP with `AbortError`
 * (proven not delivered). SMTP submission itself is never interrupted, so abort
 * cannot turn a delivery into `unknown`. After delivery, abort only skips or
 * closes the Sent APPEND, which is reported as a warning.
 */
export async function sendMessage(
  pool: PgPool,
  config: AppConfig,
  req: SendRequest,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection,
  options: MailboxActionOptions = {}
): Promise<SendResult> {
  const request = parseInput(SEND_REQUEST_SCHEMA, req);
  let deliveryConfirmed = false;
  try {
    return await sendMessageAttempt(pool, config, request, metadataProtection, options, () => {
      deliveryConfirmed = true;
    });
  } catch (error) {
    if (error instanceof SmtpDeliveryError) throw error;
    if (
      !deliveryConfirmed &&
      ["AbortError", "AccountBusyError", "HostValidationError", "InvalidInputError", "NotFoundError"].includes(
        error instanceof Error ? error.name : ""
      )
    ) {
      throw error;
    }
    throw new SmtpDeliveryError(
      deliveryConfirmed ? "unknown" : "not_delivered",
      error instanceof Error ? error.message : "Mail delivery failed",
      { cause: error }
    );
  }
}

async function sendMessageAttempt(
  pool: PgPool,
  config: AppConfig,
  req: SendRequest,
  metadataProtection: MetadataProtectionAdapter,
  { signal, bodyStore: hostBodyStore }: MailboxActionOptions,
  confirmDelivery: () => void
): Promise<SendResult> {
  throwIfAborted(signal);
  const repository = new MirrorRepository(pool, config, metadataProtection);
  const bodyStore = actionBodyStore(repository, hostBodyStore);
  const account = await repository.getAccount(req.accountId);
  if (!account) {
    throw new NotFoundError(`Account not found: ${req.accountId}`);
  }

  const creds = await resolveSmtpCreds(pool, config, account);
  const { isPrivateHost } = await assertSafeSmtpTarget(creds.host, creds.port, creds.secure, {
    allowPrivateHosts: config.IMAP_ALLOW_PRIVATE_HOSTS
  });

  const from = { email: account.email_address };
  const { raw, messageId } = await buildRawMime(req, from);
  const envelope = buildSendEnvelope(account.email_address, req);
  const warnings: string[] = [];
  const addWarning = (warning: string) => {
    if (!warnings.includes(warning)) warnings.push(warning);
  };

  // SMTP submission and the matching Sent APPEND are one account-scoped provider
  // operation. Hold the SAME advisory lock used by sync and draft APPENDs across
  // both network verbs so the worker cannot race this send or consume the provider's
  // per-account command budget concurrently. Acquisition waits a bounded time for
  // a sync; still held after that, callers get the transient AccountBusyError
  // before any irreversible SMTP delivery happens.
  return await withInteractiveAccountLock(pool, account, async (lock) => {
    // Synchronous phase gate: a periodic refresh may have failed since acquisition.
    // Do not cross the irreversible SMTP boundary until heartbeat persistence and
    // ownership by this exact Postgres session are both re-proven.
    await lock.assertLive();
    throwIfAborted(signal);

    // STARTTLS stays enforced for a public host even under IMAP_ALLOW_PRIVATE_HOSTS;
    // it relaxes only when the target actually resolved private/loopback.
    const delivery = await deliverSmtp(creds, raw, envelope, config, {
      isPrivateHost,
      onPostDeliveryWarning: addWarning
    });
    confirmDelivery();
    lock.confirmIrreversible();

    // Delivery succeeded; file the identical bytes to Sent while the account lock
    // remains held, and mirror the copy at once (ADR 0046). Every failure from here
    // is a warning — the mail is already sent.
    let sent: SentCopy = { appendedToSent: false, appendedUid: null, sentFolderPath: null, messageId: null };
    let lockLiveForFiling = true;
    try {
      await lock.assertLive();
    } catch (error) {
      lockLiveForFiling = false;
      addWarning(
        `Delivered, but filing to Sent was skipped because account-lock liveness was lost: ${error instanceof Error ? error.message : String(error)}.`
      );
    }
    if (lockLiveForFiling) {
      const connection = new ActionConnection(pool, config, account, signal);
      try {
        sent = await fileSentCopy(repository, config, bodyStore, account, connection, raw, addWarning);
      } finally {
        try {
          await connection.close();
        } catch (error) {
          // SMTP is already confirmed. Teardown failure is diagnostic only; never
          // turn it into a thrown response that could invite a duplicate re-send.
          addWarning(
            `Delivered, but closing the Sent connection failed: ${error instanceof Error ? error.message : String(error)}.`
          );
        }
      }
    }

    return {
      rfcMessageId: messageId,
      delivered: true as const,
      accepted: delivery.accepted,
      rejected: delivery.rejected,
      smtpResponse: delivery.response,
      ...sent,
      warnings
    };
  }, {
    fenceWrites: true,
    heartbeatIntervalMs: accountLockHeartbeatIntervalMs(config.STALE_HEARTBEAT_MS),
    onPostIrreversibleWarning: addWarning
  });
}
