import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../../db.js";
import { runReadMessage } from "./read-message.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const UIDVALIDITY = 78_001;
const ACCOUNT_EMAIL = `read-message-live-${process.pid}@example.test`;

interface SeedMessage {
  uid: number;
  subject: string | null;
  fromEmail: string;
  fromName?: string | null;
  toEmails?: string[];
  ccEmails?: string[];
  flags?: string[];
  ageDays: number;
  body?: string;
  bodyPlain?: string;
  selectedTextPart?: string;
  providerThreadId?: string | null;
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  headersJson?: Record<string, unknown>;
}

interface SeedAttachment {
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  disposition: "attachment" | "inline";
  contentId?: string | null;
}

liveDb("read_message tool live DB", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";
  const idByUid = new Map<number, string>();

  async function seedMessage(message: SeedMessage, attachments: SeedAttachment[] = []): Promise<void> {
    const result = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_messages (
        account_id, folder_path, uidvalidity, uid, internal_date,
        subject, from_email, from_name, to_emails, cc_emails, flags,
        provider_thread_id, rfc_message_id, in_reply_to, references_header,
        message_id_normalized, headers_json,
        deleted_in_provider, window_status, size_bytes
      )
      VALUES (
        $1, 'INBOX', $2, $3, now() - ($4 * interval '1 day'),
        $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16,
        false, 'IN_WINDOW', $17
      )
      RETURNING id
      `,
      [
        accountId,
        UIDVALIDITY,
        message.uid,
        message.ageDays,
        message.subject,
        message.fromEmail,
        message.fromName ?? null,
        message.toEmails ?? ["me@example.test"],
        message.ccEmails ?? [],
        message.flags ?? [],
        message.providerThreadId ?? null,
        message.rfcMessageId ?? null,
        message.inReplyTo ?? null,
        message.referencesHeader ?? null,
        message.rfcMessageId ? message.rfcMessageId.replace(/^<|>$/g, "").toLowerCase() : null,
        JSON.stringify(message.headersJson ?? {}),
        (message.body ?? "").length
      ]
    );
    const id = result.rows[0].id;
    idByUid.set(message.uid, id);

    if (message.body !== undefined || message.bodyPlain !== undefined || message.selectedTextPart !== undefined) {
      const raw = message.body ?? message.bodyPlain ?? message.selectedTextPart ?? "";
      await pool.query(
        `
        INSERT INTO public.imap_message_bodies (
          message_id, raw_mime, raw_bytes, raw_truncated,
          body_text, body_plain, selected_text_part
        )
        VALUES ($1, $2, $3, false, $4, $5, $6)
        `,
        [
          id,
          Buffer.from(raw),
          raw.length,
          message.body ?? null,
          message.bodyPlain ?? null,
          message.selectedTextPart ?? null
        ]
      );
      await pool.query("UPDATE public.imap_messages SET body_fetched_at = now() WHERE id = $1", [id]);
    }

    let part = 1;
    for (const a of attachments) {
      await pool.query(
        `
        INSERT INTO public.imap_attachments (
          message_id, filename, mime_type, size_bytes, part_number, content_id, disposition
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [id, a.filename, a.mimeType, a.sizeBytes, String(part), a.contentId ?? null, a.disposition]
      );
      part += 1;
    }
  }

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

    // 1: full body + quote tail + signature, cc, attachment + inline, headers.
    await seedMessage(
      {
        uid: 1,
        subject: "Project kickoff",
        fromEmail: "alice@acme.com",
        fromName: "Alice Acme",
        toEmails: ["me@example.test", "bob@acme.com"],
        ccEmails: ["carol@acme.com"],
        flags: ["\\Seen"],
        ageDays: 1,
        body: [
          "Here is the real reply content the agent should see.",
          "",
          "On Mon, Jan 1, 2026 at 9:00 AM Bob <bob@acme.com> wrote:",
          "> the original quoted message",
          "> second quoted line",
          "",
          "-- ",
          "Alice Acme | Acme Corp"
        ].join("\n"),
        providerThreadId: "thread-kickoff",
        rfcMessageId: "<msg-1@acme.com>",
        headersJson: { "message-id": "<msg-1@acme.com>", "x-priority": "1" }
      },
      [
        { filename: "deck.pdf", mimeType: "application/pdf", sizeBytes: 20480, disposition: "attachment" },
        { filename: "logo.png", mimeType: "image/png", sizeBytes: 1024, disposition: "inline", contentId: "<logo@acme>" }
      ]
    );

    // 2: only body_plain set (exercises coalesce precedence), no attachments.
    await seedMessage({
      uid: 2,
      subject: "Plain only",
      fromEmail: "bob@other.com",
      flags: [],
      ageDays: 3,
      bodyPlain: "This message only has body_plain populated."
    });

    // 3: header-only message (no body row at all → LEFT JOIN must yield null body).
    await seedMessage({
      uid: 3,
      subject: "No body yet",
      fromEmail: "news@list.com",
      flags: ["\\Seen"],
      ageDays: 5
    });
  });

  afterAll(async () => {
    if (accountId) {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    }
    await closePool();
  });

  it("returns a not_found error envelope for an unknown id", async () => {
    const res = await runReadMessage(pool, { message_id: "00000000-0000-0000-0000-000000000000" });
    expect(res).toHaveProperty("error");
    if ("error" in res) {
      expect(res.error.code).toBe("not_found");
      expect(res.error.hint).toContain("search_email");
    }
  });

  it("reads a full message: envelope, cleaned body, attachments, sync_trust", async () => {
    const res = await runReadMessage(pool, { message_id: idByUid.get(1)! });
    expect(res).not.toHaveProperty("error");
    if ("error" in res) throw new Error("unexpected error envelope");

    expect(res.message_id).toBe(idByUid.get(1));
    expect(res.thread_id).toBe("thread-kickoff");
    expect(res.account_id).toBe(accountId);
    expect(res.subject).toBe("Project kickoff");
    expect(res.from).toEqual({ email: "alice@acme.com", name: "Alice Acme" });
    expect(res.to).toContain("bob@acme.com");
    expect(res.cc).toEqual(["carol@acme.com"]);
    expect(res.flags).toEqual(["\\Seen"]);

    // Default include_quoted=false strips the attribution + quoted tail + signature.
    expect(res.body).toContain("real reply content");
    expect(res.body).not.toContain("original quoted message");
    expect(res.body).not.toContain("Acme Corp");

    // Attachments: both dispositions, incl. inline, with disposition + coerced size.
    expect(res.attachments).toHaveLength(2);
    const byName = new Map(res.attachments.map((a) => [a.filename, a]));
    expect(byName.get("deck.pdf")?.disposition).toBe("attachment");
    expect(byName.get("deck.pdf")?.size_bytes).toBe(20480);
    expect(byName.get("logo.png")?.disposition).toBe("inline");

    // Headers omitted unless asked.
    expect(res.headers).toBeUndefined();

    expect(res.sync_trust.accounts.some((a) => a.account_id === accountId)).toBe(true);
  });

  it("keeps the quoted tail when include_quoted=true and parses headers when asked", async () => {
    const res = await runReadMessage(pool, {
      message_id: idByUid.get(1)!,
      include_quoted: true,
      include_headers: true
    });
    if ("error" in res) throw new Error("unexpected error envelope");

    expect(res.body).toContain("original quoted message");
    expect(res.headers).toBeDefined();
    expect(res.headers?.["x-priority"]).toBe("1");
  });

  it("coalesces body_plain when body_text is null", async () => {
    const res = await runReadMessage(pool, { message_id: idByUid.get(2)! });
    if ("error" in res) throw new Error("unexpected error envelope");
    expect(res.body).toBe("This message only has body_plain populated.");
    expect(res.attachments).toEqual([]);
  });

  it("returns a null body for a header-only message (LEFT JOIN, no body row)", async () => {
    const res = await runReadMessage(pool, { message_id: idByUid.get(3)! });
    if ("error" in res) throw new Error("unexpected error envelope");
    expect(res.body).toBeNull();
    expect(res.body_truncated).toBe(false);
    expect(res.body_offset).toBe(0);
    expect(res.body_total_chars).toBe(0);
    expect(res.body_next_offset).toBeNull();
  });

  it("returns the full available cleaned body", async () => {
    const messageId = idByUid.get(2)!;
    const body = "x".repeat(40_000) + "END MARKER";
    await pool.query(
      "UPDATE public.imap_message_bodies SET body_plain = $2 WHERE message_id = $1",
      [messageId, body]
    );

    const result = await runReadMessage(pool, { message_id: messageId });
    if ("error" in result) throw new Error("unexpected error envelope");
    expect(result.body).toBe(body);
    expect(result.body_truncated).toBe(false);
    expect(result.body_offset).toBe(0);
    expect(result.body_total_chars).toBe(40_010);
    expect(result.body_next_offset).toBeNull();
  });

  it("returns an explicit body range when requested", async () => {
    const messageId = idByUid.get(2)!;
    await pool.query(
      "UPDATE public.imap_message_bodies SET body_plain = $2 WHERE message_id = $1",
      [messageId, "0123456789"]
    );

    const result = await runReadMessage(pool, {
      message_id: messageId,
      body_offset: 3,
      max_body_chars: 4
    });
    if ("error" in result) throw new Error("unexpected error envelope");
    expect(result).toMatchObject({
      body: "3456",
      body_truncated: true,
      body_offset: 3,
      body_total_chars: 10,
      body_next_offset: 7
    });
  });
});
