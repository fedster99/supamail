import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Unit coverage for the draft CRUD primitives (email-003, ADR 0019). This task is
 * mostly COMPOSITION, so the tests assert the composition wiring:
 *   - create  → buildRawMime + APPEND `\Draft` to the resolved Drafts folder
 *   - update  → APPEND-new + delete-old (the email-002 hard delete)
 *   - send    → RESEND the draft's raw bytes (getRawMime → deliverSmtp → APPEND to
 *               Sent), THEN delete the draft. NOT a rebuild from the mirror body.
 *   - delete  → reuses the email-002 capability-gated delete
 *   - list/get → read the MIRROR (the repository + pool), never an IMAP round-trip
 * The raw fetch, SMTP delivery, the IMAP appender, and the delete mutation are all
 * mocked, so nothing connects, sends, or mutates a real server.
 */

// Drafts-folder resolution (special-use → leaf-name → conventional) is covered by
// special-use-folder.test.ts; the per-module wrapper was inlined at its call site
// (review maintainability finding), so its redundant test was removed here.

// --- Mocked appender, send primitive, delete mutation, and repository. ---

const mocks = vi.hoisted(() => ({
  append: vi.fn(async (_path: string, _raw: Buffer, _flags: string[], _date?: Date) => ({ uid: 7 as number | null })),
  list: vi.fn(async () => [{ path: "Drafts", specialUse: "\\Drafts" }, { path: "Sent", specialUse: "\\Sent" }]),
  logout: vi.fn(async () => undefined),
  close: vi.fn(),
  connect: vi.fn(),
  // sendDraft now RESENDS the draft's raw bytes: getRawMime → deliverSmtp → APPEND
  // to Sent. The raw fetch and the SMTP submit are both mocked.
  getRawMime: vi.fn(async (_pool: unknown, _config: unknown, _id: string) => ({
    messageId: "draft-1",
    raw: Buffer.from("From: user@example.test\r\n\r\nHello there"),
    source: "fetch" as const,
    truncated: false
  })),
  deliverSmtp: vi.fn(async (_creds: unknown, _raw: Buffer, _envelope: unknown, _config: unknown, _opts?: unknown) => ({
    accepted: ["rcpt@example.test"],
    rejected: [],
    response: "250 queued"
  })),
  resolveSmtpCreds: vi.fn(async (_pool: unknown, _config: unknown, _account: unknown) => ({
    host: "smtp.example.test",
    port: 587,
    secure: false,
    username: "user@example.test",
    password: "secret"
  })),
  assertSafeSmtpTarget: vi.fn(async (_host: string, _port: number, _secure: boolean, _opts?: unknown) => ({
    isPrivateHost: false
  })),
  deleteMessage: vi.fn(async (_pool: unknown, _config: unknown, id: string, opts: { hard?: boolean }) => ({
    messageId: id,
    fromFolder: "Drafts",
    mode: opts.hard ? "expunge" : "trash",
    trashFolder: opts.hard ? null : "Trash"
  })),
  getAccount: vi.fn(),
  getMessage: vi.fn(),
  withAccountLock: vi.fn(),
  lockAssertLive: vi.fn(),
  lockConfirmIrreversible: vi.fn(),
  searchByMessageId: vi.fn(),
  poolConnect: vi.fn()
}));

vi.mock("../smtp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../smtp-client.js")>();
  return {
    ...actual,
    deliverSmtp: mocks.deliverSmtp,
    resolveSmtpCreds: mocks.resolveSmtpCreds,
    SentFolderAppender: {
      connect: vi.fn(async () => ({
        list: mocks.list,
        append: mocks.append,
        searchByMessageId: mocks.searchByMessageId,
        logout: mocks.logout,
        close: mocks.close
      }))
    }
  };
});

vi.mock("../content.js", () => ({ getRawMime: mocks.getRawMime }));
vi.mock("../host-validation.js", () => ({ assertSafeSmtpTarget: mocks.assertSafeSmtpTarget }));
vi.mock("../mailbox-mutations.js", () => ({ deleteMessage: mocks.deleteMessage }));
vi.mock("../locks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../locks.js")>();
  return { ...actual, withAccountLock: mocks.withAccountLock };
});

vi.mock("../repository.js", () => ({
  MirrorRepository: class {
    getAccount = mocks.getAccount;
    getMessage = mocks.getMessage;
  }
}));

const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

const account = {
  id: "acc-1",
  lock_id: "1234567890",
  email_address: "user@example.test",
  provider_profile: "generic-imap",
  host: "imap.example.test",
  port: 993,
  secure: true,
  username: "user@example.test",
  encrypted_password: Buffer.from("x")
};

