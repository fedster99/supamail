import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { AppConfig } from "./config.js";
import { decryptPassword } from "./crypto.js";
import type { PgPool } from "./db.js";
import { connectImap } from "./imap-connect.js";
import { getProviderProfile } from "./provider-profiles.js";
import type { ImapAccount, SendAttachment, SendRecipient, SendRequest } from "./types.js";

/**
 * SMTP compose + transport + a write-only Sent-folder APPEND client (email-001,
 * ADR 0017). This module lives OUTSIDE src/mcp/ on purpose: the agent surface is
 * zero-send by construction, so the send/append verbs must never be importable
 * from there. The sync read adapter (imap-client.ts) likewise never gains write
 * verbs — APPEND lives only on {@link SentFolderAppender} here.
 */

/** Resolved SMTP connection coordinates + plaintext secret for one send. */
export interface ResolvedSmtpCreds {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

/**
 * Resolve the SMTP coordinates + secret for an account. Resolution order is
 * explicit columns → provider-profile `smtpDefaults` → error. The username falls
 * back to the IMAP username; the password falls back to the IMAP secret (both use
 * the same frozen AES-256-GCM envelope, so one key decrypts either).
 */
export async function resolveSmtpCreds(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount
): Promise<ResolvedSmtpCreds> {
  const profile = getProviderProfile(account.provider_profile);
  let host = account.smtp_host ?? null;
  let port = account.smtp_port ?? null;
  let secure = account.smtp_secure ?? null;

  if (host === null && profile.smtpDefaults) {
    host = profile.smtpDefaults.host(account.host);
    port ??= profile.smtpDefaults.port;
    secure ??= profile.smtpDefaults.secure;
  }

  if (host === null) {
    throw new Error(
      `No SMTP host configured for account ${account.id}. Set smtp_host (and smtp_port/smtp_secure) on the account, or use a provider profile with SMTP defaults.`
    );
  }
  if (port === null) {
    throw new Error(`No SMTP port configured for account ${account.id}. Set smtp_port.`);
  }
  // Default to implicit TLS when the port is the well-known implicit-TLS port,
  // else STARTTLS — only reached when host is explicit but secure was omitted.
  if (secure === null) secure = port === 465;

  const username = account.smtp_username ?? account.username;
  const secret = account.encrypted_smtp_password ?? account.encrypted_password;
  const password = await decryptPassword(pool, secret, config.IMAP_ENCRYPTION_KEY);

  return { host, port, secure, username, password };
}

function toAddress(recipient: SendRecipient): { name?: string; address: string } {
  return recipient.name ? { name: recipient.name, address: recipient.email } : { address: recipient.email };
}

/** One MailComposer attachment entry. `content` carries the decoded bytes; an
 * inline part (cid set or inline:true) gets `contentDisposition: "inline"` so it
 * renders in-body instead of listing as a separate download. */
interface ComposerAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid?: string;
  contentDisposition?: "inline" | "attachment";
}

/**
 * Map a {@link SendAttachment} (base64 transport) to a MailComposer attachment.
 * The base64 is decoded here (Buffer.from(..., "base64") is total — invalid input
 * yields a shorter/empty buffer rather than throwing), so the composed MIME carries
 * the real bytes. A `cid` (or `inline: true`) marks the part inline for `cid:` HTML
 * references; otherwise it is a regular attachment.
 */
function toComposerAttachment(attachment: SendAttachment): ComposerAttachment {
  const inline = attachment.inline === true || (attachment.cid !== undefined && attachment.cid !== "");
  const entry: ComposerAttachment = {
    filename: attachment.filename,
    content: Buffer.from(attachment.content, "base64"),
    contentDisposition: inline ? "inline" : "attachment"
  };
  if (attachment.contentType) entry.contentType = attachment.contentType;
  if (attachment.cid) entry.cid = attachment.cid;
  return entry;
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : "localhost";
}

export interface BuiltMime {
  raw: Buffer;
  messageId: string;
}

