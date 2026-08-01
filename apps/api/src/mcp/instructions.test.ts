import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { readThreadDefinition } from "./tools/read-thread.js";

describe("MCP agent guidance", () => {
  it("gives agents a simple, accurate investigation workflow", () => {
    expect(MCP_INSTRUCTIONS).toContain("fewest calls that preserve accuracy");
    expect(MCP_INSTRUCTIONS).toContain("grouped by conversation by default");
    expect(MCP_INSTRUCTIONS).toContain("up to 10 selected result IDs");
    expect(MCP_INSTRUCTIONS).toContain("Do not read every result unless the task requires exhaustive coverage");
    expect(MCP_INSTRUCTIONS).toContain("cannot send or change mail");
    expect(MCP_INSTRUCTIONS).toContain("When a result includes sync_trust, treat it as part of the answer");

    expect(readThreadDefinition.description).toContain("broader investigation");
    const properties = readThreadDefinition.inputSchema.properties as Record<string, unknown>;
    expect(properties.message_ids).toMatchObject({
      minItems: 1,
      maxItems: 10
    });
  });
});
