import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildRawMime, buildSendEnvelope } from "../smtp-client.js";
import type { SendRequest } from "../types.js";

/**
 * Unit coverage for the send primitive's compose seam (email-001, ADR 0017):
 * Message-ID stamping/honoring, In-Reply-To/References merge (including the
 * NULL provider_thread_id generic-IMAP path where threading rides
 * In-Reply-To=source.rfc_message_id + References=the walk), and CC/BCC/custom
 * header encoding. The SMTP transport + IMAP appender are mocked so nothing
 * leaves the process.
 */

function decode(raw: Buffer): string {
  return raw.toString("utf8");
}

function headerValue(raw: string, name: string): string | null {
  // Unfold continuation lines, then match the header case-insensitively.
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  const line = unfolded.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

const FROM = { email: "sender@example.test", name: "Sender" };

describe("buildRawMime", () => {
  const base: SendRequest = {
    accountId: "acc-1",
    to: [{ email: "rcpt@example.test", name: "Recipient" }],
    subject: "Hello",
    body: { format: "plain", text: "Body text" }
  };

  it("stamps a generated Message-ID using the from-domain when none is supplied", async () => {
    const { raw, messageId } = await buildRawMime(base, FROM);
    expect(messageId).toMatch(/^<.+@example\.test>$/);
    expect(headerValue(decode(raw), "Message-ID")).toBe(messageId);
  });

  it("honors a caller-supplied Message-ID for stability", async () => {
    const supplied = "<stable-id-123@example.test>";
    const { raw, messageId } = await buildRawMime({ ...base, messageId: supplied }, FROM);
    expect(messageId).toBe(supplied);
    expect(headerValue(decode(raw), "Message-ID")).toBe(supplied);
  });

  it("merges In-Reply-To and References for the reply (generic-IMAP NULL thread path)", async () => {
    // Reply where provider_thread_id IS NULL: threading is carried purely by
    // In-Reply-To = source rfc_message_id and References = the walk.
    const req: SendRequest = {
      ...base,
      subject: "Re: Hello",
      inReplyTo: "<source-msg@peer.test>",
      references: "<root@peer.test> <source-msg@peer.test>"
    };
    const raw = decode((await buildRawMime(req, FROM)).raw);
    expect(headerValue(raw, "In-Reply-To")).toBe("<source-msg@peer.test>");
    expect(headerValue(raw, "References")).toContain("<root@peer.test>");
    expect(headerValue(raw, "References")).toContain("<source-msg@peer.test>");
  });

  it("encodes Cc into the visible headers", async () => {
    const req: SendRequest = {
      ...base,
      cc: [{ email: "cc1@example.test" }, { email: "cc2@example.test", name: "CC Two" }]
    };
    const raw = decode((await buildRawMime(req, FROM)).raw);
    expect(headerValue(raw, "Cc")).toContain("cc1@example.test");
    expect(headerValue(raw, "Cc")).toContain("cc2@example.test");
  });

  it("does NOT leak Bcc into the composed bytes (Bcc rides the SMTP envelope only)", async () => {
    const req: SendRequest = {
      ...base,
      bcc: [{ email: "secret@example.test" }]
    };
    const raw = decode((await buildRawMime(req, FROM)).raw);
    expect(headerValue(raw, "Bcc")).toBeNull();
    expect(raw).not.toContain("secret@example.test");
  });

  it("encodes a custom header passed through req.headers", async () => {
    const req: SendRequest = {
      ...base,
      headers: { "X-SupaMail-Send": "primitive" }
    };
    const raw = decode((await buildRawMime(req, FROM)).raw);
    expect(headerValue(raw, "X-SupaMail-Send")).toBe("primitive");
  });

  // ── Attachment compose seam (email-004): toComposerAttachment was untested —
  //    send.test.ts never passed req.attachments. Cover one regular base64 part +
  //    one inline cid image (Content-ID + inline disposition) in one multipart MIME.
  it("composes a base64 attachment and an inline cid image into the multipart MIME", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4 fixture");
    const pngBytes = Buffer.from("\x89PNG\r\n fixture");
    const req: SendRequest = {
      ...base,
      body: { format: "html", html: '<p>see <img src="cid:logo"></p>' },
      attachments: [
        { filename: "report.pdf", content: pdfBytes.toString("base64"), contentType: "application/pdf" },
        { filename: "logo.png", content: pngBytes.toString("base64"), contentType: "image/png", cid: "logo", inline: true }
      ]
    };
    const raw = decode((await buildRawMime(req, FROM)).raw);

    // The whole message is multipart and carries both parts' filenames.
    expect(raw.toLowerCase()).toContain("multipart/");
    expect(raw).toContain("report.pdf");
    expect(raw).toContain("logo.png");
    // The regular part is an attachment; the cid image is inline with a Content-ID.
    expect(raw.toLowerCase()).toContain("content-disposition: attachment");
    expect(raw.toLowerCase()).toContain("content-disposition: inline");
    expect(raw.toLowerCase()).toContain("content-id: <logo>");
    // The decoded bytes survive the round-trip (base64 of the real PDF fixture).
    expect(raw).toContain(pdfBytes.toString("base64"));
  });

  it("documents the lossy decode of invalid base64 (Buffer.from is total, never throws)", async () => {
    // "@@@@" is not valid base64. Buffer.from(..., "base64") is TOTAL: it drops the
    // invalid characters and yields a shorter/empty buffer rather than throwing, so
    // compose still succeeds — the part is silently truncated, not rejected. This
    // test pins that documented lossy behavior so a future change is deliberate.
    const lossy = Buffer.from("@@@@", "base64");
    expect(lossy.length).toBe(0); // invalid input → empty buffer, no throw
    const req: SendRequest = {
      ...base,
      attachments: [{ filename: "broken.bin", content: "@@@@" }]
    };
    // buildRawMime does not throw — it composes a (truncated/empty) part.
    const { raw } = await buildRawMime(req, FROM);
    expect(decode(raw)).toContain("broken.bin");
  });
});

