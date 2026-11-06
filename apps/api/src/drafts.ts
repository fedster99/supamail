import { createHash } from "node:crypto";
import { DRAFT_INPUT_SCHEMA, DRAFT_UPDATE_SCHEMA, parseInput } from "./compose-schema.js";
import type { AppConfig } from "./config.js";
import { getRawMime } from "./content.js";
import type { PgClient, PgPool } from "./db.js";
import { NoRecipientsError, NotFoundError, throwIfAborted, actionWarning, type ActionWarning } from "./errors.js";
import { assertSafeSmtpTarget } from "./host-validation.js";
import type { BodyStore } from "./body-store.js";
import { actionBodyStore, fileSentCopy, mirrorFiledMessage, type SentCopy } from "./filed-message.js";
import { timeStep } from "./action-steps.js";
import { ActionConnection } from "./imap-connect.js";
import { withInteractiveAccountLock } from "./interactive-lock.js";
import { accountLockHeartbeatIntervalMs, type AccountLock } from "./locks.js";
import { deleteMessage, deleteMessageInLock, type MailboxActionOptions } from "./mailbox-mutations.js";
import { DRAFTS_VOCABULARY, getProviderProfile, resolveSpecialUseFolder } from "./provider-profiles.js";
import { MirrorRepository } from "./repository.js";
import {
  SentFolderAppender,
  SmtpDeliveryError,
  buildRawMime,
  deliverSmtp,
  domainOf,
  resolveSmtpCreds,
  type AppendedUid
} from "./smtp-client.js";
import type { ImapAccount, ImapMessage, SendRequest, SendResult } from "./types.js";
import {
  METADATA_PROTECTED_FIELDS,
  plaintextMetadataProtection,
  revealMetadataRecord,
  type MetadataProtectionAdapter,
  type ProtectedMetadataColumns
} from "./metadata-protection.js";
import { isMirrorId } from "./mirror-id.js";

/**
 * Full draft CRUD saved to the provider Drafts folder (email-003, ADR 0019).
 * This is mostly COMPOSITION of the email-001 and email-002 primitives:
 *
 * - Create  = buildRawMime (email-001) → APPEND `\Draft` to the Drafts folder via
 *   the write-only {@link SentFolderAppender} (email-001's generic appender), then
 *   mirror the draft, row and body, from its APPENDUID (ADR 0033, ADR 0046).
 * - List/Get = read the MIRROR — drafts are already-synced messages in the Drafts
 *   folder (provider-profiles.ts intentionally mirrors Drafts).
 * - Update  = APPEND-new + delete-old. IMAP drafts are immutable (a message has a
 *   server-assigned UID and cannot be edited in place), so an update files a fresh
 *   draft and hard-deletes the previous one (email-002 `deleteMessage(hard)`).
 * - Send    = RESEND the draft's real raw RFC-822 bytes (a true round-trip): fetch
 *   the stored bytes (email-004 `getRawMime`), submit them over SMTP (email-001
 *   `deliverSmtp` + the same SSRF/TLS guards), APPEND the same bytes to Sent, then
 *   delete the draft. NOT a rebuild from the mirror's parsed body — that lost the
 *   body when it hadn't been lazily fetched yet (see ADR 0019, revised).
 * - Delete  = email-002 `deleteMessage` (reuses the capability-gated mutation).
 *
 * Create, update, send, and delete accept an optional AbortSignal. After abort no
 * new IMAP or SMTP work starts and an open IMAP client closes. Before SMTP
 * delivery the call rejects with `AbortError`. SMTP submission itself is never
 * interrupted or retried: once the provider accepts the message, abort only skips
 * the Sent APPEND and draft cleanup, which are reported as warnings.
 *
 * This module lives OUTSIDE src/mcp/ on purpose: the agent surface is zero-send /
 * zero-mutate (ADR 0014/0016), so APPEND + delete must never be importable there.
 * The sync read adapter likewise never gains a write verb — APPEND lives only on
 * {@link SentFolderAppender} (email-001) and delete only on the email-002
 * {@link import("./mailbox-mutations.js").MailboxMutator}.
 */

