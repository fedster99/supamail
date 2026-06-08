import type { PgPool } from "../db.js";
import type { WindowStatus } from "../types.js";
import { compileSearch } from "./compile.js";
import { filtersFromStructured, parseQuery } from "./parse.js";
import { buildSyncTrust } from "./sync-trust.js";
import type { SearchRequest, SearchResponse, SearchResult, SearchSort } from "./types.js";

interface ResultRow {
  id: string;
  account_id: string;
  folder_path: string;
  uidvalidity: string;
  uid: string;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  flags: string[] | null;
  window_status: WindowStatus;
  internal_date: Date;
  provider_thread_id: string | null;
  thread_count: number | null;
  body_fetched_at: Date | null;
  text_rel: number | string | null;
  recency: number | string | null;
  email_prior: number | string | null;
  score: number | string | null;
  attachment_count: number | null;
  snippet: string | null;
  body: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Intersect two optional account-id constraints. `null` means "no constraint";
 * the result of intersecting two real sets can be empty (matches nothing). */
function intersectAccounts(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  const set = new Set(b);
  return a.filter((id) => set.has(id));
}

function mapRow(row: ResultRow, explain: boolean): SearchResult {
  const score = Number(row.score ?? 0);
  return {
    identity: {
      id: row.id,
      account_id: row.account_id,
      folder_path: row.folder_path,
      uidvalidity: row.uidvalidity,
      uid: row.uid
    },
    subject: row.subject,
    from: { email: row.from_email, name: row.from_name },
    to: row.to_emails ?? [],
    date: row.internal_date.toISOString(),
    flags: row.flags ?? [],
    window_status: row.window_status,
    body_fetched_at: row.body_fetched_at ? row.body_fetched_at.toISOString() : null,
    snippet: row.snippet ?? null,
    score,
    score_breakdown: explain
      ? {
          text_relevance: Number(row.text_rel ?? 0),
          recency: Number(row.recency ?? 0),
          email_prior: Number(row.email_prior ?? 0),
          final: score
        }
      : null,
    thread: { provider_thread_id: row.provider_thread_id, message_count: row.thread_count ?? 1 },
    attachments: { count: row.attachment_count ?? 0 },
    body: row.body ?? null
  };
}

/**
 * Search the mirror. This is the single read-only entry point that the CLI
 * command and the MCP tool both wrap (ADR 0014). It parses the free-text
 * superset query and/or structured filters, resolves account scoping, then runs
 * the compiled search and the sync-trust query inside one read-only transaction.
 *
 * The database connection is injected (no global pool reach-in) so the same
 * logic runs locally and hosted. It never sends, mutates, or schedules.
 */
export async function searchMessages(pool: PgPool, request: SearchRequest): Promise<SearchResponse> {
  const startedAt = Date.now();

  const parsed = request.q
    ? parseQuery(request.q)
    : { freeText: "", accounts: [], filters: [], sort: null as SearchSort | null, limit: null as number | null, warnings: [] };
  const structuredFilters = request.filters ? filtersFromStructured(request.filters) : [];
  const filters = [...parsed.filters, ...structuredFilters];
  const warnings = [...parsed.warnings];

  const sort: SearchSort = parsed.sort ?? request.sort ?? "smart";
  const limit = clamp(parsed.limit ?? request.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, request.offset ?? 0);
  const freeText = parsed.freeText;
  const hasText = freeText.trim() !== "";

  const requestedIds = request.accounts && request.accounts !== "all" ? request.accounts : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL transaction_read_only = on");
    await client.query("SET LOCAL statement_timeout = '15s'");

    let accountFilterIds: string[] | null = null;
    if (parsed.accounts.length > 0) {
      const lowered = parsed.accounts.map((name) => name.toLowerCase());
      const resolved = await client.query<{ id: string; email: string }>(
        `SELECT id, lower(email_address) AS email FROM public.imap_accounts WHERE lower(email_address) = ANY($1::text[])`,
        [lowered]
      );
      const byEmail = new Map(resolved.rows.map((r) => [r.email, r.id]));
      accountFilterIds = [];
      for (const name of lowered) {
        const id = byEmail.get(name);
        if (id) accountFilterIds.push(id);
        else warnings.push(`account "${name}" not found; ignored`);
      }
    }

    const accountIds = intersectAccounts(requestedIds, accountFilterIds);

    let rows: ResultRow[] = [];
    // An empty (non-null) account set can never match — skip the query entirely.
    if (!(accountIds !== null && accountIds.length === 0)) {
      const compiled = compileSearch(freeText, filters, {
        accountIds,
        windowStatus: request.windowStatus ?? null,
        includeDeleted: request.includeDeleted ?? false,
        sort,
        hasText,
        limit,
        offset,
        snippet: request.snippet ?? true,
        includeBody: request.includeBody ?? false,
        groupByThread: request.groupByThread ?? true
      });
      const result = await client.query<ResultRow>(compiled.text, compiled.values);
      rows = result.rows;
    }

    const syncTrust = await buildSyncTrust(client, accountIds);
    await client.query("COMMIT");

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const results = pageRows.map((row) => mapRow(row, request.explain ?? false));

    return {
      results,
      page: { limit, offset, returned: results.length, has_more: hasMore },
      sync_trust: syncTrust,
      parsed_query: { free_text: freeText, filters, sort, warnings },
      read_only: true,
      timing_ms: { total: Date.now() - startedAt }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