describe("buildSendEnvelope", () => {
  it("includes every recipient (To + Cc + Bcc) so Bcc is delivered despite not being in the bytes", () => {
    const req: SendRequest = {
      accountId: "acc-1",
      to: [{ email: "to@example.test" }],
      cc: [{ email: "cc@example.test" }],
      bcc: [{ email: "bcc@example.test" }],
      subject: "s",
      body: { format: "plain", text: "b" }
    };
    const env = buildSendEnvelope("sender@example.test", req);
    expect(env.from).toBe("sender@example.test");
    expect(env.to).toEqual(["to@example.test", "cc@example.test", "bcc@example.test"]);
  });
});

// sendMessage orchestration with the SMTP transport + IMAP appender mocked.
// Hoisted spies let us assert delivery happens before APPEND and that the SAME
// composed bytes are both delivered and filed.
const mocks = vi.hoisted(() => ({
  deliverSmtp: vi.fn(async (_creds: unknown, _raw: Buffer, _envelope: unknown, _config: unknown) => ({
    accepted: ["rcpt@example.test"],
    rejected: [],
    response: "250 queued"
  })),
  appenderAppend: vi.fn(async (_path: string, _raw: Buffer, _flags: string[], _date?: Date) => ({ uid: 42 as number | null })),
  appenderList: vi.fn(async () => [{ path: "Sent", specialUse: "\\Sent" }]),
  appenderLogout: vi.fn(async () => undefined),
  appenderClose: vi.fn(),
  getAccount: vi.fn(),
  withAccountLock: vi.fn(),
  lockAssertLive: vi.fn(),
  lockConfirmIrreversible: vi.fn()
}));

function mockAccountLock() {
  return {
    lockId: account.lock_id,
    client: {},
    assertLive: mocks.lockAssertLive,
    confirmIrreversible: mocks.lockConfirmIrreversible
  };
}

vi.mock("../smtp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../smtp-client.js")>();
  return {
    ...actual,
    deliverSmtp: mocks.deliverSmtp,
    resolveSmtpCreds: vi.fn(async () => ({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      username: "sender@example.test",
      password: "secret"
    })),
    SentFolderAppender: {
      connect: vi.fn(async () => ({
        list: mocks.appenderList,
        append: mocks.appenderAppend,
        logout: mocks.appenderLogout,
        close: mocks.appenderClose
      }))
    }
  };
});

vi.mock("../repository.js", () => ({
  MirrorRepository: class {
    getAccount = mocks.getAccount;
  }
}));

vi.mock("../locks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../locks.js")>();
  return { ...actual, withAccountLock: mocks.withAccountLock };
});

vi.mock("../host-validation.js", () => ({
  // assertSafeSmtpTarget now returns the TLS-gate classification; the public
  // smtp.example.test in these tests is not private.
  assertSafeSmtpTarget: vi.fn(async () => ({ isPrivateHost: false }))
}));

const account = {
  id: "acc-1",
  lock_id: "1234567890",
  email_address: "sender@example.test",
  provider_profile: "generic-imap",
  host: "imap.example.test",
  port: 993,
  secure: true,
  username: "sender@example.test",
  encrypted_password: Buffer.from("x"),
  smtp_host: null,
  smtp_port: null,
  smtp_secure: null,
  smtp_username: null,
  encrypted_smtp_password: null
};