/**
 * Custom headers the caller may NOT stamp through `req.headers`. These are the
 * structural / identity / routing headers that define WHO the message is from/to
 * and HOW it is structured — letting a caller set them would let a `POST .../send`
 * forge a `From:`/`Reply-To`, smuggle a raw `Bcc:` into the SAME bytes that are
 * both delivered AND filed to Sent (defeating the "Bcc never enters the bytes"
 * guarantee), or override the multipart Content-Type. Recipients/threading go
 * through the structured SendRequest fields, never raw headers. Everything else is
 * restricted to the `X-*` custom-header namespace. Drafts reuse buildRawMime, so
 * this protects createDraft/updateDraft too. (See the review header trust-boundary
 * finding.)
 */
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "sender",
  "reply-to",
  "return-path",
  "received",
  "content-type",
  "content-transfer-encoding",
  "mime-version"
]);

/**
 * Reject a forged/structural custom header before it reaches MailComposer. Allows
 * the threading convenience headers (In-Reply-To/References/Message-ID, which the
 * structured fields also feed) and any `X-*` token; everything else must be either
 * absent or an X- custom. Throws a clear error naming the offending header.
 */
function assertSafeCustomHeaders(headers: Record<string, string>): void {
  const ALLOWED_NON_X = new Set(["in-reply-to", "references", "message-id"]);
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_CUSTOM_HEADERS.has(lower)) {
      throw new Error(
        `Header "${name}" cannot be set via custom headers — set it through the structured send fields instead`
      );
    }
    if (lower.startsWith("x-") || ALLOWED_NON_X.has(lower)) continue;
    throw new Error(
      `Custom header "${name}" is not allowed — only X-* custom headers (and In-Reply-To/References/Message-ID) may be set`
    );
  }
}

/**
 * Compose deterministic RFC-822 bytes for a {@link SendRequest} via nodemailer's
 * MailComposer (no hand-rolled MIME). A Message-ID is stamped at compose time —
 * the caller's `req.messageId` wins for stability — so the mirrored Sent copy's
 * rfc_message_id is known at send time and dedups against the later synced copy.
 * `inReplyTo`/`references` convenience fields and any custom `headers` are merged
 * (explicit headers do not clobber the structured threading fields). The returned
 * `raw` is what we BOTH submit and APPEND, so the delivered and filed bytes are
 * byte-identical (threading/dedup coherence). Bcc is intentionally NOT emitted
 * into the bytes (nodemailer's keepBcc default) — Bcc recipients ride the SMTP
 * envelope only. Attachments + inline `cid` images (email-004) are passed straight
 * through to MailComposer, which builds the multipart MIME deterministically.
 */
export async function buildRawMime(req: SendRequest, from: SendRecipient): Promise<BuiltMime> {
  const messageId = req.messageId ?? `<${randomUUID()}@${domainOf(from.email)}>`;

  // Merge convenience threading fields into custom headers without letting an
  // explicit custom header silently win over the structured field.
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  // Reject forged/structural headers (Bcc/From/Content-Type/…) before they reach
  // the bytes that are both delivered AND filed to Sent.
  assertSafeCustomHeaders(headers);

  const composer = new MailComposer({
    from: toAddress(from),
    to: req.to.map(toAddress),
    cc: req.cc?.map(toAddress),
    bcc: req.bcc?.map(toAddress),
    subject: req.subject,
    text: req.body.format === "plain" ? req.body.text ?? "" : undefined,
    html: req.body.format === "html" ? req.body.html ?? req.body.text ?? "" : undefined,
    messageId,
    inReplyTo: req.inReplyTo ?? headers["In-Reply-To"] ?? headers["in-reply-to"],
    references: req.references ?? headers.References ?? headers.references,
    attachments: req.attachments?.map(toComposerAttachment),
    headers
  });

  const node = composer.compile();
  const raw = await node.build();
  // node.messageId() returns the value MailComposer actually set (sans angle
  // brackets stripping); prefer it so SendResult matches the wire exactly.
  const stamped = node.messageId();
  return { raw, messageId: stamped ? `<${stamped.replace(/[<>]/g, "")}>` : messageId };
}

/** SMTP delivery envelope: the actual MAIL FROM / RCPT TO set (includes Bcc). */
export interface SmtpEnvelope {
  from: string;
  to: string[];
}

