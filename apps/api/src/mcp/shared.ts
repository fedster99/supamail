import type { PgClient, PgPool } from "../db.js";
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
 * global reach-in) so the same handler runs locally and hosted (ADR 0014).
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
  /** Cleaned + capped body (coalesce(body_text, body_plain, selected_text_part)). */
  body: string | null;
  body_truncated: boolean;
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

export interface MessageAttachmentRow {
  attachment_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | string | null;
  disposition: string | null;
}

export interface CleanBodyResult {
  text: string | null;
  truncated: boolean;
}

export interface CleanBodyOptions {
  includeQuoted: boolean;
  maxChars?: number;
}

export const DEFAULT_MAX_BODY_CHARS = 4096;

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
  opts: { includeQuoted: boolean; maxChars?: number; headers?: Record<string, string> } = { includeQuoted: false }
): MessageDetail {
  const rawBody = row.body_text ?? row.body_plain ?? row.selected_text_part ?? null;
  const cleaned = cleanBody(rawBody, { includeQuoted: opts.includeQuoted, maxChars: opts.maxChars });
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
    body_truncated: cleaned.truncated,
    attachments: (row.attachments ?? []).map((a) => ({
      attachment_id: a.attachment_id,
      filename: a.filename,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes === null ? null : Number(a.size_bytes),
      disposition: a.disposition
    }))
  };
  if (opts.headers) detail.headers = opts.headers;
  return detail;
}

const SIGNATURE_DELIMITER = /^-- ?$/;
const ATTRIBUTION_LINE = /^On\b.*\bwrote:\s*$/;

/**
 * Clean a plain-text body for an agent. `body_text` is already HTML-stripped
 * (ADR 0015). When `includeQuoted=false` (the default for read tools) we drop the
 * quoted reply tail — `>`-prefixed lines and the `"On ... wrote:"` attribution
 * block that introduces them — plus a trailing signature after a `-- ` delimiter.
 * Then clamp to `maxChars` (default 4096), marking `truncated` when cut. No heavy
 * markdown conversion.
 */
export function cleanBody(text: string | null, opts: CleanBodyOptions): CleanBodyResult {
  if (text === null) return { text: null, truncated: false };
  const maxChars = opts.maxChars ?? DEFAULT_MAX_BODY_CHARS;

  let working = text;
  if (!opts.includeQuoted) {
    working = stripQuotedTail(working);
    working = stripSignature(working);
  }
  working = working.replace(/\s+$/, "");

  if (working.length > maxChars) {
    return { text: working.slice(0, maxChars), truncated: true };
  }
  return { text: working, truncated: false };
}

/**
 * Drop the quoted reply tail: everything from the first `"On ... wrote:"`
 * attribution line to the end. Attribution-anchored ONLY — if no attribution
 * line is found we return the text unchanged (conservative: never strip a legit
 * body just because it ends in `>`-quoted lines).
 */
function stripQuotedTail(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (ATTRIBUTION_LINE.test(lines[i].trim())) {
      return lines.slice(0, i).join("\n");
    }
  }
  return text;
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
 * `searchMessages` (search.ts): BEGIN; SET LOCAL transaction_read_only = on;
 * SET LOCAL statement_timeout = '15s'; run fn; COMMIT; ROLLBACK on error; release
 * in finally. The connection is injected (no global pool reach-in) and only
 * SELECTs run inside, so a tool can never send, mutate, or schedule.
 */
export async function withReadOnlyTx<T>(pool: PgPool, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
export async function syncTrustFor(pool: PgPool, accountIds: string[] | null): Promise<SyncTrust> {
  return withReadOnlyTx(pool, (client) => buildSyncTrust(client, accountIds));
}
