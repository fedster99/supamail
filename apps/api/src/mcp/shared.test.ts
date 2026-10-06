import { describe, expect, it, vi } from "vitest";
import { cleanBody, mapMessageRow, withReadOnlyTx } from "./shared.js";
import { buildCc, buildReferences, quoteText, reSubject } from "./tools/draft-reply.js";
import { MAX_REFERENCES_LENGTH } from "../compose-schema.js";

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
    expect(out.omissions).toEqual(["quoted_reply_tail"]);
  });

  it("keeps the attribution, quote, and signature when includeQuoted is true", () => {
    const out = cleanBody(BODY_WITH_TAIL, { includeQuoted: true });
    expect(out.text).toContain("Alice wrote:");
    expect(out.text).toContain("> quoted line one");
    expect(out.text).toContain("My Signature");
    expect(out.truncated).toBe(false);
    expect(out.omissions).toEqual([]);
  });

  it("returns a large body in full when no explicit bound is supplied", () => {
    const long = "x".repeat(733_287);
    const out = cleanBody(long, { includeQuoted: true });
    expect(out.text).toBe(long);
    expect(out.truncated).toBe(false);
    expect(out.omissions).toEqual([]);
  });

  it("does not mark a short body as truncated", () => {
    const out = cleanBody("short body", { includeQuoted: true });
    expect(out.text).toBe("short body");
    expect(out.truncated).toBe(false);
    expect(out.omissions).toEqual([]);
  });

  it("returns {text:null, truncated:false} for null input", () => {
    expect(cleanBody(null, { includeQuoted: false })).toEqual({
      text: null,
      truncated: false,
      totalChars: 0,
      offset: 0,
      nextOffset: null,
      omissions: []
    });
  });

  it.each([
    [
      "a wrapped attribution",
      "New answer.\n\nOn Friday, August 1, 2026, Alice <alice@example.com>\nwrote:\n> Old answer.\n> Older answer."
    ],
    [
      "a trailing quote-only block",
      "New answer.\n\n> Old answer.\n> Older answer."
    ]
  ])("keeps only authored text before %s", (_label, body) => {
    const out = cleanBody(body, { includeQuoted: false });
    expect(out.text).toBe("New answer.");
    expect(out.truncated).toBe(false);
    expect(out.omissions).toEqual(["quoted_reply_tail"]);
  });

  it("keeps forwarded and ambiguous mail-client blocks", () => {
    const forwarded = "Please review this.\n\n---------- Forwarded message ---------\nFrom: Alice\nSubject: Plan";
    const original = "From: Alice\nSent: Friday\nTo: Bob\nSubject: Plan\n\nThis is the original email.";
    const outlook = "Please review this.\n\nFrom: Alice <alice@example.com>\nSent: Friday, August 1, 2026 10:00\nTo: Bob <bob@example.com>\nSubject: Plan\n\nThe incident started here.";
    const originalMessage = "Please review this.\n\n-----Original Message-----\nFrom: Alice\nSent: Friday\nTo: Bob\nSubject: Plan\n\nThe incident started here.";

    expect(cleanBody(forwarded, { includeQuoted: false }).text).toBe(forwarded);
    expect(cleanBody(original, { includeQuoted: false }).text).toBe(original);
    expect(cleanBody(outlook, { includeQuoted: false }).text).toBe(outlook);
    expect(cleanBody(originalMessage, { includeQuoted: false }).text).toBe(originalMessage);
  });

  it("ends a reply at an Outlook quoted header block", () => {
    const mac = "Hi Paul,\n\nNotes attached.\n\nFrom: Paul <paul@example.com>\nDate: Monday, August 31, 2026 at 8:22 PM\nTo: Namuka <n@example.com>\nCc: Team <t@example.com>\nSubject: Re: Next steps\n\nWhat was the outcome?";
    const windows = "Thanks.\n\n________________________________\nFrom: Alice <alice@example.com>\nSent: Friday, August 1, 2026 10:00\nTo: Bob <bob@example.com>\nSubject: RE: Plan\n\nThe incident started here.";
    const original = "Agreed.\n\n-----Original Message-----\nFrom: Alice\nSent: Friday\nTo: Bob\nSubject: Plan\n\nThe incident started here.";

    for (const [body, authored] of [[mac, "Hi Paul,\n\nNotes attached."], [windows, "Thanks."], [original, "Agreed."]]) {
      const out = cleanBody(body, { includeQuoted: false, subject: "RE: Plan" });
      expect(out.text).toBe(authored);
      expect(out.omissions).toEqual(["quoted_reply_tail"]);
      expect(cleanBody(body, { includeQuoted: true, subject: "RE: Plan" }).text).toBe(body);
    }
  });

  it.each([
    "[EXTERNAL] RE: Plan", "EXT: RE: Plan", "AW: Plan", "SV: Plan", "RE[2]: Plan", "Re : Plan",
    "RE\uFF1APlan", "*EXTERNAL* RE: Plan", "(EXTERNAL) RE: Plan", "EXTERNAL EMAIL: RE: Plan",
    "EXTERNAL RE: Plan", "Antw: Plan", "Odp: Plan", "RES: Plan", "R: Plan", "YNT: Plan", "ΑΠ: Plan",
    "回复: Plan", "答复：Plan"
  ])(
    "treats %s as a reply subject",
    (subject) => {
      const body = "Thanks.\n\nFrom: Alice <alice@example.com>\nSent: Friday\nTo: Bob\nSubject: Plan\n\nEarlier text.";
      expect(cleanBody(body, { includeQuoted: false, subject }).text).toBe("Thanks.");
    }
  );

  it.each([
    "[EXTERNAL] FW: RE: Plan", "Fwd: Plan", "Report: Plan", "[EXTERNAL] Plan", "EXT: Plan", "Aware: Plan",
    "SVG: Plan", "WG: AW: Plan", "TR: RE: Plan", "External review: Plan", "转发: RE: Plan"
  ])("does not treat %s as a reply subject", (subject) => {
    const body = "FYI\n\nFrom: Alice <alice@example.com>\nSent: Friday\nTo: Bob\nSubject: Plan\n\nEarlier text.";
    expect(cleanBody(body, { includeQuoted: false, subject }).text).toBe(body);
  });

  it("keeps Outlook header blocks in forwards, unknown subjects, and replies without authored text", () => {
    const body = "FYI\n\nFrom: Alice <alice@example.com>\nSent: Friday, August 1, 2026 10:00\nTo: Bob <bob@example.com>\nSubject: RE: Plan\n\nThe incident started here.";
    const quotedOnly = "From: Alice\nSent: Friday\nTo: Bob\nSubject: Plan\n\nThe incident started here.";

    expect(cleanBody(body, { includeQuoted: false, subject: "FW: RE: Plan" }).text).toBe(body);
    expect(cleanBody(body, { includeQuoted: false }).text).toBe(body);
    expect(cleanBody(quotedOnly, { includeQuoted: false, subject: "Re: Plan" }).text).toBe(quotedOnly);
  });

  it("reports a removed signature", () => {
    const out = cleanBody("New answer.\n-- \nAlice", { includeQuoted: false });
    expect(out.text).toBe("New answer.");
    expect(out.omissions).toEqual(["signature"]);
  });

  const CONTACT_CARD = "Jane Doe\n\nExample Widgets Ltd\n12 High Street, Springfield, AB1 2CD\nhttps://widgets.example";

  it.each([
    ["a closing", `Sounds good, see you Tuesday.\n\nThanks,\n${CONTACT_CARD}`, "Sounds good, see you Tuesday.\n\nThanks,"],
    ["a bare web address", "See you Tuesday.\n\nJane Doe\n\nExample Widgets Ltd\n500 Main St, Suite 20\nwww.widgets.example", "See you Tuesday."],
    ["trailing blank lines", `See you Tuesday.\n\n${CONTACT_CARD}\n\n`, "See you Tuesday."]
  ])("strips an Outlook contact-card signature after %s", (_label, body, authored) => {
    const out = cleanBody(body, { includeQuoted: false });
    expect(out.text).toBe(authored);
    expect(out.omissions).toEqual(["signature"]);
    expect(cleanBody(body, { includeQuoted: true }).text).toBe(body.replace(/\s+$/, ""));
  });

  it.each([
    ["a link as the last paragraph", "Here is the agenda.\n\nJane Doe\n\nhttps://widgets.example/agenda"],
    ["contact details passed on", `Please send the invoice to:\n\n${CONTACT_CARD}`],
    ["a heading over steps", "Plan below.\n\nNext Steps\n\nShip v2, then review\nhttps://widgets.example/plan"],
    ["a question in the block", "Can you check?\n\nJane Doe\n\nIs 12 High Street, Springfield right?\nhttps://widgets.example"],
    ["no blank line before the block", "See you Tuesday.\nJane Doe\nExample Widgets Ltd\n12 High Street, Springfield, AB1 2CD\nhttps://widgets.example"],
    ["a message that is only the card", CONTACT_CARD],
    ["a lowercase line in place of a name", "Notes below.\n\nsee the office\n\n12 High Street, Springfield, AB1 2CD\nhttps://widgets.example"]
  ])("keeps %s", (_label, body) => {
    const out = cleanBody(body, { includeQuoted: false });
    expect(out.text).toBe(body);
    expect(out.omissions).toEqual([]);
  });

  it("always drops Outlook's first-contact banner and image placeholders without reporting them", () => {
    const body = "You don't often get email from jane@widgets.example. Learn why this is important<https://aka.ms/LearnAboutSenderIdentification>\n\nHi Bob,\uFFFC\n\nThe draft is ready.";
    const wrapped = "Some people who received this message don\u2019t often get email from jane@widgets.example.\nLearn why this is important\nHi Bob,";

    for (const includeQuoted of [false, true]) {
      expect(cleanBody(body, { includeQuoted })).toMatchObject({
        text: "Hi Bob,\n\nThe draft is ready.",
        omissions: []
      });
      expect(cleanBody(wrapped, { includeQuoted }).text).toBe("Hi Bob,");
    }
    const mention = "I keep seeing \"Learn why this is important\" in Outlook.";
    expect(cleanBody(mention, { includeQuoted: false }).text).toBe(mention);
  });

  it("returns a requested range with a stable continuation offset", () => {
    const out = cleanBody("0123456789", {
      includeQuoted: false,
      offset: 3,
      maxChars: 4
    });

    expect(out).toEqual({
      text: "3456",
      truncated: true,
      totalChars: 10,
      offset: 3,
      nextOffset: 7,
      omissions: ["outside_requested_range"]
    });
    expect(cleanBody("0123456789", {
      includeQuoted: false,
      offset: out.nextOffset ?? 0
    })).toEqual({
      text: "789",
      truncated: false,
      totalChars: 10,
      offset: 7,
      nextOffset: null,
      omissions: ["outside_requested_range"]
    });
  });

  it("counts Unicode code points and does not split a surrogate pair", () => {
    const first = cleanBody("A😀B", {
      includeQuoted: true,
      maxChars: 2
    });
    expect(first).toEqual({
      text: "A😀",
      truncated: true,
      totalChars: 3,
      offset: 0,
      nextOffset: 2,
      omissions: ["outside_requested_range"]
    });
    expect(cleanBody("A😀B", {
      includeQuoted: true,
      offset: first.nextOffset ?? 0,
      maxChars: 1
    })).toEqual({
      text: "B",
      truncated: false,
      totalChars: 3,
      offset: 2,
      nextOffset: null,
      omissions: ["outside_requested_range"]
    });
  });

  it("returns an empty final range when the offset is beyond the body", () => {
    expect(cleanBody("short", {
      includeQuoted: true,
      offset: 100,
      maxChars: 4
    })).toEqual({
      text: "",
      truncated: false,
      totalChars: 5,
      offset: 5,
      nextOffset: null,
      omissions: ["outside_requested_range"]
    });
  });
});

