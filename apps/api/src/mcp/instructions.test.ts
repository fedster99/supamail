import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { readThreadDefinition } from "./tools/read-thread.js";

describe("MCP agent guidance", () => {
  it("describes the public tool surface without prescribing a workflow", () => {
    expect(MCP_INSTRUCTIONS).toContain("read-only access to synced email");
    expect(MCP_INSTRUCTIONS).toContain("search_email, read_message, read_thread, list_folders, and draft_reply");
    expect(MCP_INSTRUCTIONS).toContain("grouped by conversation by default");
    expect(MCP_INSTRUCTIONS).toContain("up to 10 message_ids");
    expect(MCP_INSTRUCTIONS).toContain("cannot send, save drafts, move, delete, flag, or otherwise change mail");
    expect(MCP_INSTRUCTIONS).toContain("Read results can include sync_trust");
    expect(MCP_INSTRUCTIONS).not.toContain("Use the fewest");
    expect(MCP_INSTRUCTIONS).not.toContain("Start with");
    expect(MCP_INSTRUCTIONS).not.toContain("Do not read every");

    expect(readThreadDefinition.description).toContain("broader investigation");
    const properties = readThreadDefinition.inputSchema.properties as Record<string, unknown>;
    expect(properties.message_ids).toMatchObject({
      minItems: 1,
      maxItems: 10
    });
  });
});
