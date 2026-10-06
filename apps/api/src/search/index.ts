export * from "./types.js";
export { parseQuery, parseTextTerms, filtersFromStructured, tokenize } from "./parse.js";
export {
  filenameGlob,
  filetypeMatch,
  hasFolderFilter,
  normalizeMessageId,
  resolveFolder,
  resolveFolderFilters,
  isRelativeDate,
  isValidAbsoluteDate,
  parseAbsoluteDate,
  resolveDate,
  resolveRelativeDate,
  type FiletypeMatch,
  type FolderRef,
  type FolderRow
} from "./rules.js";
export { compileSearch } from "./compile.js";
export type { CompileOptions, CompiledQuery } from "./compile.js";
export { buildSyncTrust } from "./sync-trust.js";
export { searchMessages } from "./search.js";
export { searchRequestSchema, searchEmailToolDefinition, runSearchTool, searchInputError } from "./mcp-tool.js";
export type { SearchInputError } from "./mcp-tool.js";
