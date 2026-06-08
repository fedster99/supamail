import { IMPROVED_OPTIONS, type ReferenceEngineOptions } from "./reference-engine.js";

/**
 * Suite configuration: default cutoffs, the GOAL thresholds the search engine is
 * being driven toward, and which engine configuration is "current".
 *
 * The goal is intentionally split by tier: the lexical/fuzzy contract must be met
 * hard (CI-gating), while the semantic tier is an aspirational target tracked
 * separately (a pure-lexical reference engine is not expected to fully satisfy it —
 * that is what the opt-in Tier-2 vector arm is for).
 */
export const DEFAULT_K = 10;
export const DEFAULT_RECALL_K = 20;

export interface GoalThresholds {
  /** Minimum mean nDCG@k over non-semantic cases. */
  ndcg: number;
  /** Minimum mean recall@K over non-semantic cases. */
  recall: number;
  /** Minimum mean reciprocal rank over non-semantic cases. */
  mrr: number;
  /** Minimum email-specific assertion pass rate over non-semantic cases (1 = all). */
  assertionPassRate: number;
  /** Per-case floor on nDCG@k for every gated case — stops easy cases masking one bad case. */
  perCaseNdcg: number;
  /** Per-case floor on recall@K for every gated case. */
  perCaseRecall: number;
  /**
   * Per-case floor on precision@R (R = #relevant) for every gated case. Scale-free
   * over-retrieval guard: catches noise appended after the relevant docs (which
   * recall/nDCG/MRR keep pinned at 1.0) without punishing low-prevalence queries.
   */
  perCasePrecisionAtR: number;
  /** Aspirational mean recall@K over semantic-tier cases (tracked, not gated). */
  semanticRecallTarget: number;
}

export const GOAL: GoalThresholds = {
  ndcg: 0.8,
  recall: 0.85,
  mrr: 0.8,
  assertionPassRate: 1,
  // The aggregate is a mean, so it can hide a single catastrophic case. The per-case
  // floors ensure no individual gated case collapses while the average stays high.
  perCaseNdcg: 0.7,
  perCaseRecall: 0.8,
  perCasePrecisionAtR: 0.5,
  semanticRecallTarget: 0.7
};

/**
 * The engine configuration the suite currently grades and gates against.
 * Improving search "toward the evals" means advancing this configuration (and the
 * engine behind it) until {@link GOAL} is met, then ratcheting the committed baseline.
 */
export const CURRENT_ENGINE_OPTIONS: ReferenceEngineOptions = IMPROVED_OPTIONS;
