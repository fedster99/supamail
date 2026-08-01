import type { AppConfig } from "./config.js";
import type { PgPool } from "./db.js";
import { AccountBusyError } from "./errors.js";
import { assertSafeSmtpTarget } from "./host-validation.js";
import { closeImap } from "./imap-connect.js";
import { accountLockHeartbeatIntervalMs, withAccountLock } from "./locks.js";
import { getProviderProfile, resolveSpecialUseFolder } from "./provider-profiles.js";
import { MirrorRepository } from "./repository.js";
import {
  SentFolderAppender,
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
 * to the Sent folder. It does NOT insert a mirror row — the next sync pass FETCHes
 * the real Sent copy and mirrors it with a server-assigned UID, so identity is
 * never guessed.
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
 * `unknown` and never submit it again. Remote wrappers own that durable ledger.
 */
export async function sendMessage(
  pool: PgPool,
  config: AppConfig,
  req: SendRequest,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<SendResult> {
  let deliveryConfirmed = false;
  try {
    return await sendMessageAttempt(pool, config, req, metadataProtection, () => {
      deliveryConfirmed = true;
    });
  } catch (error) {
    if (error instanceof SmtpDeliveryError) throw error;
    if (
      !deliveryConfirmed &&
      ["AccountBusyError", "HostValidationError"].includes(
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
  confirmDelivery: () => void
): Promise<SendResult> {
  const repository = new MirrorRepository(pool, config, metadataProtection);
  const account = await repository.getAccount(req.accountId);
  if (!account) {
    throw new Error(`Account not found: ${req.accountId}`);
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
  // per-account command budget concurrently. Acquisition is deliberately
  // non-blocking: callers get the established transient AccountBusyError before
  // any irreversible SMTP delivery happens.
  const result = await withAccountLock(pool, account.lock_id, async (lock) => {
    // Synchronous phase gate: a periodic refresh may have failed since acquisition.
    // Do not cross the irreversible SMTP boundary until heartbeat persistence and
    // ownership by this exact Postgres session are both re-proven.
    await lock.assertLive();

    // STARTTLS stays enforced for a public host even under IMAP_ALLOW_PRIVATE_HOSTS;
    // it relaxes only when the target actually resolved private/loopback.
    const delivery = await deliverSmtp(creds, raw, envelope, config, {
      isPrivateHost,
      onPostDeliveryWarning: addWarning
    });
    confirmDelivery();
    lock.confirmIrreversible();

    // Delivery succeeded; file the identical bytes to Sent while the account lock
    // remains held. An APPEND failure is non-fatal — the mail is already sent and
    // the next sync recovers a copy if the provider auto-filed it.
    let appendedToSent = false;
    let appendedUid: number | null = null;
    let sentFolderPath: string | null = null;
    let appender: SentFolderAppender | null = null;
    let lockLiveForFiling = true;
    try {
      try {
        await lock.assertLive();
      } catch (error) {
        lockLiveForFiling = false;
        addWarning(
          `Delivered, but filing to Sent was skipped because account-lock liveness was lost: ${error instanceof Error ? error.message : String(error)}.`
        );
      }

      if (lockLiveForFiling) {
        try {
          appender = await SentFolderAppender.connect(pool, config, account);
          const profile = getProviderProfile(account.provider_profile);
          const mailboxes = await appender.list();
          // Resolve Sent via the shared role-keyed resolver: the "sent" role consults the
          // provider profile's priority winner for its fallback (behavior preserved).
          sentFolderPath = resolveSpecialUseFolder(mailboxes, "sent", profile);
          const appended = await appender.append(sentFolderPath, raw, ["\\Seen"], new Date());
          appendedToSent = true;
          appendedUid = appended.uid;
        } catch (error) {
          addWarning(
            `Delivered, but filing to Sent failed: ${error instanceof Error ? error.message : String(error)}. The next sync will mirror the copy if the provider auto-filed it.`
          );
        }
      }
    } finally {
      if (appender) {
        try {
          await closeImap(appender);
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
      appendedToSent,
      appendedUid,
      sentFolderPath,
      warnings
    };
  }, {
    heartbeatIntervalMs: accountLockHeartbeatIntervalMs(config.STALE_HEARTBEAT_MS),
    onPostIrreversibleWarning: addWarning
  });

  if (result === null) {
    throw new AccountBusyError(`Account ${account.id} is busy syncing; retry the send shortly`);
  }
  return result;
}
