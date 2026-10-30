import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { closePool, getPool } from "../db.js";
import { createDraft, sendDraft, updateDraft } from "../drafts.js";
import { MailboxMutator } from "../mailbox-mutations.js";
import { runReadThread } from "../mcp/tools/read-thread.js";
import { sendMessage } from "../send.js";
import { ThreadingRepository } from "../threading-repository.js";

// The provider side of a send or draft save: each folder answers an APPEND with
// APPENDUID 100/<next UID>, keeps the bytes, and answers a FETCH of that UID with
// its metadata, as the server would (ADR 0046).
const provider = vi.hoisted(() => ({ nextUid: 50, stored: new Map<string, Buffer>() }));
vi.mock("../smtp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../smtp-client.js")>();
  return {
    ...actual,
    deliverSmtp: async () => ({ accepted: ["friend@example.test"], rejected: [], response: "250 OK" }),
    resolveSmtpCreds: async () => ({ host: "smtp.example.test", port: 465, secure: true, username: "u", password: "p" }),
    SentFolderAppender: {
      over: () => ({
        list: async () => [{ path: "Drafts", specialUse: "\\Drafts" }, { path: "Sent", specialUse: "\\Sent" }],
        append: async (path: string, raw: Buffer) => {
          const uid = provider.nextUid++;
          provider.stored.set(`${path}/${uid}`, raw);
          return { uidValidity: 100, uid };
        },
        findByMessageId: async () => ({ uids: [], uidValidity: 100 })
      })
    }
  };
});
vi.mock("../host-validation.js", () => ({ assertSafeSmtpTarget: async () => ({ isPrivateHost: false }) }));
vi.mock("../imap-connect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../imap-connect.js")>();
  const { simpleParser } = await import("mailparser");
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>(),
    mailbox: null as null | { path: string; uidValidity: bigint },
    mailboxOpen: async (path: string) => {
      client.mailbox = { path, uidValidity: 100n };
    },
    getMailboxLock: async (path: string) => {
      client.mailbox = { path, uidValidity: 100n };
      return { release: () => undefined };
    },
    fetch: async function* (uids: number[]) {
      for (const uid of uids) {
        const raw = provider.stored.get(`${client.mailbox?.path}/${uid}`);
        if (!raw) continue;
        const parsed = await simpleParser(raw);
        const to = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
        yield {
          uid,
          flags: new Set(["\\Seen"]),
          internalDate: new Date(),
          size: raw.length,
          envelope: { subject: parsed.subject, messageId: parsed.messageId, from: parsed.from?.value,
            to: to.flatMap((list) => list.value) },
          headers: raw.subarray(0, raw.indexOf("\r\n\r\n") + 4),
          bodyStructure: { type: "text/plain", part: "1", size: raw.length }
        };
      }
    }
  };
  return {
    ...actual,
    ActionConnection: class {
      async get() { return { client, abort: { run: <T>(command: () => Promise<T>) => command() } }; }
      async close() {}
    }
  };
});

/**
 * An agent that replies, or saves a reply, reads it in the conversation at once:
 * the action puts its filed copy into the original's conversation, as the
 * threading lane would seconds later. Runs only under test:db:live.
 */
const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const config = {
  IMAP_ENCRYPTION_KEY: "x",
  IMAP_ALLOW_PRIVATE_HOSTS: false,
  IMAP_MAX_COMMANDS_PER_MINUTE: 1_000,
  IMAP_COMMAND_TIMEOUT_MS: 5_000,
  BODY_RAW_MAX_BYTES: 25 * 1024 * 1024,
  BODY_STORAGE_MODE: "raw_mime",
  STALE_HEARTBEAT_MS: 60_000
} as unknown as AppConfig;
const ACCOUNT_EMAIL = `filed-thread-live-${process.pid}@example.test`;
const ORIGINAL = `<filed-thread-original-${process.pid}@example.test>`;