/** What a draft create/update carries. Bcc remains send-time-only because
 * nodemailer's default omits it from the APPENDed MIME. Attachments are composed
 * into that MIME by the same `buildRawMime` path as direct sends, and sendDraft
 * later resends those exact saved bytes. `accountId` selects the mailbox whose
 * Drafts folder we file to. */
export type DraftInput = Omit<SendRequest, "bcc"> & {
  /** Optional idempotency key: a retried create with the same key derives the same
   * Message-ID and returns the EXISTING draft (found in Drafts before APPEND) instead
   * of a dup. The key is the operation identity (Stripe-style) — reusing it with a
   * different payload returns the first draft UNCHANGED, it does not update it; a host
   * that records saves with `runDraftSaveOperation` rejects that reuse instead.
   * Blank/whitespace keys are treated as no key. */
  idempotencyKey?: string;
};

/** One draft summary read from the mirror (list view). */
export interface DraftSummary {
  messageId: string;
  accountId: string;
  folderPath: string;
  uid: number;
  rfcMessageId: string | null;
  subject: string | null;
  fromEmail: string | null;
  toEmails: string[];
  ccEmails: string[];
  date: string;
  flags: string[];
}

/** A single draft with its body (get view). Carries both the plaintext `body` and,
 * when the draft was authored/synced as HTML, the original `bodyHtml` + `isHtml`
 * flag so send can deliver the real HTML instead of a lossy flattened rendering. */
export interface DraftDetail extends DraftSummary {
  body: string | null;
  /** The original HTML body when the draft is HTML, else null. */
  bodyHtml: string | null;
  /** True when the draft's selected body part is HTML (format === "html"). */
  isHtml: boolean;
  inReplyTo: string | null;
  references: string | null;
}

export interface CreateDraftResult {
  accountId: string;
  draftsFolderPath: string;
  rfcMessageId: string;
  /** The saved draft's mirror id, ready at once for get, update, send, and delete.
   * Null when the server returns no APPENDUID, Drafts is not mirrored yet, the
   * mirror write failed (see `warnings`), or an idempotent retry found an earlier
   * copy that is not mirrored yet; the next Drafts sync then mirrors it. */
  messageId: string | null;
  /** From UIDPLUS APPENDUID when the server provides one, else null. */
  appendedUid: number | null;
  /** Steps that did not finish after the provider accepted the draft: its mirror
   * row or body, or (on an update) removing the version it replaced. */
  warnings: ActionWarning[];
}

export interface UpdateDraftResult extends CreateDraftResult {
  /** The mirror id of the superseded draft that was deleted. */
  replacedMessageId: string;
  /** True when the superseded draft was actually removed; false when the cleanup
   * delete failed (best-effort — the new draft is already filed). */
  replacedDraftDeleted: boolean;
}

export interface SendDraftResult {
  /** The send outcome (email-001 SendResult); its warnings are this result's. */
  send: Omit<SendResult, "warnings">;
  /** The mirror id of the draft that was deleted after sending. */
  deletedDraftId: string;
  /** True when the sent draft was actually removed from Drafts; false when the
   * post-send cleanup delete failed (the mail is ALREADY sent regardless). */
  draftDeleted: boolean;
  /** Steps that did not finish after delivery: the Sent copy, its mirror row or
   * body, or removing the sent draft (`draft_kept`). */
  warnings: ActionWarning[];
}

export interface DeleteDraftResult {
  messageId: string;
  fromFolder: string;
  /** The folder a non-hard delete moved the draft to; null for a hard delete. */
  trashFolder: string | null;
}

/** `\Draft` marks a saved draft; `\Seen` keeps it out of unread counts. */
const DRAFT_FLAGS = ["\\Draft", "\\Seen"];

/**
 * Derive a stable Message-ID from an idempotency key so a retried create maps to the
 * SAME message and is found in Drafts before APPEND instead of duplicating.
 */
