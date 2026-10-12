import { describe, expect, it } from "vitest";
import { buildReplyBody, draftReplyRequestSchema, formatReplyDate } from "./draft-reply.js";

describe("formatReplyDate", () => {
  it("renders a readable Gmail-style UTC date instead of an ISO timestamp", () => {
    expect(formatReplyDate(new Date("2026-08-14T04:35:52.000Z"))).toBe(
      "Fri, Aug 14, 2026 at 4:35 AM UTC"
    );
  });

  it("formats noon and midnight with 12-hour clock conventions", () => {
    expect(formatReplyDate(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "Thu, Jan 1, 2026 at 12:00 AM UTC"
    );
    expect(formatReplyDate(new Date("2026-01-01T12:00:00.000Z"))).toBe(
      "Thu, Jan 1, 2026 at 12:00 PM UTC"
    );
  });
});

describe("buildReplyBody", () => {
  it("keeps full plain quote depth while flattening HTML history into one compact client-compatible quote", () => {
    const body = buildReplyBody(
      "Thanks <team> & talk soon.",
      "Latest answer.\n\nOn Thu, Alice wrote:\n> Older answer.\n> Oldest answer.",
      "On Fri, Alice <alice@example.test> wrote:"
    );

    expect(body.format).toBe("plain");
    expect(body.text).toContain("> Latest answer.");
    expect(body.text).toContain("> > Older answer.");
    expect(body.html).toContain('<div class="gmail_quote gmail_quote_container">');
    expect(body.html).toContain(
      '<blockquote class="gmail_quote" type="cite" style="margin:0 0 0 8px;border-left:1px solid #ccc;padding-left:10px">'
    );
    expect(body.html).toContain("Thanks &lt;team&gt; &amp; talk soon.");
    expect(body.html).toContain("Latest answer.");
    expect(body.html).toContain("Older answer.");
    expect(body.html.match(/<blockquote/g)).toHaveLength(1);
    expect(body.html).not.toContain("> Latest answer.");
    expect(body.html).not.toContain("&gt; Older answer.");
  });

  it("puts an HTML reply above the same quote and derives its plain alternative", () => {
    const body = buildReplyBody(
      "<p>Thanks, <b>Alice</b>.</p><p>Best,<br>Bob</p>",
      "Latest answer.",
      "On Fri, Alice <alice@example.test> wrote:",
      "html"
    );

    expect(body.format).toBe("html");
    expect(body.html.startsWith("<p>Thanks, <b>Alice</b>.</p><p>Best,<br>Bob</p>\n")).toBe(true);
    expect(body.html.match(/<blockquote/g)).toHaveLength(1);
    expect(body.html).toContain("Latest answer.");
    expect(body.text).toMatch(/^Thanks, Alice\.\n\nBest,\nBob\n\nOn Fri, Alice <alice@example.test> wrote:\n> Latest answer\./);
    expect(body.text).not.toContain("<b>");
  });
});

describe("draftReplyRequestSchema", () => {
  it("accepts a plain or HTML body format and rejects any other", () => {
    const base = { source_message_id: "m1", body: "Thanks" };
    expect(draftReplyRequestSchema.parse(base).body_format).toBeUndefined();
    expect(draftReplyRequestSchema.parse({ ...base, body_format: "html" }).body_format).toBe("html");
    expect(() => draftReplyRequestSchema.parse({ ...base, body_format: "markdown" })).toThrow();
  });
});

describe("HTML source images", () => {
  it.each([
    '<p>Earlier <img src="cid:original@example.test"></p>',
    '<p>Earlier <img src=" cid:original&#64;example.test "></p><!-- <img src="cid:unused"> -->'
  ])("retains quoted image references without rewriting HTML: %s", async (sourceHtml) => {
    const { runDraftReply } = await import("./draft-reply.js");
    const client = {
      query: async (sql: string) => ({ rows: sql.includes("FROM public.imap_attachments") ? [
        { attachment_id: "inline-id", message_id: "source", account_id: "mailbox", content_id: "<original@example.test>", disposition: "inline" },
        { attachment_id: "file-id", message_id: "source", account_id: "mailbox", content_id: null, disposition: "attachment" }
      ] : sql.includes("FROM public.imap_messages") ? [{
        id: "source", account_id: "mailbox", account_email: "self@example.test", from_email: "sender@example.test",
        subject: "Hello", internal_date: new Date("2026-01-01"), body_html: sourceHtml, body_text: "Earlier",
      }] : [] }),
      release: () => {},
    };
    const result = await runDraftReply({ connect: async () => client } as never, {
      source_message_id: "source", body: "<p>Best, Alex</p>", body_format: "html",
    });
    if ("error" in result) throw new Error(JSON.stringify(result));
    expect(result.body.html).toContain(sourceHtml);
    expect(result.attachments).toEqual([{ attachmentId: "inline-id", cid: "original@example.test", inline: true }]);
  });
});
