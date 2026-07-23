import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db.js";
import { searchMessages } from "../search/index.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const UIDVALIDITY = 77_001;
const ACCOUNT_EMAIL = `search-live-${process.pid}@example.test`;

interface SeedMessage {
  uid: number;
  subject: string;
  fromEmail: string;
  fromName?: string;
  toEmails?: string[];
  flags?: string[];
  ageDays: number;
  body?: string;
  deleted?: boolean;
}

liveDb("search layer live DB", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";
  const idByUid = new Map<number, string>();

  async function seedMessage(message: SeedMessage): Promise<void> {
    const result = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_messages (
        account_id, folder_path, uidvalidity, uid, internal_date,
        subject, from_email, from_name, to_emails, flags,
        deleted_in_provider, window_status, size_bytes
      )
      VALUES (
        $1, 'INBOX', $2, $3, now() - ($4 * interval '1 day'),
        $5, $6, $7, $8, $9,
        $10, 'IN_WINDOW', $11
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
        message.flags ?? [],
        message.deleted ?? false,
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
        [id, Buffer.from(message.body), Buffer.byteLength(message.body, "utf8"), message.body]
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

    await seedMessage({
      uid: 1,
      subject: "Acme Invoice March",
      fromEmail: "alice@acme.com",
      fromName: "Alice Acme",
      flags: ["\\Seen"],
      ageDays: 1,
      body: "Please find the March invoice attached, total 1200 dollars."
    });
    await seedMessage({
      uid: 2,
      subject: "Weekly report",
      fromEmail: "bob@other.com",
      flags: [],
      ageDays: 10,
      body: "Here is the weekly report summary for the team."
    });
    await seedMessage({
      uid: 3,
      subject: "Old newsletter",
      fromEmail: "news@list.com",
      flags: ["\\Seen"],
      ageDays: 800,
      body: "Unsubscribe at any time. Some invoice tips inside."
    });
    await seedMessage({
      uid: 4,
      subject: "Deleted invoice secret",
      fromEmail: "ghost@acme.com",
      flags: ["\\Seen"],
      ageDays: 2,
      body: "secret invoice content that must never surface",
      deleted: true
    });
    // Pathological body: ~400KB, far over the 128KB FTS source cap. The generated
    // column must not ERROR on insert (the input is capped before to_tsvector), and
    // a keyword within the indexed prefix must still be findable.
    await seedMessage({
      uid: 5,
      subject: "Large thread",
      fromEmail: "noisy@acme.com",
      flags: ["\\Seen"],
      ageDays: 3,
      body: `behemoth marker ${"x ".repeat(200_000)}`
    });
  });

  afterAll(async () => {
    if (accountId) {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    }
    await closePool();
  });

  it("creates the account-scoped header FTS GIN index", async () => {
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'imap_messages_header_fts_gin'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it("populates header FTS and derives extract FTS through the indexed expression", async () => {
    const header = await pool.query<{ has_header: boolean }>(
      "SELECT header_fts IS NOT NULL AS has_header FROM public.imap_messages WHERE id = $1",
      [idByUid.get(1)]
    );
    expect(header.rows[0].has_header).toBe(true);

    const body = await pool.query<{ has_body: boolean }>(
      "SELECT public.imap_search_extract_fts(search_extract) <> ''::tsvector AS has_body FROM public.imap_message_bodies WHERE message_id = $1",
      [idByUid.get(1)]
    );
    expect(body.rows[0].has_body).toBe(true);
  });

  it("ranks a subject hit above a body-only hit and excludes soft-deleted rows", async () => {
    const response = await searchMessages(pool, { q: "invoice", accounts: [accountId] });
    const ids = response.results.map((r) => r.identity.id);

    expect(ids).toContain(idByUid.get(1)); // subject hit, recent
    expect(ids).toContain(idByUid.get(3)); // body-only hit, very old
    expect(ids).not.toContain(idByUid.get(4)); // soft-deleted, never surfaces
    expect(ids.indexOf(idByUid.get(1)!)).toBeLessThan(ids.indexOf(idByUid.get(3)!));
    expect(response.read_only).toBe(true);
  });

  it("never returns a soft-deleted body even when its term matches", async () => {
    const response = await searchMessages(pool, { q: "secret", accounts: [accountId], includeBody: true });
    expect(response.results).toHaveLength(0);
  });

  it("highlights a snippet around the matched term", async () => {
    const response = await searchMessages(pool, { q: "invoice", accounts: [accountId] });
    const top = response.results.find((r) => r.identity.id === idByUid.get(1));
    expect(top?.snippet ?? "").toContain("<mark>");
  });

  it("indexes a body far larger than the FTS cap without erroring", async () => {
    const response = await searchMessages(pool, { q: "behemoth", accounts: [accountId] });
    expect(response.results.map((r) => r.identity.id)).toContain(idByUid.get(5));
  });

  it("applies is:unread and from:@domain operators", async () => {
    const unread = await searchMessages(pool, { q: "is:unread", accounts: [accountId] });
    expect(unread.results.map((r) => r.identity.id)).toEqual([idByUid.get(2)]);

    const domain = await searchMessages(pool, { q: "from:@acme.com", accounts: [accountId] });
    const domainIds = domain.results.map((r) => r.identity.id);
    expect(domainIds).toContain(idByUid.get(1));
    expect(domainIds).not.toContain(idByUid.get(2)); // bob@other.com
  });

  it("reports a sync-trust block for the searched account", async () => {
    const response = await searchMessages(pool, { q: "report", accounts: [accountId] });
    expect(response.sync_trust.accounts.some((a) => a.account_id === accountId)).toBe(true);
    expect(typeof response.sync_trust.results_may_be_incomplete).toBe("boolean");
  });
});
