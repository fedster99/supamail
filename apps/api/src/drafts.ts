import type { AppConfig } from "./config.js";
import type { PgClient, PgPool } from "./db.js";
import { deleteMessage } from "./mailbox-mutations.js";
import { getProviderProfile, type ProviderProfile } from "./provider-profiles.js";
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

/** What a draft create/update carries — a SendRequest minus the threading-only
 * `messageId` stamping concerns. We reuse SendRequest verbatim so compose stays
 * one code path; `accountId` selects the mailbox whose Drafts folder we file to. */
export type DraftInput = SendRequest;

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

/** A single draft with its body text (get view). */
export interface DraftDetail extends DraftSummary {
  body: string | null;
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
}

export interface SendDraftResult {
  /** The send outcome (email-001 SendResult). */
  send: SendResult;
  /** The mirror id of the draft that was deleted after sending. */
  deletedDraftId: string;
}

export interface DeleteDraftResult {
  messageId: string;
  fromFolder: string;
}

/**
 * Pick the Drafts folder to APPEND into: the `\Drafts` special-use mailbox if the
 * server advertises one, else the provider profile's "drafts" priority winner,
 * else the conventional `"Drafts"`. Mirrors resolveSentFolder / resolveTrashFolder.
 */
export function resolveDraftsFolder(
  mailboxes: Array<{ path: string; specialUse?: string | null }>,
  _profile: ProviderProfile
): string {
  const bySpecialUse = mailboxes.find((m) => (m.specialUse ?? "").toLowerCase() === "\\drafts");
  if (bySpecialUse) return bySpecialUse.path;
  const byName = mailboxes.find((m) => m.path.toLowerCase().split(/[/.]/).pop() === "drafts");
  if (byName) return byName.path;
  return "Drafts";
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
    const draftsFolderPath = resolveDraftsFolder(mailboxes, profile);
    // `\Draft` marks it as a draft; `\Seen` keeps it from inflating unread counts.
    const result = await appender.append(draftsFolderPath, raw, ["\\Draft", "\\Seen"], new Date());
    return { draftsFolderPath, rfcMessageId: messageId, appendedUid: result.uid };
  } finally {
    await appender.logout().catch(() => appender.close());
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
  body_plain: string | null;
  selected_text_part: string | null;
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
  const result = await client.query<{ path: string }>(
    `
    SELECT path
    FROM public.imap_folders
    WHERE account_id = $1
      AND (
        lower(coalesce(special_use, '')) = '\\drafts'
        OR lower(regexp_replace(path, '^.*[/.]', '')) = 'drafts'
      )
    `,
    [accountId]
  );
  const paths = result.rows.map((r) => r.path);
  // Always include the conventional name so a draft filed before folder discovery
  // (or on a server that doesn't advertise special-use) is still listed.
  if (!paths.some((p) => p.toLowerCase() === "drafts")) paths.push("Drafts");
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
        NULL::text AS body_text, NULL::text AS body_plain, NULL::text AS selected_text_part
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
        b.body_text, b.body_plain, b.selected_text_part
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

    return {
      ...toSummary(row),
      body: row.body_text ?? row.body_plain ?? row.selected_text_part ?? null,
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
  const repository = new MirrorRepository(pool, config);
  const existing = await repository.getMessage(messageId);
  if (!existing) throw new Error(`Draft not found: ${messageId}`);
  if (existing.deleted_in_provider) throw new Error(`Draft ${messageId} is already deleted in the provider`);
  const account = await repository.getAccount(existing.account_id);
  if (!account) throw new Error(`Account not found for draft ${messageId}: ${existing.account_id}`);

  const req: SendRequest = { ...input, accountId: account.id };
  const { draftsFolderPath, rfcMessageId, appendedUid } = await appendDraft(pool, config, account, req);

  // Hard-delete the superseded draft (reuse email-002). A replaced draft should
  // not linger; the next sync reconciles the source row as deleted-in-provider.
  await deleteMessage(pool, config, messageId, { hard: true });

  return {
    accountId: account.id,
    draftsFolderPath,
    rfcMessageId,
    appendedUid,
    replacedMessageId: messageId
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
  if (!draft) throw new Error(`Draft not found: ${messageId}`);
  if (draft.toEmails.length === 0) {
    throw new Error(`Draft ${messageId} has no recipients; add a To address before sending`);
  }

  const to: SendRecipient[] = draft.toEmails.map((email) => ({ email }));
  const cc: SendRecipient[] = draft.ccEmails.map((email) => ({ email }));
  const request: SendRequest = {
    accountId: draft.accountId,
    to,
    cc: cc.length > 0 ? cc : undefined,
    subject: draft.subject ?? "",
    body: { format: "plain", text: draft.body ?? "" },
    inReplyTo: draft.inReplyTo ?? undefined,
    references: draft.references ?? undefined
  };

  const send = await sendMessage(pool, config, request);

  // The mail is sent and filed to Sent; remove the draft so it doesn't linger.
  // Hard-delete (reuse email-002) — a sent draft is gone, not trashed.
  await deleteMessage(pool, config, messageId, { hard: true });

  return { send, deletedDraftId: messageId };
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