function mockAccountLock() {
  return {
    lockId: account.lock_id,
    client: {},
    assertLive: mocks.lockAssertLive,
    confirmIrreversible: mocks.lockConfirmIrreversible
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the account lock is free — run the wrapped IMAP work through.
  mocks.withAccountLock.mockImplementation(async (_pool: unknown, _lockId: unknown, fn: (lock: unknown) => Promise<unknown>) => fn(mockAccountLock()));
  mocks.lockAssertLive.mockResolvedValue(undefined);
  mocks.lockConfirmIrreversible.mockImplementation(() => undefined);
  mocks.searchByMessageId.mockResolvedValue([]); // default: no prior draft (idempotency miss)
  mocks.append.mockResolvedValue({ uid: 7 });
  mocks.list.mockResolvedValue([{ path: "Drafts", specialUse: "\\Drafts" }, { path: "Sent", specialUse: "\\Sent" }]);
  mocks.getAccount.mockResolvedValue(account);
  mocks.getRawMime.mockResolvedValue({
    messageId: "draft-1",
    raw: Buffer.from("From: user@example.test\r\n\r\nHello there"),
    source: "fetch",
    truncated: false
  });
  mocks.deliverSmtp.mockResolvedValue({
    accepted: ["rcpt@example.test"],
    rejected: [],
    response: "250 queued"
  });
  mocks.resolveSmtpCreds.mockResolvedValue({
    host: "smtp.example.test", port: 587, secure: false, username: "user@example.test", password: "secret"
  });
  mocks.assertSafeSmtpTarget.mockResolvedValue({ isPrivateHost: false });
  mocks.deleteMessage.mockImplementation(async (_pool, _config, id: string, opts: { hard?: boolean }) => ({
    messageId: id, fromFolder: "Drafts", mode: opts.hard ? "expunge" : "trash", trashFolder: opts.hard ? null : "Trash"
  }));
});

