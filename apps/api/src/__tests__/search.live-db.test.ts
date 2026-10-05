import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db.js";
import { deliveryKeys } from "../delivery-identity.js";
import { buildSyncStatus, searchMessages } from "../search/index.js";

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
  });

  it("shows one result per delivery and lists its other stored copies", async () => {
    const raw = Buffer.from("Message-ID: <zephyr-copy@acme.test>\r\n\r\nZephyr launch notes");
    const ids: string[] = [];
    for (const [uid, folder] of [[30, "INBOX"], [31, "Lists"]] as const) {
      const message = await pool.query<{ id: string }>(
        `INSERT INTO public.imap_messages (
           account_id, folder_path, uidvalidity, uid, internal_date, subject, from_email,
           to_emails, flags, message_id_normalized, deleted_in_provider, window_status,
           size_bytes, body_fetched_at
         ) VALUES ($1, $2, $3, $4, now(), 'Zephyr launch', 'sam@acme.example',
           ARRAY['me@example.test'], ARRAY['\\Seen'], 'zephyr-copy@acme.test', false, 'IN_WINDOW', $5, now())
         RETURNING id`,
        [accountId, folder, UIDVALIDITY, uid, raw.byteLength]
      );
      ids.push(message.rows[0].id);
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated, body_text
         ) VALUES ($1, $2::bytea, encode(extensions.digest($2::bytea, 'sha256'), 'hex'), $3, false, 'Zephyr launch notes')`,
        [message.rows[0].id, raw, raw.byteLength]
      );
    }

    const response = await searchMessages(pool, { q: "zephyr", accounts: [accountId] });

    expect(response.results).toHaveLength(1);
    const [result] = response.results;
    expect([result.identity.id, ...(result.duplicate_message_ids ?? [])].sort()).toEqual([...ids].sort());
    expect(result.duplicate_message_ids).toHaveLength(1);

    // Hosts with their own index read the same identity.
    const keys = await deliveryKeys(pool, [...ids, idByUid.get(1)!]);
    expect(keys.get(ids[0])).toBe(keys.get(ids[1]));
    expect(keys.get(idByUid.get(1)!)).not.toBe(keys.get(ids[0]));
  });

  it("resolves in: to the account's folders by path, last name or role", async () => {
    await pool.query(
      `INSERT INTO public.imap_folders (account_id, path, delimiter, special_use, last_synced_at)
       VALUES ($1, 'INBOX', '.', '\\Inbox', now() - interval '1 hour'),
              ($1, 'INBOX.INBOX.Legal', '.', NULL, now() - interval '1 hour'),
              ($1, 'INBOX.INBOX.Sent', '.', '\\Sent', now() - interval '1 hour'),
              ($1, 'INBOX.Sent Messages', '.', NULL, now() - interval '1 hour')`,
      [accountId]
    );
    for (const [uid, folder] of [[40, "INBOX.INBOX.Legal"], [41, "INBOX.INBOX.Sent"], [42, "INBOX.Sent Messages"]] as const) {
      await pool.query(
        `INSERT INTO public.imap_messages (
           account_id, folder_path, uidvalidity, uid, internal_date, subject, from_email,
           to_emails, flags, deleted_in_provider, window_status, size_bytes
         ) VALUES ($1, $2, $3, $4, now(), 'Folder probe', 'me@example.test',
           ARRAY['you@example.test'], ARRAY['\\Recent', '\\Seen'], false, 'IN_WINDOW', 10)`,
        [accountId, folder, UIDVALIDITY, uid]
      );
    }
    const folders = async (q: string): Promise<string[]> => (await searchMessages(pool, { q, accounts: [accountId], groupByThread: false }))
      .results.map((result) => result.identity.folder_path).sort();

    expect(await folders("in:Legal")).toEqual(["INBOX.INBOX.Legal"]);
    const legal = await searchMessages(pool, { q: "in:Legal", accounts: [accountId] });
    expect(legal.results[0].flags).toEqual(["\\Seen"]);
    expect(await folders("in:sent")).toEqual(["INBOX.INBOX.Sent", "INBOX.Sent Messages"]);
    expect(await folders("in:INBOX.INBOX.* folder probe")).toEqual(["INBOX.INBOX.Legal", "INBOX.INBOX.Sent"]);
    expect(await folders("-in:sent folder probe")).toEqual(["INBOX.INBOX.Legal"]);
    const missing = await searchMessages(pool, { q: "in:Legl", accounts: [accountId] });
    expect(missing.results).toEqual([]);
    expect(missing.parsed_query.warnings[0]).toMatch(/^folder "Legl" not found; it matches nothing\. Closest folders: INBOX\.INBOX\.Legal/);
  });

  it("reports a folder synced after the last full account sync as the last sync", async () => {
    await pool.query("UPDATE public.imap_accounts SET last_sync_finished_at = now() - interval '1 day' WHERE id = $1", [accountId]);
    await pool.query(
      `INSERT INTO public.imap_folders (account_id, path, delimiter, last_synced_at)
       VALUES ($1, 'Live', '/', '2099-01-01T00:00:00Z')`,
      [accountId]
    );
    const status = await buildSyncStatus(pool, [accountId]);
    expect(status.accounts[0].last_sync_at).toBe("2099-01-01T00:00:00.000Z");
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

  it("matches either sender with OR and still applies the other operators", async () => {
    const either = await searchMessages(pool, { q: "from:@other.com OR from:@list.com", accounts: [accountId] });
    expect(either.results.map((r) => r.identity.id).sort()).toEqual([idByUid.get(2), idByUid.get(3)].sort());
    expect(either.parsed_query.warnings).toEqual([]);

    const unread = await searchMessages(pool, { q: "from:@other.com OR from:@list.com is:unread", accounts: [accountId] });
    expect(unread.results.map((r) => r.identity.id)).toEqual([idByUid.get(2)]);
  });

  it("matches either word with OR, Gmail style, and drops excluded words", async () => {
    const either = await searchMessages(pool, { q: "weekly OR newsletter", accounts: [accountId] });
    expect(either.results.map((r) => r.identity.id).sort()).toEqual([idByUid.get(2), idByUid.get(3)].sort());

    // "invoice old OR march" is invoice AND (old OR march), not (invoice AND old) OR march.
    const grouped = await searchMessages(pool, { q: "invoice old OR march", accounts: [accountId] });
    expect(grouped.results.map((r) => r.identity.id).sort()).toEqual([idByUid.get(1), idByUid.get(3)].sort());

    // Exclusions apply to typo and concept recall too.
    const excluded = await searchMessages(pool, { q: "invoice -march", accounts: [accountId] });
    expect(excluded.results.map((r) => r.identity.id)).toEqual([idByUid.get(3)]);
    // An excluded word is not a recall term: excluding "invoice" must not recall invoice mail.
    const notInvoice = await searchMessages(pool, { q: "acme -invoice", accounts: [accountId] });
    expect(notInvoice.results.map((r) => r.identity.id)).not.toContain(idByUid.get(1));

    // Text without a searchable word matches nothing.
    const punctuation = await searchMessages(pool, { q: "???", accounts: [accountId] });
    expect(punctuation.results).toEqual([]);
  });

  it("scores only orders that rank: free text with smart or relevance", async () => {
    const ranked = await searchMessages(pool, { q: "invoice", accounts: [accountId] });
    expect(typeof ranked.results[0]?.score).toBe("number");
    const listed = await searchMessages(pool, { q: "invoice sort:recent", accounts: [accountId], explain: true });
    expect(listed.results.length).toBeGreaterThan(0);
    expect(listed.results.map((r) => [r.score, r.score_breakdown])).toEqual(listed.results.map(() => [null, null]));
    const filtered = await searchMessages(pool, { q: "from:@acme.com", accounts: [accountId] });
    expect(filtered.results.length).toBeGreaterThan(0);
    expect(filtered.results.every((r) => r.score === null)).toBe(true);
    // Exclusion-only text ranks nothing.
    const excluded = await searchMessages(pool, { q: "-newsletter", accounts: [accountId] });
    expect(excluded.results.length).toBeGreaterThan(0);
    expect(excluded.results.every((r) => r.score === null)).toBe(true);
  });

  it("names the searched account without sync detail", async () => {
    const response = await searchMessages(pool, { q: "report", accounts: [accountId] });
    expect(response.accounts.map((a) => a.account_id)).toEqual([accountId]);
    expect(response).not.toHaveProperty("sync_trust");
  });
});
