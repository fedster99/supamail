import { z } from "zod";
import type { PgPool } from "../db.js";
import { searchMessages } from "./search.js";
import type { SearchRequest, SearchResponse } from "./types.js";

/**
 * Zod schema for the search request. The MCP tool and the CLI both validate
 * input through this before calling {@link searchMessages}, so the read-tool
 * contract is enforced in one place (ADR 0014).
 */
export const searchRequestSchema = z
  .object({
    q: z.string().max(4096).optional(),
    filters: z
      .object({
        from: z.string().optional(),
        fromDomain: z.string().optional(),
        to: z.string().optional(),
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
      .strict()
      .optional(),
    accounts: z.union([z.array(z.string()), z.literal("all")]).optional(),
    windowStatus: z.array(z.enum(["IN_WINDOW", "EXPIRED", "HISTORICAL"])).optional(),
    includeDeleted: z.boolean().optional(),
    sort: z.enum(["smart", "relevance", "recent", "oldest", "size", "sender"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    snippet: z.boolean().optional(),
    includeBody: z.boolean().optional(),
    explain: z.boolean().optional()
  })
  .strict()
  .refine((value) => value.q !== undefined || value.filters !== undefined, {
    message: "Provide a query string (q) and/or a structured filters object."
  });

/**
 * The MCP input schema (JSON Schema). Kept in sync with {@link searchRequestSchema}
 * and exposed as the `search_email` tool's contract. The remote transport binding
 * (issue #4, cloud) wraps {@link runSearchTool} without reimplementing it.
 */
export const searchEmailToolDefinition = {
  name: "search_email",
  title: "Search mirrored email (read-only)",
  description:
    "Search the SupaMail IMAP mirror in Postgres. Deterministic and machine-readable. " +
    "Accepts a free-text superset query (q) with Gmail-style operators " +
    "(from: to: cc: subject: body: in: is:unread is:flagged has:attachment filename: " +
    "after:7d before:2026-01-01 larger:2mb account: thread: \"exact phrase\" -exclude) " +
    "and/or a structured filters object, scoped to one or all accounts. Returns ranked, " +
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
      filters: { type: "object", description: "Structured predicates (alternative or addition to q)." },
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
      explain: { type: "boolean", default: false }
    }
  }
} as const;

/**
 * Validate raw tool arguments and run the search. The injected pool keeps this
 * transport-agnostic: the local stdio binding and any hosted binding call this
 * same function. Returns the typed {@link SearchResponse}; the transport layer
 * formats it for the wire.
 */
export async function runSearchTool(pool: PgPool, args: unknown): Promise<SearchResponse> {
  const request = searchRequestSchema.parse(args) as SearchRequest;
  return searchMessages(pool, request);
}
