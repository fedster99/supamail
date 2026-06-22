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
  deliverSmtp: vi.fn(async (_creds: unknown, _raw: Buffer, _envelope: unknown, _config: unknown) => undefined),
  appenderAppend: vi.fn(async (_path: string, _raw: Buffer, _flags: string[], _date?: Date) => ({ uid: 42 as number | null })),
  appenderList: vi.fn(async () => [{ path: "Sent", specialUse: "\\Sent" }]),
  appenderLogout: vi.fn(async () => undefined),
  getAccount: vi.fn()
}));

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
        close: vi.fn()
      }))
    }
  };
});

vi.mock("../repository.js", () => ({
  MirrorRepository: class {
    getAccount = mocks.getAccount;
  }
}));

vi.mock("../host-validation.js", () => ({
  assertSafeSmtpTarget: vi.fn(async () => undefined)
}));

const account = {
  id: "acc-1",
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
    mocks.appenderAppend.mockResolvedValue({ uid: 42 });
    mocks.appenderList.mockResolvedValue([{ path: "Sent", specialUse: "\\Sent" }]);
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

    // The bytes delivered and the bytes appended must be byte-identical.
    const deliveredRaw = mocks.deliverSmtp.mock.calls[0][1];
    const appendedRaw = mocks.appenderAppend.mock.calls[0][1];
    expect(Buffer.compare(deliveredRaw, appendedRaw)).toBe(0);

    expect(result.delivered).toBe(true);
    expect(result.appendedToSent).toBe(true);
    expect(result.appendedUid).toBe(42);
    expect(result.sentFolderPath).toBe("Sent");
    expect(result.rfcMessageId).toMatch(/^<.+>$/);
    expect(result.warnings).toEqual([]);
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
    const { sendMessage } = await import("../send.js");
    const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", IMAP_ALLOW_PRIVATE_HOSTS: false } as never;

    await expect(
      sendMessage({} as never, config, {
        accountId: "missing",
        to: [{ email: "rcpt@example.test" }],
        subject: "Hi",
        body: { format: "plain", text: "Body" }
      })
    ).rejects.toThrow(/Account not found/);
    expect(mocks.deliverSmtp).not.toHaveBeenCalled();
  });
});
