import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { closePool, getPool } from "../db.js";
import { getAttachmentMetadata, getMessageHeaders, getRawMime, listAttachments } from "../content.js";

/**
 * Live-DB coverage for the content read surface (email-004, ADR 0020) against a
 * REAL Postgres: the attachment-metadata SQL (incl. the numeric-aware part_number
 * ORDER BY that the unit tests with a fake pool cannot exercise), and the mirror
 * (no-IMAP) branches of getRawMime / getMessageHeaders. The on-demand IMAP FETCH
 * branches are covered by the mocked unit tests + the greenmail smoke; here we pin
 * the SQL itself. Runs only under the test:db:live harness (LIVE_DB_TESTS=1).
 */

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const config = { BODY_RAW_MAX_BYTES: 1_000_000 } as AppConfig;
const ACCOUNT_EMAIL = `content-live-${process.pid}@example.test`;

liveDb("content read surface (live DB)", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";
  let messageId = "";

  beforeAll(async () => {
    pool = getPool();
    const account = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
      VALUES ($1, 'imap.example.test', 993, $1, $2)
      RETURNING id
      `,
      [ACCOUNT_EMAIL, Buffer.from([0])]
    );
    accountId = account.rows[0].id;

    const message = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_messages (
        account_id, folder_path, uidvalidity, uid, internal_date,
        subject, from_email, headers_json
      )
      VALUES ($1, 'INBOX', 100, 42, now(), 'Live content subject', 'a@example.test',
              '{"X-Mailer": "Probe", "Subject": "Live content subject"}'::jsonb)
      RETURNING id
      `,
      [accountId]
    );
    messageId = message.rows[0].id;

    // A stored body so the mirror branch of getRawMime / getMessageHeaders fires.
    await pool.query(
      `
      INSERT INTO public.imap_message_bodies (
        message_id, raw_mime, raw_bytes, raw_truncated, body_text, headers_json
      )
      VALUES ($1, $2, $3, false, 'the stored body text',
              '{"In-Reply-To": "<parent@example.test>"}'::jsonb)
      `,
      [messageId, Buffer.from("Subject: Live content subject\r\n\r\nbody"), 37]
    );

    // Three attachments whose part_numbers must sort numerically: "10" must come
    // AFTER "2" (string sort would put "10" first). part_number=NULL sorts last.
    const atts: Array<[string | null, string]> = [
      ["10", "tenth.bin"],
      ["2", "second.bin"],
      [null, "null-part.bin"]
    ];
    for (const [part, name] of atts) {
      await pool.query(
        `
        INSERT INTO public.imap_attachments (message_id, filename, mime_type, size_bytes, part_number, disposition)
        VALUES ($1, $2, 'application/octet-stream', 1024, $3, 'attachment')
        `,
        [messageId, name, part]
      );
    }
  });

  afterAll(async () => {
    if (accountId) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    await closePool();
  });

  it("orders attachment metadata by NUMERIC part_number (so '10' sorts after '2'), NULLs last", async () => {
    const out = await listAttachments(pool, config, messageId);
    expect(out.map((a) => a.partNumber)).toEqual(["2", "10", null]);
    expect(out.map((a) => a.filename)).toEqual(["second.bin", "tenth.bin", "null-part.bin"]);
  });

  it("getAttachmentMetadata returns one row's mapped metadata, or null for an unknown id", async () => {
    const all = await listAttachments(pool, config, messageId);
    const meta = await getAttachmentMetadata(pool, config, all[0].attachmentId);
    expect(meta).toMatchObject({ attachmentId: all[0].attachmentId, contentType: "application/octet-stream", sizeBytes: 1024 });
    expect(await getAttachmentMetadata(pool, config, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("getRawMime returns the stored raw_mime (source=mirror) with no IMAP fetch", async () => {
    const result = await getRawMime(pool, config, messageId);
    expect(result.source).toBe("mirror");
    expect(result.raw.toString()).toContain("Live content subject");
  });

  it("getMessageHeaders merges message + body headers from the mirror (source=mirror)", async () => {
    const result = await getMessageHeaders(pool, config, messageId);
    expect(result.source).toBe("mirror");
    // The message row's headers_json + the body's headers_json are both projected.
    expect(result.headers["X-Mailer"] ?? result.headers["x-mailer"]).toBe("Probe");
    expect(result.headers["In-Reply-To"] ?? result.headers["in-reply-to"]).toBe("<parent@example.test>");

    const basic = await getMessageHeaders(pool, config, messageId, { basic: true });
    expect(basic.headers["X-Mailer"] ?? basic.headers["x-mailer"]).toBeUndefined();
  });
});
