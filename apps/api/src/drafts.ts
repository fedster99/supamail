import type { AppConfig } from "./config.js";
import type { PgClient, PgPool } from "./db.js";
import { NoRecipientsError, NotFoundError } from "./errors.js";
import { closeImap } from "./imap-connect.js";
import { deleteMessage } from "./mailbox-mutations.js";
import { DRAFTS_VOCABULARY, getProviderProfile, resolveSpecialUseFolder } from "./provider-profiles.js";
import { MirrorRepository } from "./repository.js";
import { sendMessage } from "./send.js";
import { SentFolderAppender, buildRawMime } from "./smtp-client.js";
import type { ImapAccount, SendRecipient, SendRequest, SendResult } from "./types.js";

/**
 * Full draft CRUD saved to the provider Drafts folder (email-003, ADR 0019).
 * This is mostly COMPOSITION of the email-001 and email-002 primitives:
 *
 * - Create  = buildRawMime (email-001) → APPEND `\Draft` to the Drafts folder via
 *   the write-only {@link SentFolderAppender} (email-001's generic appender).
 * - List/Get = read the MIRROR — drafts are already-synced messages in the Drafts
 *   folder (provider-profiles.ts intentionally mirrors Drafts).
 * - Update  = APPEND-new + delete-old. IMAP drafts are immutable (a message has a
 *   server-assigned UID and cannot be edited in place), so an update files a fresh
 *   draft and hard-deletes the previous one (email-002 `deleteMessage(hard)`).
 * - Send    = load the draft from the mirror → `sendMessage` (email-001) → delete
 *   the draft. The SMTP path is NOT duplicated; we feed sendMessage a SendRequest
 *   reconstructed from the stored draft.
 * - Delete  = email-002 `deleteMessage` (reuses the capability-gated mutation).
 *
 * This module lives OUTSIDE src/mcp/ on purpose: the agent surface is zero-send /
 * zero-mutate (ADR 0014/0016), so APPEND + delete must never be importable there.
 * The sync read adapter likewise never gains a write verb — APPEND lives only on
 * {@link SentFolderAppender} (email-001) and delete only on the email-002
 * {@link import("./mailbox-mutations.js").MailboxMutator}.
 */

/** What a draft create/update carries — a SendRequest minus `bcc` and
 * `attachments`. Neither can round-trip through the APPENDed draft bytes: nodemailer's
 * keepBcc default omits Bcc from the composed MIME, and `sendDraft` rebuilds the
 * SendRequest from the parsed mirror fields (attachment bytes are never mirrored), so
 * an attachment on a saved draft would be silently dropped on send. Both are therefore
 * send-time-only fields — set them on the `sendMessage` envelope, not on a draft (see
 * ADR 0019 / 0020). `accountId` selects the mailbox whose Drafts folder we file to. */
export type DraftInput = Omit<SendRequest, "bcc" | "attachments">;

/** Reject a Bcc smuggled past the type system (e.g. an untyped HTTP/JSON caller).
 * Bcc on a draft is dropped end-to-end, so refuse it loudly instead. */
function rejectBcc(input: unknown): void {
  if (input && typeof input === "object" && (input as { bcc?: unknown }).bcc !== undefined) {
    throw new Error("Bcc is not supported on saved drafts — set Bcc when you send the draft");
  }
}

/** Reject attachments smuggled past the type system (e.g. an untyped HTTP/JSON
 * caller). A draft composes its bytes once at APPEND time, but `sendDraft` rebuilds
 * the SendRequest from parsed mirror fields (attachment bytes are never mirrored), so
 * an attachment on a saved draft is dropped on send — refuse it loudly instead. */
function rejectAttachments(input: unknown): void {
  if (input && typeof input === "object" && (input as { attachments?: unknown }).attachments !== undefined) {
    throw new Error("Attachments are not supported on saved drafts — attach files when you send the draft");
  }
}

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
  /** From UIDPLUS APPENDUID when the server provides one, else null. The mirrored
   * row (and its stable message_id) appears after the next sync of Drafts. */
  appendedUid: number | null;
}

export interface UpdateDraftResult extends CreateDraftResult {
  /** The mirror id of the superseded draft that was deleted. */
  replacedMessageId: string;
  /** True when the superseded draft was actually removed; false when the cleanup
   * delete failed (best-effort — the new draft is already filed). */
  replacedDraftDeleted: boolean;
  /** Non-fatal warnings (e.g. the old draft couldn't be EXPUNGEd on a non-UIDPLUS
   * server). The update still succeeded; a leftover duplicate self-heals on sync. */
  warnings: string[];
}

