import { z } from "zod";
import type { PgPool } from "../db.js";
import { searchMessages } from "./search.js";
import type { SearchRequest, SearchResponse } from "./types.js";
import {
  plaintextMetadataProtection,
  type MetadataProtectionAdapter
} from "../metadata-protection.js";

/**
 * Zod schema for the search request. The MCP tool and the CLI both validate
 * input through this before calling {@link searchMessages}, so the read-tool
 * contract is enforced in one place (ADR 0014).
 */
/**
 * The structured `filters` object schema, extracted as a named const so the
 * advertised MCP JSON-Schema's `filters.properties` can be checked for key parity
 * against it (#40, search-schema-parity.test.ts). The Zod schema is the source of
 * truth for validation; the JSON-Schema literal below is the hand-written agent
 * contract. The per-field RULES (kind, normalization, operator aliases) are
 * single-sourced in `search/filter-fields.ts` (`STRUCTURED_FILTER_KEYS`), and the
 * parity test asserts the field table, this Zod shape, and the JSON-Schema all
 * advertise the SAME field set — a field added to one but not the others fails.
 */
export const searchFiltersSchema = z
  .object({
    from: z.string().optional(),
    fromDomain: z.string().optional(),
    to: z.string().optional(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    anyEmail: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    folder: z.string().optional(),
    thread: z.string().optional(),
    msgid: z.string().optional(),
    filename: z.string().optional(),
    filetype: z.string().optional(),
    mime: z.string().optional(),
    isUnread: z.boolean().optional(),
    isRead: z.boolean().optional(),
    isFlagged: z.boolean().optional(),
    isStarred: z.boolean().optional(),
    isAnswered: z.boolean().optional(),
    isDraft: z.boolean().optional(),
    hasAttachment: z.boolean().optional(),
    hasBody: z.boolean().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    largerThan: z.number().int().nonnegative().optional(),
    smallerThan: z.number().int().nonnegative().optional(),
    window: z.enum(["IN_WINDOW", "EXPIRED", "HISTORICAL"]).optional()
  })
  .strict();

export const searchRequestSchema = z
  .object({
    q: z.string().max(4096).optional(),
    filters: searchFiltersSchema.optional(),
    accounts: z.union([z.array(z.string()), z.literal("all")]).optional(),
    windowStatus: z.array(z.enum(["IN_WINDOW", "EXPIRED", "HISTORICAL"])).optional(),
    includeDeleted: z.boolean().optional(),
    sort: z.enum(["smart", "relevance", "recent", "oldest", "size", "sender"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    snippet: z.boolean().optional(),
    includeBody: z.boolean().optional(),
    explain: z.boolean().optional(),
    groupByThread: z.boolean().optional(),
    semantic: z.boolean().optional()
  })
  .strict()
  .refine((value) => value.q !== undefined || value.filters !== undefined, {
    message: "Provide a query string (q) and/or a structured filters object."
  });

/**
 * The MCP input schema (JSON Schema). Kept in sync with {@link searchRequestSchema}
 * and exposed as the `search_email` tool's contract. The remote transport binding
 * (issue #4) wraps {@link runSearchTool} without reimplementing it.
 */
export const searchEmailToolDefinition = {
  name: "search_email",
  title: "Search mirrored email (read-only)",
  description:
    "Search the SupaMail IMAP mirror in Postgres. Deterministic and machine-readable. " +
    "Accepts a free-text superset query (q) with Gmail-style operators " +
    "(from: to: cc: bcc: anyemail: subject: body: in: thread: is:unread is:starred is:flagged " +
    "has:attachment filename: after:7d before:2026-01-01 larger:2mb account: \"exact phrase\" -exclude) " +
    "and/or a structured filters object (from, to, cc, bcc, anyEmail, subject, body, folder, thread, " +
    "isUnread, isStarred/isFlagged, hasAttachment, after, before, …), scoped to one or all accounts. " +
    "All filters COMPOSE with the semantic free-text query — they narrow, never replace it, over the " +
    "FULL mirror history (no 90-day window). Returns ranked, " +
    "snippet-highlighted results with full mailbox identity, an optional per-result " +
    "score_breakdown (explain), the echoed parsed query, and a sync_trust block describing " +
    "how complete the mirror is. READ-ONLY: never sends, deletes, moves, or modifies mail.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["q"] }, { required: ["filters"] }],
    properties: {
      q: { type: "string", maxLength: 4096, description: "Free-text superset query with operators." },
      filters: {
        type: "object",
        additionalProperties: false,
        description:
          "Structured predicates (alternative or addition to q; they COMPOSE with the free-text query). " +
          "Field filters: from, fromDomain, to, cc, bcc, anyEmail, subject, body, thread, msgid, filename, filetype, mime. " +
          "State filters: isUnread, isRead, isStarred (alias isFlagged), isAnswered, isDraft, hasAttachment, hasBody. " +
          "Date-range: after / before (ISO 2026-01-01 or relative like 7d/12h). Folder scoping: folder (path; trailing /* matches a subtree).",
        properties: {
          from: { type: "string", description: "Sender contains; @domain matches the sender domain." },
          fromDomain: { type: "string", description: "Sender domain exact match (no leading @)." },
          to: { type: "string", description: "To-recipient contains (cc/bcc excluded)." },
          cc: { type: "string", description: "Cc-recipient contains." },
          bcc: { type: "string", description: "Bcc-recipient contains (only on mail this mailbox sent)." },
          anyEmail: { type: "string", description: "Any address field contains: from + to + cc + bcc." },
          subject: { type: "string", description: "Subject contains." },
          body: { type: "string", description: "Body full-text match." },
          folder: { type: "string", description: "Folder path exact; a trailing /* matches the subtree." },
          thread: { type: "string", description: "provider_thread_id exact match." },
          msgid: { type: "string", description: "Normalized RFC Message-ID exact match." },
          filename: { type: "string", description: "Attachment filename glob (e.g. *.pdf)." },
          filetype: { type: "string", description: "Attachment class: pdf,image,video,audio,doc,sheet,zip,text." },
          mime: { type: "string", description: "Attachment MIME type exact match." },
          isUnread: { type: "boolean" },
          isRead: { type: "boolean" },
          isFlagged: { type: "boolean" },
          isStarred: { type: "boolean", description: "Alias for isFlagged." },
          isAnswered: { type: "boolean" },
          isDraft: { type: "boolean" },
          hasAttachment: { type: "boolean" },
          hasBody: { type: "boolean" },
          after: { type: "string", description: "Received on/after (ISO date or relative like 7d)." },
          before: { type: "string", description: "Received before (ISO date or relative)." },
          largerThan: { type: "integer", minimum: 0, description: "Size larger than, in bytes." },
          smallerThan: { type: "integer", minimum: 0, description: "Size smaller than, in bytes." },
          window: { enum: ["IN_WINDOW", "EXPIRED", "HISTORICAL"], description: "Restrict to one retention lane." }
        }
      },
      accounts: {
        description: "Account UUIDs to scope to, or \"all\" (default) for every account in this database.",
        oneOf: [
          { type: "array", items: { type: "string" } },
          { const: "all" }
        ]
      },
      windowStatus: {
        type: "array",
        items: { enum: ["IN_WINDOW", "EXPIRED", "HISTORICAL"] },
        description: "Restrict to retention lanes (default: all lanes)."
      },
      includeDeleted: { type: "boolean", default: false },
      sort: { enum: ["smart", "relevance", "recent", "oldest", "size", "sender"], default: "smart" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      offset: { type: "integer", minimum: 0, default: 0 },
      snippet: { type: "boolean", default: true },
      includeBody: { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
      groupByThread: { type: "boolean", default: true, description: "Collapse each conversation to its best message." },
      semantic: { type: "boolean", default: false, description: "Opt in to the semantic tier (no-op until it ships)." }
    }
  }
} as const;

/**
 * Validate raw tool arguments and run the search. The injected pool keeps this
 * transport-agnostic: the local stdio binding and any remote binding call this
 * same function. Returns the typed {@link SearchResponse}; the transport layer
 * formats it for the wire.
 */
export async function runSearchTool(
  pool: PgPool,
  args: unknown,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<SearchResponse> {
  const request = searchRequestSchema.parse(args) as SearchRequest;
  return searchMessages(pool, request, metadataProtection);
}
