import { z } from "zod";
import type { PgPool } from "../../db.js";
import { DEFAULT_MAX_BODY_CHARS, cleanBody, toolError, withReadOnlyTx } from "../shared.js";
import type { ToolDefinition, ToolEntry } from "../shared.js";
import {
  METADATA_PROTECTED_FIELDS,
  plaintextMetadataProtection,
  revealMetadataRecord,
  type MetadataProtectionAdapter,
  type ProtectedMetadataColumns
} from "../../metadata-protection.js";

/**
 * draft_reply — PRODUCE ONLY, NEVER SENDS (ADR 0016). Reads one source message
 * from the Postgres mirror and returns a structured, ready-to-send reply draft:
 * From/To/Cc/Subject, RFC 5322 threading headers, and a quoted body. It never
 * touches IMAP, never writes the filesystem, and has NO send flag — the agent (or
 * a human) takes the payload elsewhere to actually send. There is no schema knob
 * that could trigger a send. `X-SupaMail-Draft: produced-not-sent` makes the
 * intent explicit on the wire.
 */

/**
 * Strict input schema for draft_reply. Validated via `.parse()` (like
 * read_message); server.ts's catch turns a ZodError into the error envelope.
 */
export const draftReplyRequestSchema = z
  .object({
    source_message_id: z.string(),
    body: z.string(),
    reply_all: z.boolean().optional()
  })
  .strict();

/** The DB row this tool selects: the source message + its coalesced body. */
interface SourceRow extends ProtectedMetadataColumns {
  id: string;
  account_id: string;
  provider_thread_id: string | null;
  rfc_message_id: string | null;
  references_header: string | null;
  in_reply_to: string | null;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  to_names: (string | null)[] | null;
  cc_emails: string[] | null;
  cc_names: (string | null)[] | null;
  internal_date: Date;
  account_email: string;
  account_protected_metadata: Buffer | null;
  account_protected_metadata_version: number | null;
  account_protected_metadata_key_version: number | null;
  account_protected_metadata_tokens: Record<string, string> | null;
  body_text: string | null;
  body_plain: string | null;
  selected_text_part: string | null;
}

export interface DraftRecipient {
  email: string;
  name?: string;
}

export interface DraftReply {
  draftId: string;
  from: { email: string | null; name: string | null };
  to: DraftRecipient[];
  cc: DraftRecipient[];
  subject: string;
  headers: {
    "In-Reply-To"?: string;
    References?: string;
    "X-SupaMail-Draft": "produced-not-sent";
  };
  threadId: string | null;
  body: { format: "plain"; text: string };
  warnings: string[];
}

export const draftReplyDefinition: ToolDefinition = {
  name: "draft_reply",
  title: "Draft a reply (produce-only, never sends)",
  description:
    "Produce a structured, ready-to-send reply draft from a source message in the " +
    "SupaMail mirror. Reads the source message and its account, then derives the From " +
    "address (the mirror account), To (the original sender), optional reply-all Cc " +
    "(original To+Cc minus self), a single 'Re:' subject, RFC 5322 threading headers " +
    "(In-Reply-To / References), and a quoted body. PRODUCE-ONLY: this NEVER sends, " +
    "saves drafts to IMAP, or writes any file — there is no send flag. The returned " +
    "draftId is a local handle (drf_<source id>), not an IMAP UID. Delivery requires " +
    "a separate send path outside this MCP server.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["source_message_id", "body"],
    properties: {
      source_message_id: {
        type: "string",
        description: "imap_messages.id of the message to reply to (the search/read handle)."
      },
      body: {
        type: "string",
        description: "The reply text the agent wrote. Quoted original is appended automatically."
      },
      reply_all: {
        type: "boolean",
        default: false,
        description: "Include the original To+Cc (minus the account's own address) as Cc."
      }
    }
  }
};

/**
 * Strip leading `Re:` / `Re[2]:` / `Fwd:` (case-insensitive, repeated) and prepend
 * a single `Re:`. A null/blank subject becomes `Re:` (I5).
 */
export function reSubject(subject: string | null): string {
  // Repeatedly strip stacked leading prefixes (e.g. "Re: Fwd: ...").
  let stripped = subject ?? "";
  for (;;) {
    const next = stripped.replace(/^\s*(?:re(?:\[\d+\])?|fwd?)\s*:\s*/i, "");
    if (next === stripped) break;
    stripped = next;
  }
  const trimmed = stripped.trim();
  return trimmed.length === 0 ? "Re:" : `Re: ${trimmed}`;
}

/**
 * Build the References header value (I5): the source's existing References chain
 * plus the source's own rfc_message_id, RAW (angle-bracketed, case preserved).
 * When references_header is null but in_reply_to is present, seed the chain with
 * in_reply_to so the thread stays linked.
 */
export function buildReferences(row: SourceRow): string | undefined {
  const chain: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined): void => {
    if (!value) return;
    for (const id of value.trim().split(/\s+/)) {
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      chain.push(id);
    }
  };
  if (row.references_header) {
    push(row.references_header);
  } else if (row.in_reply_to) {
    push(row.in_reply_to);
  }
  push(row.rfc_message_id);
  return chain.length === 0 ? undefined : chain.join(" ");
}

/**
 * reply-all Cc (I5): the union of the source To and Cc addresses, minus the
 * mirror account's own address (case-insensitive), null-safe over the parallel
 * *_names arrays. The original sender (To of the reply) is also excluded so they
 * are not both To and Cc.
 */
