import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db.js";
import { evaluateSearch, type CategoryScore, type Scorecard } from "../eval/run.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

/**
 * Turns the search evaluation harness into a regression gate. The categories
 * the pure-Postgres engine already does well (operator / ranking / phrase /
 * lexical) must not slip. Typo and semantic are deliberately NOT gated here —
 * they are the known-weak categories the improvement goal targets, so raising
 * them must never be blocked by this test.
 */
liveDb("search quality gate", () => {
  let pool: ReturnType<typeof getPool>;
  let scorecard: Scorecard;

  beforeAll(async () => {
    pool = getPool();
    scorecard = await evaluateSearch(pool, { accountEmail: `search-quality-${process.pid}@example.test` });
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  const category = (name: string): CategoryScore => {
    const found = scorecard.by_category.find((c) => c.category === name);
    if (!found) throw new Error(`category ${name} missing from scorecard`);
    return found;
  };

  it("answers operator queries exactly (recall and nDCG = 1.0)", () => {
    const op = category("operator");
    expect(op.metrics.recall_at_10).toBe(1);
    expect(op.metrics.ndcg_at_10).toBeCloseTo(1, 5);
  });

  it("ranks the expected result first for ranking queries", () => {
    expect(category("ranking").metrics.ndcg_at_10).toBeGreaterThanOrEqual(0.95);
    for (const q of scorecard.queries.filter((x) => x.category === "ranking")) {
      expect(q.top_first_ok, `${q.id} top_first`).not.toBe(false);
    }
  });

  it("keeps phrase queries strong", () => {
    expect(category("phrase").metrics.ndcg_at_10).toBeGreaterThanOrEqual(0.95);
  });

  it("keeps lexical recall strong", () => {
    expect(category("lexical").metrics.ndcg_at_10).toBeGreaterThanOrEqual(0.8);
  });

  it("groups conversations and demotes bulk (email-intent)", () => {
    const ei = category("email-intent");
    // Thread grouping: no conversation appears as duplicate hits.
    expect(ei.distinct_thread_ratio).toBeCloseTo(1, 5);
    expect(ei.metrics.ndcg_at_10).toBeGreaterThanOrEqual(0.95);
    // Bulk demotion + grouping: the expected human / canonical result leads.
    for (const q of scorecard.queries.filter((x) => x.category === "email-intent")) {
      expect(q.top_first_ok, `${q.id} top_first`).not.toBe(false);
    }
  });

  it("does not regress the headline below the recorded baseline", () => {
    // Baseline 2026-06-07: nDCG@10 0.692, recall@10 0.685. Gate a little under.
    expect(scorecard.headline.ndcg_at_10).toBeGreaterThanOrEqual(0.6);
    expect(scorecard.headline.recall_at_10).toBeGreaterThanOrEqual(0.6);
  });
});
