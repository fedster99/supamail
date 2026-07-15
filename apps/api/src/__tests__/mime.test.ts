import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  extractAttachmentMetadata,
  htmlToText,
  normalizeMessageId,
  parseHeaders,
  parseRawMime,
  selectBodyTextPart
} from "../mime.js";

describe("mime helpers", () => {
  it("normalizes Message-ID values", () => {
    expect(normalizeMessageId(" <ABC@example.COM> ")).toBe("abc@example.com");
    expect(normalizeMessageId(null)).toBeNull();
  });

  it("parses folded headers", () => {
    expect(parseHeaders("Subject: hello\r\n world\r\nMessage-ID: <x@y>\r\n")).toEqual({
      subject: "hello world",
      "message-id": "<x@y>"
    });
  });

  it("selects plain text over html when both parts exist", () => {
    const structure = {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/html" },
        { part: "2", type: "text/plain" }
      ]
    };

    expect(selectBodyTextPart(structure)).toEqual({ part: "2", format: "plain" });
  });

  it("extracts attachment and inline metadata from BODYSTRUCTURE", () => {
    const structure = {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain" },
        {
          part: "2",
          type: "application/pdf",
          size: 123,
          disposition: { type: "attachment", params: { filename: "invoice.pdf" } }
        },
        {
          part: "3",
          type: "image/png",
          id: "<logo@cid>",
          disposition: "inline"
        }
      ]
    };

    expect(extractAttachmentMetadata(structure)).toEqual([
      {
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 123,
        disposition: "attachment",
        contentId: null,
        partNumber: "2"
      },
      {
        filename: null,
        mimeType: "image/png",
        sizeBytes: null,
        disposition: "inline",
        contentId: "<logo@cid>",
        partNumber: "3"
      }
    ]);
  });

  it("converts basic html to normalized text", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>there</b></p><script>x()</script>")).toBe("Hello there");
  });

  it("does not crash on out-of-range or surrogate numeric entities", () => {
    expect(() => htmlToText("hi &#x110000; there")).not.toThrow();
    expect(() => htmlToText("hi &#xD800; there")).not.toThrow();
    expect(() => htmlToText("hi &#-1; there")).not.toThrow();
    expect(htmlToText("ok &#65; done")).toContain("A");
  });

  it("does not infinite-loop on a self-referential bodyStructure", () => {
    const node: { type: string; childNodes: unknown[] } = { type: "multipart/mixed", childNodes: [] };
    node.childNodes.push(node);
    expect(() => selectBodyTextPart(node)).not.toThrow();
    expect(() => extractAttachmentMetadata(node)).not.toThrow();
  });

  it("stops at depth limit on a deeply nested bodyStructure", () => {
    let root: { type: string; childNodes?: unknown[] } = { type: "text/plain" };
    for (let i = 0; i < 200; i += 1) {
      root = { type: "multipart/mixed", childNodes: [root] };
    }
    expect(() => selectBodyTextPart(root)).not.toThrow();
    expect(() => extractAttachmentMetadata(root)).not.toThrow();
  });

  it("parses raw MIME into text, html, and headers", async () => {
    const raw = Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Test",
        "Message-ID: <test@example.com>",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Hello <b>Bob</b></p>"
      ].join("\r\n")
    );

    const parsed = await parseRawMime(raw);

    expect(parsed.bodyHtml).toContain("<p>Hello");
    expect(parsed.bodyText).toBe("Hello Bob");
    expect(parsed.headersJson.subject).toBe("Test");
  });

  it("extracts a SHA-256 identity from decoded attachment bytes", async () => {
    const attachment = Buffer.from("same logical file regardless of MIME transfer encoding\n");
    const raw = Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Review the contract",
        "Message-ID: <attachment-evidence@example.com>",
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=signal-boundary",
        "",
        "--signal-boundary",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Please review the attachment.",
        "--signal-boundary",
        "Content-Type: application/pdf; name=contract.pdf",
        "Content-Disposition: attachment; filename=contract.pdf",
        "Content-Transfer-Encoding: base64",
        "",
        attachment.toString("base64"),
        "--signal-boundary--",
        ""
      ].join("\r\n")
    );

    const parsed = await parseRawMime(raw);

    expect(parsed.evidence).toEqual([
      {
        kind: "attachment_content",
        namespace: "sha256",
        key: createHash("sha256").update(attachment).digest("hex"),
        metadata: {
          filename: "contract.pdf",
          mimeType: "application/pdf",
          sizeBytes: attachment.length,
          disposition: "attachment",
          contentId: null,
          related: false
        }
      }
    ]);
    expect(JSON.stringify(parsed.evidence)).not.toContain(attachment.toString("base64"));

    const quotedPrintable = Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Same attachment, different transport encoding",
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=qp-boundary",
        "",
        "--qp-boundary",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Please review the attachment.",
        "--qp-boundary",
        "Content-Type: application/pdf; name=renamed-contract.pdf",
        "Content-Disposition: attachment; filename=renamed-contract.pdf",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "same logical file regardless of MIME transfer encoding=0A",
        "--qp-boundary--",
        ""
      ].join("\r\n")
    );
    const reparsed = await parseRawMime(quotedPrintable);
    expect(reparsed.evidence[0]?.key).toBe(parsed.evidence[0]?.key);
  });

  it("identifies calendar revisions by UID plus recurrence instance", async () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:weekly-board-",
      " meeting@example.com",
      "RECURRENCE-ID:20260714T170000Z",
      "SEQUENCE:2",
      "DTSTAMP:20260713T120000Z",
      "DTSTART:20260714T180000Z",
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    const raw = Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Updated board meeting",
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=calendar-boundary",
        "",
        "--calendar-boundary",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "The meeting moved.",
        "--calendar-boundary",
        "Content-Type: text/calendar; charset=utf-8; method=REQUEST; name=invite.ics",
        "Content-Disposition: attachment; filename=invite.ics",
        "",
        calendar,
        "--calendar-boundary--",
        ""
      ].join("\r\n")
    );

    const parsed = await parseRawMime(raw);

    expect(parsed.evidence).toContainEqual({
      kind: "calendar_instance",
      namespace: "icalendar",
      key: JSON.stringify(["weekly-board-meeting@example.com", "20260714T170000Z"]),
      metadata: {
        uid: "weekly-board-meeting@example.com",
        recurrenceId: "20260714T170000Z",
        sequence: 2,
        dtstamp: "20260713T120000Z",
        dtstart: "20260714T180000Z",
        method: "REQUEST",
        component: "VEVENT"
      }
    });
  });

  it("extracts only provider-scoped canonical resource identities", async () => {
    const envelopeId = "2f1c5704-57f4-4d18-97c8-a7cfc01f4f75";
    const raw = Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Resource links",
        "Content-Type: text/html; charset=utf-8",
        "",
        [
          '<a href="https://github.com/Acme/Alpha/pull/42?notification_referrer_id=1">PR</a>',
          '<a href="https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStuVwXyZ/edit?usp=sharing">Doc</a>',
          '<a href="https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStuVwXyZ/view">Same doc</a>',
          '<a href="https://acme.atlassian.net/browse/MAIL-123">Jira</a>',
          `<a href="https://app.docusign.com/documents/details/${envelopeId}">Envelope</a>`,
          `An unscoped UUID is not evidence: ${envelopeId}`
        ].join(" ")
      ].join("\r\n")
    );

    const parsed = await parseRawMime(raw);
    const resources = parsed.evidence.filter((item) => item.kind === "provider_resource");

    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: "github_pull", key: "acme/alpha#42" }),
      expect.objectContaining({ namespace: "google_drive_file", key: "1AbCdEfGhIjKlMnOpQrStuVwXyZ" }),
      expect.objectContaining({ namespace: "jira_issue", key: "acme.atlassian.net/MAIL-123" }),
      expect.objectContaining({ namespace: "docusign_envelope", key: envelopeId })
    ]));
    expect(resources.filter((item) => item.namespace === "google_drive_file")).toHaveLength(1);
    expect(resources).toHaveLength(4);
  });

  it("bounds provider-resource floods and marks the evidence incomplete", async () => {
    const urls = Array.from(
      { length: 150 },
      (_, index) => `https://github.com/acme/mail/issues/${index + 1}`
    );
    const raw = Buffer.from(
      [
        "From: Alerts <alerts@example.com>",
        "To: Alice <alice@example.com>",
        "Subject: Resource flood",
        "Content-Type: text/plain; charset=utf-8",
        "",
        urls.join("\r\n")
      ].join("\r\n")
    );

    const parsed = await parseRawMime(raw);

    expect(parsed.evidence).toHaveLength(100);
    expect(parsed.parserWarnings).toContain("artifact_evidence_truncated");
  });

  it("bounds calendar identifiers by UTF-8 bytes without splitting Unicode", async () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      `UID:${"😀".repeat(400)}\u0001`,
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    const raw = Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Unicode calendar",
        "MIME-Version: 1.0",
        "Content-Type: text/calendar; charset=utf-8; name=invite.ics",
        "Content-Disposition: attachment; filename=invite.ics",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(calendar).toString("base64")
      ].join("\r\n")
    );

    const parsed = await parseRawMime(raw);
    const instance = parsed.evidence.find((item) => item.kind === "calendar_instance");
    const uid = instance?.metadata.uid;

    expect(typeof uid).toBe("string");
    expect(Buffer.byteLength(String(uid), "utf8")).toBeLessThanOrEqual(1_024);
    expect(String(uid)).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(String(uid).codePointAt(String(uid).length - 2)).toBe(0x1F600);
    expect(Buffer.byteLength(instance?.key ?? "", "utf8")).toBeLessThanOrEqual(2_048);
  });

  it("does not parse oversized calendar payloads as complete evidence", async () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:oversized@example.com",
      `DESCRIPTION:${"x".repeat(1_100_000)}`,
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    const raw = Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Oversized calendar",
        "MIME-Version: 1.0",
        "Content-Type: text/calendar; charset=utf-8; name=invite.ics",
        "Content-Disposition: attachment; filename=invite.ics",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(calendar).toString("base64")
      ].join("\r\n")
    );

    const parsed = await parseRawMime(raw);

    expect(parsed.evidence.filter((item) => item.kind === "calendar_instance")).toHaveLength(0);
    expect(parsed.parserWarnings).toContain("artifact_evidence_truncated");
  });
});