export function buildCc(row: SourceRow): DraftRecipient[] {
  const self = row.account_email.toLowerCase();
  const originalSender = (row.from_email ?? "").toLowerCase();
  const out: DraftRecipient[] = [];
  const seen = new Set<string>();
  const collect = (emails: string[] | null, names: (string | null)[] | null): void => {
    const list = emails ?? [];
    for (let i = 0; i < list.length; i++) {
      const email = list[i];
      if (!email) continue;
      const lowered = email.toLowerCase();
      if (lowered === self || lowered === originalSender || seen.has(lowered)) continue;
      seen.add(lowered);
      const name = names?.[i] ?? null;
      out.push(name ? { email, name } : { email });
    }
  };
  collect(row.to_emails, row.to_names);
  collect(row.cc_emails, row.cc_names);
  return out;
}

/** Quote the original body, capping it via cleanBody and prefixing each line "> ". */
function quoteOriginal(row: SourceRow): string {
  const raw = row.body_text ?? row.body_plain ?? row.selected_text_part ?? null;
  const cleaned = cleanBody(raw, { includeQuoted: true, maxChars: DEFAULT_MAX_BODY_CHARS });
  const text = cleaned.text ?? "";
  const fromLabel = row.from_name ? `${row.from_name} <${row.from_email ?? ""}>` : row.from_email ?? "unknown sender";
  const attribution = `On ${row.internal_date.toISOString()}, ${fromLabel} wrote:`;
  const quoted = text.length === 0 ? "" : text.split("\n").map((line) => `> ${line}`).join("\n");
  return `${attribution}\n${quoted}`;
}

export async function runDraftReply(
  pool: PgPool,
  args: unknown,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<DraftReply | ReturnType<typeof toolError>> {
  const request = draftReplyRequestSchema.parse(args);

  const row = await withReadOnlyTx(pool, async (client) => {
    const result = await client.query<SourceRow>(
      `
      SELECT
        m.id,
        m.account_id,
        m.provider_thread_id,
        m.rfc_message_id,
        m.references_header,
        m.in_reply_to,
        m.subject,
        m.from_email,
        m.from_name,
        m.to_emails,
        m.to_names,
        m.cc_emails,
        m.cc_names,
        m.internal_date,
        m.protected_metadata,
        m.protected_metadata_version,
        m.protected_metadata_key_version,
        m.protected_metadata_tokens,
        a.email_address AS account_email,
        a.protected_metadata AS account_protected_metadata,
        a.protected_metadata_version AS account_protected_metadata_version,
        a.protected_metadata_key_version AS account_protected_metadata_key_version,
        a.protected_metadata_tokens AS account_protected_metadata_tokens,
        b.body_text,
        b.body_plain,
        b.selected_text_part
      FROM public.imap_messages m
      JOIN public.imap_accounts a ON a.id = m.account_id
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      WHERE m.id = $1
        AND m.deleted_in_provider = false
      `,
      [request.source_message_id]
    );
    return result.rows[0] ?? null;
  });

  if (!row) {
    return toolError(
      "not_found",
      `No mirrored message with id ${request.source_message_id}.`,
      "Use search_email or read_message to get a valid source_message_id. The message may be deleted in the provider, which draft_reply excludes."
    );
  }

  const revealedMessage = await revealMetadataRecord(
    metadataProtection,
    { kind: "message", accountId: row.account_id, recordId: row.id },
    row,
    METADATA_PROTECTED_FIELDS.message
  );
  const revealedAccount = await revealMetadataRecord(
    metadataProtection,
    { kind: "account", accountId: row.account_id, recordId: row.account_id },
    {
      email_address: row.account_email,
      protected_metadata: row.account_protected_metadata,
      protected_metadata_version: row.account_protected_metadata_version,
      protected_metadata_key_version: row.account_protected_metadata_key_version,
      protected_metadata_tokens: row.account_protected_metadata_tokens
    },
    METADATA_PROTECTED_FIELDS.accountSummary
  );
  const source = {
    ...revealedMessage,
    provider_thread_id: row.provider_thread_id,
    account_email: revealedAccount.email_address
  };

  const warnings: string[] = [];

  const headers: DraftReply["headers"] = { "X-SupaMail-Draft": "produced-not-sent" };
  if (source.rfc_message_id) {
    headers["In-Reply-To"] = source.rfc_message_id;
  } else {
    warnings.push("Source message has no Message-ID; In-Reply-To omitted and threading may be unreliable.");
  }
  const references = buildReferences(source);
  if (references) headers.References = references;

  const to: DraftRecipient[] = source.from_email
    ? [source.from_name ? { email: source.from_email, name: source.from_name } : { email: source.from_email }]
    : [];
  if (to.length === 0) {
    warnings.push("Source message has no sender address; To is empty.");
  }

  const cc = request.reply_all === true ? buildCc(source) : [];

  const quoted = quoteOriginal(source);
  const text = `${request.body}\n\n${quoted}`;

  return {
    draftId: `drf_${source.id}`,
    from: { email: source.account_email, name: null },
    to,
    cc,
    subject: reSubject(source.subject),
    headers,
    threadId: source.provider_thread_id,
    body: { format: "plain", text },
    warnings
  };
}

export const draftReplyEntry: ToolEntry = {
  definition: draftReplyDefinition,
  handler: (pool, args) => runDraftReply(pool, args)
};
