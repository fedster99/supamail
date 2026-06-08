import { z } from "zod";

/**
 * Email-search evaluation contract.
 *
 * The harness is engine-agnostic: anything implementing {@link SearchEngine} can be
 * scored by the same email-specific evals. The in-repo {@link ReferenceEngine} is the
 * first implementation; a future Postgres/pgvector engine (the production target,
 * per ADR 0014 + the search-layer work) implements the same interface and is scored
 * identically. The evals are the durable contract; the engine is improved toward them.
 */

/** Attachment metadata — mirrors the searchable columns of `imap_attachments`. */
export const AttachmentSchema = z.object({
  filename: z.string().nullable(),
  mime_type: z.string().nullable(),
  size_bytes: z.number().int().nonnegative().optional()
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * One mirrored message in the eval corpus. Shaped after the real mirror tables
 * (`imap_messages` + `imap_message_bodies`), but body text is split into the
 * personal portion (`body_clean`) and the quoted-reply history (`body_quoted`) so
 * evals can assert that quoted history does NOT pollute retrieval — an email-specific
 * concern a generic text-search eval would miss.
 */
export const EvalMessageSchema = z.object({
  id: z.string(), // stable content identity (≈ message_id_normalized); survives UIDVALIDITY resets
  account_id: z.string(),
  folder_path: z.string(), // "INBOX" | "Sent" | "Spam" | "Archive" | "Drafts" | ...
  thread_key: z.string(), // provider_thread_id or derived JWZ key
  internal_date: z.string(), // ISO 8601
  subject: z.string().nullable(),
  from_email: z.string(),
  from_name: z.string().nullable().optional(),
  to_emails: z.array(z.string()).default([]),
  to_names: z.array(z.string()).optional(),
  cc_emails: z.array(z.string()).optional(),
  flags: z.array(z.string()).default([]), // "\\Seen", "\\Flagged", "\\Answered", ...
  size_bytes: z.number().int().nonnegative().optional(),
  body_clean: z.string().nullable(), // personal text only (quoted history stripped)
  body_quoted: z.string().nullable().optional(), // quoted-reply history, if any
  is_listish: z.boolean().optional(), // bulk/newsletter (List-Unsubscribe / Precedence: bulk)
  lang: z.string().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  deleted_in_provider: z.boolean().optional()
});
export type EvalMessage = z.infer<typeof EvalMessageSchema>;

/**
 * Structured search request — a focused subset of the normative read contract from
 * the research. The CLI DSL and the MCP structured input both compile to this shape.
 */
export const SearchRequestSchema = z
  .object({
    text: z.string().optional(), // free text → FTS
    from: z.string().optional(),
    to: z.string().optional(),
    cc: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    has: z.array(z.string()).optional(), // ["attachment"]
    is: z.array(z.string()).optional(), // ["unread","read","flagged"]
    in: z.array(z.string()).optional(), // folder paths
    filename: z.string().optional(),
    after: z.string().optional(), // ISO 8601 (relative dates resolved before this layer)
    before: z.string().optional(),
    larger: z.number().optional(), // bytes
    smaller: z.number().optional(),
    phrase: z.string().optional(), // exact phrase
    or: z.array(z.string()).optional(),
    not: z.array(z.string()).optional(),
    thread: z.string().optional(),
    accounts: z.array(z.string()).optional(), // cross-account; empty/absent = all
    granularity: z.enum(["message", "thread"]).optional(),
    sort: z.enum(["relevance", "recent"]).optional(),
    limit: z.number().int().positive().optional()
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/** The set of email-search capabilities the eval suite must cover (not just "text search"). */
export const CAPABILITIES = [
  "field-from",
  "field-to",
  "field-subject",
  "field-body",
  "flag-state",
  "folder-scope",
  "attachment",
  "filename",
  "date-range",
  "size",
  "phrase",
  "boolean-or",
  "boolean-not",
  "fuzzy-typo",
  "unicode-accent",
  "identifier-exact",
  "quoted-exclusion",
  "thread-collapse",
  "recency-prior",
  "newsletter-downweight",
  "sender-importance",
  "cross-account",
  "semantic-paraphrase",
  "false-empty-avoidance"
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Email-specific behavioral assertions, evaluated per case in addition to IR metrics. */
export const EvalAssertionSchema = z.discriminatedUnion("type", [
  /** hits[0].id must equal `id`. */
  z.object({ type: z.literal("top_is"), id: z.string() }),
  /** none of `ids` may appear in the top-k. */
  z.object({ type: z.literal("must_not_return"), ids: z.array(z.string()) }),
  /** `higher` must rank strictly above `lower` (both must be present). */
  z.object({ type: z.literal("rank_above"), higher: z.string(), lower: z.string() }),
  /** at most one hit per thread_key in the top-k. */
  z.object({ type: z.literal("thread_collapsed") }),
  /** `ids` must appear in the top-k in this exact relative (newest-first) order. */
  z.object({ type: z.literal("recency_order"), ids: z.array(z.string()) }),
  /** the top-k must begin with `ids` in this exact order. */
  z.object({ type: z.literal("ordered_prefix"), ids: z.array(z.string()) })
]);
export type EvalAssertion = z.infer<typeof EvalAssertionSchema>;

/** One golden eval case: a query plus relevance judgments and email-specific assertions. */
export const EvalCaseSchema = z
  .object({
    id: z.string(),
    capability: z.enum(CAPABILITIES),
    description: z.string(),
    dsl: z.string().optional(), // human DSL form (CLI parity / documentation)
    query: SearchRequestSchema,
    relevant_ids: z.array(z.string()).default([]),
    graded: z.record(z.string(), z.number()).optional(), // id -> gain (0..3) for nDCG
    must_not_return: z.array(z.string()).optional(),
    assertions: z.array(EvalAssertionSchema).optional(),
    k: z.number().int().positive().optional(), // cutoff; defaults per suite config
    tier: z.enum(["lexical", "fuzzy", "semantic"]).default("lexical"),
    // Provenance: when a tracked (semantic-tier) case fails because the reference engine
    // lacks a capability (VIP prior, from-me de-prioritization, language stemming, true
    // vector recall), name it here so the gap is documented rather than silently tiered away.
    requires_engine_improvement: z.string().nullable().optional()
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

/** A single ranked result. */
export interface SearchHit {
  id: string;
  score: number;
  thread_key?: string;
  matched_in?: string[];
}

export interface SearchResponse {
  hits: SearchHit[];
}

/**
 * Pluggable search engine. `index` ingests the corpus; `search` answers a request.
 * Implementations may be in-process (the reference engine) or backed by Postgres.
 */
export interface SearchEngine {
  readonly name: string;
  index(messages: EvalMessage[]): void | Promise<void>;
  search(req: SearchRequest): SearchResponse | Promise<SearchResponse>;
}
