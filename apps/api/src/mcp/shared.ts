import type { PgClient, PgPool } from "../db.js";
import {
  METADATA_PROTECTED_FIELDS,
  plaintextMetadataProtection,
  revealMetadataRecord,
  type MetadataProtectionAdapter,
  type ProtectedMetadataColumns
} from "../metadata-protection.js";
import { buildSyncTrust } from "../search/index.js";
import type { SyncTrust } from "../search/types.js";
import type { WindowStatus } from "../types.js";

/**
 * The shared MCP foundation (ADR 0014/0016). Every agent-email tool and the
 * stdio server plug into the contracts here, so the four tool files
 * (`read_thread`, `read_message`, `list_folders`, `draft_reply`) and the server
 * depend on these signatures verbatim. Keep them STABLE.
 *
 * Read-only by construction: nothing here sends, mutates, or schedules — it only
 * shapes mirror rows and runs SELECTs inside a read-only transaction.
 */

/**
 * The MCP tool definition (literal JSON Schema). This is what `tools/list`
 * returns per entry; it mirrors the shape of `searchEmailToolDefinition` so the
 * registry is uniform.
 */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  inputSchema: { type: "object" } & Record<string, unknown>;
}

/**
 * One entry in the single tool registry. The server reads `definition` for
 * `tools/list` and runs `handler` for `tools/call`. The pool is injected (no
 * global reach-in) so the same handler runs locally or through a remote wrapper (ADR 0014).
 */
export interface ToolEntry {
  definition: ToolDefinition;
  handler: (pool: PgPool, args: unknown) => Promise<unknown>;
}

/** A single mirrored attachment's metadata. Bytes are never mirrored (non-goal). */
export interface MessageAttachment {
  attachment_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  disposition: string | null;
}

/**
 * A fully-read message. Extends the SearchResult field set with `cc`, a cleaned
 * `body`, an attachments list, and optional parsed headers. `read_message`
 * returns one; `read_thread` returns an array. Built by {@link mapMessageRow}
 * (do NOT import search's private `mapRow`).
 */
export interface MessageDetail {
  /** = imap_messages.id; the stable handle passed back as `message_id`. */
  message_id: string;
  /** = provider_thread_id (the conversation handle), or null. */
  thread_id: string | null;
  account_id: string;
  folder_path: string;
  subject: string | null;
  from: { email: string | null; name: string | null };
  to: string[];
  cc: string[];
  /** ISO timestamp of internal_date. */
  date: string;
  flags: string[];
  window_status: WindowStatus;
  /** Cleaned body (coalesce(body_text, body_plain, selected_text_part)). */
  body: string | null;
  /** Whether `body` contains all available source text after the requested options. */
  body_content_status: "complete" | "partial" | "unavailable";
  /** Exact reasons that available source text is absent from `body`. */
  body_omissions: BodyContentOmission[];
  body_truncated: boolean;
  /** Present on read_message responses so a caller can recover a specific body range. */
  body_offset?: number;
  body_total_chars?: number;
  body_next_offset?: number | null;
  attachments: MessageAttachment[];
  /** Parsed select headers, only when the tool was asked to include them. */
  headers?: Record<string, string>;
}

/**
 * The joined SQL row each tool selects: imap_messages columns + the coalesced
 * body source + a JSON-aggregated attachments array. Tools build their own
 * query (so they control the JOINs/filters) but converge on this row shape so
 * one `mapMessageRow` serves them all.
 */
export interface MessageDetailRow {
  id: string;
  account_id: string;
  folder_path: string;
  provider_thread_id: string | null;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  cc_emails: string[] | null;
  flags: string[] | null;
  window_status: WindowStatus;
  internal_date: Date;
  body_text: string | null;
  body_plain: string | null;
  selected_text_part: string | null;
  attachments: MessageAttachmentRow[] | null;
}

export interface MessageAttachmentRow extends ProtectedMetadataColumns {
  attachment_id: string;
  message_id: string;
  account_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | string | null;
  disposition: string | null;
}

