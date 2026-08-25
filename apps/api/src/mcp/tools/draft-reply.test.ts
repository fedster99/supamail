import { describe, expect, it } from "vitest";
import { buildReplyBody, formatReplyDate } from "./draft-reply.js";

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
});
