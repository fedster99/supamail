import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { readMessageDefinition, readMessageRequestSchema } from "./tools/read-message.js";
import { readThreadDefinition } from "./tools/read-thread.js";

describe("MCP agent guidance", () => {
  it("describes the public tool surface without prescribing a workflow", () => {
    const messageId = "00000000-0000-4000-8000-000000000001";
    expect(MCP_INSTRUCTIONS).toContain("read-only access to synced email");
    expect(MCP_INSTRUCTIONS).toContain("search_email, read_message, read_thread, list_folders, and draft_reply");
    expect(MCP_INSTRUCTIONS).toContain("grouped by conversation by default");
    expect(MCP_INSTRUCTIONS).toContain("1 to 10 message_ids");
    expect(MCP_INSTRUCTIONS).toContain("25 results by default and at most 100");
    expect(MCP_INSTRUCTIONS).toContain("account-scoped conversation_id or provider thread_id");
    expect(MCP_INSTRUCTIONS).toContain("Each thread returns at most 20 messages by default and 100 when requested");
    expect(MCP_INSTRUCTIONS).toContain("Duplicate message_ids are collapsed");
    expect(MCP_INSTRUCTIONS).toContain("each distinct ID has its own result or error entry");
    expect(MCP_INSTRUCTIONS).toContain("full available cleaned body for each message");
    expect(MCP_INSTRUCTIONS).toContain("specific range of up to 131,072 characters");
    expect(MCP_INSTRUCTIONS).toContain("body_total_chars and body_next_offset");
    expect(MCP_INSTRUCTIONS).toContain("Replies contain newly authored text by default");
    expect(MCP_INSTRUCTIONS).toContain("oldest mirrored message keeps quoted content");
    expect(MCP_INSTRUCTIONS).toContain("batch thread errors use the same fields in the affected thread entry");
    expect(MCP_INSTRUCTIONS).toContain("cannot send, save drafts, move, delete, flag, or otherwise change mail");
    expect(MCP_INSTRUCTIONS).toContain("Read results include sync_trust");
    expect(MCP_INSTRUCTIONS).not.toContain("Use the fewest");
    expect(MCP_INSTRUCTIONS).not.toContain("Start with");
    expect(MCP_INSTRUCTIONS).not.toContain("Do not read every");

    expect(readThreadDefinition.description).not.toContain("broader investigation");
    expect(readThreadDefinition.description).not.toContain("instead of issuing separate");
    expect(readThreadDefinition.description).toContain("full cleaned body");
    const properties = readThreadDefinition.inputSchema.properties as Record<string, unknown>;
    expect(properties.message_ids).toMatchObject({
      minItems: 1,
      maxItems: 10,
      items: { type: "string", format: "uuid", minLength: 36, maxLength: 36 }
    });
    expect(properties.message_id).toMatchObject({
      type: "string",
      format: "uuid",
      minLength: 36,
      maxLength: 36
    });
    const selectors = readThreadDefinition.inputSchema.oneOf as Array<Record<string, unknown>>;
    expect(selectors).toHaveLength(4);
    expect(selectors.every((selector) => Object.hasOwn(selector, "not"))).toBe(true);

    const readMessageProperties = readMessageDefinition.inputSchema.properties as Record<string, unknown>;
    expect(readMessageProperties.message_id).toMatchObject({
      type: "string",
      format: "uuid",
      minLength: 36,
      maxLength: 36
    });
    expect(readMessageProperties.body_offset).toMatchObject({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      default: 0
    });
    expect(readMessageProperties.max_body_chars).toMatchObject({
      minimum: 1,
      maximum: 131072
    });
    expect(readMessageRequestSchema.safeParse({
      message_id: messageId,
      body_offset: 131072,
      max_body_chars: 131072
    }).success).toBe(true);
    expect(readMessageRequestSchema.safeParse({
      message_id: messageId,
      max_body_chars: 131073
    }).success).toBe(false);
    for (const range of [
      { body_offset: -1 },
      { body_offset: 1.5 },
      { max_body_chars: 0 },
      { max_body_chars: 1.5 }
    ]) {
      expect(readMessageRequestSchema.safeParse({
        message_id: messageId,
        ...range
      }).success).toBe(false);
    }
    expect(readMessageRequestSchema.safeParse({
      message_id: messageId,
      body_offset: 0,
      max_body_chars: 1
    }).success).toBe(true);
    expect(readMessageRequestSchema.safeParse({
      message_id: messageId,
      body_offset: Number.MAX_SAFE_INTEGER + 1
    }).success).toBe(false);

    expect((properties.include_quoted as { description: string }).description)
      .toContain("oldest mirrored message keeps quoted content");
    expect(readMessageRequestSchema.safeParse({ message_id: "not-a-uuid" }).success).toBe(false);
  });
});
