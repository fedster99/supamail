import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioral coverage for the CLI verbs (email-001/002/003/004). cli.ts is a
 * top-level script: importing it runs commander against `process.argv` and then
 * closes the pool. We mock EVERY lib it dispatches to (plus config/db/repository/
 * engine and node:fs) so importing the module drives the command in-process with
 * no IMAP/SMTP/DB. Each case sets argv, re-imports the module (vi.resetModules),
 * and asserts the dispatch (or the refusal).
 *
 * Load-bearing assertions:
 *  - the human-in-the-loop `--confirm` gate is REQUIRED before send/reply/
 *    draft-send/delete dispatch (a missing-confirm-sends-anyway bug would be caught);
 *  - --attach file flags map to the base64 SendAttachment shape;
 *  - delete default → trash (hard:false), --hard → expunge (hard:true).
 */

// The lib mocks accept (...args: unknown[]) so `.mock.calls[0][N]` (the positional
// pool/config/id/options the CLI passes) is indexable in the assertions.
type AnyAsync = (...args: unknown[]) => Promise<unknown>;
const libs = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._a: unknown[]) => ({ delivered: true, warnings: [] })) as AnyAsync & ReturnType<typeof vi.fn>,
  createDraft: vi.fn(async (..._a: unknown[]) => ({ accountId: "acc-1", draftsFolderPath: "Drafts", rfcMessageId: "<d@x>", appendedUid: 1 })),
  sendDraft: vi.fn(async (..._a: unknown[]) => ({ send: { delivered: true }, deletedDraftId: "d1", draftDeleted: true, warnings: [] })),
  deleteDraft: vi.fn(async (..._a: unknown[]) => ({ messageId: "d1", fromFolder: "Drafts" })),
  getDraft: vi.fn(async (..._a: unknown[]) => ({ messageId: "d1" })),
  listDrafts: vi.fn(async (..._a: unknown[]) => []),
  updateDraft: vi.fn(async (..._a: unknown[]) => ({ replacedMessageId: "d1" })),
  deleteMessage: vi.fn(async (..._a: unknown[]) => ({ messageId: "m1", fromFolder: "INBOX", mode: "trash", trashFolder: "Trash" })),
  setMessageFlags: vi.fn(async (..._a: unknown[]) => ({ messageId: "m1", added: [], removed: [] })),
  moveMessage: vi.fn(async (..._a: unknown[]) => ({ messageId: "m1" })),
  moveThread: vi.fn(async (..._a: unknown[]) => ({ seedMessageId: "m1" })),
  setThreadFlags: vi.fn(async (..._a: unknown[]) => ({ seedMessageId: "m1" })),
  createFolder: vi.fn(async (..._a: unknown[]) => ({ accountId: "acc-1", path: "X" })),
  renameFolder: vi.fn(async (..._a: unknown[]) => ({ accountId: "acc-1", path: "X" })),
  deleteFolder: vi.fn(async (..._a: unknown[]) => ({ accountId: "acc-1", path: "X" })),
  runDraftReply: vi.fn(async (..._a: unknown[]) => ({
    to: [{ email: "peer@example.test" }],
    cc: [],
    subject: "Re: Hi",
    body: { text: "reply body" },
    headers: { "In-Reply-To": "<src@x>", References: "<src@x>" }
  })),
  getMessage: vi.fn(async (..._a: unknown[]) => ({ id: "src-1", account_id: "acc-1" })),
  readFile: vi.fn(async (..._a: unknown[]) => Buffer.from("FILE-CONTENT")),
  writeFile: vi.fn(async (..._a: unknown[]) => undefined),
  closePool: vi.fn(async (..._a: unknown[]) => undefined)
}));

