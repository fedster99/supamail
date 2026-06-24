import type { AppConfig } from "./config.js";
import type { PgPool } from "./db.js";
import { assertSafeSmtpTarget } from "./host-validation.js";
import { closeImap } from "./imap-connect.js";
import { getProviderProfile, resolveSpecialUseFolder } from "./provider-profiles.js";
import { MirrorRepository } from "./repository.js";
import {
  SentFolderAppender,
  buildRawMime,
  buildSendEnvelope,
  deliverSmtp,
  resolveSmtpCreds
} from "./smtp-client.js";
import type { SendRequest, SendResult } from "./types.js";

/**
 * The send/reply primitive (email-001, ADR 0017). Loads the account, validates
 * the SMTP target (SSRF guard), composes deterministic RFC-822 bytes, submits
 * them over SMTP, then APPENDs the SAME bytes to the Sent folder. It does NOT
 * insert a mirror row — the next sync pass FETCHes the real Sent copy and mirrors
 * it with a server-assigned UID, so identity is never guessed.
 *
 * This lives OUTSIDE src/mcp/ on purpose: the agent surface stays zero-send. The
 * caller (CLI with --confirm, the single-tenant HTTP door, or the cloud runtime)
 * is the human-in-the-loop gate.
 *
 * Failure ordering is deliberate: an SMTP failure throws BEFORE any APPEND, so a
 * failed send files nothing. An APPEND failure after a successful delivery does
 * NOT roll back the delivered mail (irreversible) — it is recorded as a warning
 * and the next sync still mirrors the Sent copy if the provider auto-filed it.
 *
 * IDEMPOTENCY (review decision 2): POST /send is NOT retry-safe on its own. When
 * `req.messageId` is absent, buildRawMime stamps a fresh random Message-ID each
 * call, so a timeout-then-retry re-delivers a DUPLICATE with a different
 * Message-ID (undedupeable). A caller that needs at-most-once delivery MUST supply
 * a stable `req.messageId` (then a re-send files the same id and the synced Sent
 * copy dedups). The full idempotency-key ledger is intentionally deferred to the
 * cloud wrapper (email-001 design §2.9 / ADR 0017) — no new OSS infra here.
 */
export async function sendMessage(
  pool: PgPool,
  config: AppConfig,
  req: SendRequest
): Promise<SendResult> {
  const repository = new MirrorRepository(pool, config);
  const account = await repository.getAccount(req.accountId);
  if (!account) {
    throw new Error(`Account not found: ${req.accountId}`);
  }

  const warnings: string[] = [];

  const creds = await resolveSmtpCreds(pool, config, account);
  const { isPrivateHost } = await assertSafeSmtpTarget(creds.host, creds.port, creds.secure, {
    allowPrivateHosts: config.IMAP_ALLOW_PRIVATE_HOSTS
  });

  const from = { email: account.email_address };
  const { raw, messageId } = await buildRawMime(req, from);
  const envelope = buildSendEnvelope(account.email_address, req);

  // STARTTLS stays enforced for a public host even under IMAP_ALLOW_PRIVATE_HOSTS;
  // it relaxes only when the target actually resolved private/loopback.
  await deliverSmtp(creds, raw, envelope, config, { isPrivateHost });

  // Delivery succeeded; file the identical bytes to Sent. An APPEND failure here
  // is non-fatal — the mail is already sent and the next sync recovers a copy.
  let appendedToSent = false;
  let appendedUid: number | null = null;
  let sentFolderPath: string | null = null;
  let appender: SentFolderAppender | null = null;
  try {
    appender = await SentFolderAppender.connect(pool, config, account);
    const profile = getProviderProfile(account.provider_profile);
    const mailboxes = await appender.list();
    // Resolve Sent via the shared role-keyed resolver: the "sent" role consults the
    // provider profile's priority winner for its fallback (behavior preserved).
    sentFolderPath = resolveSpecialUseFolder(mailboxes, "sent", profile);
    const result = await appender.append(sentFolderPath, raw, ["\\Seen"], new Date());
    appendedToSent = true;
    appendedUid = result.uid;
  } catch (error) {
    warnings.push(
      `Delivered, but filing to Sent failed: ${error instanceof Error ? error.message : String(error)}. The next sync will mirror the copy if the provider auto-filed it.`
    );
  } finally {
    if (appender) await closeImap(appender);
  }

  return {
    rfcMessageId: messageId,
    delivered: true,
    appendedToSent,
    appendedUid,
    sentFolderPath,
    warnings
  };
}