liveDb("a filed reply in its conversation (live DB)", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";
  let originalId = "";
  const reply = () => ({
    accountId,
    to: [{ email: "friend@example.test" }],
    subject: "Re: Plan",
    body: { format: "plain" as const, text: "Sounds good." },
    inReplyTo: ORIGINAL,
    references: ORIGINAL
  });

  async function conversation(): Promise<string[]> {
    const thread = await runReadThread(pool, { message_id: originalId });
    if (!("messages" in thread)) throw new Error(`read_thread failed: ${JSON.stringify(thread)}`);
    return thread.messages.map((message) => message.message_id);
  }

  beforeAll(async () => {
    pool = getPool();
    accountId = (await pool.query<{ id: string }>(
      `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
       VALUES ($1, 'imap.example.test', 993, $1, $2) RETURNING id`,
      [ACCOUNT_EMAIL, Buffer.from([0])]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO public.imap_folders (account_id, path, special_use, uidvalidity, status)
       VALUES ($1, 'Drafts', '\\Drafts', 100, 'ACTIVE'), ($1, 'Sent', '\\Sent', 100, 'ACTIVE')`,
      [accountId]
    );
    originalId = (await pool.query<{ id: string }>(
      `INSERT INTO public.imap_messages (account_id, folder_path, uidvalidity, uid, internal_date, subject,
         from_email, to_emails, rfc_message_id, message_id_normalized)
       VALUES ($1, 'INBOX', 100, 1, now() - interval '1 hour', 'Plan', 'friend@example.test', $2, $3, btrim($3, '<>'))
       RETURNING id`,
      [accountId, [ACCOUNT_EMAIL], ORIGINAL]
    )).rows[0].id;
    // The conversation view is live: the lane built and activated it. Without it,
    // read_thread would find a reply by its In-Reply-To alone.
    const threading = new ThreadingRepository(pool);
    let active = false;
    for (let pass = 0; pass < 100 && !active; pass += 1) {
      active = (await threading.drainAccount(accountId, { requestedBy: "live-test", activateInitial: true })).active;
    }
    expect(active).toBe(true);
    expect(await conversation()).toEqual([originalId]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (accountId) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    await closePool();
  });

  it("each filing action's copy is in the original's conversation when the action returns", async () => {
    // The provider confirms the delete of a replaced or sent draft.
    const mutator = {
      list: async () => [{ path: "Drafts", specialUse: "\\Drafts" }],
      expunge: async () => true,
      logout: async () => undefined,
      close: () => undefined
    } as unknown as MailboxMutator;
    vi.spyOn(MailboxMutator, "connect").mockResolvedValue(mutator);
    vi.spyOn(MailboxMutator, "over").mockReturnValue(mutator);

    const sent = await sendMessage(pool, config, reply());
    expect(await conversation()).toEqual([originalId, sent.messageId]);
    const draft = await createDraft(pool, config, { ...reply(), body: { format: "plain", text: "Draft answer." } });
    expect(await conversation()).toEqual([originalId, sent.messageId, draft.messageId]);
    const updated = await updateDraft(pool, config, draft.messageId!, { ...reply(), body: { format: "plain", text: "Better." } });
    expect(await conversation()).toEqual([originalId, sent.messageId, updated.messageId]);
    const sentDraft = await sendDraft(pool, config, updated.messageId!);
    expect(await conversation()).toEqual([originalId, sent.messageId, sentDraft.send.messageId]);
    for (const result of [sent, draft, updated, sentDraft]) expect(result.warnings).toEqual([]);
  });

  it("an action that cannot assign its copy now still succeeds, and the lane assigns it", async () => {
    const before = await conversation();
    // The lane holds the account's threading lock.
    const lane = await pool.connect();
    // A mirror writer holds the conversation state, so the request bound expires.
    const writer = await pool.connect();
    try {
      await lane.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`supamail.threading:${accountId}`]);
      const draft = await createDraft(pool, config, reply());
      await lane.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`supamail.threading:${accountId}`]);
      await writer.query("BEGIN");
      await writer.query("SELECT 1 FROM public.imap_thread_state WHERE account_id = $1 FOR SHARE", [accountId]);
      const sent = await sendMessage(pool, config, reply());
      await writer.query("COMMIT");

      for (const result of [draft, sent]) {
        expect(result.messageId).not.toBeNull();
        expect(result.warnings).toEqual([]);
      }
      expect(await conversation()).toEqual(before);
      const threading = new ThreadingRepository(pool);
      for (let pass = 0; pass < 10; pass += 1) await threading.drainAccount(accountId, { requestedBy: "live-test" });
      expect(await conversation()).toEqual([...before, draft.messageId, sent.messageId]);
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      lane.release();
      writer.release();
    }
  });
});
