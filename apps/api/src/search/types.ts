import type { FolderRef } from "./rules.js";

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
  | { kind: "to"; value: string; negated: boolean; raw: string }
  | { kind: "cc"; value: string; negated: boolean; raw: string }
  | { kind: "bcc"; value: string; negated: boolean; raw: string }
  | { kind: "anyEmail"; value: string; negated: boolean; raw: string }
  | { kind: "subject"; value: string; negated: boolean; raw: string }
  | { kind: "body"; value: string; negated: boolean; raw: string }
  /** `folders` is what the value resolved to in the searched accounts (`resolveFolderFilters`). */
  | { kind: "folder"; value: string; negated: boolean; raw: string; folders?: FolderRef[] }
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
  /** `from:a OR from:b`: matches when any member matches. Members are never `or`. */
  | { kind: "or"; filters: SearchFilter[]; negated: boolean; raw: string };

/** One free-text word or quoted phrase. */
export interface TextTerm {
  text: string;
  phrase: boolean;
}

/**
 * Free text parsed into terms. Every group must match, and any one term matches
 * its group: `a b OR "c d"` is a AND (b OR "c d"). Excluded terms must not match.
 */
export interface TextTerms {
  /** The input had at least one token. With no searchable term, it matches nothing. */
  hasText: boolean;
  groups: TextTerm[][];
  negative: TextTerm[];
  /** Each OR that stood beside an exclusion, punctuation, another OR or an edge,
   * with the tokens around it (null at an edge). */
  ignoredOr: IgnoredOr[];
}

export interface IgnoredOr {
  left: string | null;
  right: string | null;
}

/**
 * The parsed query: the residual free text (parsed by `parseTextTerms`), the
 * structured filters, account names to resolve, and output controls. This is the
 * single convergence point — `parseQuery` produces it and structured request
 * input maps onto it.
 */
export interface ParsedQuery {
  freeText: string;
  /** `freeText` parsed by `parseTextTerms`; engines use it instead of parsing again. */
  text: TextTerms;
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
  /** Exact/substring match against the To recipients only (cc/bcc excluded). */
  to?: string;
  /** Exact/substring match against the Cc recipients only (email-005). */
  cc?: string;
  /** Exact/substring match against the Bcc recipients only (email-005). Bcc is
   *  only populated for mail this mailbox sent (providers strip it on receipt). */
  bcc?: string;
  /** Match across every address field: from + to + cc + bcc (email-005). The
   *  Nylas `any_email` equivalent. */
  anyEmail?: string;
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
  /** Alias for isFlagged (Nylas/Gmail "starred"). */
  isStarred?: boolean;
  isAnswered?: boolean;
  isDraft?: boolean;
  hasAttachment?: boolean;
  hasBody?: boolean;
  after?: string;
  before?: string;
  largerThan?: number;
  smallerThan?: number;
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
   * Frozen clock (ISO timestamp) for recency scoring and relative-date filters.
   * Omitted in production (uses SQL `now()`); the eval pins it so scorecards are
   * reproducible and ranking ties are deterministic.
   */
  now?: string;
  /**
   * Enable the trigram-fuzzy + concept recall branches. Defaults to true. Set
   * false for the lexical-only baseline in an A/B eval (the candidate runs with
   * it true), so the recall branches' effect is measured on identical data.
   */
  recall?: boolean;
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
  body_fetched_at: string | null;
  snippet: string | null;
  /** Ranking score; null when the order ranks nothing (date, size or sender order, or no text). */
  score: number | null;
  score_breakdown: ScoreBreakdown | null;
  /** The conversation this result represents; match_count is how many of its
   *  messages matched (the collapsed duplicates when grouped by thread), not its size. */
  thread: {
    conversation_id: string | null;
    provider_thread_id: string | null;
    match_count: number;
  };
  /** Attached files (`has:attachment` counts these) and inline parts such as signature images. */
  attachments: { files: number; inline: number };
  body: string | null;
  /** Other stored copies of this email that also match, such as a direct and a
   *  list delivery. Present only when there are any. */
  duplicate_message_ids?: string[];
}

/** Why a mailbox cannot give a complete answer: its first sync is still
 *  running, or sync is stopped (connection broken) or paused. */
export type ReadAccountNotice = "first_sync_in_progress" | "sync_stopped" | "sync_paused";

/** A Mailbox Account a read result came from. `notice` appears only when the
 *  mailbox cannot give a complete answer. */
export interface ReadAccount {
  account_id: string;
  account_email: string;
  notice?: ReadAccountNotice;
}

export interface SyncStatusAccount {
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
 * The full sync report `get_sync_status` returns. `fully_synced` is true only
 * when no account has a reason in `degraded_reasons`: every account is HEALTHY,
 * past its first sync, done storing older mail, and at 100% of recent mail and
 * bodies.
 */
export interface SyncStatus {
  summary: string;
  fully_synced: boolean;
  degraded_reasons: string[];
  accounts: SyncStatusAccount[];
}

export interface SearchResponse {
  results: SearchResult[];
  page: {
    limit: number;
    offset: number;
    returned: number;
    has_more: boolean;
  };
  accounts: ReadAccount[];
  parsed_query: {
    free_text: string;
    filters: SearchFilter[];
    sort: SearchSort;
    warnings: string[];
  };
  timing_ms: { total: number };
}
