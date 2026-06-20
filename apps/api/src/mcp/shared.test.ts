import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BODY_CHARS, cleanBody } from "./shared.js";
import { buildCc, buildReferences, reSubject } from "./tools/draft-reply.js";

/**
 * No-DB unit suite for the pure MCP helpers (ADR 0014/0016). These run in the
 * default `pnpm test` lane: cleanBody / reSubject / buildReferences / buildCc are
 * exercised without a Postgres connection so the body-cleaning and reply-header
 * logic stays covered independent of the live-DB tools.
 */

// buildReferences/buildCc read a subset of the draft_reply SourceRow; build the
// minimal shape each helper touches and cast through unknown (SourceRow is private).
function sourceRow(fields: Record<string, unknown>): never {
  return fields as never;
}

describe("cleanBody", () => {
  const BODY_WITH_TAIL =
    "Hello there.\nThis is the reply.\nOn Mon, Alice wrote:\n> quoted line one\n> quoted line two\n-- \nMy Signature\nline 2";

  it("strips the attribution + quoted tail + signature when includeQuoted is false", () => {
    const out = cleanBody(BODY_WITH_TAIL, { includeQuoted: false });
    expect(out.text).toBe("Hello there.\nThis is the reply.");
    expect(out.text).not.toContain("Alice wrote:");
    expect(out.text).not.toContain(">");
    expect(out.text).not.toContain("My Signature");
    expect(out.truncated).toBe(false);
  });

  it("keeps the attribution, quote, and signature when includeQuoted is true", () => {
    const out = cleanBody(BODY_WITH_TAIL, { includeQuoted: true });
    expect(out.text).toContain("Alice wrote:");
    expect(out.text).toContain("> quoted line one");
    expect(out.text).toContain("My Signature");
    expect(out.truncated).toBe(false);
  });

  it("truncates a body longer than the cap and marks truncated", () => {
    const long = "x".repeat(DEFAULT_MAX_BODY_CHARS + 500);
    const out = cleanBody(long, { includeQuoted: true });
    expect(out.text).not.toBeNull();
    expect((out.text ?? "").length).toBeLessThanOrEqual(DEFAULT_MAX_BODY_CHARS);
    expect(out.truncated).toBe(true);
  });

  it("does not mark a short body as truncated", () => {
    const out = cleanBody("short body", { includeQuoted: true });
    expect(out.text).toBe("short body");
    expect(out.truncated).toBe(false);
  });

  it("returns {text:null, truncated:false} for null input", () => {
    expect(cleanBody(null, { includeQuoted: false })).toEqual({ text: null, truncated: false });
  });
});

describe("reSubject", () => {
  it("collapses stacked Re: into a single Re:", () => {
    expect(reSubject("Re: Re: Hello")).toBe("Re: Hello");
  });

  it("rewrites a Fwd: subject as Re:", () => {
    expect(reSubject("Fwd: Hi")).toBe("Re: Hi");
  });

  it("falls back to bare 'Re:' for null or empty subjects", () => {
    expect(reSubject(null)).toBe("Re:");
    expect(reSubject("")).toBe("Re:");
  });
});

describe("buildReferences", () => {
  it("appends the source rfc_message_id to an existing references chain (raw)", () => {
    const out = buildReferences(
      sourceRow({
        references_header: "<root@x> <a@x>",
        in_reply_to: "<a@x>",
        rfc_message_id: "<src@x>"
      })
    );
    expect(out).toBe("<root@x> <a@x> <src@x>");
  });

  it("seeds the chain from in_reply_to when references_header is null", () => {
    const out = buildReferences(
      sourceRow({
        references_header: null,
        in_reply_to: "<a@x>",
        rfc_message_id: "<src@x>"
      })
    );
    expect(out).toBe("<a@x> <src@x>");
  });

  it("returns just the source id when neither references nor in_reply_to is present", () => {
    const out = buildReferences(
      sourceRow({ references_header: null, in_reply_to: null, rfc_message_id: "<src@x>" })
    );
    expect(out).toBe("<src@x>");
  });

  it("returns undefined when there is nothing to chain", () => {
    const out = buildReferences(
      sourceRow({ references_header: null, in_reply_to: null, rfc_message_id: null })
    );
    expect(out).toBeUndefined();
  });
});

describe("buildCc", () => {
  it("dedups, excludes the account's own address (both casings) and the original sender", () => {
    const out = buildCc(
      sourceRow({
        account_email: "me@example.test",
        from_email: "alice@acme.com",
        to_emails: ["me@example.test", "bob@acme.com", "ME@EXAMPLE.TEST"],
        to_names: ["Me", "Bob", "Me Upper"],
        cc_emails: ["carol@acme.com", "bob@acme.com"],
        cc_names: ["Carol", "Bob Dup"]
      })
    );
    const emails = out.map((r) => r.email.toLowerCase());
    expect(emails).toContain("bob@acme.com");
    expect(emails).toContain("carol@acme.com");
    expect(emails).not.toContain("me@example.test");
    expect(emails).not.toContain("alice@acme.com");
    // dedup: bob appears once.
    expect(emails.filter((e) => e === "bob@acme.com")).toHaveLength(1);
    expect(out.find((r) => r.email === "bob@acme.com")?.name).toBe("Bob");
  });

  it("excludes self and original sender even when they are the only recipients", () => {
    const out = buildCc(
      sourceRow({
        account_email: "me@example.test",
        from_email: "alice@acme.com",
        to_emails: ["me@example.test", "alice@acme.com"],
        to_names: ["Me", "Alice"],
        cc_emails: [],
        cc_names: []
      })
    );
    expect(out).toEqual([]);
  });
});
