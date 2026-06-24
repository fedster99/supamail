import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { closePool, getPool } from "../db.js";
import { MirrorRepository } from "../repository.js";

/**
 * Live-DB coverage for the flag write-through (email-002, ADR 0018) against a REAL
 * Postgres: setMessageFlags writes the new flag set THROUGH to the mirror row via
 * MirrorRepository.applyMessageFlags so mark-read/star reflect immediately (the
 * flag-scan sync only re-reads recent mail). The IMAP STORE is mocked elsewhere;
 * here we pin the actual transactional UPDATE — case-insensitive add/remove,
 * dedup, account scoping, and the missing-row null. Runs only under test:db:live.
 */

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const config = { IMAP_ENCRYPTION_KEY: "x", IMAP_ALLOW_PRIVATE_HOSTS: false } as unknown as AppConfig;
const ACCOUNT_EMAIL = `mutations-live-${process.pid}@example.test`;

liveDb("flag write-through (live DB)", () => {
  let pool: ReturnType<typeof getPool>;
  let repository: MirrorRepository;
  let accountId = "";
  let otherAccountId = "";

  async function seedMessage(uid: number, flags: string[], account = accountId): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_messages (account_id, folder_path, uidvalidity, uid, internal_date, flags)
      VALUES ($1, 'INBOX', 100, $2, now(), $3)
      RETURNING id
      `,
      [account, uid, flags]
    );
    return result.rows[0].id;
  }

  beforeAll(async () => {
    pool = getPool();
    repository = new MirrorRepository(pool, config);
    const a = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
       VALUES ($1, 'imap.example.test', 993, $1, $2) RETURNING id`,
      [ACCOUNT_EMAIL, Buffer.from([0])]
    );
    accountId = a.rows[0].id;
    const b = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
       VALUES ($1, 'imap.example.test', 993, $1, $2) RETURNING id`,
      [`other-${ACCOUNT_EMAIL}`, Buffer.from([0])]
    );
    otherAccountId = b.rows[0].id;
  });

  afterAll(async () => {
    if (accountId) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    if (otherAccountId) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [otherAccountId]);
    await closePool();
  });

  it("adds a flag and persists it on the mirror row", async () => {
    const id = await seedMessage(1, []);
    const next = await repository.applyMessageFlags(id, accountId, { add: ["\\Seen"] });
    expect(next).toEqual(["\\Seen"]);
    const row = await pool.query<{ flags: string[] }>("SELECT flags FROM public.imap_messages WHERE id = $1", [id]);
    expect(row.rows[0].flags).toEqual(["\\Seen"]);
  });

  it("removes a flag (case-insensitive) and does not duplicate an existing one", async () => {
    const id = await seedMessage(2, ["\\Seen", "\\Flagged"]);
    // Remove \\Flagged with a different case; add \\Seen again (already present).
    const next = await repository.applyMessageFlags(id, accountId, { add: ["\\seen"], remove: ["\\flagged"] });
    expect(next).not.toBeNull();
    expect(next).toContain("\\Seen");
    expect(next).not.toContain("\\Flagged");
    // \\Seen is not duplicated despite being added again.
    expect(next!.filter((f) => f.toLowerCase() === "\\seen")).toHaveLength(1);
  });

  it("returns null and writes nothing when the message is not found for that account", async () => {
    const id = await seedMessage(3, ["\\Seen"]);
    // Same message id, but scoped to the OTHER account → no row → null, no change.
    const next = await repository.applyMessageFlags(id, otherAccountId, { add: ["\\Flagged"] });
    expect(next).toBeNull();
    const row = await pool.query<{ flags: string[] }>("SELECT flags FROM public.imap_messages WHERE id = $1", [id]);
    expect(row.rows[0].flags).toEqual(["\\Seen"]); // untouched
  });
});
