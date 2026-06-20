import { runSearchTool, searchEmailToolDefinition } from "../search/index.js";
import type { ToolDefinition, ToolEntry } from "./shared.js";
import { readMessageEntry, runReadMessage } from "./tools/read-message.js";
import { readThreadEntry, runReadThread } from "./tools/read-thread.js";
import { listFoldersEntry, runListFolders } from "./tools/list-folders.js";
import { draftReplyEntry, runDraftReply } from "./tools/draft-reply.js";

export * from "./shared.js";

// Re-export each tool's run-function so the CLI and any hosted transport can wire
// to the same handlers the registry runs (one source of truth). Tool definitions
// are reachable via TOOLS[i].definition, so they are not re-exported here.
export { runReadMessage, runReadThread, runListFolders, runDraftReply };

/**
 * The single tool registry (ADR 0014: one read-tool contract). The stdio server
 * and the zero-send safety test both import THIS array, so the surface cannot
 * drift between what runs and what is asserted.
 *
 * search_email is the canonical ranked search, kept untouched — we wrap the
 * existing `searchEmailToolDefinition` + `runSearchTool` rather than reimplement.
 * The other four tools (read_message, read_thread, list_folders, draft_reply)
 * plug in from `./tools/*`, each contributing a ready-made `ToolEntry`.
 */
export const TOOLS: ToolEntry[] = [
  {
    definition: searchEmailToolDefinition as unknown as ToolDefinition,
    handler: (pool, args) => runSearchTool(pool, args)
  },
  readMessageEntry,
  readThreadEntry,
  listFoldersEntry,
  draftReplyEntry
];
