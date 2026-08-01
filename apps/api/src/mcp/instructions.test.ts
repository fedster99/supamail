import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { readThreadDefinition } from "./tools/read-thread.js";

describe("MCP agent guidance", () => {
  it("describes the public tool surface without prescribing a workflow", () => {
    expect(MCP_INSTRUCTIONS).toContain("read-only access to synced email");
    expect(MCP_INSTRUCTIONS).toContain("search_email, read_message, read_thread, list_folders, and draft_reply");
    expect(MCP_INSTRUCTIONS).toContain("grouped by conversation by default");
    expect(MCP_INSTRUCTIONS).toContain("1 to 10 message_ids");
    expect(MCP_INSTRUCTIONS).toContain("25 results by default and at most 100");
    expect(MCP_INSTRUCTIONS).toContain("account-scoped conversation_id or provider thread_id");
    expect(MCP_INSTRUCTIONS).toContain("at most 20 messages by default and 100 when requested");
    expect(MCP_INSTRUCTIONS).toContain("Duplicate message_ids are collapsed");
    expect(MCP_INSTRUCTIONS).toContain("cannot send, save drafts, move, delete, flag, or otherwise change mail");
    expect(MCP_INSTRUCTIONS).toContain("Read results include sync_trust");
    expect(MCP_INSTRUCTIONS).not.toContain("Use the fewest");
    expect(MCP_INSTRUCTIONS).not.toContain("Start with");
    expect(MCP_INSTRUCTIONS).not.toContain("Do not read every");

    expect(readThreadDefinition.description).not.toContain("broader investigation");
    expect(readThreadDefinition.description).not.toContain("instead of issuing separate");
    expect(readThreadDefinition.description).toContain("4,096 characters");
    const properties = readThreadDefinition.inputSchema.properties as Record<string, unknown>;
    expect(properties.message_ids).toMatchObject({
      minItems: 1,
      maxItems: 10
    });
    const selectors = readThreadDefinition.inputSchema.oneOf as Array<Record<string, unknown>>;
    expect(selectors).toHaveLength(4);
    expect(selectors.every((selector) => Object.hasOwn(selector, "not"))).toBe(true);
  });
});
