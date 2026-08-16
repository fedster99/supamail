import { describe, expect, it } from "vitest";
import { selectClosureExpansionPlan } from "../threading-repository.js";

describe("thread closure query planning", () => {
  it("uses indexed probes only below the measured crossover", () => {
    expect(selectClosureExpansionPlan(1)).toBe("indexed");
    expect(selectClosureExpansionPlan(10)).toBe("indexed");
    expect(selectClosureExpansionPlan(20)).toBe("indexed");
    expect(selectClosureExpansionPlan(21)).toBe("ordered_scan");
    expect(selectClosureExpansionPlan(331)).toBe("ordered_scan");
  });
});
