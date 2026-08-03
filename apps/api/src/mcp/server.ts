#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { closePool, getPool } from "../db.js";
import { TOOLS } from "./index.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { toolError } from "./shared.js";

/**
 * The local stdio MCP server for agent email access (ADR 0014). It is the
 * read-only surface over the Postgres mirror: orient → search → read → draft.
 * Every tool is read-only except draft_reply, which only *produces* a reply and
 * never sends, appends, or mutates (ADR 0016). Transport-pluggable: deployments wrap
 * the same TOOLS registry behind authed remote transport without reimplementing.
 */

const SERVER_NAME = "supamail-mcp";

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
      instructions: MCP_INSTRUCTIONS
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
