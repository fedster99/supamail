export * from "./types.js";
export { parseQuery, parseTextTerms, filtersFromStructured, tokenize, isRelativeDate } from "./parse.js";
export { compileSearch } from "./compile.js";
export type { CompileOptions, CompiledQuery } from "./compile.js";
export { buildSyncTrust } from "./sync-trust.js";
export { searchMessages } from "./search.js";
export { searchRequestSchema, searchEmailToolDefinition, runSearchTool } from "./mcp-tool.js";
