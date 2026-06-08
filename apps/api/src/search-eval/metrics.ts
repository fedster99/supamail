import type { EvalAssertion, EvalCase, SearchHit } from "./types.js";

/** Recall@k: fraction of relevant docs retrieved in the top-k. */
export function recallAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1; // nothing to find ⇒ trivially satisfied
  const topK = rankedIds.slice(0, k);
  let found = 0;
  for (const id of topK) if (relevant.has(id)) found += 1;
  return found / relevant.size;
}

/** Precision@k: fraction of the top-k that are relevant. */
export function precisionAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  const topK = rankedIds.slice(0, k);
  if (topK.length === 0) return relevant.size === 0 ? 1 : 0;
  let found = 0;
  for (const id of topK) if (relevant.has(id)) found += 1;
  return found / topK.length;
}

/** Reciprocal rank of the first relevant doc (0 if none in the list). */
export function reciprocalRank(rankedIds: string[], relevant: Set<string>): number {
  for (let i = 0; i < rankedIds.length; i += 1) {
    if (relevant.has(rankedIds[i])) return 1 / (i + 1);
  }
  return relevant.size === 0 ? 1 : 0;
}

/**
 * nDCG@k with graded gains (binary relevance defaults to gain 1).
 * DCG = Σ gain_i / log2(i + 2); normalized by the ideal DCG.
 */
export function ndcgAtK(
  rankedIds: string[],
  relevant: Set<string>,
  k: number,
  graded?: Record<string, number>
): number {
  const gainOf = (id: string): number => {
    if (graded && id in graded) return graded[id];
    return relevant.has(id) ? 1 : 0;
  };
  const topK = rankedIds.slice(0, k);
  let dcg = 0;
  topK.forEach((id, i) => {
    const g = gainOf(id);
    if (g > 0) dcg += g / Math.log2(i + 2);
  });

  // Ideal DCG must use the SAME gain function over the union of relevant ids + graded
  // keys; otherwise a `graded` map that omits some relevant_ids yields an iDCG smaller
  // than the achievable DCG and nDCG can exceed 1.0.
  const idealGains = [...new Set([...relevant, ...Object.keys(graded ?? {})])]
    .map((id) => gainOf(id))
    .filter((g) => g > 0);
  idealGains.sort((a, b) => b - a);
  let idcg = 0;
  idealGains.slice(0, k).forEach((g, i) => {
    idcg += g / Math.log2(i + 2);
  });

  if (idcg === 0) return 1; // no positive gains to achieve ⇒ trivially satisfied
  return dcg / idcg;
}

export interface AssertionResult {
  type: EvalAssertion["type"];
  passed: boolean;
  detail?: string;
}

/**
 * Evaluate the email-specific behavioral assertions for one case against its ranked hits.
 * These capture behaviors IR metrics alone do not (quoted-reply exclusion, thread
 * collapsing, recency ordering, exact-top, rank-above).
 */
export function evaluateAssertions(testCase: EvalCase, hits: SearchHit[], k: number): AssertionResult[] {
  const topHits = hits.slice(0, k);
  const topIds = topHits.map((h) => h.id);
  const indexOf = (id: string): number => topIds.indexOf(id);
  const results: AssertionResult[] = [];

  const assertions: EvalAssertion[] = [...(testCase.assertions ?? [])];
  // `must_not_return` may be declared as a top-level convenience field.
  if (testCase.must_not_return && testCase.must_not_return.length > 0) {
    assertions.push({ type: "must_not_return", ids: testCase.must_not_return });
  }

  for (const assertion of assertions) {
    switch (assertion.type) {
      case "top_is": {
        const passed = topIds[0] === assertion.id;
        results.push({
          type: assertion.type,
          passed,
          detail: passed ? undefined : `expected top "${assertion.id}", got "${topIds[0] ?? "<none>"}"`
        });
        break;
      }
      case "must_not_return": {
        const offenders = assertion.ids.filter((id) => topIds.includes(id));
        results.push({
          type: assertion.type,
          passed: offenders.length === 0,
          detail: offenders.length === 0 ? undefined : `forbidden id(s) in top-${k}: ${offenders.join(", ")}`
        });
        break;
      }
      case "rank_above": {
        const hi = indexOf(assertion.higher);
        const lo = indexOf(assertion.lower);
        const passed = hi !== -1 && (lo === -1 || hi < lo);
        results.push({
          type: assertion.type,
          passed,
          detail: passed
            ? undefined
            : `expected "${assertion.higher}" above "${assertion.lower}" (ranks ${hi} vs ${lo})`
        });
        break;
      }
      case "thread_collapsed": {
        const seen = new Map<string, number>();
        for (const hit of topHits) {
          const key = hit.thread_key ?? hit.id;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([key]) => key);
        results.push({
          type: assertion.type,
          passed: dupes.length === 0,
          detail: dupes.length === 0 ? undefined : `thread(s) returned more than once: ${dupes.join(", ")}`
        });
        break;
      }
      case "recency_order": {
        const positions = assertion.ids.map((id) => indexOf(id));
        const allPresent = positions.every((p) => p !== -1);
        const monotonic = positions.every((p, i) => i === 0 || positions[i - 1] < p);
        const passed = allPresent && monotonic;
        results.push({
          type: assertion.type,
          passed,
          detail: passed ? undefined : `expected newest-first order ${assertion.ids.join(" > ")}, got positions ${positions.join(",")}`
        });
        break;
      }
      case "ordered_prefix": {
        const passed = assertion.ids.every((id, i) => topIds[i] === id);
        results.push({
          type: assertion.type,
          passed,
          detail: passed ? undefined : `expected prefix ${assertion.ids.join(" > ")}, got ${topIds.slice(0, assertion.ids.length).join(" > ")}`
        });
        break;
      }
    }
  }

  return results;
}