export interface SendDraftResult {
  /** The send outcome (email-001 SendResult). */
  send: SendResult;
  /** The mirror id of the draft that was deleted after sending. */
  deletedDraftId: string;
  /** True when the sent draft was actually removed from Drafts; false when the
   * post-send cleanup delete failed (the mail is ALREADY sent regardless). */
  draftDeleted: boolean;
  /** Non-fatal warnings (e.g. the draft couldn't be EXPUNGEd on a non-UIDPLUS
   * server). The send still succeeded; the leftover draft self-heals on sync. */
  warnings: string[];
}

export interface DeleteDraftResult {
  messageId: string;
  fromFolder: string;
}

/** APPEND `req` to the account's Drafts folder with the `\Draft` flag, reusing the
 * email-001 write-only appender. Returns the resolved folder + APPENDUID. */
async function appendDraft(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount,
  req: SendRequest
): Promise<{ draftsFolderPath: string; rfcMessageId: string; appendedUid: number | null }> {
  const from = { email: account.email_address };
  const { raw, messageId } = await buildRawMime(req, from);

  const appender = await SentFolderAppender.connect(pool, config, account);
  try {
    const profile = getProviderProfile(account.provider_profile);
    const mailboxes = await appender.list();
    // Resolve Drafts via the shared role-keyed resolver: the "drafts" role uses its
    // leaf-name fallback and (unlike Sent) ignores the profile (behavior preserved).
    // The SQL draftFolderPaths stays a SEPARATE encoding (mirrored table, not LIST).
    const draftsFolderPath = resolveSpecialUseFolder(mailboxes, "drafts", profile);
    // `\Draft` marks it as a draft; `\Seen` keeps it from inflating unread counts.
    const result = await appender.append(draftsFolderPath, raw, ["\\Draft", "\\Seen"], new Date());
    return { draftsFolderPath, rfcMessageId: messageId, appendedUid: result.uid };
  } finally {
    await closeImap(appender);
  }
}

/**
 * Create a draft: compose RFC-822 bytes (email-001 buildRawMime) and APPEND them
 * with `\Draft` to the resolved Drafts folder. We do NOT insert a mirror row — the
 * next sync of Drafts mirrors the copy with its server-assigned UID, so identity
 * is never guessed (same discipline as email-001's Sent APPEND).
 */
export async function createDraft(
  pool: PgPool,
  config: AppConfig,
  input: DraftInput
): Promise<CreateDraftResult> {
  rejectBcc(input);
  rejectAttachments(input);
  const repository = new MirrorRepository(pool, config);
  const account = await repository.getAccount(input.accountId);
  if (!account) throw new Error(`Account not found: ${input.accountId}`);

  const { draftsFolderPath, rfcMessageId, appendedUid } = await appendDraft(pool, config, account, input);
  return { accountId: account.id, draftsFolderPath, rfcMessageId, appendedUid };
}

