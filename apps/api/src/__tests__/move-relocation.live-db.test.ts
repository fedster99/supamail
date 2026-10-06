import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getWindowCutoff, type AppConfig } from "../config.js";
import { getAttachmentMetadata, getMessageHeaders, getRawMime, listAttachments } from "../content.js";
import { closePool, getPool } from "../db.js";
import { getDraft } from "../drafts.js";
import { MailboxMutator, moveMessage } from "../mailbox-mutations.js";
import { runReadMessage } from "../mcp/tools/read-message.js";
import { runReadThread } from "../mcp/tools/read-thread.js";
import { MirrorRepository } from "../repository.js";
import type { MessageMetadata } from "../types.js";

/**
 * Live-DB coverage for ADR 0037 against a REAL Postgres:
 *  - a COPYUID-confirmed move relocates the row, so its id, body, and attachments
 *    stay attached, and the destination's later sync updates that same row;
 *  - relocation refuses a destination key already taken, an untracked destination,
 *    or a UIDVALIDITY that does not match the mirrored folder;
 *  - every by-id read refuses a removed row (the contract every new read must keep).
 * Runs only under test:db:live.
 */

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const config = { IMAP_ENCRYPTION_KEY: "x", IMAP_ALLOW_PRIVATE_HOSTS: false, WINDOW_DAYS: 30 } as unknown as AppConfig;
const ACCOUNT_EMAIL = `move-live-${process.pid}@example.test`;

