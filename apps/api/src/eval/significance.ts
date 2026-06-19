/**
 * Deterministic significance testing for paired A/B search evals.
 *
 * At n≈32 queries a 1–2 point nDCG move is inside the noise, so a bare mean
 * delta cannot drive ship/no-ship. These helpers answer "is candidate actually
 * different from baseline, or is this sampling noise?" via a paired permutation
 * test (the distribution-free standard for paired IR runs) plus a bootstrap CI on
 * the mean delta. Both use a fixed-seed PRNG, so the verdict is reproducible
 * run-to-run — no `Math.random`, no flaky gate.
 */

/** mulberry32 — a tiny, fast, well-distributed seeded PRNG in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

export interface PairedComparison {
  n: number;
  mean_baseline: number;
  mean_candidate: number;
  mean_delta: number;
  /** Two-sided paired permutation p-value (sign-flip). */
  p_value: number;
  /** Bootstrap 95% CI on the mean delta [lo, hi]. */
  ci_lower: number;
  ci_upper: number;
  /** Significant improvement: p < 0.05 AND the whole CI is above 0. */
  significant_improvement: boolean;
  /** Significant regression: p < 0.05 AND the whole CI is below 0. */
  significant_regression: boolean;
}

/**
 * Paired permutation test on per-query scores (candidate − baseline). Under the
 * null (no effect) the sign of each paired delta is exchangeable; we flip signs
 * `iters` times and measure how often |permuted mean| ≥ |observed mean|.
 */
export function pairedPermutationTest(
  baseline: number[],
  candidate: number[],
  iters = 10000,
  seed = 0x5eed
): number {
  if (baseline.length !== candidate.length) {
    throw new Error(`paired test needs equal-length vectors (${baseline.length} vs ${candidate.length})`);
  }
  const deltas = candidate.map((c, i) => c - baseline[i]);
  const observed = Math.abs(mean(deltas));
  // All-zero deltas → no effect, p = 1 (avoids a degenerate "0 ≥ 0" sweep to p=0).
  if (deltas.every((d) => d === 0)) return 1;
  const rand = mulberry32(seed);
  let atLeastAsExtreme = 0;
  for (let it = 0; it < iters; it += 1) {
    let sum = 0;
    for (const d of deltas) sum += rand() < 0.5 ? -d : d;
    if (Math.abs(sum / deltas.length) >= observed - 1e-12) atLeastAsExtreme += 1;
  }
  return atLeastAsExtreme / iters;
}

/** Bootstrap CI on the mean of `deltas` (candidate − baseline), percentile method. */
export function bootstrapDeltaCI(
  deltas: number[],
  iters = 10000,
  seed = 0xb007,
  alpha = 0.05
): { lo: number; hi: number } {
  if (deltas.length === 0) return { lo: 0, hi: 0 };
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let it = 0; it < iters; it += 1) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i += 1) sum += deltas[Math.floor(rand() * deltas.length)];
    means.push(sum / deltas.length);
  }
  means.sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * means.length);
  const hiIdx = Math.min(means.length - 1, Math.ceil((1 - alpha / 2) * means.length) - 1);
  return { lo: means[loIdx], hi: means[hiIdx] };
}

/** Full paired comparison of two per-query metric vectors (baseline vs candidate). */
export function comparePaired(
  baseline: number[],
  candidate: number[],
  opts: { permIters?: number; bootIters?: number; seed?: number } = {}
): PairedComparison {
  const permIters = opts.permIters ?? 10000;
  const bootIters = opts.bootIters ?? 10000;
  const seed = opts.seed ?? 0x5eed;
  const deltas = candidate.map((c, i) => c - baseline[i]);
  const p = pairedPermutationTest(baseline, candidate, permIters, seed);
  const ci = bootstrapDeltaCI(deltas, bootIters, seed ^ 0xb007);
  return {
    n: baseline.length,
    mean_baseline: mean(baseline),
    mean_candidate: mean(candidate),
    mean_delta: mean(deltas),
    p_value: p,
    ci_lower: ci.lo,
    ci_upper: ci.hi,
    significant_improvement: p < 0.05 && ci.lo > 0,
    significant_regression: p < 0.05 && ci.hi < 0
  };
}