export interface SmtpDeliveryReceipt {
  accepted: string[];
  rejected: string[];
  response: string | null;
}

export type SmtpDeliveryOutcome = "not_delivered" | "unknown";

/**
 * A failed SMTP submission with an explicit delivery outcome.
 *
 * `not_delivered` means the provider did not accept responsibility, so a caller
 * may retry. `unknown` means the submission result cannot be proved and the
 * provider may have accepted the message. A caller must not resubmit it.
 */
export class SmtpDeliveryError extends Error {
  readonly outcome: SmtpDeliveryOutcome;

  constructor(outcome: SmtpDeliveryOutcome, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SmtpDeliveryError";
    this.outcome = outcome;
  }
}

interface NodemailerSmtpError {
  code?: unknown;
  command?: unknown;
  responseCode?: unknown;
  syscall?: unknown;
}

function classifySmtpFailure(error: unknown): SmtpDeliveryOutcome {
  if (!error || typeof error !== "object") return "unknown";
  const smtpError = error as NodemailerSmtpError;

  // Only a complete negative reply is definitive. Nodemailer can attach a
  // partial positive responseCode when a socket closes before the final CRLF.
  // That server may already have accepted DATA.
  if (
    typeof smtpError.responseCode === "number" &&
    smtpError.responseCode >= 400 &&
    smtpError.responseCode <= 599
  ) {
    return "not_delivered";
  }

  const code = typeof smtpError.code === "string" ? smtpError.code.toUpperCase() : "";
  const syscall = typeof smtpError.syscall === "string" ? smtpError.syscall.toLowerCase() : "";
  const command = typeof smtpError.command === "string" ? smtpError.command.toUpperCase() : "";
  // These failures prove that SMTP submission did not start.
  if (["EAUTH", "ETLS", "EDNS", "EREQUIRETLS"].includes(code)) return "not_delivered";
  if (code === "ESOCKET" && ["connect", "getaddrinfo"].includes(syscall)) {
    return "not_delivered";
  }
  if (code === "ETIMEDOUT" && command === "CONN") return "not_delivered";

  if (command === "DATA" || command === "CONN") return "unknown";
  if (command) return "not_delivered";

  // Preserve at-most-once behavior when Nodemailer cannot identify the stage.
  return "unknown";
}

function recipientStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((recipient) =>
    typeof recipient === "string"
      ? recipient
      : String((recipient as { address?: unknown })?.address ?? recipient)
  );
}

/**
 * Submit the EXACT composed `raw` bytes over SMTP. Using `raw:` ships byte-for-byte
 * what we also APPEND to Sent. `secure=true` is implicit TLS (465); otherwise we
 * require STARTTLS (`requireTLS`). STARTTLS enforcement is decoupled from the
 * IMAP_ALLOW_PRIVATE_HOSTS opt-in (review decision 3): a non-implicit-TLS host that
 * resolved PUBLIC ALWAYS gets requireTLS, even when the private-hosts opt-in is set
 * — so a self-hoster who enables the flag AND sends through a real public :587
 * provider can never silently fall back to cleartext (MITM strip). We relax
 * requireTLS only when the target actually resolved private/loopback (`opts
 * .isPrivateHost`), the local GreenMail-style case. `verify()` is skipped (one
 * fewer round-trip; failures surface on send). The envelope carries every
 * recipient incl. Bcc.
 */
