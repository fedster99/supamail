import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPublicMigrations, closePool, getPool, readPublicMigrationFiles } from "../../db.js";
import { folderCountDrift } from "../../__tests__/helpers/integration-harness.js";
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
  totals: { total: number; unread: number };
  accounts: Array<{ account_id: string; account_email: string; notice?: string }>;
}

liveDb("list_folders tool live DB", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";

  async function seedFolder(path: string, specialUse: string | null, status: string, tracked = true): Promise<void> {
    await pool.query(
      `
      INSERT INTO public.imap_folders (account_id, path, special_use, status, tracked)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [accountId, path, specialUse, status, tracked]
    );
  }

  async function countsFor(path: string): Promise<{ total: number; unread: number } | undefined> {
    const res = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    const folder = res.folders.find((f) => f.path === path);
    return folder && { total: folder.total, unread: folder.unread };
  }

  async function seedMessage(message: SeedMessage): Promise<void> {
    const result = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_messages (
        account_id, folder_path, uidvalidity, uid, internal_date,
        subject, from_email, to_emails, flags,
        deleted_in_provider, size_bytes
      )
      VALUES (
        $1, $2, $3, $4, now() - ($5 * interval '1 day'),
        $6, $7, $8, $9,
        $10, $11
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
    await seedFolder("Archive", null, "ACTIVE");
    await seedFolder("Empty", null, "PENDING");
    await seedFolder("[Gmail]/All Mail", "\\All", "ACTIVE", false);
    await seedFolder("Old Project", null, "ACTIVE", false);

    // INBOX: 3 live (2 unread, 1 of those flagged) + 1 soft-deleted unread that must not count.
    await seedMessage({ uid: 1, folder: "INBOX", subject: "Welcome", fromEmail: "a@x.test", flags: ["\\Seen"], ageDays: 1, body: "hi" });
    await seedMessage({ uid: 2, folder: "INBOX", subject: "Unread one", fromEmail: "b@x.test", flags: [], ageDays: 2, body: "hello" });
    await seedMessage({ uid: 3, folder: "INBOX", subject: "Unread flagged", fromEmail: "c@x.test", flags: ["\\Flagged"], ageDays: 3, body: "important" });
    await seedMessage({ uid: 4, folder: "INBOX", subject: "Deleted unread", fromEmail: "d@x.test", flags: [], ageDays: 4, deleted: true, body: "ghost" });

    // Sent: 2 live, both read (Sent typically carries \Seen).
    await seedMessage({ uid: 5, folder: "Sent", subject: "Re: hi", fromEmail: ACCOUNT_EMAIL, flags: ["\\Seen"], ageDays: 1, body: "reply" });
    await seedMessage({ uid: 6, folder: "Sent", subject: "Re: hello", fromEmail: ACCOUNT_EMAIL, flags: ["\\Seen", "\\Answered"], ageDays: 2, body: "reply2" });

    // Old Project: excluded after it was synced; its 1 read message is still live.
    await seedMessage({ uid: 8, folder: "Old Project", subject: "Kickoff", fromEmail: "f@x.test", flags: ["\\Seen"], ageDays: 200 });

    // Archive: 1 live unread.
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

  it("lists empty tracked folders, and untracked ones only while they hold mail", async () => {
    const res = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    const empty = res.folders.find((f) => f.path === "Empty");
    expect(empty).toMatchObject({ total: 0, unread: 0, special_use: null, status: "PENDING" });
    expect(res.folders.find((f) => f.path === "Old Project")).toMatchObject({ total: 1, unread: 0 });
    expect(res.folders.some((f) => f.path === "[Gmail]/All Mail")).toBe(false);
  });

  it("sums the listed folders into totals (total/unread) over the non-deleted live mirror", async () => {
    const res = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    // Live across INBOX(3) + Sent(2) + Archive(1) + Old Project(1) = 7; unread INBOX uid2, uid3 + Archive uid7.
    expect(res.totals).toEqual({ total: 7, unread: 3 });
  });

  it("keeps counts exact through flag changes, tombstones, moves, and deletes", async () => {
    const ids = await pool.query<{ uid: string; id: string }>(
      "SELECT uid, id FROM public.imap_messages WHERE account_id = $1",
      [accountId]
    );
    const id = new Map(ids.rows.map((row) => [Number(row.uid), row.id]));
    const writeFlagsRow = (uid: number, flags: string[] | null) =>
      pool.query("UPDATE public.imap_messages SET flags = $2 WHERE id = $1", [id.get(uid), flags]);
    const writeDeletedRow = (uid: number, deleted: boolean) =>
      pool.query("UPDATE public.imap_messages SET deleted_in_provider = $2 WHERE id = $1", [id.get(uid), deleted]);

    await writeFlagsRow(2, ["\\Seen"]);
    expect(await countsFor("INBOX")).toEqual({ total: 3, unread: 1 });

    await writeFlagsRow(1, null);
    expect(await countsFor("INBOX")).toEqual({ total: 3, unread: 2 });

    await writeDeletedRow(3, true);
    await writeDeletedRow(4, false);
    expect(await countsFor("INBOX")).toEqual({ total: 3, unread: 2 });

    // One statement across folders nets each folder independently.
    await pool.query(
      "UPDATE public.imap_messages SET folder_path = 'Archive' WHERE id = ANY($1::uuid[])",
      [[id.get(1), id.get(5)]]
    );
    expect(await countsFor("INBOX")).toEqual({ total: 2, unread: 1 });
    expect(await countsFor("Sent")).toEqual({ total: 1, unread: 0 });
    expect(await countsFor("Archive")).toEqual({ total: 3, unread: 2 });

    await pool.query("DELETE FROM public.imap_messages WHERE id = $1", [id.get(7)]);
    expect(await countsFor("Archive")).toEqual({ total: 2, unread: 1 });

    // The stored counts equal a fresh count for every folder of the account.
    expect(await folderCountDrift(pool, [accountId])).toEqual([]);
  });

  it("counts without waiting on a folder row that sync holds locked", async () => {
    // Sync locks the folder row before it writes messages. A user write in the
    // same folder must still finish, or the two would deadlock.
    const sync = await pool.connect();
    const user = await pool.connect();
    try {
      await sync.query("BEGIN");
      await sync.query(
        "SELECT id FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX' FOR UPDATE",
        [accountId]
      );
      await user.query("SET lock_timeout = '2s'");
      await user.query(
        `
        UPDATE public.imap_messages SET flags = '{}'
        WHERE account_id = $1 AND folder_path = 'INBOX' AND deleted_in_provider = false
        `,
        [accountId]
      );
    } finally {
      await sync.query("ROLLBACK");
      await user.query("RESET lock_timeout");
      sync.release();
      user.release();
    }
    expect(await countsFor("INBOX")).toEqual({ total: 2, unread: 2 });
  });

  it("leaves the counts row alone for a write that changes no count", async () => {
    // A body or evidence update must not queue behind an open count change in
    // the same folder.
    const live = await pool.query<{ id: string }>(
      `
      SELECT id FROM public.imap_messages
      WHERE account_id = $1 AND folder_path = 'INBOX' AND deleted_in_provider = false
      ORDER BY uid
      `,
      [accountId]
    );
    expect(live.rows.length).toBeGreaterThanOrEqual(2);
    const [counted, untouched] = live.rows.map((row) => row.id);
    const counting = await pool.connect();
    const other = await pool.connect();
    try {
      await counting.query("BEGIN");
      await counting.query(
        "UPDATE public.imap_messages SET flags = CASE WHEN flags @> $2::text[] THEN '{}' ELSE $2::text[] END WHERE id = $1",
        [counted, ["\\Seen"]]
      );
      await other.query("SET lock_timeout = '2s'");
      await other.query("UPDATE public.imap_messages SET body_fetched_at = now() WHERE id = $1", [untouched]);
    } finally {
      await counting.query("ROLLBACK");
      await other.query("RESET lock_timeout");
      counting.release();
      other.release();
    }
  });

  it("drops an account's counts with the account", async () => {
    const other = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
      VALUES ($1, 'imap.example.test', 993, $1, $2)
      RETURNING id
      `,
      [`other-${ACCOUNT_EMAIL}`, Buffer.from([0])]
    );
    const otherId = other.rows[0].id;
    await pool.query(
      `
      INSERT INTO public.imap_messages (account_id, folder_path, uidvalidity, uid, internal_date)
      VALUES ($1, 'INBOX', $2, 1, now())
      `,
      [otherId, UIDVALIDITY]
    );
    await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [otherId]);
    const left = await pool.query(
      "SELECT 1 FROM public.imap_folder_message_counts WHERE account_id = $1",
      [otherId]
    );
    expect(left.rows).toEqual([]);
  });

  it("backfills counts from existing mail once, and a second migrate keeps them", async () => {
    const before = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    // A database from before 0028: no counts table. Run 0028 itself, as its
    // first apply did; later migrations dropped objects earlier files create, so
    // the whole set no longer re-runs (ADR 0040).
    const counts = (await readPublicMigrationFiles()).find((migration) => migration.id === "0028_folder_message_counts")!;
    try {
      await pool.query("DROP TABLE public.imap_folder_message_counts");
    } finally {
      // Later test files share this database; never leave it without the table.
      await pool.query(counts.sql);
    }
    const backfilled = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    await applyPublicMigrations(pool);
    const rerun = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    expect(backfilled.folders).toEqual(before.folders);
    expect(rerun.folders).toEqual(before.folders);
  });

  it("names the scoped account without sync detail", async () => {
    const res = (await runListFolders(pool, { account: accountId })) as ListFoldersOk;
    expect(res.accounts).toEqual([{ account_id: accountId, account_email: ACCOUNT_EMAIL, notice: "first_sync_in_progress" }]);
    expect(res).not.toHaveProperty("sync_trust");
  });

  it("aggregates across all accounts when account is omitted (folder rows keep account_id)", async () => {
    const res = (await runListFolders(pool, {})) as ListFoldersOk;
    const mine = res.folders.filter((f) => f.account_id === accountId);
    expect(mine.length).toBeGreaterThanOrEqual(5); // INBOX, Sent, Archive, Empty, Old Project
    expect(mine.every((f) => f.account_id === accountId)).toBe(true);
  });
});
