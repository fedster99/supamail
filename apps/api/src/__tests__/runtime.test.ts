import { describe, expect, it, vi } from "vitest";
import { createServerCloser, parseRuntimeMode } from "../runtime.js";

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

  it("routes combined-mode fatal errors and startup-time signals through API shutdown", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const source = await readFile(resolve(process.cwd(), "src/runtime.ts"), "utf8");

    expect(source).toContain(
      "installProcessHandlers: true, onStop: closeApi"
    );
    expect(source).not.toContain('process.on("SIGTERM", shutdown)');
    expect(source).not.toContain('process.on("SIGINT", shutdown)');
  });

  it("closes the API server once and keeps normal already-closed shutdowns out of error logs", () => {
    const error = Object.assign(new Error("Server is not running."), {
      code: "ERR_SERVER_NOT_RUNNING"
    });
    const server = {
      close: vi.fn((callback?: (error?: Error) => void) => callback?.(error))
    };
    const sink = { error: vi.fn() };
    const closeOnce = createServerCloser(server, sink);

    closeOnce();
    closeOnce();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(sink.error).not.toHaveBeenCalled();
  });

  it("still reports genuine API close failures", () => {
    const error = Object.assign(new Error("socket teardown failed"), { code: "EIO" });
    const server = {
      close: (callback?: (error?: Error) => void) => callback?.(error)
    };
    const sink = { error: vi.fn() };

    createServerCloser(server, sink)();

    expect(sink.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.error.mock.calls[0][0])).toMatchObject({
      event: "api.close.failed",
      error: { message: "socket teardown failed", code: "EIO" }
    });
  });
});
