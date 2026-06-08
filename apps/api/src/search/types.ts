import type { WindowStatus } from "../types.js";

/**
 * Sort modes. `smart` blends relevance and recency (the default); `relevance`
 * drops the recency multiply; the rest are deterministic ordered scans.
 */
export type SearchSort = "smart" | "relevance" | "recent" | "oldest" | "size" | "sender";

export const SEARCH_SORTS: SearchSort[] = ["smart", "relevance", "recent", "oldest", "size", "sender"];

/**
 * Internal, fully-parsed filter representation. Both the free-text operator
 * parser and the structured request input converge on this tagged union, which
 * the compiler turns into bound SQL predicates. `negated` flips the predicate
 * (`-from:x`, `is:unread`); `raw` is echoed back for round-trip honesty.
 */
export type SearchFilter =
  | { kind: "from"; value: string; negated: boolean; raw: string }
  | { kind: "fromDomain"; value: string; negated: boolean; raw: string }
  | { kind: "recipient"; value: string; negated: boolean; raw: string }
  | { kind: "subject"; value: string; negated: boolean; raw: string }
  | { kind: "body"; value: string; negated: boolean; raw: string }
  | { kind: "folder"; value: string; negated: boolean; raw: string }
  | { kind: "thread"; value: string; negated: boolean; raw: string }
  | { kind: "msgid"; value: string; negated: boolean; raw: string }
  | { kind: "flag"; value: string; negated: boolean; raw: string }
  | { kind: "hasAttachment"; negated: boolean; raw: string }
  | { kind: "hasBody"; negated: boolean; raw: string }
  | { kind: "filename"; value: string; negated: boolean; raw: string }
  | { kind: "filetype"; value: string; negated: boolean; raw: string }
  | { kind: "mime"; value: string; negated: boolean; raw: string }
  | { kind: "date"; op: "after" | "before"; value: string; negated: boolean; raw: string }
  | { kind: "size"; op: "larger" | "smaller"; value: number; negated: boolean; raw: string }
  | { kind: "window"; value: WindowStatus; negated: boolean; raw: string };

/**
 * The parsed query: the residual free text (fed to websearch_to_tsquery), the
 * structured filters, account names to resolve, and output controls. This is the
 * single convergence point — `parseQuery` produces it and structured request
 * input maps onto it.
 */
export interface ParsedQuery {
  freeText: string;
  accounts: string[];
  filters: SearchFilter[];
  sort: SearchSort | null;
  limit: number | null;
  warnings: string[];
}

/**
 * Optional structured filter input (an alternative to the `q` string) so agents
 * can pass predicates as a typed object instead of building a query string.
 */
export interface StructuredFilters {
  from?: string;
  fromDomain?: string;
  to?: string;
  subject?: string;
  body?: string;
  folder?: string;
  thread?: string;
  msgid?: string;
  filename?: string;
  filetype?: string;
  mime?: string;
  isUnread?: boolean;
  isRead?: boolean;
  isFlagged?: boolean;
  isAnswered?: boolean;
  isDraft?: boolean;
  hasAttachment?: boolean;
  hasBody?: boolean;
  after?: string;
  before?: string;
  largerThan?: number;
  smallerThan?: number;
  window?: WindowStatus;
}

/**
 * The public search request. The CLI command and the MCP tool both build this
 * and hand it to `searchMessages`. Either `q`, `filters`, or both may be set.
 */
export interface SearchRequest {
  q?: string;
  filters?: StructuredFilters;
  /** Account UUIDs to scope to, or "all"/undefined for every account in this DB. */
  accounts?: string[] | "all";
  windowStatus?: WindowStatus[];
  includeDeleted?: boolean;
  sort?: SearchSort;
  limit?: number;
  offset?: number;
  snippet?: boolean;
  includeBody?: boolean;
  explain?: boolean;
  /**
   * Collapse each conversation to its single best message. Defaults to true —
   * email search returns conversations, not duplicate quoted-reply hits. Set
   * false to get every individual message.
   */
  groupByThread?: boolean;
  /**
   * Opt in to the semantic (Tier 2) retrieval branch. No-op today — the pure
   * core ships without an embedding model — so this is accepted and ignored
   * until the gated pgvector tier lands. Declared here to match the MCP/CLI
   * contract that already exposes it.
   */
  semantic?: boolean;
}

export interface SearchResultIdentity {
  id: string;
  account_id: string;
  folder_path: string;
  uidvalidity: string;
  uid: string;
}

export interface ScoreBreakdown {
  text_relevance: number;
  recency: number;
  email_prior: number;
  final: number;
}

export interface SearchResult {
  identity: SearchResultIdentity;
  subject: string | null;
  from: { email: string | null; name: string | null };
  to: string[];
  date: string;
  flags: string[];
  window_status: WindowStatus;
  body_fetched_at: string | null;
  snippet: string | null;
  score: number;
  score_breakdown: ScoreBreakdown | null;
  /** The conversation this result represents; message_count is how many of its
   *  messages matched (the collapsed duplicates when grouped by thread). */
  thread: { provider_thread_id: string | null; message_count: number };
  attachments: { count: number };
  body: string | null;
}

export interface SyncTrustAccount {
  account_id: string;
  account_email: string;
  sync_state: string;
  sync_state_reason: string | null;
  last_sync_at: string | null;
  currently_syncing: boolean;
  initial_sync_in_progress: boolean;
  historical_backfill_in_progress: boolean;
  live_headers_complete_pct: number;
  live_bodies_complete_pct: number;
  historical_bodies_complete_pct: number;
}

/**
 * Honest completeness signal. `fully_synced` is true only when every searched
 * account is HEALTHY, not initial-syncing, not backfilling, and at 100% live
 * body coverage — so an agent never silently trusts a partial mirror.
 */
export interface SyncTrust {
  fully_synced: boolean;
  results_may_be_incomplete: boolean;
  degraded_reasons: string[];
  accounts: SyncTrustAccount[];
}

export interface SearchResponse {
  results: SearchResult[];
  page: {
    limit: number;
    offset: number;
    returned: number;
    has_more: boolean;
  };
  sync_trust: SyncTrust;
  parsed_query: {
    free_text: string;
    filters: SearchFilter[];
    sort: SearchSort;
    warnings: string[];
  };
  read_only: true;
  timing_ms: { total: number };
}