vi.mock("../config.js", () => ({ getConfig: vi.fn(() => ({ IMAP_ENCRYPTION_KEY: "x", IMAP_ALLOW_PRIVATE_HOSTS: false })) }));
vi.mock("../db.js", () => ({
  getPool: vi.fn(() => ({})),
  closePool: libs.closePool,
  applyPublicMigrations: vi.fn(async () => undefined)
}));
vi.mock("../repository.js", () => ({
  MirrorRepository: class {
    getMessage = libs.getMessage;
  }
}));
vi.mock("../sync-engine.js", () => ({ MirrorEngine: class {} }));
vi.mock("../search/index.js", () => ({ searchMessages: vi.fn(async () => ({ results: [] })) }));
vi.mock("../mcp/index.js", () => ({
  runDraftReply: libs.runDraftReply,
  runListFolders: vi.fn(async () => ({})),
  runReadMessage: vi.fn(async () => ({})),
  runReadThread: vi.fn(async () => ({}))
}));
vi.mock("../send.js", () => ({ sendMessage: libs.sendMessage }));
vi.mock("../drafts.js", () => ({
  createDraft: libs.createDraft,
  deleteDraft: libs.deleteDraft,
  getDraft: libs.getDraft,
  listDrafts: libs.listDrafts,
  sendDraft: libs.sendDraft,
  updateDraft: libs.updateDraft
}));
vi.mock("../mailbox-mutations.js", () => ({
  createFolder: libs.createFolder,
  deleteFolder: libs.deleteFolder,
  deleteMessage: libs.deleteMessage,
  moveMessage: libs.moveMessage,
  moveThread: libs.moveThread,
  renameFolder: libs.renameFolder,
  setMessageFlags: libs.setMessageFlags,
  setThreadFlags: libs.setThreadFlags
}));
vi.mock("../content.js", () => ({
  cleanMessageBody: vi.fn(async () => ({})),
  downloadAttachment: vi.fn(async () => ({ content: Buffer.from("x"), attachmentId: "a", filename: "f", contentType: null })),
  getMessageHeaders: vi.fn(async () => ({})),
  getRawMime: vi.fn(async () => ({ raw: Buffer.from("x"), source: "mirror", truncated: false })),
  listAttachments: vi.fn(async () => [])
}));
vi.mock("node:fs/promises", () => ({ readFile: libs.readFile, writeFile: libs.writeFile }));

/** Run the CLI in-process with the given argv (after `node cli.js`). */
async function runCli(...args: string[]): Promise<void> {
  process.argv = ["node", "cli.js", ...args];
  process.exitCode = undefined;
  vi.resetModules();
  await import("../cli.js");
}

let stderr: string;
let stdout: string;
let stderrSpy: { mockRestore: () => void };
let stdoutSpy: { mockRestore: () => void };
let logSpy: { mockRestore: () => void };

/** The positional SendRequest the CLI passes to sendMessage (pool, config, req). */
function sentRequest(): Record<string, any> {
  return libs.sendMessage.mock.calls[0][2] as Record<string, any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  stderr = "";
  stdout = "";
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as never);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  logSpy.mockRestore();
  process.exitCode = undefined;
});

describe("the --confirm send gate", () => {
  it("send REFUSES (no SMTP) without --confirm and exits non-zero", async () => {
    await runCli("send", "--account-id", "acc-1", "--to", "rcpt@example.test", "--subject", "Hi", "--body", "Hello");
    expect(libs.sendMessage).not.toHaveBeenCalled();
    expect(stderr).toMatch(/Refusing to send without --confirm/);
    expect(process.exitCode).toBe(1);
  });

  it("send DISPATCHES once --confirm is present", async () => {
    await runCli("send", "--account-id", "acc-1", "--to", "rcpt@example.test", "--subject", "Hi", "--body", "Hello", "--confirm");
    expect(libs.sendMessage).toHaveBeenCalledTimes(1);
    const req = sentRequest();
    expect(req).toMatchObject({ accountId: "acc-1", subject: "Hi" });
    expect(req.to).toEqual([{ email: "rcpt@example.test" }]);
  });

  it("reply REFUSES without --confirm (never resolves the source or sends)", async () => {
    await runCli("reply", "src-1", "--body", "my reply");
    expect(libs.sendMessage).not.toHaveBeenCalled();
    expect(libs.getMessage).not.toHaveBeenCalled();
    expect(stderr).toMatch(/Refusing to send without --confirm/);
    expect(process.exitCode).toBe(1);
  });

  it("reply DISPATCHES with --confirm (reuses the produce-only draft + threads it)", async () => {
    await runCli("reply", "src-1", "--body", "my reply", "--confirm");
    expect(libs.runDraftReply).toHaveBeenCalledTimes(1);
    expect(libs.sendMessage).toHaveBeenCalledTimes(1);
    const req = sentRequest();
    expect(req).toMatchObject({
      accountId: "acc-1",
      inReplyTo: "<src@x>",
      references: "<src@x>"
    });
  });

  it("draft-send REFUSES without --confirm", async () => {
    await runCli("draft-send", "d1");
    expect(libs.sendDraft).not.toHaveBeenCalled();
    expect(stderr).toMatch(/Refusing to send a draft without --confirm/);
    expect(process.exitCode).toBe(1);
  });

  it("draft-send DISPATCHES with --confirm", async () => {
    await runCli("draft-send", "d1", "--confirm");
    expect(libs.sendDraft).toHaveBeenCalledTimes(1);
    expect(libs.sendDraft.mock.calls[0][2]).toBe("d1");
  });
});