describe("mapMessageRow", () => {
  it("keeps sync source truncation distinct from an explicit response range", () => {
    const message = mapMessageRow({
      id: "message-1",
      account_id: "account-1",
      folder_path: "INBOX",
      provider_thread_id: null,
      subject: "Partial source",
      from_email: "alice@example.test",
      from_name: "Alice",
      to_emails: ["me@example.test"],
      cc_emails: [],
      flags: [],
      internal_date: new Date("2026-08-01T00:00:00.000Z"),
      body_text: "0123456789",
      body_plain: null,
      selected_text_part: null,
      raw_truncated: true,
      attachments: []
    }, { includeQuoted: true, maxChars: 4, includeBodyRange: true });

    expect(message).toMatchObject({
      body: "0123",
      body_content_status: "partial",
      body_omissions: ["source_truncated", "outside_requested_range"],
      body_truncated: true,
      body_total_chars: 10,
      body_next_offset: 4
    });
  });
  it("drops the session-only \\Recent flag and omits a missing provider thread id", () => {
    const row = {
      id: "message-1",
      account_id: "account-1",
      folder_path: "INBOX",
      provider_thread_id: null,
      subject: "Flags",
      from_email: "alice@example.test",
      from_name: "Alice",
      to_emails: ["me@example.test"],
      cc_emails: [],
      flags: ["\\Seen", "\\Recent", "\\recent", "$Label"],
      window_status: "IN_WINDOW" as const,
      internal_date: new Date("2026-08-01T00:00:00.000Z"),
      body_text: "hello",
      body_plain: null,
      selected_text_part: null,
      raw_truncated: false,
      attachments: []
    };

    const message = mapMessageRow(row);
    expect(message.flags).toEqual(["\\Seen", "$Label"]);
    expect(message).not.toHaveProperty("thread_id");
    expect(mapMessageRow({ ...row, provider_thread_id: "provider-thread" }).thread_id).toBe("provider-thread");
  });
});

