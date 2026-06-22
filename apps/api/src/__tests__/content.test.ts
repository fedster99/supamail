import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { PgPool } from "../db.js";
import {
  cleanMessageBody,
  getMessageHeaders,
  getRawMime,
  listAttachments,
  selectFields
} from "../content.js";

// A minimal fake pool: every connect() yields a client whose query() returns the
// given rows. Covers the mirror-only read paths (no IMAP round-trip).
function fakePool(rows: unknown[]): PgPool {
  const client = {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    release: vi.fn()
  };
  return { connect: vi.fn(async () => client) } as unknown as PgPool;
}

const config = { BODY_RAW_MAX_BYTES: 1_000_000 } as AppConfig;

describe("selectFields", () => {
  it("returns the object unchanged when no fields are given", () => {
    const v = { a: 1, b: 2 };
    expect(selectFields(v)).toEqual(v);
    expect(selectFields(v, [])).toEqual(v);
  });

  it("projects to only the requested keys and ignores unknown ones", () => {
    expect(selectFields({ a: 1, b: 2, c: 3 }, ["a", "c", "zzz"])).toEqual({ a: 1, c: 3 });
  });
});

describe("listAttachments", () => {
  it("maps mirror rows to AttachmentInfo (mime_type→contentType, size→number, inline disposition)", async () => {
    const pool = fakePool([
      { id: "att-1", message_id: "m1", filename: "report.pdf", mime_type: "application/pdf", size_bytes: "2048", part_number: "2", content_id: null, disposition: "attachment" },
      { id: "att-2", message_id: "m1", filename: "logo.png", mime_type: "image/png", size_bytes: "512", part_number: "1.2", content_id: "<logo>", disposition: "INLINE" }
    ]);
    const out = await listAttachments(pool, config, "m1");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ attachmentId: "att-1", contentType: "application/pdf", sizeBytes: 2048, inline: false });
    expect(out[1]).toMatchObject({ attachmentId: "att-2", contentType: "image/png", sizeBytes: 512, contentId: "<logo>", inline: true });
  });
});

describe("getRawMime (mirror path)", () => {
  it("returns the stored raw_mime with source=mirror and no IMAP fetch", async () => {
    const raw = Buffer.from("Subject: hi\r\n\r\nbody");
    const pool = fakePool([{ raw_mime: raw, raw_bytes: null, raw_truncated: false }]);
    const result = await getRawMime(pool, config, "m1");
    expect(result.source).toBe("mirror");
    expect(result.truncated).toBe(false);
    expect(result.raw.equals(raw)).toBe(true);
  });
});

describe("getMessageHeaders (mirror path)", () => {
  it("merges body+message headers; basic:true keeps only the threading subset", async () => {
    const pool = fakePool([
      {
        headers_json: { "message-id": "<m@x>", "x-mailer": "Foo", subject: "Hello" },
        body_headers: { "in-reply-to": "<p@x>", references: "<a@x> <p@x>", "x-spam": "0" }
      }
    ]);
    const full = await getMessageHeaders(pool, config, "m1");
    expect(full.source).toBe("mirror");
    expect(full.headers).toMatchObject({ "message-id": "<m@x>", "x-mailer": "Foo", "in-reply-to": "<p@x>" });

    const basic = await getMessageHeaders(pool, config, "m1", { basic: true });
    expect(basic.headers).toMatchObject({ "message-id": "<m@x>", "in-reply-to": "<p@x>", references: "<a@x> <p@x>", subject: "Hello" });
    expect(basic.headers["x-mailer"]).toBeUndefined();
    expect(basic.headers["x-spam"]).toBeUndefined();
  });
});

describe("cleanMessageBody (deterministic, no LLM)", () => {
  it("strips the quoted reply tail and signature from the stored body", async () => {
    const body = [
      "Thanks, that works for me.",
      "",
      "-- ",
      "Jane Doe | Acme Corp",
      "",
      "On Mon, Jan 1, 2026 at 9:00 AM, Bob <bob@x> wrote:",
      "> the original message",
      "> second quoted line"
    ].join("\n");
    const pool = fakePool([{ body_text: body, body_plain: null, selected_text_part: null }]);
    const clean = await cleanMessageBody(pool, config, "m1");
    expect(clean.body).toContain("Thanks, that works for me.");
    expect(clean.body).not.toContain("the original message");
    expect(clean.body).not.toContain("Jane Doe | Acme Corp");
  });

  it("keeps the quoted tail when includeQuoted is set", async () => {
    const body = "Reply line.\n\nOn Mon, Bob <bob@x> wrote:\n> original";
    const pool = fakePool([{ body_text: body, body_plain: null, selected_text_part: null }]);
    const clean = await cleanMessageBody(pool, config, "m1", { includeQuoted: true });
    expect(clean.body).toContain("original");
  });
});
