import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { PgPool } from "../db.js";
import {
  ContentImapClient,
  cleanMessageBody,
  downloadAttachment,
  getMessageHeaders,
  getRawMime,
  listAttachments,
  selectFields
} from "../content.js";
import { NotFoundError, UnfetchableContentError } from "../errors.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// On-demand IMAP fetch surface (email-004, ADR 0020). Until now ONLY the mirror
// read paths above were covered; the fetch verbs (downloadAttachment, the
// getRawMime/getMessageHeaders FETCH fallbacks) and the whole ContentImapClient
// had zero unit coverage (CRITICAL testing finding). We mock ContentImapClient
// .connect (as mailbox-mutations.test.ts mocks MailboxMutator.connect via spyOn)
// so the real lib functions run their SQL+fetch orchestration with no socket.
// ─────────────────────────────────────────────────────────────────────────────

/** A reader stub standing in for a connected ContentImapClient. logout()/close()
 * mirror the real teardown surface so closeImap() works. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReader(over: { downloadPart?: any; fetchOneSource?: any } = {}) {
  return {
    downloadPart: over.downloadPart ?? vi.fn(async () => Buffer.from("PART-BYTES")),
    fetchOneSource: over.fetchOneSource ?? vi.fn(async () => Buffer.from("RAW-BYTES")),
    logout: vi.fn(async () => undefined),
    close: vi.fn()
  };
}

const connectSpy = vi.spyOn(ContentImapClient, "connect");

const MESSAGE_ROW = {
  id: "m1",
  account_id: "acc-1",
  folder_path: "INBOX",
  uidvalidity: "100",
  uid: "42",
  deleted_in_provider: false
};
const ACCOUNT_ROW = { id: "acc-1", host: "imap.example.test", provider_profile: "generic-imap" };

/**
 * A pool that routes BOTH `pool.query(sql)` (MirrorRepository.getMessage/getAccount)
 * AND `pool.connect().query(sql)` (the content SELECTs) by inspecting the SQL text.
 * `attachment` is the imap_attachments metadata row; `body`/`headers` feed the raw/
 * header mirror SELECTs (return [] / null columns to force the FETCH fallback).
 */
function routingPool(opts: {
  attachment?: Record<string, unknown> | null;
  bodyRow?: Record<string, unknown> | null;
  headerRow?: Record<string, unknown> | null;
  message?: Record<string, unknown> | null;
  account?: Record<string, unknown> | null;
} = {}): PgPool {
  const rowsFor = (value: Record<string, unknown> | null | undefined, fallback: Record<string, unknown>) =>
    value === null ? [] : [value ?? fallback];
  const route = async (sql: string) => {
    // Order matters: the raw/header SELECTs name imap_messages too, so match the
    // more specific tables (attachments, bodies, headers, accounts) FIRST and treat
    // the bare `SELECT * FROM public.imap_messages` (getMessage) as the fallthrough.
    if (/FROM public\.imap_attachments/i.test(sql)) {
      return { rows: opts.attachment == null ? [] : [opts.attachment] };
    }
    if (/FROM public\.imap_accounts/i.test(sql)) {
      return { rows: rowsFor(opts.account, ACCOUNT_ROW) };
    }
    if (/raw_mime/i.test(sql)) {
      return { rows: rowsFor(opts.bodyRow, { raw_mime: null, raw_truncated: false }) };
    }
    if (/headers_json/i.test(sql)) {
      return { rows: rowsFor(opts.headerRow, { headers_json: null, body_headers: null }) };
    }
    if (/SELECT \* FROM public\.imap_messages/i.test(sql)) {
      // MirrorRepository.getMessage (SELECT * FROM public.imap_messages WHERE id=$1)
      return { rows: rowsFor(opts.message, MESSAGE_ROW) };
    }
    return { rows: [] };
  };
  const client = { query: vi.fn(async (sql: string) => route(sql)), release: vi.fn() };
  return {
    query: vi.fn(async (sql: string) => route(sql)),
    connect: vi.fn(async () => client)
  } as unknown as PgPool;
}

