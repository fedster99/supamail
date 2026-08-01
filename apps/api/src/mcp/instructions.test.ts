import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { readThreadDefinition } from "./tools/read-thread.js";

describe("MCP investigation guidance", () => {
  it("tells agents to batch selected grouped-search threads during a broader investigation", () => {
    expect(MCP_INSTRUCTIONS).toContain("broader investigation");
    expect(MCP_INSTRUCTIONS).toContain("message_ids");
    expect(MCP_INSTRUCTIONS).toContain("grouped search results");
    expect(MCP_INSTRUCTIONS).toContain("instead of issuing separate read_thread calls");

    expect(readThreadDefinition.description).toContain("broader investigation");
    const properties = readThreadDefinition.inputSchema.properties as Record<string, unknown>;
    expect(properties.message_ids).toMatchObject({
      minItems: 1,
      maxItems: 10
    });
  });
});
