import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db.js";
import { compareSearch, evaluateSearch, type CategoryScore, type ComparisonReport, type Scorecard } from "../eval/run.js";

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
    expect(ei.distinct_thread_ratio ?? 0).toBeCloseTo(1, 5);
    expect(ei.metrics.ndcg_at_10).toBeGreaterThanOrEqual(0.95);
    // Bulk demotion + grouping: the expected human / canonical result leads.
    for (const q of scorecard.queries.filter((x) => x.category === "email-intent")) {
      expect(q.top_first_ok, `${q.id} top_first`).not.toBe(false);
    }
  });

  it("returns nothing for the junk-return guard sentinels", () => {
    // A loosened fuzzy/concept threshold that returns junk would fail here instead
    // of inflating a category — the anti-regression guard.
    expect(scorecard.guard.failures, JSON.stringify(scorecard.guard.failures)).toEqual([]);
    expect(scorecard.guard.passed).toBe(scorecard.guard.total);
  });

  it("does not regress the headline below an absolute smoke floor", () => {
    // Backstop only — the real anti-regression check is the significance gate below.
    expect(scorecard.headline.ndcg_at_10).toBeGreaterThanOrEqual(0.6);
    expect(scorecard.headline.recall_at_10).toBeGreaterThanOrEqual(0.6);
  });
});

/**
 * The trustworthy gate: instead of asserting an absolute headline (noise at n=32),
 * A/B the recall branches against the lexical-only baseline on the same frozen
 * corpus and require (a) no category significantly worse, and (b) an overall
 * significant improvement — a paired permutation test with a fixed seed, so it is
 * deterministic. This is what tells a real move from sampling noise.
 */
liveDb("search A/B significance gate", () => {
  let pool: ReturnType<typeof getPool>;
  let report: ComparisonReport;

  beforeAll(async () => {
    pool = getPool();
    report = await compareSearch(pool, { accountEmail: `search-ab-${process.pid}@example.test` });
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  it("never makes a category significantly worse than the lexical baseline", () => {
    expect(report.significant_regressions, report.significant_regressions.join(", ")).toEqual([]);
  });

  it("significantly improves overall nDCG@10 over the lexical baseline", () => {
    expect(report.overall.mean_delta).toBeGreaterThan(0);
    expect(report.overall.significant_improvement, `p=${report.overall.p_value}, CI[${report.overall.ci_lower}, ${report.overall.ci_upper}]`).toBe(true);
  });
});