describe("sendMessage orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAccountLock.mockImplementation(async (_pool: unknown, _lockId: unknown, fn: (lock: unknown) => Promise<unknown>) => fn(mockAccountLock()));
    mocks.lockAssertLive.mockResolvedValue(undefined);
    mocks.lockConfirmIrreversible.mockImplementation(() => undefined);
    mocks.appenderAppend.mockResolvedValue({ uid: 42 });
    mocks.appenderList.mockResolvedValue([{ path: "Sent", specialUse: "\\Sent" }]);
    mocks.appenderLogout.mockResolvedValue(undefined);
    mocks.appenderClose.mockImplementation(() => undefined);
    mocks.getAccount.mockResolvedValue(account);
  });

  it("delivers then APPENDs the SAME bytes to Sent and returns a SendResult", async () => {
    const { sendMessage } = await import("../send.js");
    const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;
    const result = await sendMessage({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hi",
      body: { format: "plain", text: "Body" }
    });

    expect(mocks.deliverSmtp).toHaveBeenCalledTimes(1);
    expect(mocks.appenderAppend).toHaveBeenCalledTimes(1);
    expect(mocks.withAccountLock).toHaveBeenCalledWith(
      expect.anything(),
      account.lock_id,
      expect.any(Function),
      expect.objectContaining({ heartbeatIntervalMs: 60_000, onPostIrreversibleWarning: expect.any(Function) })
    );

    // The bytes delivered and the bytes appended must be byte-identical.
    const deliveredRaw = mocks.deliverSmtp.mock.calls[0][1];
    const appendedRaw = mocks.appenderAppend.mock.calls[0][1];
    expect(Buffer.compare(deliveredRaw, appendedRaw)).toBe(0);

    expect(result.delivered).toBe(true);
    expect(result.appendedToSent).toBe(true);
    expect(result.appendedUid).toBe(42);
    expect(result.sentFolderPath).toBe("Sent");
    expect(result.rfcMessageId).toMatch(/^<.+>$/);
    expect(result.accepted).toEqual(["rcpt@example.test"]);
    expect(result.rejected).toEqual([]);
    expect(result.smtpResponse).toBe("250 queued");
    expect(result.warnings).toEqual([]);
  });

  it("holds the per-account lock across SMTP delivery and Sent APPEND", async () => {
    let lockHeld = false;
    mocks.withAccountLock.mockImplementationOnce(async (_pool: unknown, _lockId: unknown, fn: (lock: unknown) => Promise<unknown>) => {
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
    mocks.appenderAppend.mockImplementationOnce(async () => {
      expect(lockHeld).toBe(true);
      return { uid: 42 };
    });
    mocks.appenderLogout.mockImplementationOnce(async () => {
      expect(lockHeld).toBe(true);
    });

    const { sendMessage } = await import("../send.js");
    const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;
    await sendMessage({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hi",
      body: { format: "plain", text: "Body" }
    });

    expect(lockHeld).toBe(false);
  });

  it("throws AccountBusyError before SMTP delivery when the account lock is held", async () => {
    mocks.withAccountLock.mockResolvedValueOnce(null);
    const { AccountBusyError } = await import("../errors.js");
    const { sendMessage } = await import("../send.js");
    const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

    await expect(
      sendMessage({} as never, config, {
        accountId: "acc-1",
        to: [{ email: "rcpt@example.test" }],
        subject: "Hi",
        body: { format: "plain", text: "Body" }
      })
    ).rejects.toBeInstanceOf(AccountBusyError);

    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
    expect(mocks.appenderAppend).not.toHaveBeenCalled();
  });

  it("fails before SMTP when lock liveness cannot be proven at the irreversible boundary", async () => {
    mocks.lockAssertLive.mockRejectedValueOnce(new Error("lock session lost"));
    const { SmtpDeliveryError } = await import("../smtp-client.js");
    const { sendMessage } = await import("../send.js");
    const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

    const error = await sendMessage({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hi",
      body: { format: "plain", text: "Body" }
    }).catch((value) => value);
    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error.outcome).toBe("not_delivered");
    expect(error.message).toMatch(/lock session lost/);
    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
    expect(mocks.lockConfirmIrreversible).not.toHaveBeenCalled();
  });

  it("returns delivered with a warning when liveness is lost after SMTP confirmation", async () => {
    mocks.lockAssertLive
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("heartbeat refresh exhausted"));
    const { sendMessage } = await import("../send.js");
    const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

    const result = await sendMessage({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hi",
      body: { format: "plain", text: "Body" }
    });
    expect(result.delivered).toBe(true);
    expect(mocks.lockConfirmIrreversible).toHaveBeenCalledTimes(1);
    expect(mocks.appenderAppend).not.toHaveBeenCalled();
    expect(result.warnings.join(" ")).toMatch(/filing to Sent was skipped.*heartbeat refresh exhausted/i);
  });

  it("does NOT APPEND when delivery throws (nothing filed on a failed send)", async () => {
    mocks.deliverSmtp.mockRejectedValueOnce(new Error("smtp down"));
    const { sendMessage } = await import("../send.js");
    const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

    await expect(
      sendMessage({} as never, config, {
        accountId: "acc-1",
        to: [{ email: "rcpt@example.test" }],
        subject: "Hi",
        body: { format: "plain", text: "Body" }
      })
    ).rejects.toThrow(/smtp down/);
    expect(mocks.appenderAppend).not.toHaveBeenCalled();
  });

  it("preserves an unknown SMTP outcome for a durable remote caller", async () => {
    const { SmtpDeliveryError } = await import("../smtp-client.js");
    const unknown = new SmtpDeliveryError("unknown", "response lost");
    mocks.deliverSmtp.mockRejectedValueOnce(unknown);
    const { sendMessage } = await import("../send.js");
    const config = {
      IMAP_ENCRYPTION_KEY: "0123456789abcdef",
      IMAP_ALLOW_PRIVATE_HOSTS: false
    } as never;

    await expect(sendMessage({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hi",
      body: { format: "plain", text: "Body" }
    })).rejects.toBe(unknown);
    expect(mocks.appenderAppend).not.toHaveBeenCalled();
  });

  it("marks an unexpected failure after SMTP acceptance as unknown", async () => {
    mocks.lockConfirmIrreversible.mockImplementationOnce(() => {
      throw new Error("local confirmation failed");
    });
    const { SmtpDeliveryError } = await import("../smtp-client.js");
    const { sendMessage } = await import("../send.js");
    const config = {
      IMAP_ENCRYPTION_KEY: "0123456789abcdef",
      IMAP_ALLOW_PRIVATE_HOSTS: false
    } as never;

    const error = await sendMessage({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hi",
      body: { format: "plain", text: "Body" }
    }).catch((value) => value);

    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error.outcome).toBe("unknown");
  });

  it("records a warning (does not throw) when delivery succeeds but APPEND fails", async () => {
    mocks.appenderAppend.mockRejectedValueOnce(new Error("append refused"));
    const { sendMessage } = await import("../send.js");
    const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

    const result = await sendMessage({} as never, config, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hi",
      body: { format: "plain", text: "Body" }
    });
    expect(result.delivered).toBe(true);
    expect(result.appendedToSent).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/Sent failed/i);
  });

  it("throws for an unknown account before any delivery", async () => {
    mocks.getAccount.mockResolvedValueOnce(null);
    const { SmtpDeliveryError } = await import("../smtp-client.js");
    const { sendMessage } = await import("../send.js");
    const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

    const error = await sendMessage({} as never, config, {
        accountId: "missing",
        to: [{ email: "rcpt@example.test" }],
        subject: "Hi",
        body: { format: "plain", text: "Body" }
      }).catch((value) => value);
    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error.outcome).toBe("not_delivered");
    expect(error.message).toMatch(/Account not found/);
    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
  });

  // ── The appender socket-cleanup fallback: closeImap() tries a graceful LOGOUT
  //    and, when that rejects (broken/timed-out socket), falls back to a hard
  //    close() so the socket can never leak. This fallback was previously untested.
  it("falls back to close() when the appender logout rejects (no leak, still delivered)", async () => {
    let lockHeld = false;
    mocks.withAccountLock.mockImplementationOnce(async (_pool: unknown, _lockId: unknown, fn: (lock: unknown) => Promise<unknown>) => {
      lockHeld = true;
      try {
        return await fn(mockAccountLock());
      } finally {
        lockHeld = false;
      }
    });
    mocks.appenderLogout.mockRejectedValueOnce(new Error("LOGOUT timed out"));
    mocks.appenderClose.mockImplementationOnce(() => {
      expect(lockHeld).toBe(true);
    });
    const { sendMessage } = await import("../send.js");
    const cfg = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

    const result = await sendMessage({} as never, cfg, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hi",
      body: { format: "plain", text: "Body" }
    });
    // The send still succeeds; the teardown swallowed the failed logout and closed.
    expect(result.delivered).toBe(true);
    expect(mocks.appenderLogout).toHaveBeenCalledTimes(1);
    expect(mocks.appenderClose).toHaveBeenCalledTimes(1);
    expect(lockHeld).toBe(false);
  });

  it("reports teardown failure as a warning after confirmed delivery instead of throwing", async () => {
    mocks.appenderLogout.mockRejectedValueOnce(new Error("LOGOUT timed out"));
    mocks.appenderClose.mockImplementationOnce(() => {
      throw new Error("socket close failed");
    });
    const { sendMessage } = await import("../send.js");
    const cfg = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

    const result = await sendMessage({} as never, cfg, {
      accountId: "acc-1",
      to: [{ email: "rcpt@example.test" }],
      subject: "Hi",
      body: { format: "plain", text: "Body" }
    });

    expect(result.delivered).toBe(true);
    expect(result.appendedToSent).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/closing the Sent connection failed: socket close failed/i);
  });
});
