#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { closePool, getPool } from "../db.js";
import { TOOLS } from "./index.js";
import { toolError } from "./shared.js";

/**
 * The local stdio MCP server for agent email access (ADR 0014). It is the
 * read-only surface over the Postgres mirror: orient → search → read → draft.
 * Every tool is read-only except draft_reply, which only *produces* a reply and
 * never sends, appends, or mutates (ADR 0016). Transport-pluggable: deployments wrap
 * the same TOOLS registry behind authed remote transport without reimplementing.
 */

const SERVER_NAME = "supamail-mcp";

const INSTRUCTIONS = `SupaMail agent email — a READ-ONLY window onto your mirrored mailbox in Postgres, plus a reply *drafter*. Five tools, no sending.

The loop: orient → search → read → draft.
1. ORIENT with list_folders to see folders + unread/flagged/total counts for an account.
2. SEARCH with search_email (the canonical ranked search) to find messages. Each hit carries an identity.id.
3. READ with read_message (one message) or read_thread (the whole conversation), passing a hit's identity.id as message_id.
4. DRAFT with draft_reply to produce a ready-to-send reply. It NEVER sends — you (or your client) send it.

ID model: a search hit's identity.id IS the message_id. Pass it verbatim to read_message {message_id} or read_thread {message_id} (the thread is seeded from that message). read_message returns thread_id = the conversation handle.

Recipes:
- Latest email from someone: search_email {q:"from:alice@example.com sort:recent", limit:1}.
- Unread today: search_email {q:"is:unread newer_than:1d", sort:"recent"}.
- Triage the inbox: search_email {q:"is:unread", sort:"recent"} — then read_message the ones that matter.

Non-goals (do not attempt): NO sending or appending mail; NO attachment bytes or content extraction (only attachment metadata is mirrored); NO labels, flags, moves, deletes, or any mutation.

Every read tool attaches a sync_trust block. It reports how complete the mirror is for the searched accounts (initial sync still running, history backfilling, bodies missing, account degraded). If sync_trust says results may be incomplete, say so — do not present a partial mirror as the whole mailbox.

Errors come back as { error: { code, message, hint } }; the hint tells you what to do next. Empty results are NOT errors.`;

async function readVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(resolve(here, "../../package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function createServer(): Promise<Server> {
  const version = await readVersion();
  const server = new Server(
    { name: SERVER_NAME, version },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: INSTRUCTIONS
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => t.definition)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = TOOLS.find((t) => t.definition.name === name);
    if (!entry) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              toolError("unknown_tool", `No tool named "${name}".`, `Call tools/list; valid tools: ${TOOLS.map((t) => t.definition.name).join(", ")}.`)
            )
          }
        ],
        isError: true
      };
    }
    try {
      const payload = await entry.handler(getPool(), args ?? {});
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(toolError("tool_failed", message, "Check the arguments against the tool's inputSchema and retry."))
          }
        ],
        isError: true
      };
    }
  });

  return server;
}

async function main(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
}

// Self-invoke guard: run main() only when executed directly (stdio entrypoint),
// not when imported (e.g. by the safety test that inspects TOOLS).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    void closePool().finally(() => process.exit(1));
  });
}