describe("attachment flag → SendAttachment shape", () => {
  it("--attach reads the file and maps it to a base64 SendAttachment", async () => {
    await runCli(
      "send", "--account-id", "acc-1", "--to", "rcpt@example.test",
      "--subject", "Hi", "--body", "Hello", "--attach", "/tmp/report.pdf", "--confirm"
    );
    expect(libs.readFile).toHaveBeenCalledWith("/tmp/report.pdf");
    const req = sentRequest();
    expect(req.attachments).toHaveLength(1);
    expect(req.attachments[0]).toMatchObject({
      filename: "report.pdf",
      // Buffer.from("FILE-CONTENT").toString("base64")
      content: Buffer.from("FILE-CONTENT").toString("base64")
    });
    // A regular --attach is NOT inline.
    expect(req.attachments[0].inline).toBeUndefined();
  });

  it("--inline cid=path maps to an inline SendAttachment with the cid", async () => {
    await runCli(
      "send", "--account-id", "acc-1", "--to", "rcpt@example.test",
      "--subject", "Hi", "--html", "<p><img src=cid:logo></p>",
      "--inline", "logo=/tmp/logo.png", "--body", "ignored", "--confirm"
    );
    const req = sentRequest();
    expect(req.attachments[0]).toMatchObject({ filename: "logo.png", cid: "logo", inline: true });
    expect(req.body).toMatchObject({ format: "html" });
  });
});

describe("delete default (trash) vs --hard (expunge)", () => {
  it("delete WITHOUT --confirm refuses", async () => {
    await runCli("delete", "m1");
    expect(libs.deleteMessage).not.toHaveBeenCalled();
    expect(stderr).toMatch(/Refusing to delete without --confirm/);
    expect(process.exitCode).toBe(1);
  });

  it("delete --confirm (no --hard) maps to a soft trash (hard:false)", async () => {
    await runCli("delete", "m1", "--confirm");
    expect(libs.deleteMessage).toHaveBeenCalledTimes(1);
    expect(libs.deleteMessage.mock.calls[0][3]).toEqual({ hard: false });
  });

  it("delete --confirm --hard maps to an EXPUNGE (hard:true)", async () => {
    await runCli("delete", "m1", "--confirm", "--hard");
    expect(libs.deleteMessage.mock.calls[0][3]).toEqual({ hard: true });
  });

  it("draft-delete default maps to soft trash (hard:false) under --confirm", async () => {
    await runCli("draft-delete", "d1", "--confirm");
    expect(libs.deleteDraft).toHaveBeenCalledTimes(1);
    expect(libs.deleteDraft.mock.calls[0][3]).toEqual({ hard: false });
  });

  it("draft-delete --hard maps to EXPUNGE (hard:true)", async () => {
    await runCli("draft-delete", "d1", "--confirm", "--hard");
    expect(libs.deleteDraft.mock.calls[0][3]).toEqual({ hard: true });
  });
});

describe("non-destructive verbs need no --confirm", () => {
  it("mark-read dispatches setMessageFlags(+\\Seen) with no gate", async () => {
    await runCli("mark-read", "m1");
    expect(libs.setMessageFlags).toHaveBeenCalledTimes(1);
    expect(libs.setMessageFlags.mock.calls[0][3]).toEqual({ add: ["seen"] });
  });

  it("move dispatches moveMessage with no gate", async () => {
    await runCli("move", "m1", "Archive");
    expect(libs.moveMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), "m1", "Archive");
  });
});