describe("createDraft", () => {
  it("throws AccountBusyError (and never APPENDs) when the per-account lock is held", async () => {
    // Worker mid-sync holds the advisory lock → withAccountLock returns null. The
    // draft APPEND must not race; it surfaces a retryable busy error instead.
    mocks.withAccountLock.mockResolvedValueOnce(null);
    const { createDraft } = await import("../drafts.js");
    const { AccountBusyError } = await import("../errors.js");
    await expect(
      createDraft({} as never, config, {
        accountId: "acc-1",
        to: [{ email: "rcpt@example.test" }],
        subject: "My draft",
        body: { format: "plain", text: "Hello" }
      })
    ).rejects.toBeInstanceOf(AccountBusyError);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("returns the existing draft (no duplicate APPEND) on an idempotent retry", async () => {
    // Same Idempotency-Key -> same derived Message-ID -> search finds the prior APPEND.
    mocks.searchByMessageId.mockResolvedValueOnce([41, 42]);
    const { createDraft } = await import("../drafts.js");
    const result = await createDraft({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "My draft",
      body: { format: "plain", text: "Hello" },
      idempotencyKey: "req-key-1"
    });
    expect(mocks.searchByMessageId).toHaveBeenCalledTimes(1);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(result.appendedUid).toBe(42); // highest UID of the existing match
  });

  it("searches by the derived Message-ID then APPENDs when an idempotency key has no prior draft", async () => {
    const { createDraft } = await import("../drafts.js");
    await createDraft({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "My draft",
      body: { format: "plain", text: "Hello" },
      idempotencyKey: "req-key-2"
    });
    expect(mocks.searchByMessageId).toHaveBeenCalledTimes(1);
    const [folder, msgId] = mocks.searchByMessageId.mock.calls[0];
    expect(folder).toBe("Drafts");
    // Deterministic <draft-{sha256[0:32]}@domain> stamped into the composed bytes.
    expect(String(msgId)).toMatch(/^<draft-[0-9a-f]{32}@example\.test>$/);
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });

  it("does NOT search (goes straight to APPEND) when no idempotency key is given", async () => {
    const { createDraft } = await import("../drafts.js");
    await createDraft({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "My draft",
      body: { format: "plain", text: "Hello" }
    });
    expect(mocks.searchByMessageId).not.toHaveBeenCalled();
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });

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
    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
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

  it("rejects attachments smuggled past the type system before connecting (bytes can't round-trip a draft)", async () => {
    const { createDraft } = await import("../drafts.js");
    await expect(
      // Attachment bytes are never mirrored, so sendDraft (which rebuilds the
      // SendRequest from the mirror) would drop them on send — refuse, not accept.
      createDraft({} as never, config, {
        accountId: "acc-1",
        to: [{ email: "rcpt@example.test" }],
        subject: "My draft",
        body: { format: "plain", text: "Hello" },
        attachments: [{ filename: "report.pdf", content: "AAAA" }]
      } as never)
    ).rejects.toThrow("Attachments are not supported on saved drafts — attach files when you send the draft");
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

  // ── Review PR-A (decision 1): the revised draft is already filed, so a failed
  //    delete of the OLD draft must downgrade to a warning, not fail the update. ─
  it("STILL reports the update when the old-draft delete rejects (best-effort cleanup)", async () => {
    mocks.getMessage.mockResolvedValue({ id: "draft-1", account_id: "acc-1", deleted_in_provider: false });
    mocks.deleteMessage.mockRejectedValueOnce(new Error("Hard delete needs the UIDPLUS extension"));
    const { updateDraft } = await import("../drafts.js");

    const result = await updateDraft({} as never, config, "draft-1", {
      to: [{ email: "rcpt@example.test" }],
      subject: "Revised",
      body: { format: "plain", text: "v2" }
    });
    // The new draft is filed; the update is reported despite the cleanup failure.
    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(result.replacedMessageId).toBe("draft-1");
    expect(result.replacedDraftDeleted).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/removing the previous draft failed/i);
  });

  it("throws AccountBusyError before the delete when the account lock is held (no partial state)", async () => {
    mocks.getMessage.mockResolvedValue({ id: "draft-1", account_id: "acc-1", deleted_in_provider: false });
    mocks.withAccountLock.mockResolvedValueOnce(null); // worker mid-sync holds the lock
    const { updateDraft } = await import("../drafts.js");
    const { AccountBusyError } = await import("../errors.js");
    await expect(
      updateDraft({} as never, config, "draft-1", {
        to: [{ email: "rcpt@example.test" }],
        subject: "Revised",
        body: { format: "plain", text: "v2" }
      })
    ).rejects.toBeInstanceOf(AccountBusyError);
    // The APPEND 503'd BEFORE the still-unlocked delete-old ran — no orphaned second draft.
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

  it("throws AccountBusyError before raw fetch or SMTP when the account is busy", async () => {
    mocks.withAccountLock.mockResolvedValueOnce(null);
    const pool = mockPoolReturningDraft(draftRow);
    const { AccountBusyError } = await import("../errors.js");
    const { sendDraft } = await import("../drafts.js");

    await expect(sendDraft(pool, config, "draft-1")).rejects.toBeInstanceOf(AccountBusyError);
    expect(mocks.getRawMime).not.toHaveBeenCalled();
    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
  });

  it("RESENDS the draft's raw bytes over SMTP, APPENDs them to Sent, then deletes the draft", async () => {
    const pool = mockPoolReturningDraft(draftRow);
    const { sendDraft } = await import("../drafts.js");
    const result = await sendDraft(pool, config, "draft-1");

    expect(mocks.withAccountLock).toHaveBeenCalledWith(
      pool,
      account.lock_id,
      expect.any(Function),
      expect.objectContaining({ heartbeatIntervalMs: 60_000, onPostIrreversibleWarning: expect.any(Function) })
    );

    // The actual draft bytes are fetched (true round-trip), NOT rebuilt from the
    // parsed mirror fields — there is no SendRequest reconstruction anymore.
    expect(mocks.getRawMime).toHaveBeenCalledWith(pool, config, "draft-1");
    const rawBytes = mocks.getRawMime.mock.results[0].value as Promise<{ raw: Buffer }>;
    const expectedRaw = (await rawBytes).raw;

    // The SSRF guard runs before delivery (parity with the send path).
    expect(mocks.assertSafeSmtpTarget).toHaveBeenCalledTimes(1);
    // The EXACT fetched bytes are submitted over SMTP.
    expect(mocks.deliverSmtp).toHaveBeenCalledTimes(1);
    const [, deliveredRaw, envelope] = mocks.deliverSmtp.mock.calls[0];
    expect(Buffer.isBuffer(deliveredRaw)).toBe(true);
    expect((deliveredRaw as Buffer).equals(expectedRaw)).toBe(true);
    // Envelope recipients come from the SYNCED header fields (To + Cc), never the body.
    expect(envelope).toMatchObject({ from: "user@example.test", to: ["rcpt@example.test"] });

    // The SAME bytes are filed to Sent (resolved Sent folder).
    expect(mocks.append).toHaveBeenCalledTimes(1);
    const [sentPath, sentRaw, sentFlags] = mocks.append.mock.calls[0];
    expect(sentPath).toBe("Sent");
    expect((sentRaw as Buffer).equals(expectedRaw)).toBe(true);
    expect(sentFlags).toContain("\\Seen");

    // Delete happens AFTER the send.
    expect(mocks.deleteMessage).toHaveBeenCalledWith(pool, config, "draft-1", { hard: true });
    const deliverOrder = mocks.deliverSmtp.mock.invocationCallOrder[0];
    const deleteOrder = mocks.deleteMessage.mock.invocationCallOrder[0];
    expect(deliverOrder).toBeLessThan(deleteOrder);
    expect(result).toMatchObject({
      deletedDraftId: "draft-1",
      send: {
        delivered: true,
        accepted: ["rcpt@example.test"],
        rejected: [],
        smtpResponse: "250 queued"
      }
    });
  });

  it("SENT bytes CONTAIN the draft body — the regression that caused the empty send", async () => {
    // The bug: a freshly created/updated draft whose body wasn't lazily fetched into
    // the mirror yet (draft.body === null) used to send an EMPTY email because send
    // rebuilt the SendRequest from the NULL mirror body. The fix resends the raw
    // bytes, so the body survives even when the mirror body row is absent.
    const knownBody = "Updated draft body that MUST survive";
    const rawWithBody = Buffer.from(
      `From: user@example.test\r\nTo: rcpt@example.test\r\nSubject: Hello\r\n\r\n${knownBody}`
    );
    mocks.getRawMime.mockResolvedValueOnce({
      messageId: "draft-1", raw: rawWithBody, source: "fetch", truncated: false
    });
    // The mirror body is NULL (lazy body-fetch hasn't populated it) — the exact
    // condition that produced the empty send under the old rebuild-from-mirror path.
    const pool = mockPoolReturningDraft({ ...draftRow, body_text: null, body_plain: null, selected_text_part: null });
    const { sendDraft } = await import("../drafts.js");
    await sendDraft(pool, config, "draft-1");

    // The bytes submitted over SMTP CONTAIN the real body.
    const [, deliveredRaw] = mocks.deliverSmtp.mock.calls[0];
    expect((deliveredRaw as Buffer).toString("utf8")).toContain(knownBody);
    // The Sent-APPEND got the IDENTICAL bytes (same body).
    const [, sentRaw] = mocks.append.mock.calls[0];
    expect((sentRaw as Buffer).toString("utf8")).toContain(knownBody);
    expect((sentRaw as Buffer).equals(deliveredRaw as Buffer)).toBe(true);
  });

  it("refuses to send a draft with no recipients (and does not deliver or delete)", async () => {
    const pool = mockPoolReturningDraft({ ...draftRow, to_emails: [] });
    const { sendDraft } = await import("../drafts.js");
    await expect(sendDraft(pool, config, "draft-1")).rejects.toThrow(/no recipients/);
    expect(mocks.getRawMime).not.toHaveBeenCalled();
    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
  });

  it("throws when the draft is not found", async () => {
    const pool = mockPoolReturningDraft(null);
    const { sendDraft } = await import("../drafts.js");
    await expect(sendDraft(pool, config, "missing")).rejects.toThrow(/Draft not found/);
    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
  });

  it("fails closed when the draft raw MIME is truncated (never submits a corrupt message)", async () => {
    const pool = mockPoolReturningDraft(draftRow);
    // getRawMime hit the BODY_RAW_MAX_BYTES cap → the bytes are incomplete.
    mocks.getRawMime.mockResolvedValueOnce({
      messageId: "draft-1", raw: Buffer.from("From: user@example.test\r\n\r\npartial"), source: "fetch", truncated: true
    });
    const { sendDraft } = await import("../drafts.js");
    const { SmtpDeliveryError } = await import("../smtp-client.js");
    const error = await sendDraft(pool, config, "draft-1").catch((value) => value);
    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error.outcome).toBe("not_delivered");
    expect(error.message).toMatch(/truncated/i);
    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
  });

  it("does NOT submit over SMTP when the raw fetch fails (fail closed — no empty/garbage send)", async () => {
    const pool = mockPoolReturningDraft(draftRow);
    // e.g. a UIDVALIDITY mismatch, or the draft vanished from the Drafts folder.
    mocks.getRawMime.mockRejectedValueOnce(new Error("UIDVALIDITY changed for Drafts"));
    const { sendDraft } = await import("../drafts.js");
    const { SmtpDeliveryError } = await import("../smtp-client.js");
    const error = await sendDraft(pool, config, "draft-1").catch((value) => value);
    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error.outcome).toBe("not_delivered");
    expect(error.message).toMatch(/UIDVALIDITY/);
    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
  });

  // ── Review PR-A (decision 1): the post-send cleanup is best-effort. The send
  //    is irreversible, so a delete failure must NEVER throw a delivered send. ─
  it("STILL reports delivered when the post-send draft delete rejects (best-effort cleanup)", async () => {
    const pool = mockPoolReturningDraft(draftRow);
    // The cleanup EXPUNGE fails (e.g. no UIDPLUS) AFTER a successful send.
    mocks.deleteMessage.mockRejectedValueOnce(new Error("Hard delete needs the UIDPLUS extension"));
    const { sendDraft } = await import("../drafts.js");

    const result = await sendDraft(pool, config, "draft-1");
    // The send happened and is reported delivered — no throw.
    expect(mocks.deliverSmtp).toHaveBeenCalledTimes(1);
    expect(result.send.delivered).toBe(true);
    expect(result.deletedDraftId).toBe("draft-1");
    expect(result.draftDeleted).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/removing the draft from Drafts failed/i);
    // The warning is also threaded onto the nested SendResult.
    expect(result.send.warnings.join(" ")).toMatch(/removing the draft/i);
  });

  it("STILL reports delivered when the Sent-APPEND fails (best-effort filing)", async () => {
    const pool = mockPoolReturningDraft(draftRow);
    // The Sent APPEND rejects AFTER a successful delivery — must not throw.
    mocks.append.mockRejectedValueOnce(new Error("APPEND to Sent failed"));
    const { sendDraft } = await import("../drafts.js");

    const result = await sendDraft(pool, config, "draft-1");
    expect(mocks.deliverSmtp).toHaveBeenCalledTimes(1);
    expect(result.send.delivered).toBe(true);
    expect(result.send.appendedToSent).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/filing to Sent failed/i);
  });

  it("holds the lock through SMTP, APPEND, fallback teardown, and draft cleanup", async () => {
    const pool = mockPoolReturningDraft(draftRow);
    let lockHeld = false;
    mocks.withAccountLock.mockImplementationOnce(async (_pool, _lockId, fn: (lock: unknown) => Promise<unknown>) => {
      lockHeld = true;
      try {
        return await fn(mockAccountLock());
      } finally {
        lockHeld = false;
      }
    });
    mocks.deliverSmtp.mockImplementationOnce(async () => {
      expect(lockHeld).toBe(true);
      return { accepted: ["rcpt@example.test"], rejected: [], response: "250 queued" };
    });
    mocks.append.mockImplementationOnce(async () => {
      expect(lockHeld).toBe(true);
      return { uid: 7 };
    });
    mocks.logout.mockImplementationOnce(async () => {
      expect(lockHeld).toBe(true);
      throw new Error("LOGOUT timed out");
    });
    mocks.close.mockImplementationOnce(() => {
      expect(lockHeld).toBe(true);
    });
    mocks.deleteMessage.mockImplementationOnce(async () => {
      expect(lockHeld).toBe(true);
      return { messageId: "draft-1", fromFolder: "Drafts", mode: "expunge", trashFolder: null };
    });

    const { sendDraft } = await import("../drafts.js");
    const result = await sendDraft(pool, config, "draft-1");
    expect(result.send.delivered).toBe(true);
    expect(lockHeld).toBe(false);
  });

  it("downgrades appender logout plus fallback-close failure after delivery to a warning", async () => {
    const pool = mockPoolReturningDraft(draftRow);
    mocks.logout.mockRejectedValueOnce(new Error("LOGOUT timed out"));
    mocks.close.mockImplementationOnce(() => {
      throw new Error("socket close failed");
    });

    const { sendDraft } = await import("../drafts.js");
    const result = await sendDraft(pool, config, "draft-1");
    expect(result.send.delivered).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/closing the Sent connection failed: socket close failed/i);
  });

  it("reports draftDeleted=true and no cleanup warning on the happy path", async () => {
    const pool = mockPoolReturningDraft(draftRow);
    const { sendDraft } = await import("../drafts.js");
    const result = await sendDraft(pool, config, "draft-1");
    expect(result.draftDeleted).toBe(true);
    expect(result.warnings).toEqual([]);
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