/** A mirrored Drafts-folder row, joined with its stored body for the get view. */
interface DraftRow {
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
async function draftFolderPaths(client: PgClient, accountId: string): Promise<string[]> {
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

/**
 * List drafts from the MIRROR. Drafts are already-synced messages living in the
 * Drafts folder (or carrying the `\Draft` flag). Read-only — no IMAP round-trip.
 */
export async function listDrafts(
  pool: PgPool,
  config: AppConfig,
  accountId: string,
  options: { limit?: number } = {}
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
    return result.rows.map(toSummary);
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
  messageId: string
): Promise<DraftDetail | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<DraftRow>(
      `
      SELECT
        m.id, m.account_id, m.folder_path, m.uid, m.rfc_message_id, m.subject,
        m.from_email, m.to_emails, m.cc_emails, m.flags, m.in_reply_to,
        m.references_header, m.internal_date,
        b.body_text, b.body_html, b.body_plain, b.selected_text_part, b.selected_text_format
      FROM public.imap_messages m
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      WHERE m.id = $1
        AND m.deleted_in_provider = false
      `,
      [messageId]
    );
    const row = result.rows[0];
    if (!row) return null;

    const paths = await draftFolderPaths(client, row.account_id);
    const isDraftFolder = paths.includes(row.folder_path);
    const isDraftFlagged = (row.flags ?? []).some((f) => f.toLowerCase() === "\\draft");
    if (!isDraftFolder && !isDraftFlagged) return null;

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
 * delete-old: file the revised draft, then hard-delete the previous one (reusing
 * the email-002 capability-gated delete). The new draft's mirror row appears after
 * the next Drafts sync.
 */
export async function updateDraft(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  input: Omit<DraftInput, "accountId">
): Promise<UpdateDraftResult> {
  rejectBcc(input);
  rejectAttachments(input);
  const repository = new MirrorRepository(pool, config);
  const existing = await repository.getMessage(messageId);
  if (!existing) throw new NotFoundError(`Draft not found: ${messageId}`);
  if (existing.deleted_in_provider) throw new Error(`Draft ${messageId} is already deleted in the provider`);
  const account = await repository.getAccount(existing.account_id);
  if (!account) throw new Error(`Account not found for draft ${messageId}: ${existing.account_id}`);

  const req: SendRequest = { ...input, accountId: account.id };
  const { draftsFolderPath, rfcMessageId, appendedUid } = await appendDraft(pool, config, account, req);

  // Hard-delete the superseded draft (reuse email-002). Best-effort: the revised
  // draft is ALREADY filed, so a delete failure (e.g. no UIDPLUS for a UID-scoped
  // EXPUNGE) must NOT fail the update — we downgrade it to a warning and report the
  // update as done. A lingering old draft self-heals on the next Drafts sync.
  const warnings: string[] = [];
  let replacedDraftDeleted = true;
  try {
    await deleteMessage(pool, config, messageId, { hard: true });
  } catch (error) {
    replacedDraftDeleted = false;
    warnings.push(
      `Updated, but removing the previous draft failed: ${error instanceof Error ? error.message : String(error)}. The old copy self-heals on the next sync.`
    );
  }

  return {
    accountId: account.id,
    draftsFolderPath,
    rfcMessageId,
    appendedUid,
    replacedMessageId: messageId,
    replacedDraftDeleted,
    warnings
  };
}

/**
 * Send a draft: load it from the mirror, reconstruct a SendRequest (To/Cc/Subject
 * + body + threading headers), send it via the email-001 `sendMessage` primitive
 * (which delivers over SMTP and files a copy to Sent), then delete the draft from
 * Drafts. The SMTP path is reused, never duplicated.
 */
export async function sendDraft(
  pool: PgPool,
  config: AppConfig,
  messageId: string
): Promise<SendDraftResult> {
  const draft = await getDraft(pool, config, messageId);
  if (!draft) throw new NotFoundError(`Draft not found: ${messageId}`);
  if (draft.toEmails.length === 0) {
    throw new NoRecipientsError(`Draft ${messageId} has no recipients; add a To address before sending`);
  }

  const to: SendRecipient[] = draft.toEmails.map((email) => ({ email }));
  const cc: SendRecipient[] = draft.ccEmails.map((email) => ({ email }));
  // Preserve the draft's body format. An HTML-authored (or HTML-synced) draft is
  // sent as real HTML — flattening it to htmlTo(text) would silently lose links and
  // formatting. Only a plaintext draft (or an HTML draft with no stored HTML body)
  // goes out as plain. See ADR 0019.
  const body: SendRequest["body"] =
    draft.isHtml && draft.bodyHtml !== null
      ? { format: "html", html: draft.bodyHtml }
      : { format: "plain", text: draft.body ?? "" };
  const request: SendRequest = {
    accountId: draft.accountId,
    to,
    cc: cc.length > 0 ? cc : undefined,
    subject: draft.subject ?? "",
    body,
    inReplyTo: draft.inReplyTo ?? undefined,
    references: draft.references ?? undefined
  };

  const send = await sendMessage(pool, config, request);

  // The mail is sent and filed to Sent; remove the draft so it doesn't linger.
  // Hard-delete (reuse email-002) — a sent draft is gone, not trashed. CRITICAL:
  // the send is IRREVERSIBLE and already succeeded, so the cleanup is best-effort
  // — a delete failure (e.g. no UIDPLUS for a UID-scoped EXPUNGE) must NEVER turn a
  // delivered send into a thrown failure (which would invite a duplicate re-send).
  // We downgrade it to a warning and still report delivered; the leftover draft
  // self-heals on the next Drafts sync. (Mirrors send.ts's best-effort Sent-APPEND.)
  const warnings = [...send.warnings];
  let draftDeleted = true;
  try {
    await deleteMessage(pool, config, messageId, { hard: true });
  } catch (error) {
    draftDeleted = false;
    warnings.push(
      `Delivered, but removing the draft from Drafts failed: ${error instanceof Error ? error.message : String(error)}. The leftover draft self-heals on the next sync.`
    );
  }

  return { send: { ...send, warnings }, deletedDraftId: messageId, draftDeleted, warnings };
}

/**
 * Delete a draft. Reuses the email-002 capability-gated delete mutation: default
 * moves it to Trash (reversible), `hard: true` EXPUNGEs it (irreversible).
 */
export async function deleteDraft(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  options: { hard?: boolean } = {}
): Promise<DeleteDraftResult> {
  const result = await deleteMessage(pool, config, messageId, { hard: options.hard });
  return { messageId: result.messageId, fromFolder: result.fromFolder };
}
