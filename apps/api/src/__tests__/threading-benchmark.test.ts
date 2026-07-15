import { describe, expect, it } from "vitest";
import {
  THREADING_BENCHMARK,
  evaluateThreadingBenchmark
} from "../eval/threading-benchmark.js";

describe("hand-labeled threading release benchmark", () => {
  it("covers the required high-risk slices", () => {
    const slices = new Set(THREADING_BENCHMARK.map((benchmarkCase) => benchmarkCase.slice));
    for (const required of [
      "normal_reply",
      "missing_parent",
      "late_parent",
      "long_lived_conversation",
      "forward",
      "malformed_header",
      "alias",
      "automated_reminder",
      "subject_reuse",
      "malformed_reply_blocks_subject_fallback",
      "participant_local_part_case_collision",
      "verified_copy_reply_header_conflict",
      "dangerous_duplicate_message_id",
      "delivery_copy",
      "provider_identity",
      "synthetic_rain_style_regression"
    ]) {
      expect(slices.has(required), `missing benchmark slice: ${required}`).toBe(true);
    }
  });

  it("meets the v1 precision/recall gate with zero dangerous false merges", () => {
    const result = evaluateThreadingBenchmark();

    expect(result.cases).toBeGreaterThanOrEqual(14);
    expect(result.messages).toBeGreaterThanOrEqual(30);
    expect(result.delivery.precision).toBeGreaterThanOrEqual(0.999);
    expect(result.delivery.recall).toBeGreaterThanOrEqual(0.999);
    expect(result.conversation.precision).toBeGreaterThanOrEqual(0.999);
    expect(result.conversation.recall).toBeGreaterThanOrEqual(0.999);
    expect(result.dangerousFalseMerges).toBe(0);
  });
});
