import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveDraftsFolder } from "../drafts.js";
import { genericImapProfile } from "../provider-profiles.js";

/**
 * Unit coverage for the draft CRUD primitives (email-003, ADR 0019). This task is
 * mostly COMPOSITION, so the tests assert the composition wiring:
 *   - create  → buildRawMime + APPEND `\Draft` to the resolved Drafts folder
 *   - update  → APPEND-new + delete-old (the email-002 hard delete)
 *   - send    → email-001 sendMessage, THEN delete the draft
 *   - delete  → reuses the email-002 capability-gated delete
 *   - list/get → read the MIRROR (the repository + pool), never an IMAP round-trip
 * The IMAP appender, the send primitive, and the delete mutation are all mocked,
 * so nothing connects, sends, or mutates a real server.
 */

describe("resolveDraftsFolder", () => {
  it("prefers the \\Drafts special-use mailbox", () => {
    const boxes = [
      { path: "INBOX", specialUse: null },
      { path: "Brouillons", specialUse: "\\Drafts" }
    ];
    expect(resolveDraftsFolder(boxes, genericImapProfile)).toBe("Brouillons");
  });

  it("falls back to a folder literally named Drafts, then the conventional Drafts", () => {
    expect(resolveDraftsFolder([{ path: "INBOX.Drafts", specialUse: null }], genericImapProfile)).toBe("INBOX.Drafts");
    expect(resolveDraftsFolder([{ path: "INBOX", specialUse: null }], genericImapProfile)).toBe("Drafts");
  });
});

// --- Mocked appender, send primitive, delete mutation, and repository. ---

const mocks = vi.hoisted(() => ({
  append: vi.fn(async (_path: string, _raw: Buffer, _flags: string[], _date?: Date) => ({ uid: 7 as number | null })),
  list: vi.fn(async () => [{ path: "Drafts", specialUse: "\\Drafts" }]),
  logout: vi.fn(async () => undefined),
  close: vi.fn(),
  connect: vi.fn(),
  sendMessage: vi.fn(async (_pool: unknown, _config: unknown, _req: unknown) => ({
    rfcMessageId: "<sent@example.test>",
    delivered: true,
    appendedToSent: true,
    appendedUid: 1,
    sentFolderPath: "Sent",
    warnings: [] as string[]
  })),
  deleteMessage: vi.fn(async (_pool: unknown, _config: unknown, id: string, opts: { hard?: boolean }) => ({
    messageId: id,
    fromFolder: "Drafts",
    mode: opts.hard ? "expunge" : "trash",
    trashFolder: opts.hard ? null : "Trash"
  })),
  getAccount: vi.fn(),
  getMessage: vi.fn(),
  poolConnect: vi.fn()
}));

vi.mock("../smtp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../smtp-client.js")>();
  return {
    ...actual,
    SentFolderAppender: {
      connect: vi.fn(async () => ({
        list: mocks.list,
        append: mocks.append,
        logout: mocks.logout,
        close: mocks.close
      }))
    }
  };
});

vi.mock("../send.js", () => ({ sendMessage: mocks.sendMessage }));
vi.mock("../mailbox-mutations.js", () => ({ deleteMessage: mocks.deleteMessage }));

vi.mock("../repository.js", () => ({
  MirrorRepository: class {
    getAccount = mocks.getAccount;
    getMessage = mocks.getMessage;
  }
}));

const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

const account = {
  id: "acc-1",
  email_address: "user@example.test",
  provider_profile: "generic-imap",
  host: "imap.example.test",
  port: 993,
  secure: true,
  username: "user@example.test",
  encrypted_password: Buffer.from("x")
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.append.mockResolvedValue({ uid: 7 });
  mocks.list.mockResolvedValue([{ path: "Drafts", specialUse: "\\Drafts" }]);
  mocks.getAccount.mockResolvedValue(account);
  mocks.sendMessage.mockResolvedValue({
    rfcMessageId: "<sent@example.test>",
    delivered: true,
    appendedToSent: true,
    appendedUid: 1,
    sentFolderPath: "Sent",
    warnings: []
  });
  mocks.deleteMessage.mockImplementation(async (_pool, _config, id: string, opts: { hard?: boolean }) => ({
    messageId: id, fromFolder: "Drafts", mode: opts.hard ? "expunge" : "trash", trashFolder: opts.hard ? null : "Trash"
  }));
});

