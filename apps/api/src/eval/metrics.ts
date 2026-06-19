/**
 * Pure information-retrieval metrics. No database, no I/O — these turn a ranked
 * list of result ids plus a set of relevance judgments into the standard search
 * quality numbers, so "how good is the search" becomes measurable and tracked.
 *
 * `results` is the ranked list of message ids returned by the search (best
 * first). `relevant` maps a relevant message id to its graded relevance (>= 1;
 * higher = more relevant). Ids absent from the map are treated as non-relevant.
 */
export type Judgments = Map<string, number>;

function relevantIds(relevant: Judgments): Set<string> {
  return new Set([...relevant.keys()]);
}

/** Fraction of the top-k results that are relevant. */
export function precisionAtK(results: string[], relevant: Judgments, k: number): number {
  if (k <= 0) return 0;
  const rel = relevantIds(relevant);
  const topK = results.slice(0, k);
  const hits = topK.filter((id) => rel.has(id)).length;
  return hits / k;
}

/** Fraction of all relevant docs that appear in the top-k results. */
export function recallAtK(results: string[], relevant: Judgments, k: number): number {
  const rel = relevantIds(relevant);
  if (rel.size === 0) return 0;
  const topK = new Set(results.slice(0, k));
  let hits = 0;
  for (const id of rel) if (topK.has(id)) hits += 1;
  return hits / rel.size;
}

/** Reciprocal of the rank (1-based) of the first relevant result; 0 if none. */
export function reciprocalRank(results: string[], relevant: Judgments): number {
  const rel = relevantIds(relevant);
  for (let i = 0; i < results.length; i += 1) {
    if (rel.has(results[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Exponential relevance gain `2^g - 1`. Rewards a grade-3 doc 7×, a grade-2 doc
 *  3×, a grade-1 doc 1× — so swapping two relevant docs of *different* grade moves
 *  nDCG (linear gain barely does). gain(1)=1, so an all-grade-1 corpus is unchanged. */
function gain(grade: number): number {
  return grade > 0 ? Math.pow(2, grade) - 1 : 0;
}

/** Discounted cumulative gain over the top-k, using exponential graded relevance. */
export function dcgAtK(results: string[], relevant: Judgments, k: number): number {
  let dcg = 0;
  const topK = results.slice(0, k);
  for (let i = 0; i < topK.length; i += 1) {
    dcg += gain(relevant.get(topK[i]) ?? 0) / Math.log2(i + 2);
  }
  return dcg;
}

/** Normalized DCG@k in [0,1]: actual DCG divided by the ideal ordering's DCG. */
export function ndcgAtK(results: string[], relevant: Judgments, k: number): number {
  const ideal = [...relevant.values()].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i += 1) idcg += gain(ideal[i]) / Math.log2(i + 2);
  if (idcg === 0) return 0;
  return dcgAtK(results, relevant, k) / idcg;
}

/** 1 if at least one relevant doc is in the top-k, else 0 (a.k.a. success@k). */
export function successAtK(results: string[], relevant: Judgments, k: number): number {
  const rel = relevantIds(relevant);
  return results.slice(0, k).some((id) => rel.has(id)) ? 1 : 0;
}

export interface QueryMetrics {
  precision_at_5: number;
  precision_at_10: number;
  recall_at_10: number;
  reciprocal_rank: number;
  /** nDCG at a small cutoff — on a 31-doc index, @3 actually exercises ordering
   *  among the relevant docs where @10 saturates. */
  ndcg_at_3: number;
  ndcg_at_10: number;
  /** Did the single best answer come first? The agent's top-1 is what matters. */
  success_at_1: number;
  success_at_10: number;
}

/** Compute the full metric set for a single query's ranked results. */
export function scoreQuery(results: string[], relevant: Judgments): QueryMetrics {
  return {
    precision_at_5: precisionAtK(results, relevant, 5),
    precision_at_10: precisionAtK(results, relevant, 10),
    recall_at_10: recallAtK(results, relevant, 10),
    reciprocal_rank: reciprocalRank(results, relevant),
    ndcg_at_3: ndcgAtK(results, relevant, 3),
    ndcg_at_10: ndcgAtK(results, relevant, 10),
    success_at_1: successAtK(results, relevant, 1),
    success_at_10: successAtK(results, relevant, 10)
  };
}

/** Mean of each metric across a set of per-query results. */
export function meanMetrics(all: QueryMetrics[]): QueryMetrics {
  const keys: (keyof QueryMetrics)[] = [
    "precision_at_5",
    "precision_at_10",
    "recall_at_10",
    "reciprocal_rank",
    "ndcg_at_3",
    "ndcg_at_10",
    "success_at_1",
    "success_at_10"
  ];
  const out = {} as QueryMetrics;
  for (const key of keys) {
    out[key] = all.length === 0 ? 0 : all.reduce((sum, m) => sum + m[key], 0) / all.length;
  }
  return out;
}
