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
  it("returns a plain fallback and semantic, escaped HTML for the full nested quote history", () => {
    const body = buildReplyBody(
      "Thanks <team> & talk soon.",
      "Latest answer.\n\nOn Thu, Alice wrote:\n> Older answer.\n> Oldest answer.",
      "On Fri, Alice <alice@example.test> wrote:"
    );

    expect(body.format).toBe("plain");
    expect(body.text).toContain("> Latest answer.");
    expect(body.text).toContain("> > Older answer.");
    expect(body.html).toContain("<blockquote type=\"cite\">");
    expect(body.html).toContain("Thanks &lt;team&gt; &amp; talk soon.");
    expect(body.html).toContain("Latest answer.");
    expect(body.html).toContain("Older answer.");
    expect(body.html.match(/<blockquote type=\"cite\">/g)).toHaveLength(2);
    expect(body.html).not.toContain("> Latest answer.");
    expect(body.html).not.toContain("&gt; Older answer.");
  });
});
