import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SendRequest } from "../types.js";

/**
 * Review PR-A unit coverage for the SMTP compose/transport hardening:
 *  - buildRawMime header denylist: a forged structural/identity header
 *    (Bcc/From/Cc/Content-Type/…) is rejected before it can reach the bytes that
 *    are BOTH delivered AND filed to Sent; only X-* (and the threading headers)
 *    pass. Drafts reuse buildRawMime, so this protects createDraft too.
 *  - deliverSmtp requireTLS decoupling (decision 3): a non-implicit-TLS PUBLIC
 *    host keeps requireTLS=true even when IMAP_ALLOW_PRIVATE_HOSTS is set; it
 *    relaxes only when the resolved host is actually private/loopback.
 *
 * nodemailer is mocked so the transport config is captured without a socket.
 */

const transport = vi.hoisted(() => ({
  sendMail: vi.fn(async () => undefined),
  close: vi.fn()
}));
const createTransport = vi.hoisted(() =>
  vi.fn((_options: Record<string, unknown>) => transport)
);

vi.mock("nodemailer", () => ({
  default: { createTransport }
}));

const FROM = { email: "sender@example.test" };

function headerValue(raw: string, name: string): string | null {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  const line = unfolded.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

const base: SendRequest = {
  accountId: "acc-1",
  to: [{ email: "rcpt@example.test" }],
  subject: "Hello",
  body: { format: "plain", text: "Body" }
};

describe("buildRawMime header denylist", () => {
  it("rejects forged structural/identity headers (Bcc/From/To/Cc/Sender/Reply-To/Content-Type/MIME-Version)", async () => {
    const { buildRawMime } = await import("../smtp-client.js");
    const forbidden = [
      "Bcc",
      "From",
      "To",
      "Cc",
      "Sender",
      "Reply-To",
      "Return-Path",
      "Received",
      "Content-Type",
      "MIME-Version"
    ];
    for (const name of forbidden) {
      await expect(
        buildRawMime({ ...base, headers: { [name]: "x@evil.test" } }, FROM)
      ).rejects.toThrow(new RegExp(name, "i"));
    }
  });

  it("is case-insensitive on the denylist (a lowercased bcc is still rejected)", async () => {
    const { buildRawMime } = await import("../smtp-client.js");
    await expect(buildRawMime({ ...base, headers: { bcc: "x@evil.test" } }, FROM)).rejects.toThrow(/bcc/i);
  });

  it("rejects an unknown non-X- custom header but allows X-* and the threading headers", async () => {
    const { buildRawMime } = await import("../smtp-client.js");
    await expect(buildRawMime({ ...base, headers: { "X-Random": "v" } }, FROM)).resolves.toBeDefined();
    await expect(buildRawMime({ ...base, headers: { "In-Reply-To": "<a@b>" } }, FROM)).resolves.toBeDefined();
    await expect(buildRawMime({ ...base, headers: { "Subject-Override": "no" } }, FROM)).rejects.toThrow(/not allowed/i);
  });

  it("a forged Bcc never reaches the composed bytes (it throws before compile)", async () => {
    const { buildRawMime } = await import("../smtp-client.js");
    await expect(buildRawMime({ ...base, headers: { Bcc: "secret@evil.test" } }, FROM)).rejects.toThrow();
    // A legitimate X-* header DOES round-trip into the bytes.
    const { raw } = await buildRawMime({ ...base, headers: { "X-SupaMail-Send": "primitive" } }, FROM);
    expect(headerValue(raw.toString("utf8"), "X-SupaMail-Send")).toBe("primitive");
  });
});

describe("deliverSmtp requireTLS decoupling (decision 3)", () => {
  const creds = {
    host: "smtp.example.test",
    port: 587,
    secure: false,
    username: "u",
    password: "p"
  };
  const envelope = { from: "sender@example.test", to: ["rcpt@example.test"] };
  const config = { CONNECT_TIMEOUT_MS: 1000, IMAP_COMMAND_TIMEOUT_MS: 1000 } as never;

  beforeEach(() => {
    createTransport.mockClear();
    transport.sendMail.mockReset();
    transport.sendMail.mockResolvedValue(undefined);
    transport.close.mockReset();
    transport.close.mockImplementation(() => undefined);
  });

  it("sets requireTLS=true for a PUBLIC STARTTLS host (isPrivateHost not set)", async () => {
    const { deliverSmtp } = await import("../smtp-client.js");
    await deliverSmtp(creds, Buffer.from("raw"), envelope, config);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0][0]).toMatchObject({ requireTLS: true, secure: false });
  });

  it("keeps requireTLS=true for a PUBLIC host even when isPrivateHost=false is explicit (the opt-in must NOT drop TLS)", async () => {
    const { deliverSmtp } = await import("../smtp-client.js");
    await deliverSmtp(creds, Buffer.from("raw"), envelope, config, { isPrivateHost: false });
    expect(createTransport.mock.calls[0][0]).toMatchObject({ requireTLS: true });
  });

  it("relaxes requireTLS to false ONLY when the resolved host is actually private/loopback", async () => {
    const { deliverSmtp } = await import("../smtp-client.js");
    await deliverSmtp(creds, Buffer.from("raw"), envelope, config, { isPrivateHost: true });
    expect(createTransport.mock.calls[0][0]).toMatchObject({ requireTLS: false });
  });

  it("an implicit-TLS (secure=true) host never sets requireTLS regardless of privateness", async () => {
    const { deliverSmtp } = await import("../smtp-client.js");
    await deliverSmtp({ ...creds, secure: true, port: 465 }, Buffer.from("raw"), envelope, config);
    expect(createTransport.mock.calls[0][0]).toMatchObject({ requireTLS: false, secure: true });
  });

  it("returns a warning instead of overwriting confirmed delivery when transport close throws", async () => {
    const warning = vi.fn();
    transport.close.mockImplementationOnce(() => {
      throw new Error("transport close failed");
    });
    const { deliverSmtp } = await import("../smtp-client.js");
    await deliverSmtp(creds, Buffer.from("raw"), envelope, config, { onPostDeliveryWarning: warning });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/Delivered.*transport close failed/i));
  });

  it("preserves the original SMTP error when send and close both fail", async () => {
    transport.sendMail.mockRejectedValueOnce(new Error("SMTP rejected message"));
    transport.close.mockImplementationOnce(() => {
      throw new Error("transport close failed");
    });
    const { deliverSmtp } = await import("../smtp-client.js");
    await expect(deliverSmtp(creds, Buffer.from("raw"), envelope, config)).rejects.toThrow(/SMTP rejected message/);
  });
});