export async function deliverSmtp(
  creds: ResolvedSmtpCreds,
  raw: Buffer,
  envelope: SmtpEnvelope,
  config: AppConfig,
  opts: { isPrivateHost?: boolean; onPostDeliveryWarning?: (warning: string) => void } = {}
): Promise<SmtpDeliveryReceipt> {
  // Require STARTTLS for any non-implicit-TLS target, UNLESS the resolved host is
  // actually private/loopback (dev/self-hosted GreenMail). The IMAP_ALLOW_PRIVATE_
  // HOSTS opt-in alone no longer drops TLS for a public host.
  const requireTLS = !creds.secure && !opts.isPrivateHost;
  const transporter = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    requireTLS,
    auth: { user: creds.username, pass: creds.password },
    connectionTimeout: config.CONNECT_TIMEOUT_MS,
    greetingTimeout: config.CONNECT_TIMEOUT_MS,
    socketTimeout: config.IMAP_COMMAND_TIMEOUT_MS,
    logger: false
  });

  let deliveryError: unknown;
  let receipt: SmtpDeliveryReceipt | null = null;
  try {
    const info = await transporter.sendMail({ envelope, raw });
    receipt = {
      accepted: recipientStrings(info.accepted),
      rejected: recipientStrings(info.rejected),
      response: typeof info.response === "string" ? info.response : null
    };
  } catch (error) {
    deliveryError = error;
  }

  try {
    await transporter.close();
  } catch (error) {
    if (receipt) {
      opts.onPostDeliveryWarning?.(
        `Delivered, but closing the SMTP transport failed: ${error instanceof Error ? error.message : String(error)}.`
      );
    }
    // When sendMail itself failed, preserve that original delivery uncertainty;
    // a close failure must never overwrite the causally useful SMTP error.
  }

  if (deliveryError) {
    throw new SmtpDeliveryError(
      classifySmtpFailure(deliveryError),
      deliveryError instanceof Error ? deliveryError.message : "SMTP delivery failed",
      { cause: deliveryError }
    );
  }
  return receipt!;
}

/** Build the SMTP envelope (MAIL FROM + every recipient, including Bcc). */
export function buildSendEnvelope(from: string, req: SendRequest): SmtpEnvelope {
  const to = [
    ...req.to.map((r) => r.email),
    ...(req.cc ?? []).map((r) => r.email),
    ...(req.bcc ?? []).map((r) => r.email)
  ];
  return { from, to };
}

/**
 * Write-only, single-verb IMAP client for filing the sent copy. Its socket comes
 * from the one shared {@link connectImap} prelude (decrypt + assertSafeImapTarget +
 * the close-on-connect-error guard, imap-connect.ts); it exposes ONLY `append()`
 * (and `list()` so the caller can resolve the Sent folder). The sync path can never
 * write; the send path can never read-sync.
 */
export class SentFolderAppender {
  private constructor(private readonly client: ImapFlow) {}

  static async connect(
    pool: PgPool,
    config: AppConfig,
    account: ImapAccount
  ): Promise<SentFolderAppender> {
    // Socket + SSRF guard + decrypt + the close-on-connect-error guard come from the
    // one shared connect prelude (imap-connect.ts); this client only adds the
    // append-only verb surface on top (ADR 0017/0022).
    const client = await connectImap(pool, config, account);
    return new SentFolderAppender(client);
  }

  /** List mailboxes so the caller can resolve the Sent folder by special-use. */
  async list(): Promise<Array<{ path: string; specialUse?: string | null }>> {
    const boxes = await this.client.list();
    return boxes.map((b) => ({ path: b.path, specialUse: b.specialUse ?? null }));
  }

  /**
   * APPEND raw bytes to `path`, returning the UIDPLUS APPENDUID when the server
   * provides one (else null — the next sync mirrors the copy regardless).
   */
  async append(path: string, raw: Buffer, flags: string[], date?: Date): Promise<{ uid: number | null }> {
    const result = await this.client.append(path, raw, flags, date);
    const uid = result && typeof result === "object" && "uid" in result ? (result as { uid?: number }).uid : undefined;
    return { uid: typeof uid === "number" ? uid : null };
  }

  /**
   * SEARCH `folderPath` for messages carrying an exact Message-ID header, returning
   * their UIDs. Used for idempotent draft creation (search-before-APPEND): a retried
   * create derives the same Message-ID, so a prior APPEND is found instead of duped.
   * SEARCH needs the mailbox selected, so it takes the folder lock for the search.
   */
  async searchByMessageId(folderPath: string, rfcMessageId: string): Promise<number[]> {
    const lock = await this.client.getMailboxLock(folderPath);
    try {
      const uids = await this.client.search({ header: { "message-id": rfcMessageId } }, { uid: true });
      return Array.isArray(uids) ? uids : [];
    } finally {
      lock.release();
    }
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  close(): void {
    this.client.close();
  }
}
