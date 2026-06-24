import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { closePool, getPool } from "../db.js";
import { getDraft, listDrafts } from "../drafts.js";

/**
 * Live-DB coverage for draft folder resolution (email-003, ADR 0019) against a
 * REAL Postgres: the draftFolderPaths SQL (special_use = '\drafts' OR leaf-name
 * 'drafts', shared via DRAFTS_VOCABULARY) and the listDrafts/getDraft reads. We
 * seed a Drafts folder + messages and assert that a draft in the special-use
 * folder AND a \\Draft-flagged message in a non-Drafts folder are both surfaced,
 * while a plain INBOX message is not. Runs only under test:db:live.
 */

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const config = { IMAP_ENCRYPTION_KEY: "x", IMAP_ALLOW_PRIVATE_HOSTS: false } as unknown as AppConfig;
const ACCOUNT_EMAIL = `drafts-live-${process.pid}@example.test`;

liveDb("draft folder resolution (live DB)", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";
  const idBySubject = new Map<string, string>();

  async function seedMessage(opts: {
    subject: string;
    folderPath: string;
    uid: number;
    flags?: string[];
    toEmails?: string[];
    body?: string;
  }): Promise<void> {
    const result = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_messages (
        account_id, folder_path, uidvalidity, uid, internal_date, subject, to_emails, flags
      )
      VALUES ($1, $2, 100, $3, now(), $4, $5, $6)
      RETURNING id
      `,
      [accountId, opts.folderPath, opts.uid, opts.subject, opts.toEmails ?? ["rcpt@example.test"], opts.flags ?? []]
    );
    const id = result.rows[0].id;
    idBySubject.set(opts.subject, id);
    if (opts.body !== undefined) {
      await pool.query(
        `
        INSERT INTO public.imap_message_bodies (message_id, raw_mime, raw_bytes, raw_truncated, body_text, selected_text_format)
        VALUES ($1, $2, $3, false, $4, 'plain')
        `,
        [id, Buffer.from(opts.body), opts.body.length, opts.body]
      );
    }
  }

  beforeAll(async () => {
    pool = getPool();
    const account = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
       VALUES ($1, 'imap.example.test', 993, $1, $2) RETURNING id`,
      [ACCOUNT_EMAIL, Buffer.from([0])]
    );
    accountId = account.rows[0].id;

    // A Drafts folder advertised via the \Drafts special-use attribute.
    await pool.query(
      `INSERT INTO public.imap_folders (account_id, path, special_use) VALUES ($1, 'Drafts', '\\Drafts')`,
      [accountId]
    );

    // (1) a real draft in the Drafts folder; (2) a \\Draft-flagged message living
    // OUTSIDE a Drafts folder (must still be a draft); (3) a plain INBOX message.
    await seedMessage({ subject: "Folder draft", folderPath: "Drafts", uid: 1, body: "draft body" });
    await seedMessage({ subject: "Flagged draft", folderPath: "INBOX", uid: 2, flags: ["\\Draft"], body: "flagged body" });
    await seedMessage({ subject: "Plain inbox", folderPath: "INBOX", uid: 3, body: "inbox body" });
  });

  afterAll(async () => {
    if (accountId) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    await closePool();
  });

  it("listDrafts surfaces the Drafts-folder message AND the \\Draft-flagged message, not the plain inbox one", async () => {
    const drafts = await listDrafts(pool, config, accountId, {});
    const subjects = drafts.map((d) => d.subject).sort();
    expect(subjects).toEqual(["Flagged draft", "Folder draft"]);
    expect(subjects).not.toContain("Plain inbox");
  });

  it("getDraft returns the folder draft with its body", async () => {
    const id = idBySubject.get("Folder draft")!;
    const draft = await getDraft(pool, config, id);
    expect(draft).not.toBeNull();
    expect(draft!.subject).toBe("Folder draft");
    expect(draft!.body).toBe("draft body");
  });

  it("getDraft returns the \\Draft-flagged message even though it is not in a Drafts folder", async () => {
    const id = idBySubject.get("Flagged draft")!;
    const draft = await getDraft(pool, config, id);
    expect(draft).not.toBeNull();
    expect(draft!.folderPath).toBe("INBOX");
  });

  it("getDraft returns null for a plain (non-draft) inbox message", async () => {
    const id = idBySubject.get("Plain inbox")!;
    expect(await getDraft(pool, config, id)).toBeNull();
  });
});
