import { describe, expect, it } from "vitest";
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
});