/** Load and reveal attachment metadata for one or more messages. */
export async function loadMessageAttachments(
  client: PgClient,
  messageIds: readonly string[],
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<Map<string, MessageAttachmentRow[]>> {
  const byMessage = new Map<string, MessageAttachmentRow[]>();
  for (const messageId of messageIds) byMessage.set(messageId, []);
  if (messageIds.length === 0) return byMessage;

  const result = await client.query<MessageAttachmentRow>(
    `
    SELECT attachment.id AS attachment_id, attachment.message_id, message.account_id,
           attachment.filename, attachment.mime_type, attachment.size_bytes,
           attachment.disposition, attachment.part_number,
           attachment.protected_metadata, attachment.protected_metadata_version,
           attachment.protected_metadata_key_version, attachment.protected_metadata_tokens
    FROM public.imap_attachments attachment
    JOIN public.imap_messages message ON message.id = attachment.message_id
    WHERE attachment.message_id = ANY($1::uuid[])
    ORDER BY attachment.message_id,
             NULLIF(regexp_replace(coalesce(attachment.part_number, ''), '[^0-9]', '', 'g'), '')::bigint NULLS LAST,
             attachment.part_number
    `,
    [messageIds]
  );

  for (const row of result.rows) {
    const revealed = await revealMetadataRecord(
      metadataProtection,
      { kind: "attachment", accountId: row.account_id, recordId: row.attachment_id },
      row,
      METADATA_PROTECTED_FIELDS.attachment
    );
    byMessage.get(row.message_id)?.push(revealed);
  }
  return byMessage;
}

export interface CleanBodyResult {
  text: string | null;
  truncated: boolean;
  totalChars: number;
  offset: number;
  nextOffset: number | null;
  omissions: BodyContentOmission[];
}

export type BodyContentOmission =
  | "quoted_reply_tail"
  | "signature"
  | "outside_requested_range";

export interface CleanBodyOptions {
  includeQuoted: boolean;
  maxChars?: number;
  offset?: number;
}

/**
 * Shared attachment-aggregation SQL fragment (assumes the message alias is `m`).
 * Both read tools select this verbatim so attachment shape and ordering stay in
 * one place. part_number is ordered NUMERICALLY (digits extracted) so part 10
 * sorts after part 2, not before it.
 */
export const ATTACHMENTS_AGG = `COALESCE((SELECT jsonb_agg(jsonb_build_object('attachment_id', a.id, 'filename', a.filename, 'mime_type', a.mime_type, 'size_bytes', a.size_bytes, 'disposition', a.disposition) ORDER BY NULLIF(regexp_replace(a.part_number, '[^0-9]', '', 'g'), '')::bigint NULLS LAST, a.part_number) FROM public.imap_attachments a WHERE a.message_id = m.id), '[]'::jsonb) AS attachments`;

/**
 * Map a joined message row to {@link MessageDetail}. Body precedence is
 * `coalesce(body_text, body_plain, selected_text_part)` (I2). The caller decides
 * `includeQuoted`/`headers`; this only shapes the row, deferring body cleaning to
 * {@link cleanBody} so each tool can pass its own options.
 */
export function mapMessageRow(
  row: MessageDetailRow,
  opts: {
    includeQuoted: boolean;
    maxChars?: number;
    offset?: number;
    includeBodyRange?: boolean;
    headers?: Record<string, string>;
  } = { includeQuoted: false }
): MessageDetail {
  const rawBody = row.body_text ?? row.body_plain ?? row.selected_text_part ?? null;
  const cleaned = cleanBody(rawBody, {
    includeQuoted: opts.includeQuoted,
    maxChars: opts.maxChars,
    offset: opts.offset
  });
  const detail: MessageDetail = {
    message_id: row.id,
    thread_id: row.provider_thread_id,
    account_id: row.account_id,
    folder_path: row.folder_path,
    subject: row.subject,
    from: { email: row.from_email, name: row.from_name },
    to: row.to_emails ?? [],
    cc: row.cc_emails ?? [],
    date: row.internal_date.toISOString(),
    flags: row.flags ?? [],
    window_status: row.window_status,
    body: cleaned.text,
    body_content_status: rawBody === null
      ? "unavailable"
      : cleaned.omissions.length > 0 ? "partial" : "complete",
    body_omissions: cleaned.omissions,
    body_truncated: cleaned.truncated,
    attachments: (row.attachments ?? []).map((a) => ({
      attachment_id: a.attachment_id,
      filename: a.filename,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes === null ? null : Number(a.size_bytes),
      disposition: a.disposition
    }))
  };
  if (opts.includeBodyRange) {
    detail.body_offset = cleaned.offset;
    detail.body_total_chars = cleaned.totalChars;
    detail.body_next_offset = cleaned.nextOffset;
  }
  if (opts.headers) detail.headers = opts.headers;
  return detail;
}

const SIGNATURE_DELIMITER = /^-- ?$/;
const ATTRIBUTION_START = /^On\b/i;
const ATTRIBUTION_END = /\bwrote:\s*$/i;
const MAX_ATTRIBUTION_LINES = 4;
const MIN_QUOTED_TAIL_LINES = 2;

/**
 * Clean a plain-text body for an agent. `body_text` is already HTML-stripped
 * (ADR 0015). When `includeQuoted=false` (the default for read tools) we drop the
 * quoted reply tail introduced by a recognized attribution or trailing
 * quote-only block. It also drops a trailing signature after a `-- ` delimiter.
 * Ambiguous Outlook and Original Message blocks stay intact because email
 * clients use the same shape for forwarded content. It returns the full cleaned
 * body unless the caller explicitly supplies `maxChars`. No heavy markdown conversion.
 */
export function cleanBody(text: string | null, opts: CleanBodyOptions): CleanBodyResult {
  if (text === null) {
    return {
      text: null,
      truncated: false,
      totalChars: 0,
      offset: 0,
      nextOffset: null,
      omissions: []
    };
  }
  const maxChars = Number.isFinite(opts.maxChars) && Number(opts.maxChars) > 0
    ? Math.floor(Number(opts.maxChars))
    : undefined;
  const requestedOffset = Number.isFinite(opts.offset) && Number(opts.offset) > 0
    ? Math.floor(Number(opts.offset))
    : 0;

  let working = text.replace(/\r\n?/g, "\n");
  const omissions: BodyContentOmission[] = [];
  if (!opts.includeQuoted) {
    const withoutQuotedTail = stripQuotedTail(working);
    if (withoutQuotedTail !== working) omissions.push("quoted_reply_tail");
    working = withoutQuotedTail;
    const withoutSignature = stripSignature(working);
    if (withoutSignature !== working) omissions.push("signature");
    working = withoutSignature;
  }
  working = working.replace(/\s+$/, "");
  const range = sliceCodePoints(working, requestedOffset, maxChars);
  if (range.offset > 0 || range.nextOffset !== null) {
    omissions.push("outside_requested_range");
  }
  return {
    text: range.text,
    truncated: range.nextOffset !== null,
    totalChars: range.totalChars,
    offset: range.offset,
    nextOffset: range.nextOffset,
    omissions
  };
}

/** Slice by Unicode code points so a requested range cannot split a surrogate pair. */
function sliceCodePoints(
  text: string,
  requestedOffset: number,
  maxChars?: number
): { text: string; totalChars: number; offset: number; nextOffset: number | null } {
  let charIndex = 0;
  let unitIndex = 0;
  let startUnit = text.length;
  let endUnit = text.length;
  const requestedEnd = maxChars === undefined
    ? Number.POSITIVE_INFINITY
    : requestedOffset + maxChars;

  while (unitIndex < text.length) {
    if (charIndex === requestedOffset) startUnit = unitIndex;
    if (charIndex === requestedEnd) endUnit = unitIndex;
    const codePoint = text.codePointAt(unitIndex);
    unitIndex += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    charIndex += 1;
  }

  const totalChars = charIndex;
  const offset = Math.min(requestedOffset, totalChars);
  const end = maxChars === undefined
    ? totalChars
    : Math.min(totalChars, offset + maxChars);
  if (offset === totalChars) startUnit = text.length;
  if (end === totalChars) endUnit = text.length;

  return {
    text: text.slice(startUnit, endUnit),
    totalChars,
    offset,
    nextOffset: end < totalChars ? end : null
  };
}

/**
 * Drop the quoted reply tail from the first conservative boundary to the end.
 * Forwarded-message separators are intentionally not boundaries because a
 * forward can be new evidence rather than a duplicate thread tail.
 */
function stripQuotedTail(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (
      isAttributionBoundary(lines, i)
      || isQuoteOnlyBoundary(lines, i)
    ) {
      return lines.slice(0, i).join("\n");
    }
  }
  return text;
}

