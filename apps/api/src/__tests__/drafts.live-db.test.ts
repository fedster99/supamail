import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getWindowCutoff, type AppConfig } from "../config.js";
import { closePool, getPool } from "../db.js";
import { createDraft, getDraft, listDrafts } from "../drafts.js";
import { MirrorRepository } from "../repository.js";
import type { ImapFolder } from "../types.js";

// The provider side of a draft save: Drafts answers APPEND with APPENDUID 100/50.
vi.mock("../smtp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../smtp-client.js")>();
  return {
    ...actual,
    SentFolderAppender: {
      connect: async () => ({
        list: async () => [{ path: "Drafts", specialUse: "\\Drafts" }],
        append: async () => ({ uidValidity: 100, uid: 50 }),
        searchByMessageId: async () => ({ uids: [], uidValidity: 100 }),
        logout: async () => undefined,
        close: () => undefined
      })
    }
  };
});

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

const config = { IMAP_ENCRYPTION_KEY: "x", IMAP_ALLOW_PRIVATE_HOSTS: false, WINDOW_DAYS: 30 } as unknown as AppConfig;
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

    // A Drafts folder advertised via the \Drafts special-use attribute, already
    // read by sync at UIDVALIDITY 100.
    await pool.query(
      `INSERT INTO public.imap_folders (account_id, path, special_use, uidvalidity, status)
       VALUES ($1, 'Drafts', '\\Drafts', 100, 'ACTIVE')`,
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

  it("getLiveMessageId finds a live row by its exact physical identity only", async () => {
    const repository = new MirrorRepository(pool, config);
    expect(await repository.getLiveMessageId({ accountId, folderPath: "Drafts", uidValidity: 100, uid: 1 })).toBe(idBySubject.get("Folder draft"));
    expect(await repository.getLiveMessageId({ accountId, folderPath: "Drafts", uidValidity: 101, uid: 1 })).toBeNull();
    expect(await repository.getLiveMessageId({ accountId, folderPath: "INBOX", uidValidity: 100, uid: 1 })).toBeNull();
    await seedMessage({ subject: "Deleted draft", folderPath: "Drafts", uid: 9 });
    await pool.query("UPDATE public.imap_messages SET deleted_in_provider = true WHERE id = $1", [
      idBySubject.get("Deleted draft")
    ]);
    expect(await repository.getLiveMessageId({ accountId, folderPath: "Drafts", uidValidity: 100, uid: 9 })).toBeNull();
  });

  it("a saved draft is readable at once, and the next sync keeps its id", async () => {
    const saved = await createDraft(pool, config, {
      accountId,
      to: [{ email: "rcpt@example.test", name: "Rcpt" }],
      subject: "Saved draft",
      body: { format: "plain", text: "saved body" }
    });
    expect(saved).toMatchObject({ appendedUid: 50, warnings: [] });
    expect(saved.messageId).not.toBeNull();

    const draft = await getDraft(pool, config, saved.messageId!);
    expect(draft).toMatchObject({
      messageId: saved.messageId,
      folderPath: "Drafts",
      uid: 50,
      rfcMessageId: saved.rfcMessageId,
      subject: "Saved draft",
      toEmails: ["rcpt@example.test"],
      flags: ["\\Draft", "\\Seen"],
      body: null
    });

    // Sync reads UID 50 again (it is above last_uid) and writes the server's view.
    const repository = new MirrorRepository(pool, config);
    const folder = (await pool.query<ImapFolder>(
      "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'Drafts'",
      [accountId]
    )).rows[0];
    expect(folder.headers_synced_count).toBe(1);
    const [synced] = await repository.upsertMessages(accountId, folder, 100, [{
      uid: 50,
      internalDate: new Date(),
      sizeBytes: 321,
      flags: ["\\Draft", "\\Seen"],
      rfcMessageId: saved.rfcMessageId,
      messageIdNormalized: saved.rfcMessageId.replace(/[<>]/g, ""),
      providerMessageId: "server-object-id",
      providerMessageIdNamespace: "objectid",
      providerThreadId: null,
      providerThreadIdNamespace: null,
      inReplyTo: null,
      referencesHeader: null,
      subject: "Saved draft",
      fromEmail: ACCOUNT_EMAIL,
      fromName: null,
      toEmails: ["rcpt@example.test"],
      toNames: ["Rcpt"],
      ccEmails: [],
      ccNames: [],
      bccEmails: [],
      headersJson: { "message-id": saved.rfcMessageId },
      mimeStructure: { part: "1", type: "text/plain" },
      attachments: []
    }], getWindowCutoff(config));
    expect(synced).toMatchObject({ id: saved.messageId, provider_message_id: "server-object-id", size_bytes: "321" });
    expect(synced.mime_structure).toEqual({ part: "1", type: "text/plain" });
    const counted = await pool.query<{ headers_synced_count: number }>(
      "SELECT headers_synced_count FROM public.imap_folders WHERE id = $1",
      [folder.id]
    );
    expect(counted.rows[0].headers_synced_count).toBe(1);
  });

  it("getDraft returns null for a plain (non-draft) inbox message", async () => {
    const id = idBySubject.get("Plain inbox")!;
    expect(await getDraft(pool, config, id)).toBeNull();
  });
});
