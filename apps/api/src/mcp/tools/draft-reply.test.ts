import { describe, expect, it } from "vitest";
import { formatReplyDate } from "./draft-reply.js";

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
