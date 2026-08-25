import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../../db.js";
import { runDraftReply } from "./draft-reply.js";
import type { DraftReply } from "./draft-reply.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const UIDVALIDITY = 78_001;
const ACCOUNT_EMAIL = `draft-live-${process.pid}@example.test`;

interface SeedMessage {
  uid: number;
  subject: string | null;
  fromEmail: string | null;
  fromName?: string | null;
  toEmails?: string[];
  toNames?: (string | null)[];
  ccEmails?: string[];
  ccNames?: (string | null)[];
  rfcMessageId?: string | null;
  referencesHeader?: string | null;
  inReplyTo?: string | null;
  providerThreadId?: string | null;
  body?: string;
}

function isDraft(value: DraftReply | { error: unknown }): asserts value is DraftReply {
  if ("error" in value) {
    throw new Error(`Expected a draft, got error: ${JSON.stringify(value.error)}`);
  }
}

liveDb("draft_reply live DB", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";
  const idByUid = new Map<number, string>();

  async function seedMessage(message: SeedMessage): Promise<void> {
    const result = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_messages (
        account_id, folder_path, uidvalidity, uid, internal_date,
        subject, from_email, from_name, to_emails, to_names,
        cc_emails, cc_names, rfc_message_id, references_header, in_reply_to,
        provider_thread_id, window_status, size_bytes
      )
      VALUES (
        $1, 'INBOX', $2, $3, now() - interval '1 hour',
        $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13,
        $14, 'IN_WINDOW', $15
      )
      RETURNING id
      `,
      [
        accountId,
        UIDVALIDITY,
        message.uid,
        message.subject,
        message.fromEmail,
        message.fromName ?? null,
        message.toEmails ?? null,
        message.toNames ?? null,
        message.ccEmails ?? null,
        message.ccNames ?? null,
        message.rfcMessageId ?? null,
        message.referencesHeader ?? null,
        message.inReplyTo ?? null,
        message.providerThreadId ?? null,
        (message.body ?? "").length
      ]
    );
    const id = result.rows[0].id;
    idByUid.set(message.uid, id);

    if (message.body !== undefined) {
      await pool.query(
        `
        INSERT INTO public.imap_message_bodies (
          message_id, raw_mime, raw_bytes, raw_truncated, body_text
        )
        VALUES ($1, $2, $3, false, $4)
        `,
        [id, Buffer.from(message.body), message.body.length, message.body]
      );
      await pool.query("UPDATE public.imap_messages SET body_fetched_at = now() WHERE id = $1", [id]);
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

    // 1: fully-threaded message with references + own Message-ID, To+Cc for reply-all.
    await seedMessage({
      uid: 1,
      subject: "Re: Quarterly numbers",
      fromEmail: "alice@acme.com",
      fromName: "Alice Acme",
      toEmails: [ACCOUNT_EMAIL, "bob@acme.com"],
      toNames: ["Me", "Bob Builder"],
      ccEmails: ["carol@acme.com", ACCOUNT_EMAIL.toUpperCase()],
      ccNames: ["Carol", "Me Upper"],
      rfcMessageId: "<msg-1@acme.com>",
      referencesHeader: "<root@acme.com> <msg-0@acme.com>",
      providerThreadId: "thread-xyz",
      body: "Here are the numbers.\nLine two."
    });

    // 2: no rfc_message_id (In-Reply-To must be omitted + warning), null subject.
    await seedMessage({
      uid: 2,
      subject: null,
      fromEmail: "dave@other.com",
      fromName: null,
      toEmails: [ACCOUNT_EMAIL],
      rfcMessageId: null,
      inReplyTo: "<earlier@other.com>",
      referencesHeader: null,
      body: "No message id here."
    });

    await seedMessage({
      uid: 3,
      subject: "Long source",
      fromEmail: "long@example.com",
      body: `${"x".repeat(4_097)}END MARKER`
    });
  });

  afterAll(async () => {
    if (accountId) {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    }
    await closePool();
  });

  it("derives From=account, To=sender, a single Re: subject, and threading headers", async () => {
    const draft = await runDraftReply(pool, { source_message_id: idByUid.get(1), body: "Thanks!" });
    isDraft(draft);

    expect(draft.draftId).toBe(`drf_${idByUid.get(1)}`);
    expect(draft.from.email).toBe(ACCOUNT_EMAIL);
    expect(draft.to).toEqual([{ email: "alice@acme.com", name: "Alice Acme" }]);
    expect(draft.subject).toBe("Re: Quarterly numbers"); // single Re:, not "Re: Re: ..."
    expect(draft.headers["In-Reply-To"]).toBe("<msg-1@acme.com>"); // RAW angle-bracketed
    expect(draft.headers.References).toBe("<root@acme.com> <msg-0@acme.com> <msg-1@acme.com>");
    expect(draft.headers["X-SupaMail-Draft"]).toBe("produced-not-sent");
    expect(draft.threadId).toBe("thread-xyz");
    expect(draft.body.format).toBe("plain");
    expect(draft.body.text.startsWith("Thanks!\n\nOn ")).toBe(true);
    expect(draft.body.text).toContain("Alice Acme <alice@acme.com> wrote:");
    expect(draft.body.text).toContain("> Here are the numbers.");
    // Every line of the quoted original is prefixed, not just the first — a
    // first-line-only regression would leave "Line two." unprefixed.
    expect(draft.body.text).toContain("> Line two.");
    const quotedLines = draft.body.text.split("\n").filter((l) => l.startsWith("> "));
    expect(quotedLines.length).toBeGreaterThan(1);
    expect(draft.body.html).toContain('<div class="gmail_quote gmail_quote_container">');
    expect(draft.body.html).toContain('<blockquote class="gmail_quote" type="cite"');
    expect(draft.body.html.match(/<blockquote/g)).toHaveLength(1);
    expect(draft.body.html).toContain("Here are the numbers.");
    expect(draft.body.html).not.toContain("> Here are the numbers.");
    expect(draft.warnings).toEqual([]);
  });

  it("does not include Cc unless reply_all is set", async () => {
    const draft = await runDraftReply(pool, { source_message_id: idByUid.get(1), body: "Thanks!" });
    isDraft(draft);
    expect(draft.cc).toEqual([]);
  });

  it("reply_all Cc = To+Cc minus self (case-insensitive) and minus the original sender", async () => {
    const draft = await runDraftReply(pool, {
      source_message_id: idByUid.get(1),
      body: "Thanks all!",
      reply_all: true
    });
    isDraft(draft);
    const ccEmails = draft.cc.map((r) => r.email.toLowerCase());
    expect(ccEmails).toContain("bob@acme.com");
    expect(ccEmails).toContain("carol@acme.com");
    // self excluded in both casings; original sender (To) not duplicated into Cc.
    expect(ccEmails).not.toContain(ACCOUNT_EMAIL.toLowerCase());
    expect(ccEmails).not.toContain("alice@acme.com");
    expect(draft.cc.find((r) => r.email === "bob@acme.com")?.name).toBe("Bob Builder");
  });

  it("omits In-Reply-To and warns when the source has no Message-ID; subject falls back to 'Re:'", async () => {
    const draft = await runDraftReply(pool, { source_message_id: idByUid.get(2), body: "Got it." });
    isDraft(draft);
    expect(draft.headers["In-Reply-To"]).toBeUndefined();
    // references_header null but in_reply_to present → chain seeded from in_reply_to.
    expect(draft.headers.References).toBe("<earlier@other.com>");
    expect(draft.subject).toBe("Re:");
    expect(draft.warnings.some((w) => w.includes("Message-ID"))).toBe(true);
  });

  it("quotes the full available source instead of silently shortening it", async () => {
    const draft = await runDraftReply(pool, { source_message_id: idByUid.get(3), body: "Thanks." });
    isDraft(draft);
    expect(draft.body.text).toContain(`> ${"x".repeat(4_097)}END MARKER`);
  });

  it("returns a not_found error for an unknown source id", async () => {
    const result = await runDraftReply(pool, {
      source_message_id: "00000000-0000-0000-0000-000000000000",
      body: "x"
    });
    expect("error" in result && result.error.code).toBe("not_found");
  });
});
