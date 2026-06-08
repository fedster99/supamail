import { describe, expect, it } from "vitest";
import { auditCases, loadCases, loadCorpus, nonDiscriminatingCases, validateReferences } from "./corpus.js";
import { ndcgAtK, precisionAtK, recallAtK, reciprocalRank } from "./metrics.js";
import { BASELINE_OPTIONS, IMPROVED_OPTIONS, ReferenceEngine } from "./reference-engine.js";
import { summarize } from "./report.js";
import { runEval } from "./runner.js";
import type { EvalMessage, SearchEngine, SearchResponse } from "./types.js";

/** Returns every non-deleted message, recency-sorted, for any query. */
class FirehoseEngine implements SearchEngine {
  readonly name = "firehose";
  private msgs: EvalMessage[] = [];
  index(messages: EvalMessage[]): void {
    this.msgs = messages.filter((m) => !m.deleted_in_provider);
  }
  search(): SearchResponse {
    const hits = [...this.msgs]
      .sort((a, b) => Date.parse(b.internal_date) - Date.parse(a.internal_date))
      .map((m) => ({ id: m.id, score: 1, thread_key: m.thread_key }));
    return { hits };
  }
}

/** Returns nothing for any query. */
class NullEngine implements SearchEngine {
  readonly name = "null";
  index(): void {}
  search(): SearchResponse {
    return { hits: [] };
  }
}

describe("metrics", () => {
  const rel = new Set(["a", "c"]);

  it("recall@k counts relevant in the top-k", () => {
    expect(recallAtK(["a", "b", "c", "d"], rel, 2)).toBeCloseTo(0.5);
    expect(recallAtK(["a", "b", "c"], rel, 3)).toBe(1);
  });

  it("precision@k counts relevant fraction of the top-k", () => {
    expect(precisionAtK(["a", "b"], rel, 2)).toBe(0.5);
    expect(precisionAtK(["a", "c"], rel, 2)).toBe(1);
  });

  it("reciprocal rank uses the first relevant position", () => {
    expect(reciprocalRank(["b", "a"], rel)).toBe(0.5);
    expect(reciprocalRank(["a"], rel)).toBe(1);
    expect(reciprocalRank(["x", "y"], rel)).toBe(0);
  });

  it("nDCG is 1 for an ideal ranking and < 1 otherwise", () => {
    expect(ndcgAtK(["a", "c", "b"], rel, 3)).toBeCloseTo(1);
    expect(ndcgAtK(["b", "a", "c"], rel, 3)).toBeLessThan(1);
  });

  it("treats an empty relevant set as trivially satisfied", () => {
    expect(recallAtK(["x"], new Set(), 5)).toBe(1);
    expect(ndcgAtK(["x"], new Set(), 5)).toBe(1);
  });

  it("never exceeds 1.0 even when graded omits some relevant ids", () => {
    // Regression: a `graded` map that doesn't list every relevant id used to give an
    // iDCG smaller than the achievable DCG, letting nDCG climb above 1.
    const rel = new Set(["a", "b", "c"]);
    expect(ndcgAtK(["x", "a", "b"], rel, 3, { x: 3 })).toBeLessThanOrEqual(1 + 1e-9);
    expect(ndcgAtK(["a", "b", "c"], rel, 3, { a: 3, b: 2, c: 1 })).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("eval corpus integrity", () => {
  it("has no dangling message references", () => {
    const problems = validateReferences(loadCorpus(), loadCases());
    expect(problems).toEqual([]);
  });

  it("has no non-discriminating gated cases", () => {
    // Every gated multi-relevant case must carry an ordering assertion / graded gains,
    // or be explicitly marked order_agnostic — otherwise it can't catch a ranking regression.
    expect(nonDiscriminatingCases(loadCases())).toEqual([]);
  });
});

describe("email-search eval suite", () => {
  const corpus = loadCorpus();
  const cases = loadCases();

  it("the improved engine meets the goal (CI gate)", async () => {
    const report = await runEval(new ReferenceEngine(IMPROVED_OPTIONS, "improved"), corpus, cases);
    // Surface concrete failures in the assertion message when this regresses.
    expect(report.goal.failures).toEqual([]);
    expect(report.goal.met).toBe(true);
  });

  it("the improved engine beats the naive baseline (search improved toward the evals)", async () => {
    const baseline = await runEval(new ReferenceEngine(BASELINE_OPTIONS, "baseline"), corpus, cases);
    const improved = await runEval(new ReferenceEngine(IMPROVED_OPTIONS, "improved"), corpus, cases);
    expect(improved.overall.ndcg).toBeGreaterThan(baseline.overall.ndcg);
    expect(improved.overall.assertionPassRate).toBeGreaterThan(baseline.overall.assertionPassRate);
    expect(improved.semantic.recall).toBeGreaterThan(baseline.semantic.recall);
  });

  it("covers a broad spread of email-specific capabilities", () => {
    const covered = new Set(cases.map((c) => c.capability));
    expect(covered.size).toBeGreaterThanOrEqual(20);
    // The capabilities that make this an EMAIL-search eval (not a generic text-search eval):
    for (const cap of ["quoted-exclusion", "thread-collapse", "recency-prior", "newsletter-downweight"]) {
      expect(covered.has(cap as never)).toBe(true);
    }
  });
});

describe("anti-gaming guards (the gate must have teeth)", () => {
  const corpus = loadCorpus();
  const cases = loadCases();

  it("a firehose engine that returns everything FAILS the goal", async () => {
    const report = await runEval(new FirehoseEngine(), corpus, cases);
    expect(report.goal.met).toBe(false);
  });

  it("a null engine that returns nothing FAILS the goal", async () => {
    const report = await runEval(new NullEngine(), corpus, cases);
    expect(report.goal.met).toBe(false);
  });

  it("the naive baseline FAILS the goal (so passing is not trivial)", async () => {
    const report = await runEval(new ReferenceEngine(BASELINE_OPTIONS, "baseline"), corpus, cases);
    expect(report.goal.met).toBe(false);
  });
});

describe("determinism", () => {
  it("produces identical scores across runs", async () => {
    const corpus = loadCorpus();
    const cases = loadCases();
    const a = summarize(await runEval(new ReferenceEngine(IMPROVED_OPTIONS, "i"), corpus, cases));
    const b = summarize(await runEval(new ReferenceEngine(IMPROVED_OPTIONS, "i"), corpus, cases));
    expect(a).toEqual(b);
  });

  it("the case audit surfaces only intended distractors", () => {
    // auditCases is a non-fatal quality signal; keep the distractor set small and intentional.
    const warnings = auditCases(loadCorpus(), loadCases());
    const unusedLine = warnings.find((w) => w.includes("never referenced")) ?? "";
    const count = Number(unusedLine.match(/^(\d+) fixture/)?.[1] ?? 0);
    expect(count).toBeLessThanOrEqual(4);
  });
});
