import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../mcp/index.js";

/**
 * The agent-email surface is READ-ONLY and ZERO-SEND by construction (ADR
 * 0014/0016). This test is the enforcement: it reads the registry the server
 * actually runs (`TOOLS`) plus the literal source of every `src/mcp/` file, and
 * fails if anything could send, append, move, delete, or flag mail. The static
 * scan catches an accidental future import (imapflow/nodemailer/smtp) or write
 * call (append/store/expunge/sendMail/…) before it can ship.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = resolve(HERE, "../mcp");

/** Recursively collect every .ts source file under src/mcp/. */
async function collectMcpSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMcpSources(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

// Forbidden send/IMAP-write transports — never imported by the agent surface.
const FORBIDDEN_IMPORT = /from\s+["']imapflow["']|imap-client|nodemailer|smtp/i;

// Forbidden mutation/send call sites. Substring (not regex) so a paren or dot is
// matched literally; covers imapflow writes + SMTP send.
const FORBIDDEN_CALLS = [
  "append(",
  "messageMove",
  "messageCopy",
  "messageDelete",
  "messageFlagsAdd",
  "messageFlagsSet",
  "messageFlagsRemove",
  "mailboxCreate",
  "mailboxDelete",
  "mailboxRename",
  ".store(",
  "expunge",
  "setFlags",
  "sendMail",
  "transport.send"
];

const READ_TOOLS = new Set(["search_email", "read_message", "read_thread", "list_folders"]);
const EXPECTED_TOOL_NAMES = ["search_email", "read_message", "read_thread", "list_folders", "draft_reply"];

// A tool name must never advertise a send/mutate capability.
const FORBIDDEN_NAME = /send|submit|^reply_send|move|delete|flag|append|trash|archive_to_server/i;

describe("agent-email surface is zero-send", () => {
  it("(A) no src/mcp source imports a sender/IMAP-write transport or calls a write/send method", async () => {
    const files = await collectMcpSources(MCP_DIR);
    // Sanity: we actually found the surface (server + shared + index + tools).
    expect(files.length).toBeGreaterThanOrEqual(7);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(FORBIDDEN_IMPORT.test(source), `${file} imports a forbidden sender/IMAP-write transport`).toBe(false);
      for (const call of FORBIDDEN_CALLS) {
        expect(source.includes(call), `${file} contains forbidden mutation/send call "${call}"`).toBe(false);
      }
    }
  });

  it("(B) every tool is non-destructive; reads are read-only/closed-world; draft_reply is a non-read, non-destructive, idempotent producer", () => {
    for (const entry of TOOLS) {
      const { name, annotations } = entry.definition;
      expect(annotations.destructiveHint, `${name} must be destructiveHint:false`).toBe(false);

      if (READ_TOOLS.has(name)) {
        expect(annotations.readOnlyHint, `${name} must be readOnlyHint:true`).toBe(true);
        expect(annotations.openWorldHint, `${name} must be openWorldHint:false`).toBe(false);
      }
    }

    const draft = TOOLS.find((t) => t.definition.name === "draft_reply");
    expect(draft, "draft_reply must be registered").toBeDefined();
    expect(draft?.definition.annotations.readOnlyHint).toBe(false);
    expect(draft?.definition.annotations.destructiveHint).toBe(false);
    expect(draft?.definition.annotations.idempotentHint).toBe(true);
  });

  it("(C) exactly the five expected tools are registered and no name advertises a send/mutate capability", () => {
    const names = TOOLS.map((t) => t.definition.name);
    expect([...names].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());

    for (const name of names) {
      expect(FORBIDDEN_NAME.test(name), `tool name "${name}" advertises a send/mutate capability`).toBe(false);
    }
  });

  it("(D) no tool's inputSchema exposes a delivery/send key, and draft_reply's keys are a known subset", () => {
    const SEND_KEY = /^(send|deliver|smtp|transmit|sendmail)/i;
    for (const entry of TOOLS) {
      const properties = (entry.definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const key of Object.keys(properties)) {
        expect(SEND_KEY.test(key), `${entry.definition.name} exposes a delivery/send input key "${key}"`).toBe(false);
      }
    }

    const draft = TOOLS.find((t) => t.definition.name === "draft_reply");
    expect(draft, "draft_reply must be registered").toBeDefined();
    const draftKeys = Object.keys((draft?.definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    const allowed = new Set(["source_message_id", "body", "reply_all"]);
    for (const key of draftKeys) {
      expect(allowed.has(key), `draft_reply exposes an unexpected input key "${key}"`).toBe(true);
    }
  });
});