function buildDraftMessageId(domain: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${domain}:${idempotencyKey}`).digest("hex");
  return `<draft-${digest.slice(0, 32)}@${domain}>`;
}

type SavedDraft = Omit<CreateDraftResult, "accountId">;

interface ComposedDraft {
  raw: Buffer;
  rfcMessageId: string;
  idempotencyKey: string | null;
}

async function composeDraft(
  account: ImapAccount,
  req: SendRequest,
  idempotencyKey?: string | null
): Promise<ComposedDraft> {
  // With an idempotency key, stamp a deterministic Message-ID (buildRawMime honors
  // req.messageId) so a retry finds its own prior APPEND instead of duping.
  const request: SendRequest = idempotencyKey
    ? { ...req, messageId: buildDraftMessageId(domainOf(account.email_address), idempotencyKey) }
    : req;
  const { raw, messageId: rfcMessageId } = await buildRawMime(request, { email: account.email_address });
  return { raw, rfcMessageId, idempotencyKey: idempotencyKey ?? null };
}

/**
 * Compose `req`, APPEND it to the account's Drafts folder, and write its mirror row,
 * under the per-account advisory lock: one mirror-changing operation per Mailbox
 * Account at a time. The save waits for a sync that holds the lock (withInteractiveAccountLock).
 * The lock fences its writes, as sync's does: a save that lost the lock cannot write
 * a row that sync already read, and no sync interleaves with the mirror write.
 */
async function saveDraft(
  pool: PgPool,
  config: AppConfig,
  repository: MirrorRepository,
  account: ImapAccount,
  req: SendRequest,
  idempotencyKey: string | null | undefined,
  options: MailboxActionOptions
): Promise<SavedDraft> {
  const composed = await timeStep(options.onStep, "compose", () => composeDraft(account, req, idempotencyKey));
  const bodyStore = actionBodyStore(repository, options.bodyStore);
  const warnings: ActionWarning[] = [];
  return await withInteractiveAccountLock(pool, account, async (lock) => {
    const connection = new ActionConnection(pool, config, account, options);
    try {
      return await fileAndMirrorDraft(repository, config, bodyStore, account, composed, lock, warnings, connection);
    } finally {
      await connection.close();
    }
  }, { fenceWrites: true, onStep: options.onStep });
}

/** The locked part of a save: file the draft, then mirror it (ADR 0046). */
async function fileAndMirrorDraft(
  repository: MirrorRepository,
  config: AppConfig,
  bodyStore: BodyStore,
  account: ImapAccount,
  composed: ComposedDraft,
  lock: AccountLock,
  warnings: ActionWarning[],
  connection: ActionConnection
): Promise<SavedDraft> {
  const { raw, rfcMessageId, idempotencyKey } = composed;
  const filed = await fileDraft(repository, account, raw, rfcMessageId, idempotencyKey, connection);
  // The provider holds the draft now. A later mirror or lock failure must not fail
  // the save: a retry without an idempotency key would file a second draft.
  lock.confirmIrreversible();
  const saved: SavedDraft = {
    draftsFolderPath: filed.draftsFolderPath,
    rfcMessageId,
    messageId: null,
    appendedUid: filed.appended?.uid ?? null,
    warnings
  };
  if (!filed.appended) return saved;
  const appended = filed.appended;
  try {
    // A retry that found an earlier attempt's copy mirrors only its row when it is
    // not mirrored yet: that attempt's bytes may differ from these, so its body is
    // left to the body lane.
    saved.messageId = (filed.retried
      ? await timeStep(connection.onStep, "db_mirror", () => repository.getLiveMessageId({
        accountId: account.id, folderPath: filed.draftsFolderPath, ...appended
      }))
      : null)
      ?? await mirrorFiledMessage(repository, config, bodyStore, connection, account.id,
        { folderPath: filed.draftsFolderPath, appended, raw: filed.retried ? null : raw },
        (warning) => warnings.push(warning));
  } catch (error) {
    warnings.push(actionWarning("mirror_pending", error));
  }
  return saved;
}

/** File the composed bytes in Drafts, or find the copy that an earlier attempt with
 * the same idempotency key filed. */
async function fileDraft(
  repository: MirrorRepository,
  account: ImapAccount,
  raw: Buffer,
  rfcMessageId: string,
  idempotencyKey: string | null | undefined,
  connection: ActionConnection
): Promise<{ draftsFolderPath: string; appended: AppendedUid | null; retried: boolean }> {
  const appender = SentFolderAppender.over(await connection.get());
  const profile = getProviderProfile(account.provider_profile);
  const mailboxes = await appender.list();
  // Resolve Drafts via the shared role-keyed resolver: the "drafts" role uses its
  // leaf-name fallback and (unlike Sent) ignores the profile (behavior preserved).
  // The SQL draftFolderPaths stays a SEPARATE encoding (mirrored table, not LIST).
  const draftsFolderPath = resolveSpecialUseFolder(mailboxes, "drafts", profile);

  // Idempotency: a retried create (same key -> same Message-ID) finds its prior
  // APPEND and returns that UID instead of filing a duplicate draft. Runs under
  // the same lock as the APPEND, so lookup + append are atomic per account.
  if (idempotencyKey) {
    const existing = await appender.findByMessageId(draftsFolderPath, rfcMessageId);
    if (existing.uids.length > 0) {
      return {
        draftsFolderPath,
        appended: { uidValidity: existing.uidValidity, uid: Math.max(...existing.uids) },
        retried: true
      };
    }
  }

  // Drafts is durably due before the provider command, as for a move, so a host
  // can reconcile it after acknowledgement without a prompt IDLE/NOTIFY event.
  await timeStep(connection.onStep, "db_mirror", () => repository.markFoldersForReconcile(account.id, [draftsFolderPath]));
  const appended = await appender.append(draftsFolderPath, raw, DRAFT_FLAGS, new Date());
  return { draftsFolderPath, appended, retried: false };
}

/**
 * Create a draft: compose RFC-822 bytes (email-001 buildRawMime), APPEND them with
 * `\Draft` to the resolved Drafts folder, and write the draft's mirror row from the
 * server's APPENDUID, when the folder identity checks pass (ADR 0046). Without a mirror id, the next
 * sync of Drafts mirrors the copy.
 */
export async function createDraft(
  pool: PgPool,
  config: AppConfig,
  input: DraftInput,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection,
  options: MailboxActionOptions = {}
): Promise<CreateDraftResult> {
  const request = parseInput(DRAFT_INPUT_SCHEMA, input);
  throwIfAborted(options.signal);
  const repository = new MirrorRepository(pool, config, metadataProtection);
  const account = await timeStep(options.onStep, "db_load", () => repository.getAccount(request.accountId));
  if (!account) throw new NotFoundError(`Account not found: ${request.accountId}`);

  const saved = await saveDraft(pool, config, repository, account, request, request.idempotencyKey, options);
  return { accountId: account.id, ...saved };
}

/** A mirrored Drafts-folder row, joined with its stored body for the get view. */
interface DraftRow extends ProtectedMetadataColumns {
  id: string;
  account_id: string;
  folder_path: string;
  uid: string;
  rfc_message_id: string | null;
  subject: string | null;
  from_email: string | null;
  to_emails: string[] | null;
  cc_emails: string[] | null;
  flags: string[] | null;
  in_reply_to: string | null;
  references_header: string | null;
  internal_date: Date;
  body_text: string | null;
  body_html: string | null;
  body_plain: string | null;
  selected_text_part: string | null;
  selected_text_format: "plain" | "html" | null;
}

function toSummary(row: DraftRow): DraftSummary {
  return {
    messageId: row.id,
    accountId: row.account_id,
    folderPath: row.folder_path,
    uid: Number(row.uid),
    rfcMessageId: row.rfc_message_id,
    subject: row.subject,
    fromEmail: row.from_email,
    toEmails: row.to_emails ?? [],
    ccEmails: row.cc_emails ?? [],
    date: row.internal_date.toISOString(),
    flags: row.flags ?? []
  };
}

/**
 * Resolve which folder paths hold drafts for an account: any folder whose
 * special_use is `\Drafts`, plus the conventional name fallback. Drafts are
 * mirrored (provider-profiles keeps them), so this reads the synced folder set.
 */
async function draftFolderPaths(client: Pick<PgClient, "query">, accountId: string): Promise<string[]> {
  // The Drafts vocabulary is shared with the in-memory role resolver
  // (DRAFTS_VOCABULARY) so the two never drift on "what names a Drafts folder";
  // the QUERY stays its own distinct encoding (mirrored folder table, not a LIST).
  const result = await client.query<{ path: string }>(
    `
    SELECT path
    FROM public.imap_folders
    WHERE account_id = $1
      AND (
        lower(coalesce(special_use, '')) = $2
        OR lower(regexp_replace(path, '^.*[/.]', '')) = $3
      )
    `,
    [accountId, DRAFTS_VOCABULARY.specialUse, DRAFTS_VOCABULARY.leafName]
  );
  const paths = result.rows.map((r) => r.path);
  // Always include the conventional name so a draft filed before folder discovery
  // (or on a server that doesn't advertise special-use) is still listed.
  if (!paths.some((p) => p.toLowerCase() === DRAFTS_VOCABULARY.leafName)) paths.push(DRAFTS_VOCABULARY.conventional);
  return paths;
}

/** A draft lives in a Drafts folder or carries the `\Draft` flag. */
function isDraft(draftFolders: string[], row: { folder_path: string; flags: string[] | null }): boolean {
  return draftFolders.includes(row.folder_path)
    || (row.flags ?? []).some((flag) => flag.toLowerCase() === "\\draft");
}

/**
 * Prove `messageId` names a live draft. Any other message is "not found" to a draft
 * action, so a draft update or delete can never rewrite or remove an ordinary email.
 */
async function loadLiveDraft(pool: PgPool, repository: MirrorRepository, messageId: string): Promise<ImapMessage> {
  const message = await repository.getMessage(messageId);
  if (!message) throw new NotFoundError(`Draft not found: ${messageId}`);
  if (message.deleted_in_provider) throw new NotFoundError(`Draft ${messageId} is already deleted in the provider`);
  if (!isDraft(await draftFolderPaths(pool, message.account_id), message)) {
    throw new NotFoundError(`Draft not found: ${messageId}`);
  }
  return message;
}

/**
 * List drafts from the MIRROR. Drafts are already-synced messages living in the
 * Drafts folder (or carrying the `\Draft` flag). Read-only — no IMAP round-trip.
 */
export async function listDrafts(
  pool: PgPool,
  config: AppConfig,
  accountId: string,
  options: { limit?: number; metadataProtection?: MetadataProtectionAdapter } = {}
): Promise<DraftSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const client = await pool.connect();
  try {
    const paths = await draftFolderPaths(client, accountId);
    const result = await client.query<DraftRow>(
      `
      SELECT
        m.id, m.account_id, m.folder_path, m.uid, m.rfc_message_id, m.subject,
        m.from_email, m.to_emails, m.cc_emails, m.flags, m.in_reply_to,
        m.references_header, m.internal_date,
        m.protected_metadata, m.protected_metadata_version,
        m.protected_metadata_key_version, m.protected_metadata_tokens,
        NULL::text AS body_text, NULL::text AS body_html, NULL::text AS body_plain,
        NULL::text AS selected_text_part, NULL::text AS selected_text_format
      FROM public.imap_messages m
      WHERE m.account_id = $1
        AND m.deleted_in_provider = false
        AND (
          m.folder_path = ANY($2::text[])
          OR EXISTS (SELECT 1 FROM unnest(coalesce(m.flags, '{}'::text[])) f WHERE lower(f) = '\\draft')
        )
      ORDER BY m.internal_date DESC, m.id DESC
      LIMIT $3
      `,
      [accountId, paths, limit]
    );
    const metadataProtection = options.metadataProtection ?? plaintextMetadataProtection;
    return Promise.all(result.rows.map(async (row) => toSummary(
      await revealMetadataRecord(
        metadataProtection,
        { kind: "message", accountId: row.account_id, recordId: row.id },
        row,
        METADATA_PROTECTED_FIELDS.message
      )
    )));
  } finally {
    client.release();
  }
}

/**
 * Get one draft (with its body) from the mirror by mirror message id. Returns null
 * if the message is not a draft (not in a Drafts folder and not `\Draft`-flagged).
 */
export async function getDraft(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<DraftDetail | null> {
  if (!isMirrorId(messageId)) return null;
  const client = await pool.connect();
  try {
    const result = await client.query<DraftRow>(
      `
      SELECT
        m.id, m.account_id, m.folder_path, m.uid, m.rfc_message_id, m.subject,
        m.from_email, m.to_emails, m.cc_emails, m.flags, m.in_reply_to,
        m.references_header, m.internal_date,
        m.protected_metadata, m.protected_metadata_version,
        m.protected_metadata_key_version, m.protected_metadata_tokens,
        b.body_text, b.body_html, b.body_plain, b.selected_text_part, b.selected_text_format
      FROM public.imap_messages m
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      WHERE m.id = $1
        AND m.deleted_in_provider = false
      `,
      [messageId]
    );
    const storedRow = result.rows[0];
    if (!storedRow) return null;
    const row = await revealMetadataRecord(
      metadataProtection,
      { kind: "message", accountId: storedRow.account_id, recordId: storedRow.id },
      storedRow,
      METADATA_PROTECTED_FIELDS.message
    );

    if (!isDraft(await draftFolderPaths(client, row.account_id), row)) return null;

    // The draft is HTML when its selected body part is HTML, or (defensively) when
    // there is an HTML body but no plaintext to fall back to. Send uses bodyHtml so
    // links/formatting survive instead of being flattened by htmlToText.
    const isHtml =
      row.selected_text_format === "html" ||
      (row.body_html !== null && row.body_text === null && row.body_plain === null);

    return {
      ...toSummary(row),
      body: row.body_text ?? row.body_plain ?? row.selected_text_part ?? null,
      bodyHtml: row.body_html ?? null,
      isHtml,
      inReplyTo: row.in_reply_to,
      references: row.references_header
    };
  } finally {
    client.release();
  }
}

/**
 * Update a draft. IMAP drafts are immutable (a stored message has a fixed
 * server-assigned UID and cannot be edited in place), so update is APPEND-new +
 * delete-old: file the revised draft (with its mirror row, as create does), then
 * hard-delete the previous one (reusing the email-002 capability-gated delete).
 */
export async function updateDraft(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  input: Omit<DraftInput, "accountId">,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection,
  options: MailboxActionOptions = {}
): Promise<UpdateDraftResult> {
  const request = parseInput(DRAFT_UPDATE_SCHEMA, input);
  throwIfAborted(options.signal);
  const repository = new MirrorRepository(pool, config, metadataProtection);
  const { draft, account } = await timeStep(options.onStep, "db_load", async () => {
    const draft = await loadLiveDraft(pool, repository, messageId);
    return { draft, account: await repository.getAccount(draft.account_id) };
  });
  if (!account) throw new Error(`Account not found for draft ${messageId}: ${draft.account_id}`);

  const composed = await timeStep(options.onStep, "compose", () => composeDraft(account, { ...request, accountId: account.id }));
  const bodyStore = actionBodyStore(repository, options.bodyStore);
  const warnings: ActionWarning[] = [];
  // One lock across the APPEND and the delete, so no sync runs between them, and
  // one connection, so one login per update.
  const { saved, replacedDraftDeleted } = await withInteractiveAccountLock(pool, account, async (lock) => {
    const connection = new ActionConnection(pool, config, account, options);
    try {
      const saved = await fileAndMirrorDraft(repository, config, bodyStore, account, composed, lock, warnings, connection);
      // Hard-delete the superseded draft (reuse email-002). The revised draft is
      // already filed, so a delete failure (e.g. no UIDPLUS for a UID-scoped
      // EXPUNGE) is `draft_kept`, not a failed update; the User removes the copy.
      try {
        await deleteMessageInLock(pool, config, messageId, {
          hard: true, metadataProtection, signal: options.signal, onStep: options.onStep, connection
        });
        return { saved, replacedDraftDeleted: true };
      } catch (error) {
        warnings.push(actionWarning("draft_kept", error));
        return { saved, replacedDraftDeleted: false };
      }
    } finally {
      await connection.close();
    }
  }, { fenceWrites: true, onStep: options.onStep });

  return { accountId: account.id, ...saved, replacedMessageId: messageId, replacedDraftDeleted };
}

/**
 * Send a draft by RESENDING its real RFC-822 bytes — a true round-trip, NOT a
 * rebuild from the mirror's parsed fields (ADR 0019, revised).
 *
 * The old path reconstructed a `SendRequest` from `getDraft`'s parsed body
 * (`draft.body` / `draft.bodyHtml`). Under lazy body-fetch a freshly created or
 * updated draft's BODY may not be mirrored yet (`body` NULL) even though its
 * headers/recipients are — so the rebuild SENT AN EMPTY EMAIL. The fix sends the
 * draft's actual stored bytes, so body + HTML + formatting (and provider-composed
 * attachments) survive by construction and the mirror-body dependence is gone.
 *
 * Flow:
 *  1. `getRawMime` returns the draft's raw bytes — the mirrored `raw_mime`, or an
 *     on-demand UIDVALIDITY-guarded IMAP FETCH from the draft's Drafts folder+UID
 *     (folder/uid/uidvalidity are reliably synced even when the body isn't).
 *  2. `deliverSmtp` submits those EXACT bytes (reusing `resolveSmtpCreds` +
 *     `assertSafeSmtpTarget` SSRF guard + the requireTLS logic from the send path).
 *     The envelope `to` = the draft's synced header recipients (To + Cc) — never the
 *     lazy body — so recipient handling stays safe.
 *  3. The SAME bytes are APPENDed to Sent (reuse `SentFolderAppender`), as send does.
 *  4. The draft is best-effort hard-deleted from Drafts.
 */
export async function sendDraft(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection,
  options: MailboxActionOptions = {}
): Promise<SendDraftResult> {
  let deliveryConfirmed = false;
  try {
    return await sendDraftAttempt(pool, config, messageId, metadataProtection, options, () => {
      deliveryConfirmed = true;
    });
  } catch (error) {
    if (error instanceof SmtpDeliveryError) throw error;
    if (
      !deliveryConfirmed &&
      [
        "AbortError",
        "AccountBusyError",
        "HostValidationError",
        "NoRecipientsError",
        "NotFoundError"
      ].includes(error instanceof Error ? error.name : "")
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

async function sendDraftAttempt(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  metadataProtection: MetadataProtectionAdapter,
  { signal, bodyStore: hostBodyStore, sessions, onStep }: MailboxActionOptions,
  confirmDelivery: () => void
): Promise<SendDraftResult> {
  throwIfAborted(signal);
  const draft = await timeStep(onStep, "db_load", () => getDraft(pool, config, messageId, metadataProtection));
  if (!draft) throw new NotFoundError(`Draft not found: ${messageId}`);
  if (draft.toEmails.length === 0) {
    throw new NoRecipientsError(`Draft ${messageId} has no recipients; add a To address before sending`);
  }

  const repository = new MirrorRepository(pool, config, metadataProtection);
  const account = await timeStep(onStep, "db_load", () => repository.getAccount(draft.accountId));
  if (!account) throw new Error(`Account not found for draft ${messageId}: ${draft.accountId}`);
  const bodyStore = actionBodyStore(repository, hostBodyStore);

  // Resolve SMTP creds + run the SSRF guard exactly as send.ts does.
  const { creds, isPrivateHost } = await timeStep(onStep, "smtp_send", async () => {
    const creds = await resolveSmtpCreds(pool, config, account);
    const { isPrivateHost } = await assertSafeSmtpTarget(creds.host, creds.port, creds.secure, {
      allowPrivateHosts: config.IMAP_ALLOW_PRIVATE_HOSTS
    });
    return { creds, isPrivateHost };
  });

  // Envelope recipients come from the SYNCED header fields only (never the lazy
  // body): MAIL FROM = the account email, RCPT TO = the draft's To + Cc.
  const envelope = { from: account.email_address, to: [...draft.toEmails, ...draft.ccEmails] };
  const warnings: ActionWarning[] = [];

  // The raw fetch can itself require IMAP, so acquire before it and keep the same
  // account lock through SMTP delivery, Sent APPEND, appender teardown, and draft
  // cleanup. Contention is proven-unsent: no provider verb has run yet.
  return await withInteractiveAccountLock(pool, account, async (lock) => {
    // One connection for the raw fetch, the Sent APPEND and the draft delete. It is
    // opened again only if it died while SMTP ran, which can outlast an idle socket.
    const connection = new ActionConnection(pool, config, account, { signal, sessions, onStep });
    try {
      // The draft's ACTUAL bytes (true round-trip): mirrored raw_mime, or an on-demand
      // UIDVALIDITY-guarded FETCH from the Drafts folder+UID. This carries the real
      // body + HTML + formatting regardless of lazy mirror-body state.
      const { raw, truncated } = await getRawMime(pool, config, messageId, metadataProtection, { signal, connection, onStep });
      if (truncated) {
        // Fail closed before SMTP: the capped bytes would be a corrupt MIME message.
        throw new Error(
          `Draft ${messageId} raw MIME exceeds the fetch cap and would be truncated; refusing to send a corrupt message.`
        );
      }

      // Re-prove heartbeat + session ownership immediately before crossing the
      // irreversible SMTP boundary (the raw fetch may have taken time).
      await lock.assertLive();
      throwIfAborted(signal);
      const delivery = await timeStep(onStep, "smtp_send", () => deliverSmtp(creds, raw, envelope, config, { isPrivateHost }));
      confirmDelivery();
      lock.confirmIrreversible();

      // The mail is sent. A lock that is no longer live files nothing and removes
      // nothing (its fenced writes would fail anyway); every other failure from
      // here is a warning on a delivered result.
      let sent: SentCopy = { appendedToSent: false, appendedUid: null, sentFolderPath: null, messageId: null };
      const liveness = await lock.assertLive().then(() => null, (error: unknown) => error);
      if (liveness) warnings.push(actionWarning("sent_copy_missing", liveness));
      // File the same bytes to Sent and mirror the copy at once (ADR 0046).
      else sent = await fileSentCopy(repository, config, bodyStore, account, connection, raw, (warning) => warnings.push(warning));

      // Remove the sent draft while the same account lock remains held.
      let draftDeleted = false;
      try {
        if (liveness) throw liveness;
        await lock.assertLive();
        await deleteMessageInLock(pool, config, messageId, { hard: true, metadataProtection, signal, onStep, connection });
        draftDeleted = true;
      } catch (error) {
        warnings.push(actionWarning("draft_kept", error));
      }

      const send: Omit<SendResult, "warnings"> = {
        // The resent bytes carry the draft's ORIGINAL Message-ID (no recompose).
        rfcMessageId: draft.rfcMessageId ?? "",
        delivered: true,
        accepted: delivery.accepted,
        rejected: delivery.rejected,
        smtpResponse: delivery.response,
        ...sent
      };
      return { send, deletedDraftId: messageId, draftDeleted, warnings };
    } finally {
      // Teardown is never a result: before delivery the thrown error stands, and
      // after it a thrown close could invite a duplicate send.
      await connection.close().catch(() => undefined);
    }
  }, {
    fenceWrites: true,
    heartbeatIntervalMs: accountLockHeartbeatIntervalMs(config.STALE_HEARTBEAT_MS),
    onStep
  });
}

/**
 * Delete a draft. Reuses the email-002 capability-gated delete mutation: default
 * moves it to Trash (reversible), `hard: true` EXPUNGEs it (irreversible).
 */
export async function deleteDraft(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  options: MailboxActionOptions & { hard?: boolean; metadataProtection?: MetadataProtectionAdapter } = {}
): Promise<DeleteDraftResult> {
  const repository = new MirrorRepository(pool, config, options.metadataProtection ?? plaintextMetadataProtection);
  await timeStep(options.onStep, "db_load", () => loadLiveDraft(pool, repository, messageId));
  const result = await deleteMessage(pool, config, messageId, options);
  return { messageId: result.messageId, fromFolder: result.fromFolder, trashFolder: result.trashFolder };
}