afterEach(() => {
  connectSpy.mockReset();
});

describe("downloadAttachment (on-demand IMAP part fetch)", () => {
  it("resolves the attachment + message + account and downloads the part by UID", async () => {
    const reader = fakeReader();
    connectSpy.mockResolvedValue(reader as unknown as ContentImapClient);
    const pool = routingPool({
      attachment: { id: "att-1", message_id: "m1", filename: "report.pdf", mime_type: "application/pdf", size_bytes: "2048", part_number: "2", content_id: null, disposition: "attachment" }
    });

    const out = await downloadAttachment(pool, config, "att-1");

    expect(reader.downloadPart).toHaveBeenCalledTimes(1);
    // folderPath, uidValidity, uid, part, maxBytes — all from the resolved coords.
    expect(reader.downloadPart).toHaveBeenCalledWith("INBOX", 100, 42, "2", config.BODY_RAW_MAX_BYTES);
    expect(out.attachmentId).toBe("att-1");
    expect(out.filename).toBe("report.pdf");
    expect(out.content.toString()).toBe("PART-BYTES");
    // The reader is always torn down.
    expect(reader.logout).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved part number through even when it is a nested part (e.g. 1.2)", async () => {
    const reader = fakeReader();
    connectSpy.mockResolvedValue(reader as unknown as ContentImapClient);
    const pool = routingPool({
      attachment: { id: "att-2", message_id: "m1", filename: "logo.png", mime_type: "image/png", size_bytes: "512", part_number: "1.2", content_id: "<logo>", disposition: "inline" }
    });
    await downloadAttachment(pool, config, "att-2");
    expect(reader.downloadPart).toHaveBeenCalledWith("INBOX", 100, 42, "1.2", config.BODY_RAW_MAX_BYTES);
  });

  it("throws NotFoundError when the attachment id is unknown (no IMAP connect)", async () => {
    const pool = routingPool({ attachment: null });
    await expect(downloadAttachment(pool, config, "missing")).rejects.toBeInstanceOf(NotFoundError);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("throws UnfetchableContentError (→422) when the attachment row has no BODYSTRUCTURE part number", async () => {
    const pool = routingPool({
      attachment: { id: "att-3", message_id: "m1", filename: "x", mime_type: null, size_bytes: null, part_number: null, content_id: null, disposition: "attachment" }
    });
    await expect(downloadAttachment(pool, config, "att-3")).rejects.toBeInstanceOf(UnfetchableContentError);
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

describe("getRawMime fetch branch", () => {
  it("does an on-demand FETCH (source=fetch) when raw_mime is not mirrored (parsed_only)", async () => {
    const reader = fakeReader({ fetchOneSource: vi.fn(async () => Buffer.from("RAW-MIME-BYTES")) });
    connectSpy.mockResolvedValue(reader as unknown as ContentImapClient);
    // bodyRow has raw_mime: null → the fetch fallback fires.
    const pool = routingPool({ bodyRow: { raw_mime: null, raw_truncated: false } });

    const result = await getRawMime(pool, config, "m1");
    expect(result.source).toBe("fetch");
    expect(result.raw.toString()).toBe("RAW-MIME-BYTES");
    expect(reader.fetchOneSource).toHaveBeenCalledWith("INBOX", 100, 42, config.BODY_RAW_MAX_BYTES);
    expect(result.truncated).toBe(false);
  });

  it("flags truncated=true when the fetched source reaches the BODY_RAW_MAX_BYTES boundary", async () => {
    const small = { ...config, BODY_RAW_MAX_BYTES: 4 } as AppConfig;
    // exactly 4 bytes → length >= maxBytes → truncated.
    const reader = fakeReader({ fetchOneSource: vi.fn(async () => Buffer.from("ABCD")) });
    connectSpy.mockResolvedValue(reader as unknown as ContentImapClient);
    const pool = routingPool({ bodyRow: { raw_mime: null, raw_truncated: false } });

    const result = await getRawMime(pool, small, "m1");
    expect(result.source).toBe("fetch");
    expect(result.truncated).toBe(true);
  });

  it("does NOT truncate when the fetched source is below the boundary", async () => {
    const small = { ...config, BODY_RAW_MAX_BYTES: 16 } as AppConfig;
    const reader = fakeReader({ fetchOneSource: vi.fn(async () => Buffer.from("ABCD")) });
    connectSpy.mockResolvedValue(reader as unknown as ContentImapClient);
    const pool = routingPool({ bodyRow: { raw_mime: null, raw_truncated: false } });
    const result = await getRawMime(pool, small, "m1");
    expect(result.truncated).toBe(false);
  });
});

describe("getMessageHeaders fetch fallback", () => {
  it("FETCHes + parses the source headers (source=fetch) when nothing is mirrored", async () => {
    const rawHeaders = "Subject: Hi there\r\nFrom: a@x\r\nMessage-ID: <h@x>\r\n\r\nbody";
    const reader = fakeReader({ fetchOneSource: vi.fn(async () => Buffer.from(rawHeaders)) });
    connectSpy.mockResolvedValue(reader as unknown as ContentImapClient);
    // headerRow with both header maps null → merged is empty → fetch fallback.
    const pool = routingPool({ headerRow: { headers_json: null, body_headers: null } });

    const result = await getMessageHeaders(pool, config, "m1");
    expect(result.source).toBe("fetch");
    expect(reader.fetchOneSource).toHaveBeenCalledTimes(1);
    // The parsed header block carries the source headers.
    expect(result.headers.subject ?? result.headers.Subject).toContain("Hi there");
  });
});

describe("ContentImapClient (UIDVALIDITY guard + verb surface)", () => {
  /** A bare ImapFlow stub the ContentImapClient wraps. `uidValidity` controls the
   * mailbox the lock selects so we can drive the assertUidValidity guard. */
  function imapStub(uidValidity: number | null, over: Record<string, unknown> = {}) {
    return {
      mailbox: uidValidity === null ? false : { uidValidity },
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      download: vi.fn(async () => ({ content: (async function* () { yield Buffer.from("DL"); })() })),
      fetchOne: vi.fn(async () => ({ source: Buffer.from("SRC") })),
      logout: vi.fn(async () => undefined),
      close: vi.fn(),
      ...over
    };
  }

  /** Build a ContentImapClient around a stub ImapFlow (bypassing connect()). */
  function clientFrom(stub: Record<string, unknown>): ContentImapClient {
    return Reflect.construct(ContentImapClient as unknown as new (c: unknown) => ContentImapClient, [stub]);
  }

  it("downloadPart returns the decoded part bytes under a matching UIDVALIDITY", async () => {
    const stub = imapStub(100);
    const client = clientFrom(stub);
    const bytes = await client.downloadPart("INBOX", 100, 42, "2", 1000);
    expect(bytes.toString()).toBe("DL");
    expect(stub.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(stub.download).toHaveBeenCalledWith("42", "2", { uid: true, maxBytes: 1000 });
  });

  it("fetchOneSource returns the message source under a matching UIDVALIDITY", async () => {
    const stub = imapStub(100);
    const client = clientFrom(stub);
    const bytes = await client.fetchOneSource("INBOX", 100, 42, 1000);
    expect(bytes.toString()).toBe("SRC");
  });

  it("downloadPart fails closed (throws) when the live UIDVALIDITY no longer matches", async () => {
    const stub = imapStub(999); // server moved underneath us
    const client = clientFrom(stub);
    await expect(client.downloadPart("INBOX", 100, 42, "2", 1000)).rejects.toThrow(/UIDVALIDITY changed/);
    // The guard fires BEFORE any download.
    expect(stub.download).not.toHaveBeenCalled();
  });

  it("fetchOneSource fails closed (throws) on a UIDVALIDITY mismatch", async () => {
    const stub = imapStub(999);
    const client = clientFrom(stub);
    await expect(client.fetchOneSource("INBOX", 100, 42, 1000)).rejects.toThrow(/UIDVALIDITY changed/);
    expect(stub.fetchOne).not.toHaveBeenCalled();
  });
});
