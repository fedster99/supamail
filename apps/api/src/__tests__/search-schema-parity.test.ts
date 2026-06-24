import { describe, expect, it } from "vitest";
import { searchEmailToolDefinition, searchFiltersSchema } from "../search/mcp-tool.js";
import { STRUCTURED_FILTER_KEYS } from "../search/filter-fields.js";

/**
 * #40 — single-source guard for the `search_email` structured-filter contract.
 *
 * The filter field set is declared in THREE places that must agree: the
 * declarative `STRUCTURED_FILTER_KEYS` field table (the single source the parser
 * and the structured adapter both consume), the Zod `searchFiltersSchema` (the
 * validation source of truth), and the hand-written JSON-Schema
 * `inputSchema.filters.properties` (the agent-facing contract). The first is the
 * single source of the per-field RULES (kind, normalization, operator aliases);
 * the Zod validators and the JSON-Schema descriptions/enums stay hand-written
 * because they are editorial. This test makes drift impossible to ship: a field
 * added to one but not the others turns a silent agent-contract bug into a test
 * failure. The advertised JSON-Schema is intentionally left byte-identical, so
 * this is a parity guard, not a derivation.
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
  it("the field table, the Zod filters shape, and the JSON-Schema all advertise the SAME field set", () => {
    const tableKeys = [...STRUCTURED_FILTER_KEYS].sort();
    const zodKeys = Object.keys(searchFiltersSchema.shape).sort();
    const jsonKeys = jsonSchemaFilterKeys().sort();
    // All three must agree pairwise. Asserting against the table on both sides
    // makes the field table the single source of the contract's field SET.
    expect(zodKeys).toEqual(tableKeys);
    expect(jsonKeys).toEqual(tableKeys);
  });

  it("the field table has no duplicate structured key", () => {
    expect(STRUCTURED_FILTER_KEYS.length).toBe(new Set(STRUCTURED_FILTER_KEYS).size);
  });

  it("has no duplicate field declared in the JSON-Schema filters", () => {
    const keys = jsonSchemaFilterKeys();
    expect(keys.length).toBe(new Set(keys).size);
  });
});
