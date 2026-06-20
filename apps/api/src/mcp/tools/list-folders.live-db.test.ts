import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../../db.js";
import { runListFolders } from "./list-folders.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const UIDVALIDITY = 78_001;
const ACCOUNT_EMAIL = `list-folders-live-${process.pid}@example.test`;

interface SeedMessage {
  uid: number;
  folder: string;
  subject: string;
  fromEmail: string;
  flags?: string[];
  ageDays: number;
  body?: string;
  deleted?: boolean;
}

interface ListFoldersOk {
  folders: Array<{ account_id: string; path: string; special_use: string | null; status: string | null; total: number; unread: number }>;
  totals: { total: number; unread: number; flagged: number };
  sync_trust: { accounts: Array<{ account_id: string }>; results_may_be_incomplete: boolean };
}

liveDb("list_folders tool live DB", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";

  async function seedFolder(path: string, specialUse: string | null, status: string): Promise<void> {
    await pool.query(
      `
      INSERT INTO public.imap_folders (account_id, path, special_use, status)
      VALUES ($1, $2, $3, $4)
      `,
      [accountId, path, specialUse, status]
    );
  }

  async function seedMessage(message: SeedMessage): Promise<void> {
    const result = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_messages (
        account_id, folder_path, uidvalidity, uid, internal_date,
        subject, from_email, to_emails, flags,
        deleted_in_provider, window_status, size_bytes
      )
      VALUES (
        $1, $2, $3, $4, now() - ($5 * interval '1 day'),
        $6, $7, $8, $9,
        $10, 'IN_WINDOW', $11
      )
      RETURNING id
      `,
      [
        accountId,
        message.folder,
        UIDVALIDITY,
        message.uid,
        message.ageDays,
        message.subject,
        message.fromEmail,
        ["me@example.test"],
        message.flags ?? [],
        message.deleted ?? false,
        (message.body ?? "").length
      ]
    );
    const id = result.rows[0].id;

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

    await seedFolder("INBOX", "\\Inbox", "ACTIVE");
    await seedFolder("Sent", "\\Sent", "ACTIVE");
    // NOTE: "Archive" folder deliberately has messages but NO imap_folders row,
    // to prove the LEFT JOIN keeps the folder (special_use/status null).

    // INBOX: 3 live (2 unread, 1 of those flagged) + 1 soft-deleted unread that must not count.
    await seedMessage({ uid: 1, folder: "INBOX", subject: "Welcome", fromEmail: "a@x.test", flags: ["\\Seen"], ageDays: 1, body: "hi" });
    await seedMessage({ uid: 2, folder: "INBOX", subject: "Unread one", fromEmail: "b@x.test", flags: [], ageDays: 2, body: "hello" });
    await seedMessage({ uid: 3, folder: "INBOX", subject: "Unread flagged", fromEmail: "c@x.test", flags: ["\\Flagged"], ageDays: 3, body: "important" });
    await seedMessage({ uid: 4, folder: "INBOX", subject: "Deleted unread", fromEmail: "d@x.test", flags: [], ageDays: 4, deleted: true, body: "ghost" });

    // Sent: 2 live, both read (Sent typically carries \Seen).
    await seedMessage({ uid: 5, folder: "Sent", subject: "Re: hi", fromEmail: ACCOUNT_EMAIL, flags: ["\\Seen"], ageDays: 1, body: "reply" });
    await seedMessage({ uid: 6, folder: "Sent", subject: "Re: hello", fromEmail: ACCOUNT_EMAIL, flags: ["\\Seen", "\\Answered"], ageDays: 2, body: "reply2" });

    // Archive (no folder row): 1 live unread.
    await seedMessage({ uid: 7, folder: "Archive", subject: "Old thing", fromEmail: "e@x.test", flags: [], ageDays: 100, body: "archived" });
  });

  afterAll(async () => {
    if (accountId) {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    }
    await closePool();
  });

  it("aggregates per-folder live total/unread and excludes soft-deleted rows", async () => {
    const res = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    const byPath = new Map(res.folders.map((f) => [f.path, f]));

    const inbox = byPath.get("INBOX");
    expect(inbox).toBeDefined();
    expect(inbox?.total).toBe(3); // 4 inserted, 1 soft-deleted excluded
    expect(inbox?.unread).toBe(2); // uid 2 + uid 3; deleted uid 4 never counts
    expect(inbox?.special_use).toBe("\\Inbox");
    expect(inbox?.status).toBe("ACTIVE");

    const sent = byPath.get("Sent");
    expect(sent?.total).toBe(2);
    expect(sent?.unread).toBe(0);
    expect(sent?.special_use).toBe("\\Sent");
  });

  it("keeps folders that have no imap_folders row (LEFT JOIN, not folder_id)", async () => {
    const res = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    const archive = res.folders.find((f) => f.path === "Archive");
    expect(archive).toBeDefined();
    expect(archive?.total).toBe(1);
    expect(archive?.unread).toBe(1);
    expect(archive?.special_use).toBeNull();
    expect(archive?.status).toBeNull();
  });

  it("reports account-wide totals (total/unread/flagged) over the non-deleted live mirror", async () => {
    const res = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    // Live across INBOX(3) + Sent(2) + Archive(1) = 6; deleted uid 4 excluded.
    expect(res.totals.total).toBe(6);
    expect(res.totals.unread).toBe(3); // INBOX uid2, uid3 + Archive uid7
    expect(res.totals.flagged).toBe(1); // only INBOX uid3 has \Flagged
  });

  it("attaches a sync_trust block for the scoped account", async () => {
    const res = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    expect(res.sync_trust.accounts.some((a) => a.account_id === accountId)).toBe(true);
    expect(typeof res.sync_trust.results_may_be_incomplete).toBe("boolean");
  });

  it("aggregates across all accounts when account is omitted (folder rows keep account_id)", async () => {
    const res = (await runListFolders(pool, {})) as ListFoldersOk;
    const mine = res.folders.filter((f) => f.account_id === accountId);
    expect(mine.length).toBeGreaterThanOrEqual(3); // INBOX, Sent, Archive
    expect(mine.every((f) => f.account_id === accountId)).toBe(true);
  });
});
