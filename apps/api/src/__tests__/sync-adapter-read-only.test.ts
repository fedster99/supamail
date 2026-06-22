import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ThrottledImapClient } from "../imap-client.js";

/**
 * The sync read adapter (imap-client.ts) must stay READ-ONLY (ADR 0017). The send
 * path now imports IMAP write verbs (APPEND) into the codebase via the separate
 * SentFolderAppender (smtp-client.ts), so this test pins the invariant that the
 * adapter the sync engine uses can never silently grow a write verb. APPEND lives
 * ONLY on SentFolderAppender; the sync path can never write, the send path can
 * never read-sync.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const IMAP_CLIENT_PATH = resolve(HERE, "../imap-client.ts");

// IMAP write verbs that must never appear on the sync adapter.
const WRITE_VERBS = [
  "append",
  "store",
  "expunge",
  "setFlags",
  "messageMove",
  "messageCopy",
  "messageDelete",
  "messageFlagsAdd",
  "messageFlagsSet",
  "messageFlagsRemove",
  "mailboxCreate",
  "mailboxDelete",
  "mailboxRename"
];

function ownAndProtoMethodNames(instance: object): Set<string> {
  const names = new Set<string>();
  let proto: object | null = instance;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

describe("sync IMAP adapter is read-only", () => {
  it("ThrottledImapClient exposes no IMAP write verbs", () => {
    // Build a bare instance via the prototype so we can enumerate its methods
    // without a live connection.
    const methods = ownAndProtoMethodNames(ThrottledImapClient.prototype);
    for (const verb of WRITE_VERBS) {
      expect(methods.has(verb), `ThrottledImapClient must not expose "${verb}"`).toBe(false);
    }
  });

  it("the imap-client source never references a write verb (MirrorImapClient interface stays read-only)", async () => {
    const source = await readFile(IMAP_CLIENT_PATH, "utf8");
    for (const verb of WRITE_VERBS) {
      // Word-boundary match so "store" doesn't trip on unrelated identifiers.
      const pattern = new RegExp(`\\b${verb}\\s*\\(`);
      expect(pattern.test(source), `imap-client.ts must not call a write verb "${verb}("`).toBe(false);
    }
  });
});
