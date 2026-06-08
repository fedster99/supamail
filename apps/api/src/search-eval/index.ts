/**
 * Email-search evaluation harness.
 *
 * Engine-agnostic: any {@link SearchEngine} is scored by the same email-specific evals.
 * See `apps/api/src/search-eval/README.md` and ADR 0015 for the design.
 */
export * from "./types.js";
export * from "./metrics.js";
export * from "./reference-engine.js";
export * from "./corpus.js";
export * from "./runner.js";
export * from "./report.js";
export { CURRENT_ENGINE_OPTIONS, DEFAULT_K, DEFAULT_RECALL_K, GOAL } from "./config.js";
