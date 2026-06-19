import { describe, expect, it } from "vitest";
import {
  dcgAtK,
  meanMetrics,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  scoreQuery,
  successAtK
} from "../eval/metrics.js";
import { messages, queries } from "../eval/corpus.js";

function judg(...ids: string[]): Map<string, number> {
  return new Map(ids.map((id) => [id, 1]));
}

describe("IR metrics", () => {
  const relevant = judg("a", "b", "c");

  it("precision@k counts relevant in the top k over k", () => {
    expect(precisionAtK(["a", "x", "b", "y"], relevant, 2)).toBe(0.5);
    expect(precisionAtK(["a", "b"], relevant, 2)).toBe(1);
    expect(precisionAtK([], relevant, 5)).toBe(0);
  });

  it("recall@k counts relevant found over total relevant", () => {
    expect(recallAtK(["a", "b", "x"], relevant, 10)).toBeCloseTo(2 / 3);
    expect(recallAtK(["a", "b", "c"], relevant, 10)).toBe(1);
    expect(recallAtK(["a", "b", "c"], relevant, 2)).toBeCloseTo(2 / 3);
  });

  it("reciprocal rank is 1 over the first relevant position", () => {
    expect(reciprocalRank(["x", "a", "b"], relevant)).toBe(0.5);
    expect(reciprocalRank(["a"], relevant)).toBe(1);
    expect(reciprocalRank(["x", "y"], relevant)).toBe(0);
  });

  it("nDCG@k is 1 for an ideal ranking and < 1 when relevant docs sink", () => {
    const ideal = ndcgAtK(["a", "b", "c", "z"], relevant, 10);
    expect(ideal).toBeCloseTo(1);
    const sunk = ndcgAtK(["z", "y", "a"], relevant, 10);
    expect(sunk).toBeGreaterThan(0);
    expect(sunk).toBeLessThan(ideal);
  });

  it("nDCG respects graded relevance ordering", () => {
    const graded = new Map([["a", 3], ["b", 1]]);
    const good = ndcgAtK(["a", "b"], graded, 10);
    const bad = ndcgAtK(["b", "a"], graded, 10);
    expect(good).toBeCloseTo(1);
    expect(bad).toBeLessThan(good);
  });

  it("dcg and success behave at the edges", () => {
    expect(dcgAtK([], relevant, 5)).toBe(0);
    expect(successAtK(["x", "a"], relevant, 5)).toBe(1);
    expect(successAtK(["x", "y"], relevant, 5)).toBe(0);
  });

  it("meanMetrics averages each field", () => {
    const a = scoreQuery(["a", "b", "c"], relevant);
    const b = scoreQuery(["x", "y", "z"], relevant);
    const mean = meanMetrics([a, b]);
    expect(mean.recall_at_10).toBeCloseTo((a.recall_at_10 + b.recall_at_10) / 2);
  });
});

describe("eval corpus invariants", () => {
  const ids = new Set(messages.map((m) => m.id));

  it("has unique message ids", () => {
    expect(ids.size).toBe(messages.length);
  });

  it("references only real messages in every query's ground truth", () => {
    for (const query of queries) {
      for (const sid of query.relevant) {
        expect(ids.has(sid), `${query.id} relevant id ${sid}`).toBe(true);
      }
      if (query.topFirst) {
        expect(ids.has(query.topFirst), `${query.id} topFirst ${query.topFirst}`).toBe(true);
      }
      expect(query.relevant.length, `${query.id} has ground truth`).toBeGreaterThan(0);
    }
  });

  it("covers every query category", () => {
    const categories = new Set(queries.map((q) => q.category));
    for (const expected of ["lexical", "ranking", "operator", "phrase", "typo", "semantic"]) {
      expect(categories.has(expected as never)).toBe(true);
    }
  });
});
