import { describe, expect, it } from "vitest";
import { loadCases, loadCorpus, validateReferences } from "./corpus.js";
import { ndcgAtK, precisionAtK, recallAtK, reciprocalRank } from "./metrics.js";
import { BASELINE_OPTIONS, IMPROVED_OPTIONS, ReferenceEngine } from "./reference-engine.js";
import { runEval } from "./runner.js";

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
});

describe("eval corpus integrity", () => {
  it("has no dangling message references", () => {
    const problems = validateReferences(loadCorpus(), loadCases());
    expect(problems).toEqual([]);
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