liveDb("a confirmed move keeps the message id (live DB)", () => {
  let pool: ReturnType<typeof getPool>;
  let repository: MirrorRepository;
  let accountId = "";
  let archiveFolderId = "";
  let nextUid = 1;

  async function seedMessage(opts: { folderPath?: string; uidValidity?: number; uid?: number; deleted?: boolean } = {}) {
    const uid = opts.uid ?? nextUid++;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_messages (
         account_id, folder_path, uidvalidity, uid, internal_date, subject, rfc_message_id, deleted_in_provider
       ) VALUES ($1, $2, $3, $4, now(), 'Move me', $5, $6) RETURNING id`,
      [accountId, opts.folderPath ?? "INBOX", opts.uidValidity ?? 100, uid, `<move-${uid}@example.test>`, opts.deleted ?? false]
    );
    const id = result.rows[0].id;
    await pool.query(
      `INSERT INTO public.imap_message_bodies (message_id, raw_mime, raw_bytes, raw_truncated, body_text, selected_text_format)
       VALUES ($1, $2, 4, false, 'body', 'plain')`,
      [id, Buffer.from("body")]
    );
    await pool.query(
      `INSERT INTO public.imap_attachments (message_id, filename, mime_type, size_bytes, part_number, disposition)
       VALUES ($1, 'a.pdf', 'application/pdf', 10, '2', 'attachment')`,
      [id]
    );
    return { id, uid };
  }

  async function row(id: string) {
    const result = await pool.query<{
      folder_id: string | null; folder_path: string; uidvalidity: string; uid: string; deleted_in_provider: boolean;
    }>("SELECT folder_id, folder_path, uidvalidity, uid, deleted_in_provider FROM public.imap_messages WHERE id = $1", [id]);
    return result.rows[0];
  }

  const source = (id: string, uid: number, folderPath = "INBOX") =>
    ({ messageId: id, accountId, folderPath, uidValidity: 100, uid });

  beforeAll(async () => {
    pool = getPool();
    repository = new MirrorRepository(pool, config);
    const account = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
       VALUES ($1, 'imap.example.test', 993, $1, $2) RETURNING id`,
      [ACCOUNT_EMAIL, Buffer.from([0])]
    );
    accountId = account.rows[0].id;
    await pool.query(
      `INSERT INTO public.imap_folders (account_id, path, uidvalidity, status, tracked)
       VALUES ($1, 'INBOX', 100, 'ACTIVE', true), ($1, 'Untracked', 300, 'ACTIVE', false)`,
      [accountId]
    );
    const archive = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_folders (account_id, path, special_use, uidvalidity, status, tracked)
       VALUES ($1, 'Archive', '\\Archive', 200, 'ACTIVE', true) RETURNING id`,
      [accountId]
    );
    archiveFolderId = archive.rows[0].id;
  });

  beforeEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    vi.restoreAllMocks();
    if (accountId) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    await closePool();
  });

  async function folderCount(path: string): Promise<number> {
    const result = await pool.query<{ message_count: number }>(
      "SELECT message_count FROM public.imap_folder_message_counts WHERE account_id = $1 AND folder_path = $2",
      [accountId, path]
    );
    return Number(result.rows[0]?.message_count ?? 0);
  }

  it("relocates the row: same id, new location, body and attachment still attached", async () => {
    const { id, uid } = await seedMessage();
    const [inboxBefore, archiveBefore] = [await folderCount("INBOX"), await folderCount("Archive")];
    const moved = await repository.relocateMovedMessage(source(id, uid), { folderPath: "Archive", uidValidity: 200, uid: 501 });
    // The folder counts (ADR 0036) follow the row.
    expect([await folderCount("INBOX"), await folderCount("Archive")]).toEqual([inboxBefore - 1, archiveBefore + 1]);

    expect(moved).toBe(true);
    expect(await row(id)).toEqual({
      folder_id: archiveFolderId, folder_path: "Archive", uidvalidity: "200", uid: "501", deleted_in_provider: false
    });
    expect((await listAttachments(pool, config, id)).map((a) => a.filename)).toEqual(["a.pdf"]);
    const read = await runReadMessage(pool, { message_id: id });
    expect(read).toMatchObject({ message_id: id, folder_path: "Archive", body: "body" });
  });

  it("is updated in place by the destination's next sync, so the id survives it", async () => {
    const { id, uid } = await seedMessage();
    await repository.relocateMovedMessage(source(id, uid), { folderPath: "Archive", uidValidity: 200, uid: 502 });
    const [archive] = await repository.getFoldersForWake(accountId, ["Archive"]);
    const synced: MessageMetadata = {
      uid: 502, internalDate: new Date(), sizeBytes: 4, flags: ["\\Seen"], rfcMessageId: `<move-${uid}@example.test>`,
      messageIdNormalized: `move-${uid}@example.test`, providerMessageId: null, providerMessageIdNamespace: null,
      providerThreadId: null, providerThreadIdNamespace: null, inReplyTo: null, referencesHeader: null,
      subject: "Move me", fromEmail: "a@example.test", fromName: null, toEmails: [], toNames: [], ccEmails: [],
      ccNames: [], bccEmails: [], headersJson: {}, mimeStructure: null, attachments: []
    };
    const [upserted] = await repository.upsertMessages(accountId, archive, 200, [synced]);

    expect(upserted.id).toBe(id);
    const count = await pool.query("SELECT 1 FROM public.imap_messages WHERE account_id = $1 AND folder_path = 'Archive' AND uid = 502", [accountId]);
    expect(count.rowCount).toBe(1);
  });

  it.each([
    ["the destination UID is already mirrored", "Archive", 200, "taken"],
    ["the destination is not tracked", "Untracked", 300, "free"],
    ["the UIDVALIDITY does not match the mirrored folder", "Archive", 999, "free"],
    ["the destination folder is not mirrored", "Nowhere", 200, "free"]
  ])("does not relocate when %s", async (_case, folderPath, uidValidity, slot) => {
    const { id, uid } = await seedMessage();
    const destinationUid = 600 + uid;
    if (slot === "taken") await seedMessage({ folderPath: "Archive", uidValidity: 200, uid: destinationUid });
    const before = await row(id);

    const moved = await repository.relocateMovedMessage(source(id, uid), { folderPath, uidValidity, uid: destinationUid });

    expect(moved).toBe(false);
    expect(await row(id)).toEqual(before);
  });

  it("moveMessage keeps the id end to end, and the old location is gone", async () => {
    const { id, uid } = await seedMessage();
    vi.spyOn(MailboxMutator, "connect").mockResolvedValue({
      move: async () => ({ uidMap: new Map([[uid, 777]]), uidValidity: 200 }),
      logout: async () => undefined,
      close: () => undefined
    } as unknown as MailboxMutator);

    const result = await moveMessage(pool, config, id, "Archive");

    expect(result).toMatchObject({ messageId: id, toFolder: "Archive", newUid: 777, idKept: true });
    expect(await runReadMessage(pool, { message_id: id })).toMatchObject({ message_id: id, folder_path: "Archive" });
    const atSource = await pool.query(
      "SELECT 1 FROM public.imap_messages WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = $2", [accountId, uid]
    );
    expect(atSource.rowCount).toBe(0);
  });

  it("every by-id read refuses a removed message", async () => {
    const { id } = await seedMessage({ deleted: true });
    const [attachment] = (await pool.query<{ id: string }>(
      "SELECT id FROM public.imap_attachments WHERE message_id = $1", [id]
    )).rows;

    expect(await runReadMessage(pool, { message_id: id })).toMatchObject({ error: { code: "not_found" } });
    expect(await runReadThread(pool, { message_id: id })).toMatchObject({ error: { code: "not_found" } });
    expect(await listAttachments(pool, config, id)).toEqual([]);
    expect(await getAttachmentMetadata(pool, config, attachment.id)).toBeNull();
    expect(await getDraft(pool, config, id)).toBeNull();
    await expect(getRawMime(pool, config, id)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(getMessageHeaders(pool, config, id)).rejects.toMatchObject({ name: "NotFoundError" });
  });
});