describe("createDraft", () => {
  it("APPENDs the composed bytes with \\Draft to the resolved Drafts folder", async () => {
    const { createDraft } = await import("../drafts.js");
    const result = await createDraft({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "My draft",
      body: { format: "plain", text: "Hello" }
    });

    expect(mocks.append).toHaveBeenCalledTimes(1);
    const [path, raw, flags] = mocks.append.mock.calls[0];
    expect(path).toBe("Drafts");
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(flags).toContain("\\Draft");
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ accountId: "acc-1", draftsFolderPath: "Drafts", appendedUid: 7 });
    expect(result.rfcMessageId).toMatch(/^<.+>$/);
    // Create does NOT send or delete — it only files the draft.
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
  });

  it("throws for an unknown account before connecting", async () => {
    mocks.getAccount.mockResolvedValueOnce(null);
    const { createDraft } = await import("../drafts.js");
    await expect(
      createDraft({} as never, config, {
        accountId: "missing",
        to: [{ email: "x@example.test" }],
        subject: "s",
        body: { format: "plain", text: "b" }
      })
    ).rejects.toThrow(/Account not found/);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("rejects a Bcc smuggled past the type system before connecting (Bcc can't round-trip a draft)", async () => {
    const { createDraft } = await import("../drafts.js");
    await expect(
      // A Bcc on a saved draft is dropped end-to-end (nodemailer's keepBcc default
      // omits it from the APPENDed bytes), so it must be refused, not accepted.
      createDraft({} as never, config, {
        accountId: "acc-1",
        to: [{ email: "rcpt@example.test" }],
        bcc: [{ email: "secret@example.test" }],
        subject: "My draft",
        body: { format: "plain", text: "Hello" }
      } as never)
    ).rejects.toThrow("Bcc is not supported on saved drafts — set Bcc when you send the draft");
    // Refused before any account lookup or IMAP connect.
    expect(mocks.getAccount).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });
});

describe("updateDraft", () => {
  it("APPENDs a new draft then hard-deletes the old one (IMAP drafts are immutable)", async () => {
    mocks.getMessage.mockResolvedValue({ id: "draft-1", account_id: "acc-1", deleted_in_provider: false });
    const { updateDraft } = await import("../drafts.js");
    const result = await updateDraft({} as never, config, "draft-1", {
      to: [{ email: "rcpt@example.test" }],
      subject: "Revised",
      body: { format: "plain", text: "v2" }
    });

    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMessage).toHaveBeenCalledTimes(1);
    // Old draft removed by a hard delete (reuses email-002), not trashed.
    expect(mocks.deleteMessage).toHaveBeenCalledWith({}, config, "draft-1", { hard: true });
    expect(result).toMatchObject({ replacedMessageId: "draft-1", draftsFolderPath: "Drafts" });
  });

  it("throws for an unknown draft without appending or deleting", async () => {
    mocks.getMessage.mockResolvedValue(null);
    const { updateDraft } = await import("../drafts.js");
    await expect(
      updateDraft({} as never, config, "missing", { to: [], subject: "s", body: { format: "plain", text: "b" } })
    ).rejects.toThrow(/Draft not found/);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
  });
});

