import { DEFAULT_K, DEFAULT_RECALL_K, GOAL } from "./config.js";
import {
  evaluateAssertions,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  type AssertionResult
} from "./metrics.js";
import type { Capability, EvalCase, EvalMessage, SearchEngine } from "./types.js";

export interface CaseResult {
  id: string;
  capability: Capability;
  tier: EvalCase["tier"];
  k: number;
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
  assertions: AssertionResult[];
  assertionPassRate: number;
  retrieved: number;
}

export interface AggregateMetrics {
  count: number;
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
  assertionPassRate: number;
}

export interface EvalReport {
  engine: string;
  overall: AggregateMetrics; // non-semantic cases (the CI-gated contract)
  semantic: AggregateMetrics; // semantic-tier cases (tracked, aspirational)
  byCapability: Partial<Record<Capability, AggregateMetrics>>;
  cases: CaseResult[];
  goal: { met: boolean; failures: string[] };
}

function mean(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function aggregate(cases: CaseResult[]): AggregateMetrics {
  return {
    count: cases.length,
    recall: mean(cases.map((c) => c.recall)),
    precision: mean(cases.map((c) => c.precision)),
    mrr: mean(cases.map((c) => c.mrr)),
    ndcg: mean(cases.map((c) => c.ndcg)),
    assertionPassRate: mean(cases.map((c) => c.assertionPassRate))
  };
}

export async function runEval(
  engine: SearchEngine,
  messages: EvalMessage[],
  cases: EvalCase[]
): Promise<EvalReport> {
  await engine.index(messages);

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const response = await engine.search(testCase.query);
    const rankedIds = response.hits.map((h) => h.id);
    const relevant = new Set(testCase.relevant_ids);
    const k = testCase.k ?? DEFAULT_K;

    const assertions = evaluateAssertions(testCase, response.hits, k);
    const assertionPassRate = assertions.length === 0 ? 1 : assertions.filter((a) => a.passed).length / assertions.length;

    results.push({
      id: testCase.id,
      capability: testCase.capability,
      tier: testCase.tier,
      k,
      recall: recallAtK(rankedIds, relevant, testCase.k ?? DEFAULT_RECALL_K),
      precision: precisionAtK(rankedIds, relevant, k),
      mrr: reciprocalRank(rankedIds, relevant),
      ndcg: ndcgAtK(rankedIds, relevant, k, testCase.graded),
      assertions,
      assertionPassRate,
      retrieved: rankedIds.length
    });
  }

  const nonSemantic = results.filter((r) => r.tier !== "semantic");
  const semantic = results.filter((r) => r.tier === "semantic");

  const byCapability: Partial<Record<Capability, AggregateMetrics>> = {};
  for (const r of results) {
    const group = results.filter((x) => x.capability === r.capability);
    byCapability[r.capability] = aggregate(group);
  }

  const overall = aggregate(nonSemantic);
  const failures: string[] = [];
  if (overall.ndcg < GOAL.ndcg) failures.push(`nDCG@${DEFAULT_K} ${overall.ndcg.toFixed(3)} < goal ${GOAL.ndcg}`);
  if (overall.recall < GOAL.recall)
    failures.push(`recall@${DEFAULT_RECALL_K} ${overall.recall.toFixed(3)} < goal ${GOAL.recall}`);
  if (overall.mrr < GOAL.mrr) failures.push(`MRR ${overall.mrr.toFixed(3)} < goal ${GOAL.mrr}`);
  if (overall.assertionPassRate < GOAL.assertionPassRate)
    failures.push(
      `assertion pass rate ${overall.assertionPassRate.toFixed(3)} < goal ${GOAL.assertionPassRate}`
    );

  return {
    engine: engine.name,
    overall,
    semantic: aggregate(semantic),
    byCapability,
    cases: results,
    goal: { met: failures.length === 0, failures }
  };
}
