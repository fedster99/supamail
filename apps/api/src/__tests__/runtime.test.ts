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

  it("runs the advisory-lock self-test before the API serves (api + combined)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const source = await readFile(resolve(process.cwd(), "src/runtime.ts"), "utf8");

    // The API takes the per-account advisory lock (body fetch, draft APPEND, mutations),
    // so a mispooled standalone API must fail fast at startup like the worker instead of
    // silently breaking the lock mutex. Guard that the self-test precedes serving.
    expect(source).toContain("runLockSelfTestWithRetry");
    // api mode: self-test (getPool()) precedes the bare startApiServer().
    const apiSelfTest = source.indexOf("await runApiLockSelfTest(getPool())");
    const apiServe = source.indexOf("startApiServer();");
    expect(apiSelfTest).toBeGreaterThan(-1);
    expect(apiServe).toBeGreaterThan(apiSelfTest);
    // combined mode (the production API+worker topology): self-test (pool) precedes
    // startApiServer({ ... }). Distinct anchors so deleting the combined gate fails.
    const combinedSelfTest = source.indexOf("await runApiLockSelfTest(pool)");
    const combinedServe = source.indexOf("startApiServer({");
    expect(combinedSelfTest).toBeGreaterThan(-1);
    expect(combinedServe).toBeGreaterThan(combinedSelfTest);
  });
});