describe("sendDraft", () => {
  // sendDraft loads the draft via getDraft, which reads the pool directly.
  function mockPoolReturningDraft(row: Record<string, unknown> | null) {
    const client = {
      query: vi.fn()
        // 1st query: the draft row (LEFT JOIN body)
        .mockResolvedValueOnce({ rows: row ? [row] : [] })
        // 2nd query (only if a row): draftFolderPaths
        .mockResolvedValueOnce({ rows: [{ path: "Drafts" }] }),
      release: vi.fn()
    };
    return { connect: vi.fn(async () => client) } as never;
  }

  const draftRow = {
    id: "draft-1",
    account_id: "acc-1",
    folder_path: "Drafts",
    uid: "7",
    rfc_message_id: "<draft@example.test>",
    subject: "Hello",
    from_email: "user@example.test",
    to_emails: ["rcpt@example.test"],
    cc_emails: [],
    flags: ["\\Draft"],
    in_reply_to: "<orig@peer.test>",
    references_header: "<orig@peer.test>",
    internal_date: new Date("2026-05-19T00:00:00.000Z"),
    body_text: "Hello there",
    body_html: null,
    body_plain: null,
    selected_text_part: null,
    selected_text_format: "plain"
  };

  it("sends via the email-001 primitive then deletes the draft", async () => {
    const pool = mockPoolReturningDraft(draftRow);
    const { sendDraft } = await import("../drafts.js");
    const result = await sendDraft(pool, config, "draft-1");

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    const sentReq = mocks.sendMessage.mock.calls[0][2];
    expect(sentReq).toMatchObject({
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hello",
      body: { format: "plain", text: "Hello there" },
      inReplyTo: "<orig@peer.test>",
      references: "<orig@peer.test>"
    });
    // Delete happens AFTER the send.
    expect(mocks.deleteMessage).toHaveBeenCalledWith(pool, config, "draft-1", { hard: true });
    const sendOrder = mocks.sendMessage.mock.invocationCallOrder[0];
    const deleteOrder = mocks.deleteMessage.mock.invocationCallOrder[0];
    expect(sendOrder).toBeLessThan(deleteOrder);
    expect(result).toMatchObject({ deletedDraftId: "draft-1", send: { delivered: true } });
  });

  it("sends an HTML draft as real HTML (not a lossy htmlToText flattening)", async () => {
    // An HTML-authored/synced draft: selected part is HTML and a stored HTML body
    // carries the real markup. Send must deliver that HTML, not a flattened render.
    const html = '<p>Hi <a href="https://supamail.test">link</a></p>';
    const htmlRow = {
      ...draftRow,
      body_text: "Hi link https://supamail.test", // the lossy fallback that must NOT be sent
      body_html: html,
      selected_text_format: "html" as const
    };
    const pool = mockPoolReturningDraft(htmlRow);
    const { sendDraft } = await import("../drafts.js");
    await sendDraft(pool, config, "draft-1");

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    const sentReq = mocks.sendMessage.mock.calls[0][2] as { body: { format: string; html?: string } };
    expect(sentReq.body.format).toBe("html");
    expect(sentReq.body.html).toBe(html);
    // The flattened plaintext is never substituted for the real HTML.
    expect(sentReq.body).not.toMatchObject({ format: "plain" });
  });

  it("refuses to send a draft with no recipients (and does not delete)", async () => {
    const pool = mockPoolReturningDraft({ ...draftRow, to_emails: [] });
    const { sendDraft } = await import("../drafts.js");
    await expect(sendDraft(pool, config, "draft-1")).rejects.toThrow(/no recipients/);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
  });

  it("throws when the draft is not found", async () => {
    const pool = mockPoolReturningDraft(null);
    const { sendDraft } = await import("../drafts.js");
    await expect(sendDraft(pool, config, "missing")).rejects.toThrow(/Draft not found/);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});

describe("deleteDraft", () => {
  it("reuses the email-002 delete mutation (trash by default, hard on request)", async () => {
    const { deleteDraft } = await import("../drafts.js");

    const trashed = await deleteDraft({} as never, config, "draft-1", {});
    expect(mocks.deleteMessage).toHaveBeenLastCalledWith({}, config, "draft-1", { hard: undefined });
    expect(trashed).toMatchObject({ messageId: "draft-1", fromFolder: "Drafts" });

    await deleteDraft({} as never, config, "draft-1", { hard: true });
    expect(mocks.deleteMessage).toHaveBeenLastCalledWith({}, config, "draft-1", { hard: true });
  });
});

describe("listDrafts / getDraft read the mirror", () => {
  it("listDrafts queries the Drafts folders and \\Draft-flagged rows", async () => {
    const client = {
      query: vi.fn()
        // draftFolderPaths
        .mockResolvedValueOnce({ rows: [{ path: "Drafts" }] })
        // the list query
        .mockResolvedValueOnce({ rows: [{
          id: "d1", account_id: "acc-1", folder_path: "Drafts", uid: "7", rfc_message_id: null,
          subject: "S", from_email: "user@example.test", to_emails: ["x@example.test"], cc_emails: [],
          flags: ["\\Draft"], in_reply_to: null, references_header: null,
          internal_date: new Date("2026-05-19T00:00:00.000Z"), body_text: null, body_plain: null, selected_text_part: null
        }] }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as never;
    const { listDrafts } = await import("../drafts.js");
    const drafts = await listDrafts(pool, config, "acc-1", {});
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ messageId: "d1", folderPath: "Drafts", subject: "S" });
    // No IMAP — only the injected pool was used.
    expect(client.release).toHaveBeenCalled();
  });

  it("getDraft returns null when the row is not a draft (not a Drafts folder, not \\Draft-flagged)", async () => {
    const client = {
      query: vi.fn()
        // the draft row in a non-Drafts folder, no \Draft flag
        .mockResolvedValueOnce({ rows: [{
          id: "m1", account_id: "acc-1", folder_path: "INBOX", uid: "9", rfc_message_id: null,
          subject: "S", from_email: "user@example.test", to_emails: [], cc_emails: [], flags: [],
          in_reply_to: null, references_header: null,
          internal_date: new Date("2026-05-19T00:00:00.000Z"), body_text: "b", body_plain: null, selected_text_part: null
        }] })
        // draftFolderPaths
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as never;
    const { getDraft } = await import("../drafts.js");
    const draft = await getDraft(pool, config, "m1");
    expect(draft).toBeNull();
  });
});
