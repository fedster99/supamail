import { createHash } from "node:crypto";
import type { PgPool } from "../db.js";
import { searchMessages } from "../search/search.js";
import { guardQueries, messages, queries, type QueryCategory } from "./corpus.js";
import { meanMetrics, scoreQuery, type QueryMetrics } from "./metrics.js";
import { comparePaired, type PairedComparison } from "./significance.js";

export interface QueryScore {
  id: string;
  category: QueryCategory;
  q: string;
  relevant_count: number;
  returned_count: number;
  metrics: QueryMetrics;
  /** null when the query has no topFirst expectation. */
  top_first_ok: boolean | null;
  /** Distinct conversations / results in the top 10. 1.0 = no duplicate-thread
   *  hits; lower means the same conversation appears multiple times. null on an
   *  empty result set (no threads to be distinct), so a total miss can't masquerade
   *  as a perfect 1.0 thread score. */
  distinct_thread_ratio: number | null;
  /** Relevant synthetic ids that did not make the top 10. */
  missing: string[];
}

export interface CategoryScore {
  category: QueryCategory;
  query_count: number;
  metrics: QueryMetrics;
  /** Mean over queries with a non-null ratio (empty-result queries excluded). */
  distinct_thread_ratio: number | null;
  /** Share of queries with nDCG@10 ≥ 0.95 — a saturation flag. A category that is
   *  ~all-saturated can't detect ranking regressions; treat its mean cautiously. */
  saturated_share: number;
}

export interface GuardScore {
  id: string;
  q: string;
  /** True when the engine returned nothing (or only allowed ids). */
  passed: boolean;
  returned: number;
  unexpected: string[];
}

export interface Scorecard {
  corpus_size: number;
  query_count: number;
  eval_now: string;
  headline: { ndcg_at_10: number; recall_at_10: number; mrr: number };
  overall: QueryMetrics;
  by_category: CategoryScore[];
  queries: QueryScore[];
  /** Anti-regression guard: junk-return sentinels (see corpus.guardQueries). */
  guard: { total: number; passed: number; failures: GuardScore[] };
}

export interface EvaluateOptions {
  /** Limit passed to each search; large enough to cover the judged sets. */
  limit?: number;
  /** Account email to seed under; defaults to a process-unique address. */
  accountEmail?: string;
  /** Request the semantic tier (Tier 2; no-op without embeddings). */
  semantic?: boolean;
}

const EVAL_UIDVALIDITY = 99_001;

/**
 * Frozen clock. The corpus seeds `internal_date` relative to this instant and the
 * engine scores recency against the same instant (via `SearchRequest.now`), so a
 * scorecard is byte-reproducible run-to-run and ranking ties never depend on
 * wall-clock drift. Any fixed timestamp works; this one is arbitrary but stable.
 */
export const EVAL_NOW = "2026-01-15T12:00:00.000Z";

const SATURATION_NDCG = 0.95;

type ResolveFn = (syntheticId: string) => string;

/**
 * Deterministic UUIDv5-style id from a synthetic message id, so the engine's final
 * `id DESC` tiebreak is stable across runs — a prerequisite (with the frozen clock)
 * for byte-identical scorecards. Same input → same UUID, every run.
 */
