import { describe, expect, it } from "vitest";
import { getAttachmentMetadata, getMessageHeaders, getRawMime, listAttachments, cleanMessageBody } from "../content.js";
import { getDraft } from "../drafts.js";
import { moveThread, setThreadFlags } from "../mailbox-mutations.js";
import { isMirrorId } from "../mirror-id.js";
import { MirrorRepository } from "../repository.js";
import { runSearchTool } from "../search/mcp-tool.js";

/**
 * A malformed id names no mirror row. Each lookup answers "not found" before any
 * query, instead of a Postgres UUID cast error (22P02) that becomes a server error.
 */
const untouchedPool = {
  connect: () => { throw new Error("must not connect"); },
  query: () => { throw new Error("must not query"); }
} as never;
const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;
const MALFORMED = ["not-a-uuid", "<draft@example.test>", "42", ""];

describe("isMirrorId", () => {
  it("accepts only a UUID string", () => {
    expect(isMirrorId("11111111-1111-4111-8111-111111111111")).toBe(true);
    for (const value of [...MALFORMED, ["11111111-1111-4111-8111-111111111111"], null, undefined, 42]) {
      expect(isMirrorId(value)).toBe(false);
    }
  });
});

describe("lookups by a malformed id", () => {
  it("answer not found without touching the database", async () => {
    const repository = new MirrorRepository(untouchedPool, config);
    for (const id of MALFORMED) {
      expect(await repository.getMessage(id)).toBeNull();
      expect(await repository.getAccount(id)).toBeNull();
      expect(await getDraft(untouchedPool, config, id)).toBeNull();
      expect(await listAttachments(untouchedPool, config, id)).toEqual([]);
      expect(await getAttachmentMetadata(untouchedPool, config, id)).toBeNull();
      for (const read of [
        () => getRawMime(untouchedPool, config, id),
        () => getMessageHeaders(untouchedPool, config, id),
        () => cleanMessageBody(untouchedPool, config, id),
        () => moveThread(untouchedPool, config, id, "Archive"),
        () => setThreadFlags(untouchedPool, config, id, { add: ["seen"] })
      ]) {
        await expect(read()).rejects.toMatchObject({ name: "NotFoundError" });
      }
    }
  });
});

describe("runSearchTool", () => {
  it("returns invalid_input for arguments that fail the schema, before any query", async () => {
    const result = await runSearchTool(untouchedPool, { q: "x", limit: 500 });
    expect(result).toMatchObject({ error: { code: "invalid_input" } });
    expect("error" in result && result.error.message).toMatch(/^Invalid search arguments\. limit: /);
  });
});
