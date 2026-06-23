import { describe, expect, it } from "vitest";
import { searchEmailToolDefinition, searchFiltersSchema } from "../search/mcp-tool.js";

/**
 * #40 — single-source guard for the `search_email` structured-filter contract.
 *
 * mcp-tool.ts holds TWO declarations of the filter field set: the Zod
 * `searchFiltersSchema` (the validation source of truth) and the hand-written
 * JSON-Schema `inputSchema.filters.properties` (the agent-facing contract). They are
 * kept in sync only by a comment. This test makes that drift impossible to ship: a
 * field added to one but not the other turns a silent agent-contract bug into a test
 * failure. The advertised JSON-Schema is intentionally left as-is (its per-field
 * descriptions/enums are editorial), so this is a parity guard, not a derivation.
 */

function jsonSchemaFilterKeys(): string[] {
  const inputSchema = searchEmailToolDefinition.inputSchema as {
    properties: {
      filters: { properties: Record<string, unknown> };
    };
  };
  return Object.keys(inputSchema.properties.filters.properties);
}

describe("search_email filter schema parity", () => {
  it("Zod filters shape and JSON-Schema filters.properties advertise the SAME field set", () => {
    const zodKeys = Object.keys(searchFiltersSchema.shape).sort();
    const jsonKeys = jsonSchemaFilterKeys().sort();
    expect(jsonKeys).toEqual(zodKeys);
  });

  it("has no duplicate field declared in the JSON-Schema filters", () => {
    const keys = jsonSchemaFilterKeys();
    expect(keys.length).toBe(new Set(keys).size);
  });
});
