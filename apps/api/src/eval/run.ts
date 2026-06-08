import type { PgPool } from "../db.js";
import { searchMessages } from "../search/search.js";
import { messages, queries, type QueryCategory } from "./corpus.js";
import { meanMetrics, scoreQuery, type QueryMetrics } from "./metrics.js";

export interface QueryScore {
  id: string;
  category: QueryCategory;
  q: string;
  relevant_count: number;
  returned_count: number;
  metrics: QueryMetrics;
  /** null when the query has no topFirst expectation. */
  top_first_ok: boolean | null;
  /** Relevant synthetic ids that did not make the top 10. */
  missing: string[];
}

export interface CategoryScore {
  category: QueryCategory;
  query_count: number;
  metrics: QueryMetrics;
}

export interface Scorecard {
  corpus_size: number;
  query_count: number;
  headline: { ndcg_at_10: number; recall_at_10: number; mrr: number };
  overall: QueryMetrics;
  by_category: CategoryScore[];
  queries: QueryScore[];
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
 * Seed the judged corpus into an isolated account, run every query through the
 * real {@link searchMessages}, and score the results against the ground truth.
 * The account is deleted afterwards (cascade), so the eval is side-effect free
 * and safe to run against a shared database.
 */
export async function evaluateSearch(pool: PgPool, options: EvaluateOptions = {}): Promise<Scorecard> {
  const limit = options.limit ?? 25;
  const accountEmail = options.accountEmail ?? `search-eval-${process.pid}@example.test`;

  const accountResult = await pool.query<{ id: string }>(
    `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
     VALUES ($1, 'imap.example.test', 993, $1, $2)
     RETURNING id`,
    [accountEmail, Buffer.from([0])]
  );
  const accountId = accountResult.rows[0].id;
  const uuidBySynthetic = new Map<string, string>();

  try {
    let uid = 1;
    for (const message of messages) {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO public.imap_messages (
           account_id, folder_path, uidvalidity, uid, internal_date,
           subject, from_email, from_name, to_emails, flags,
           deleted_in_provider, window_status, size_bytes
         )
         VALUES ($1, $2, $3, $4, now() - ($5 * interval '1 day'),
           $6, $7, $8, $9, $10, false, 'IN_WINDOW', $11)
         RETURNING id`,
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
          message.sizeBytes ?? message.body.length
        ]
      );
      const id = inserted.rows[0].id;
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

    const resolve = (syntheticId: string): string => {
      const uuid = uuidBySynthetic.get(syntheticId);
      if (!uuid) throw new Error(`Eval corpus query references unknown message id: ${syntheticId}`);
      return uuid;
    };

    const perQuery: QueryScore[] = [];
    for (const query of queries) {
      const response = await searchMessages(pool, {
        q: query.q,
        accounts: [accountId],
        limit,
        semantic: options.semantic
      });
      const resultUuids = response.results.map((r) => r.identity.id);
      const judgments = new Map<string, number>(query.relevant.map((sid) => [resolve(sid), 1]));
      const metrics = scoreQuery(resultUuids, judgments);

      const top10 = new Set(resultUuids.slice(0, 10));
      const missing = query.relevant.filter((sid) => !top10.has(resolve(sid)));
      const topFirstOk = query.topFirst ? resultUuids[0] === resolve(query.topFirst) : null;

      perQuery.push({
        id: query.id,
        category: query.category,
        q: query.q,
        relevant_count: query.relevant.length,
        returned_count: resultUuids.length,
        metrics,
        top_first_ok: topFirstOk,
        missing
      });
    }

    const overall = meanMetrics(perQuery.map((p) => p.metrics));
    const categories = [...new Set(queries.map((q) => q.category))];
    const byCategory: CategoryScore[] = categories.map((category) => {
      const subset = perQuery.filter((p) => p.category === category);
      return {
        category,
        query_count: subset.length,
        metrics: meanMetrics(subset.map((s) => s.metrics))
      };
    });

    return {
      corpus_size: messages.length,
      query_count: queries.length,
      headline: {
        ndcg_at_10: overall.ndcg_at_10,
        recall_at_10: overall.recall_at_10,
        mrr: overall.reciprocal_rank
      },
      overall,
      by_category: byCategory,
      queries: perQuery
    };
  } finally {
    await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
  }
}

export { messages, queries } from "./corpus.js";
