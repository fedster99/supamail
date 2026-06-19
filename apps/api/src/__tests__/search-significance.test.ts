import { describe, expect, it } from "vitest";
import { ndcgAtK, type Judgments } from "../eval/metrics.js";
import {
  bootstrapDeltaCI,
  comparePaired,
  mulberry32,
  pairedPermutationTest
} from "../eval/significance.js";

describe("graded nDCG", () => {
  const judged: Judgments = new Map([
    ["a", 3],
    ["b", 1]
  ]);

  it("is 1.0 for the ideal (high grade first) ordering", () => {
    expect(ndcgAtK(["a", "b"], judged, 10)).toBeCloseTo(1, 10);
  });

  it("drops below 1.0 when two relevant docs of different grade are swapped", () => {
    // This is the roadmap's verification: with grading, ordering among relevant
    // docs matters (binary/forced-grade-1 made this exactly 1.0).
    expect(ndcgAtK(["b", "a"], judged, 10)).toBeLessThan(0.95);
  });

  it("uses exponential gain (grade 3 dominates grade 1)", () => {
    // gain(3)=7, gain(1)=1 → putting the grade-1 doc first costs most of the score.
    const wrong = ndcgAtK(["b", "a"], judged, 10);
    expect(wrong).toBeGreaterThan(0.5);
    expect(wrong).toBeLessThan(0.75);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)());
  });
});

describe("pairedPermutationTest", () => {
  it("returns p=1 for identical vectors (no effect)", () => {
    expect(pairedPermutationTest([0.5, 0.6, 0.7], [0.5, 0.6, 0.7])).toBe(1);
  });

  it("is deterministic (fixed seed)", () => {
    const a = [0.1, 0.2, 0.3, 0.2, 0.4];
    const b = [0.6, 0.7, 0.8, 0.6, 0.9];
    expect(pairedPermutationTest(a, b)).toBe(pairedPermutationTest(a, b));
  });

  it("finds a large consistent improvement significant", () => {
    const base = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    const cand = [0.8, 0.7, 0.9, 0.6, 0.85, 0.75, 0.95, 0.8];
    expect(pairedPermutationTest(base, cand)).toBeLessThan(0.05);
  });

  it("throws on length mismatch", () => {
    expect(() => pairedPermutationTest([0.1], [0.1, 0.2])).toThrow();
  });
});

describe("comparePaired", () => {
  it("flags a clear win as a significant improvement with a positive CI", () => {
    const base = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    const cand = [0.9, 0.8, 0.85, 0.95, 0.7, 0.9];
    const c = comparePaired(base, cand);
    expect(c.mean_delta).toBeGreaterThan(0);
    expect(c.ci_lower).toBeGreaterThan(0);
    expect(c.significant_improvement).toBe(true);
    expect(c.significant_regression).toBe(false);
  });

  it("flags a clear loss as a significant regression", () => {
    const base = [0.9, 0.8, 0.85, 0.95, 0.7, 0.9];
    const cand = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    const c = comparePaired(base, cand);
    expect(c.significant_regression).toBe(true);
    expect(c.ci_upper).toBeLessThan(0);
  });

  it("calls a tiny noisy difference non-significant", () => {
    const base = [0.50, 0.60, 0.55, 0.48, 0.62, 0.51];
    const cand = [0.51, 0.59, 0.56, 0.47, 0.63, 0.50];
    const c = comparePaired(base, cand);
    expect(c.significant_improvement).toBe(false);
    expect(c.significant_regression).toBe(false);
  });
});

describe("bootstrapDeltaCI", () => {
  it("brackets the mean delta and is deterministic", () => {
    const deltas = [0.2, 0.3, 0.25, 0.15, 0.35, 0.28];
    const ci1 = bootstrapDeltaCI(deltas);
    const ci2 = bootstrapDeltaCI(deltas);
    expect(ci1).toEqual(ci2);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    expect(ci1.lo).toBeLessThanOrEqual(mean);
    expect(ci1.hi).toBeGreaterThanOrEqual(mean);
  });
});
