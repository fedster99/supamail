import { z } from "zod";
import type { PgClient, PgPool } from "../../db.js";
import {
  loadMessageAttachments,
  mapMessageRow,
  syncTrustFor,
  toolError,
  withReadOnlyTx,
  type MessageDetail,
  type MessageDetailRow,
  type ToolDefinition,
  type ToolEntry
} from "../shared.js";
import type { SyncTrust } from "../../search/index.js";
import {
  METADATA_PROTECTED_FIELDS,
  plaintextMetadataProtection,
  revealMetadataRecord,
  type MetadataProtectionAdapter,
  type ProtectedMetadataColumns
} from "../../metadata-protection.js";

/**
 * Zod schema for `read_message`. The handler validates raw tool arguments
 * through this before touching the database, so the read-tool contract is
 * enforced in one place (ADR 0014).
 */
export const readMessageRequestSchema = z
  .object({
    message_id: z.string().uuid(),
    include_headers: z.boolean().optional(),
    include_quoted: z.boolean().optional(),
    body_offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    max_body_chars: z.number().int().min(1).optional()
  })
  .strict();

/**
 * The row `read_message` selects: every {@link MessageDetailRow} column plus the
 * raw `headers_json` (parsed into the optional `headers` block only when the
 * caller asks). Bodies come from the LEFT JOIN (I2); attachments are aggregated
 * by the subquery (all dispositions, incl. inline — I9).
 */
interface ReadMessageRow extends MessageDetailRow, ProtectedMetadataColumns {
  headers_json: Record<string, unknown> | null;
}

/**
 * Library-only switch for hosted callers that hydrate complete bodies from their
 * own body store. The public MCP tool always leaves this enabled.
 */
export interface ReadMessageOptions {
  includeBody?: boolean;
}

/**
 * Project `headers_json` to a flat string→string map. The mirror stores parsed
 * headers as JSON; we keep only scalar values (the common select headers) and
 * stringify them so the agent gets a predictable shape.
 */
function projectHeaders(raw: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    else if (Array.isArray(value)) out[key] = value.map((v) => String(v)).join(", ");
  }
  return out;
}

/**
 * The MCP `read_message` tool definition (literal JSON Schema), mirroring the
 * shape of `searchEmailToolDefinition`. Read-only and idempotent: it only
 * SELECTs one mirrored message and never sends, deletes, moves, or modifies mail.
 */
export const readMessageDefinition: ToolDefinition = {
  name: "read_message",
  title: "Read one mirrored email (read-only)",
  description:
    "Fetch a single mirrored email by its stable message_id (the id returned by search_email " +
    "or read_thread). By default, the body contains the newly authored plain text, with " +
    "recognized quoted reply tails and signatures removed. It returns the full cleaned body. " +
    "body_offset and max_body_chars can return a specific range without a product character ceiling; " +
    "body_total_chars, body_next_offset, body_truncated, body_content_status, and body_omissions " +
    "state whether text is absent and why. " +
    "Also returns the from/to/cc envelope, flags, " +
    "window_status, and the attachments list (filename, mime_type, size_bytes, disposition — " +
    "including inline parts). include_quoted=true retains the quoted reply tail and " +
    "signature; include_headers=true attaches parsed select headers. Attachment BYTES are not " +
    "mirrored (metadata only). Always attaches a sync_trust block describing mirror completeness. " +
    "READ-ONLY: never sends, deletes, moves, or modifies mail.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["message_id"],
    properties: {
      message_id: {
        type: "string",
        format: "uuid",
        minLength: 36,
        maxLength: 36,
        description: "The stable message id (imap_messages.id) returned by search_email or read_thread."
      },
      include_headers: {
        type: "boolean",
        default: false,
        description: "Attach parsed select headers from the mirror (default false)."
      },
      include_quoted: {
        type: "boolean",
        default: false,
        description: "Keep the quoted reply tail + signature instead of stripping them (default false)."
      },
      body_offset: {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        default: 0,
        description: "Optional character offset at which to start the cleaned body (default 0)."
      },
      max_body_chars: {
        type: "integer",
        minimum: 1,
        description: "Optional positive body range size. Omit it to return the full remaining cleaned body."
      }
    }
  }
};

/**
 * Validate raw tool arguments and read one message from the mirror. The injected
 * pool keeps this transport-agnostic: the local stdio binding and any remote
 * binding call this same function.
 *
 * Body precedence is `coalesce(body_text, body_plain, selected_text_part)` (I2);
 * raw_mime is never read. Attachments include every disposition (I9). Returns the
 * `not_found` error envelope when no message matches.
 */
export async function runReadMessage(
  pool: PgPool,
  args: unknown,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection,
  options: ReadMessageOptions = {}
): Promise<(MessageDetail & { sync_trust: SyncTrust }) | ReturnType<typeof toolError>> {
  let request: z.infer<typeof readMessageRequestSchema>;
  try {
    request = readMessageRequestSchema.parse(args);
  } catch (error) {
    return toolError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid arguments.",
      "Pass one valid message_id and optional body range or header settings."
    );
  }
  const includeHeaders = request.include_headers ?? false;
  const includeQuoted = request.include_quoted ?? false;

  const row = await withReadOnlyTx(pool, async (client: PgClient) => {
    const result = await client.query<ReadMessageRow>(
      `
      SELECT
        m.id,
        m.account_id,
        m.folder_path,
        m.provider_thread_id,
        m.subject,
        m.from_email,
        m.from_name,
        m.to_emails,
        m.cc_emails,
        m.flags,
        m.window_status,
        m.internal_date,
        m.headers_json,
        m.protected_metadata,
        m.protected_metadata_version,
        m.protected_metadata_key_version,
        m.protected_metadata_tokens,
        b.raw_truncated,
        ${options.includeBody === false
          ? "NULL::text AS body_text, NULL::text AS body_plain, NULL::text AS selected_text_part"
          : "b.body_text, b.body_plain, b.selected_text_part"}
      FROM public.imap_messages m
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      WHERE m.id = $1
      `,
      [request.message_id]
    );
    const row = result.rows[0] ?? null;
    if (!row) return null;
    const attachments = await loadMessageAttachments(client, [row.id], metadataProtection);
    return { ...row, attachments: attachments.get(row.id) ?? [] };
  });

  if (!row) {
    return toolError("not_found", `No mirrored message with id ${request.message_id}.`, "call search_email to locate the message id");
  }

  const revealed = await revealMetadataRecord(
    metadataProtection,
    { kind: "message", accountId: row.account_id, recordId: row.id },
    row,
    METADATA_PROTECTED_FIELDS.message
  );
  const served = { ...revealed, provider_thread_id: row.provider_thread_id };
  const headers = includeHeaders ? projectHeaders(served.headers_json) : undefined;
  const detail = mapMessageRow(served, {
    includeQuoted,
    headers,
    offset: request.body_offset,
    maxChars: request.max_body_chars,
    includeBodyRange: true
  });
  const sync_trust = await syncTrustFor(pool, [row.account_id], metadataProtection);

  return { ...detail, sync_trust };
}

/** The registry entry the server and safety test both read. */
export const readMessageEntry: ToolEntry = {
  definition: readMessageDefinition,
  handler: (pool, args) => runReadMessage(pool, args)
};