describe("quoteText", () => {
  it("prefixes empty and trailing lines without a per-line string array", () => {
    expect(quoteText("first\n\nlast\n")).toBe("> first\n> \n> last\n> ");
  });
});

describe("withReadOnlyTx", () => {
  it("evicts the client when rollback fails", async () => {
    const workError = new Error("read failed");
    const rollbackError = new Error("rollback failed");
    const query = vi.fn(async (sql: string) => {
      if (sql === "ROLLBACK") throw rollbackError;
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as never;

    await expect(withReadOnlyTx(pool, async () => {
      throw workError;
    })).rejects.toBe(workError);

    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(rollbackError);
  });

  it("releases the client normally after a successful rollback", async () => {
    const workError = new Error("read failed");
    const query = vi.fn(async () => ({ rows: [] }));
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as never;

    await expect(withReadOnlyTx(pool, async () => {
      throw workError;
    })).rejects.toBe(workError);

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(undefined);
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

  it("keeps the root and the newest ids when a long thread exceeds the send limit", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `<message-${String(i).padStart(4, "0")}@lists.example.test>`);
    const out = buildReferences(
      sourceRow({ references_header: ids.join(" "), in_reply_to: ids[399], rfc_message_id: "<src@x>" })
    )!;
    const kept = out.split(" ");
    expect(out.length).toBeLessThanOrEqual(MAX_REFERENCES_LENGTH);
    expect(kept[0]).toBe(ids[0]);
    expect(kept.slice(-2)).toEqual([ids[399], "<src@x>"]);
    expect(ids.slice(400 - (kept.length - 2))).toEqual(kept.slice(1, -1));
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