function stableUuid(name: string): string {
  const h = createHash("sha1").update(`supamail-eval:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface SeededCorpus {
  accountId: string;
  resolve: ResolveFn;
}

/** Seed the judged corpus into an isolated account against the frozen clock. */
async function seedCorpus(pool: PgPool, accountEmail: string): Promise<SeededCorpus> {
  const accountResult = await pool.query<{ id: string }>(
    `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
     VALUES ($1, 'imap.example.test', 993, $1, $2)
     RETURNING id`,
    [accountEmail, Buffer.from([0])]
  );
  const accountId = accountResult.rows[0].id;
  const uuidBySynthetic = new Map<string, string>();

  let uid = 1;
  for (const message of messages) {
    const id = stableUuid(message.id);
    await pool.query(
      `INSERT INTO public.imap_messages (
         id, account_id, folder_path, uidvalidity, uid, internal_date,
         subject, from_email, from_name, to_emails, flags,
         provider_thread_id, headers_json,
         deleted_in_provider, window_status, size_bytes
       )
       VALUES ($14, $1, $2, $3, $4, '${EVAL_NOW}'::timestamptz - ($5 * interval '1 day'),
         $6, $7, $8, $9, $10, $11, $12, false, 'IN_WINDOW', $13)`,
      [
        accountId,
        message.folder,
        EVAL_UIDVALIDITY,
        uid,
        message.ageDays,
        message.subject,
        message.fromEmail,
        message.fromName,
        message.toEmails,
        message.flags,
        message.providerThreadId,
        JSON.stringify(message.headersJson),
        message.sizeBytes ?? message.body.length,
        id
      ]
    );
    uuidBySynthetic.set(message.id, id);
    uid += 1;

    await pool.query(
      `INSERT INTO public.imap_message_bodies (message_id, raw_mime, raw_bytes, raw_truncated, body_text)
       VALUES ($1, $2, $3, false, $4)`,
      [id, Buffer.from(message.body), message.body.length, message.body]
    );
    await pool.query("UPDATE public.imap_messages SET body_fetched_at = now() WHERE id = $1", [id]);

    let part = 1;
    for (const attachment of message.attachments) {
      await pool.query(
        `INSERT INTO public.imap_attachments (message_id, filename, mime_type, disposition, part_number)
         VALUES ($1, $2, $3, 'attachment', $4)`,
        [id, attachment.filename, attachment.mimeType, String(part)]
      );
      part += 1;
    }
  }

  const resolve: ResolveFn = (syntheticId) => {
    const uuid = uuidBySynthetic.get(syntheticId);
    if (!uuid) throw new Error(`Eval corpus query references unknown message id: ${syntheticId}`);
    return uuid;
  };
  return { accountId, resolve };
}

/** Run every judged query through the real engine under one arm (recall on/off). */
async function runArm(
  pool: PgPool,
  accountId: string,
  resolve: ResolveFn,
  arm: { recall: boolean; limit: number; semantic?: boolean }
): Promise<QueryScore[]> {
  const perQuery: QueryScore[] = [];
  for (const query of queries) {
    const response = await searchMessages(pool, {
      q: query.q,
      accounts: [accountId],
      limit: arm.limit,
      semantic: arm.semantic,
      now: EVAL_NOW,
      recall: arm.recall
    });
    const resultUuids = response.results.map((r) => r.identity.id);
    const judgments = new Map<string, number>(
      query.relevant.map((sid) => [resolve(sid), query.grades?.[sid] ?? 1])
    );
    const metrics = scoreQuery(resultUuids, judgments);

    const top10 = new Set(resultUuids.slice(0, 10));
    const missing = query.relevant.filter((sid) => !top10.has(resolve(sid)));
    const topFirstOk = query.topFirst ? resultUuids[0] === resolve(query.topFirst) : null;

    const topResults = response.results.slice(0, 10);
    const threadKeys = new Set(topResults.map((r) => r.thread.provider_thread_id ?? r.identity.id));
    const distinctThreadRatio = topResults.length === 0 ? null : threadKeys.size / topResults.length;

    perQuery.push({
      id: query.id,
      category: query.category,
      q: query.q,
      relevant_count: query.relevant.length,
      returned_count: resultUuids.length,
      metrics,
      top_first_ok: topFirstOk,
      distinct_thread_ratio: distinctThreadRatio,
      missing
    });
  }
  return perQuery;
}

/** Run the guard sentinels (correct answer: empty / only allowed ids). */
async function runGuards(
  pool: PgPool,
  accountId: string,
  resolve: ResolveFn,
  limit: number
): Promise<GuardScore[]> {
  const out: GuardScore[] = [];
  for (const guard of guardQueries) {
    const response = await searchMessages(pool, {
      q: guard.q,
      accounts: [accountId],
      limit,
      now: EVAL_NOW,
      recall: true
    });
    const allowed = new Set((guard.allowedIds ?? []).map(resolve));
    const unexpected = response.results.map((r) => r.identity.id).filter((id) => !allowed.has(id));
    out.push({
      id: guard.id,
      q: guard.q,
      passed: unexpected.length === 0,
      returned: response.results.length,
      unexpected
    });
  }
  return out;
}

function aggregateCategories(perQuery: QueryScore[]): CategoryScore[] {
  const categories = [...new Set(queries.map((q) => q.category))];
  return categories.map((category) => {
    const subset = perQuery.filter((p) => p.category === category);
    const ratios = subset.map((s) => s.distinct_thread_ratio).filter((r): r is number => r !== null);
    return {
      category,
      query_count: subset.length,
      metrics: meanMetrics(subset.map((s) => s.metrics)),
      distinct_thread_ratio: ratios.length === 0 ? null : ratios.reduce((a, b) => a + b, 0) / ratios.length,
      saturated_share:
        subset.length === 0 ? 0 : subset.filter((s) => s.metrics.ndcg_at_10 >= SATURATION_NDCG).length / subset.length
    };
  });
}

/**
 * Seed the judged corpus into an isolated account, run every query through the
 * real {@link searchMessages} against the frozen clock, score with graded
 * relevance, and run the anti-regression guards. The account is deleted afterwards
 * (cascade), so the eval is side-effect free and safe on a shared database.
 */
export async function evaluateSearch(pool: PgPool, options: EvaluateOptions = {}): Promise<Scorecard> {
  const limit = options.limit ?? 25;
  const accountEmail = options.accountEmail ?? `search-eval-${process.pid}@example.test`;
  const { accountId, resolve } = await seedCorpus(pool, accountEmail);

  try {
    const perQuery = await runArm(pool, accountId, resolve, { recall: true, limit, semantic: options.semantic });
    const guardScores = await runGuards(pool, accountId, resolve, limit);
    const overall = meanMetrics(perQuery.map((p) => p.metrics));

    return {
      corpus_size: messages.length,
      query_count: queries.length,
      eval_now: EVAL_NOW,
      headline: {
        ndcg_at_10: overall.ndcg_at_10,
        recall_at_10: overall.recall_at_10,
        mrr: overall.reciprocal_rank
      },
      overall,
      by_category: aggregateCategories(perQuery),
      queries: perQuery,
      guard: {
        total: guardScores.length,
        passed: guardScores.filter((g) => g.passed).length,
        failures: guardScores.filter((g) => !g.passed)
      }
    };
  } finally {
    await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
  }
}

export interface CategoryComparison {
  category: QueryCategory;
  comparison: PairedComparison;
}

export interface ComparisonReport {
  baseline_label: string;
  candidate_label: string;
  metric: "ndcg_at_10";
  overall: PairedComparison;
  by_category: CategoryComparison[];
  /** Categories where the candidate is significantly WORSE than baseline. Empty
   *  is the pass condition for the significance gate. */
  significant_regressions: QueryCategory[];
}

/**
 * A/B the recall branches: run every query under the lexical-only baseline
 * (`recall: false`) and the full candidate (`recall: true`) against the *same*
 * seeded corpus and the same frozen clock, pair the per-query nDCG@10 vectors,
 * and report a paired permutation p-value + bootstrap 95% CI per category and
 * overall. This is how a 1–2 point move is told from noise.
 */
export async function compareSearch(pool: PgPool, options: EvaluateOptions = {}): Promise<ComparisonReport> {
  const limit = options.limit ?? 25;
  const accountEmail = options.accountEmail ?? `search-eval-cmp-${process.pid}@example.test`;
  const { accountId, resolve } = await seedCorpus(pool, accountEmail);

  try {
    const baseline = await runArm(pool, accountId, resolve, { recall: false, limit, semantic: options.semantic });
    const candidate = await runArm(pool, accountId, resolve, { recall: true, limit, semantic: options.semantic });

    const byId = (rows: QueryScore[]): Map<string, QueryScore> => new Map(rows.map((r) => [r.id, r]));
    const baseById = byId(baseline);
    const candById = byId(candidate);
    const ndcg = (rows: Map<string, QueryScore>, ids: string[]): number[] =>
      ids.map((id) => rows.get(id)?.metrics.ndcg_at_10 ?? 0);

    const allIds = queries.map((q) => q.id);
    const overall = comparePaired(ndcg(baseById, allIds), ndcg(candById, allIds));

    const categories = [...new Set(queries.map((q) => q.category))];
    const byCategory: CategoryComparison[] = categories.map((category) => {
      const ids = queries.filter((q) => q.category === category).map((q) => q.id);
      return { category, comparison: comparePaired(ndcg(baseById, ids), ndcg(candById, ids)) };
    });

    return {
      baseline_label: "lexical-only (recall=false)",
      candidate_label: "fuzzy+concept (recall=true)",
      metric: "ndcg_at_10",
      overall,
      by_category: byCategory,
      significant_regressions: byCategory
        .filter((c) => c.comparison.significant_regression)
        .map((c) => c.category)
    };
  } finally {
    await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
  }
}

export { messages, queries } from "./corpus.js";
