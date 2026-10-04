import { describe, expect, it } from "vitest";
import { runSearchTool } from "../search/mcp-tool.js";

const untouchedPool = {
  connect: () => { throw new Error("must not connect"); },
  query: () => { throw new Error("must not query"); }
} as never;

describe("runSearchTool", () => {
  it("returns invalid_input for arguments that fail the schema, before any query", async () => {
    const result = await runSearchTool(untouchedPool, { q: "x", limit: 500 });
    expect(result).toMatchObject({ error: { code: "invalid_input" } });
    expect("error" in result && result.error.message).toMatch(/^Invalid search arguments\. limit: /);
  });
});