/** Match one-line and conservatively wrapped `On ... wrote:` attributions. */
function isAttributionBoundary(lines: string[], start: number): boolean {
  if (!ATTRIBUTION_START.test(lines[start].trim())) return false;
  for (let end = start; end < Math.min(lines.length, start + MAX_ATTRIBUTION_LINES); end++) {
    const joined = lines
      .slice(start, end + 1)
      .map((line) => line.trim())
      .join(" ");
    if (ATTRIBUTION_END.test(joined)) return true;
  }
  return false;
}

/** Match a final block of at least two `>`-quoted lines after a blank line. */
function isQuoteOnlyBoundary(lines: string[], start: number): boolean {
  if (start === 0 || lines[start - 1].trim() !== "" || !/^\s*>/.test(lines[start])) {
    return false;
  }
  const tail = lines.slice(start).filter((line) => line.trim() !== "");
  return tail.length >= MIN_QUOTED_TAIL_LINES && tail.every((line) => /^\s*>/.test(line));
}

/** Drop a trailing signature introduced by a `-- ` delimiter line. */
function stripSignature(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (SIGNATURE_DELIMITER.test(lines[i])) {
      return lines.slice(0, i).join("\n");
    }
  }
  return text;
}

/**
 * Run `fn` inside a read-only transaction — the exact wrapper copied from
 * `searchMessages` (search.ts), with REPEATABLE READ added so multi-statement
 * tools resolve an active projection from one snapshot: BEGIN REPEATABLE READ
 * READ ONLY; SET LOCAL transaction_read_only = on; SET LOCAL statement_timeout
 * = '15s'; run fn; COMMIT; ROLLBACK on error; release in finally. The connection
 * is injected (no global pool reach-in) and only SELECTs run inside, so a tool
 * can never send, mutate, or schedule.
 */
export async function withReadOnlyTx<T>(pool: PgPool, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL transaction_read_only = on");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The uniform error envelope. `hint` tells the agent what to do next. */
export function toolError(
  code: string,
  message: string,
  hint: string
): { error: { code: string; message: string; hint: string } } {
  return { error: { code, message, hint } };
}

/**
 * Build the sync-trust block for the given accounts, wrapping the search layer's
 * `buildSyncTrust` so tools attach the same honest mirror-completeness signal as
 * search. `null` means "every account in this database". Runs read-only.
 */
export async function syncTrustFor(
  pool: PgPool,
  accountIds: string[] | null,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<SyncTrust> {
  return withReadOnlyTx(
    pool,
    (client) => buildSyncTrust(client, accountIds, metadataProtection)
  );
}
