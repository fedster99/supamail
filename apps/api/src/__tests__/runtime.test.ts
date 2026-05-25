import { describe, expect, it } from "vitest";
import { parseRuntimeMode } from "../runtime.js";

describe("runtime entrypoint", () => {
  it("defaults to worker mode for self-hosted Docker/Fly deploys", () => {
    expect(parseRuntimeMode({})).toBe("worker");
  });

  it("accepts worker, api, and combined modes", () => {
    expect(parseRuntimeMode({ SUPAMAIL_MODE: "worker" })).toBe("worker");
    expect(parseRuntimeMode({ SUPAMAIL_MODE: "api" })).toBe("api");
    expect(parseRuntimeMode({ SUPAMAIL_MODE: "combined" })).toBe("combined");
  });

  it("rejects unknown runtime modes before opening network resources", () => {
    expect(() => parseRuntimeMode({ SUPAMAIL_MODE: "nope" })).toThrow(
      "SUPAMAIL_MODE must be one of: worker, api, combined"
    );
  });
});
