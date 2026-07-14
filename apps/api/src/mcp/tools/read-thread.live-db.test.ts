import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../../db.js";
import { runReadThread } from "./read-thread.js";
import type { ReadThreadResult } from "./read-thread.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const UIDVALIDITY = 88_002;
const ACCOUNT_EMAIL = `read-thread-live-${process.pid}@example.test`;
const THREAD_ID = `thread-${process.pid}`;
const ACTIVE_CONVERSATION_ID = `thread_${"a".repeat(32)}`;

interface SeedMessage {
  uid: number;
  folderPath?: string;
  subject: string;
  fromEmail: string;
  fromName?: string;
  toEmails?: string[];
  ccEmails?: string[];
  flags?: string[];
  ageDays: number;
  body?: string;
  providerThreadId?: string | null;
  rfcMessageId?: string | null;
  messageIdNormalized?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  deleted?: boolean;
  attachments?: Array<{ filename: string; mimeType: string; sizeBytes: number; partNumber: string; disposition: string }>;
}

function isResult(value: unknown): value is ReadThreadResult {
  return typeof value === "object" && value !== null && "thread" in value;
}

liveDb("read_thread live DB", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";
  const idByUid = new Map<number, string>();

  async function seedMessage(message: SeedMessage): Promise<void> {
    const result = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_messages (
        account_id, folder_path, uidvalidity, uid, internal_date,
        subject, from_email, from_name, to_emails, cc_emails, flags,
        provider_thread_id, rfc_message_id, message_id_normalized,
        in_reply_to, references_header,
        deleted_in_provider, window_status, size_bytes
      )
      VALUES (
        $1, $18, $2, $3, now() - ($4 * interval '1 day'),
        $5, $6, $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15,
        $16, 'IN_WINDOW', $17
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
        message.ccEmails ?? [],
        message.flags ?? [],
        message.providerThreadId === undefined ? null : message.providerThreadId,
        message.rfcMessageId ?? null,
        message.messageIdNormalized ?? null,
        message.inReplyTo ?? null,
        message.referencesHeader ?? null,
        message.deleted ?? false,
        (message.body ?? "").length,
        message.folderPath ?? "INBOX"
      ]
    );
    const id = result.rows[0].id;
    idByUid.set(message.uid, id);

    if (message.body !== undefined) {
      await pool.query(
        `
        INSERT INTO public.imap_message_bodies (
          message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated, body_text, fetched_at
        )
        VALUES ($1, $2, $3, $4, false, $5, now())
        `,
        [
          id,
          Buffer.from(message.body),
          createHash("sha256").update(message.body).digest("hex"),
          message.body.length,
          message.body
        ]
      );
      await pool.query("UPDATE public.imap_messages SET body_fetched_at = now() WHERE id = $1", [id]);
    }

    for (const att of message.attachments ?? []) {
      await pool.query(
        `
        INSERT INTO public.imap_attachments (
          message_id, filename, mime_type, size_bytes, part_number, disposition
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [id, att.filename, att.mimeType, att.sizeBytes, att.partNumber, att.disposition]
      );
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

    // A 3-message provider-threaded conversation (oldest → newest by ageDays).
    await seedMessage({
      uid: 1,
      subject: "Project kickoff",
      fromEmail: "alice@acme.com",
      fromName: "Alice Acme",
      toEmails: ["bob@acme.com"],
      ageDays: 5,
      providerThreadId: THREAD_ID,
      rfcMessageId: "<root@acme.com>",
      messageIdNormalized: "root@acme.com",
      body: "Let's kick off the project on Monday.",
      attachments: [
        { filename: "agenda.pdf", mimeType: "application/pdf", sizeBytes: 1024, partNumber: "2", disposition: "attachment" }
      ]
    });
    await seedMessage({
      uid: 2,
      subject: "Re: Project kickoff",
      fromEmail: "bob@acme.com",
      toEmails: ["alice@acme.com"],
      ccEmails: ["carol@acme.com"],
      ageDays: 4,
      providerThreadId: THREAD_ID,
      rfcMessageId: "<reply1@acme.com>",
      messageIdNormalized: "reply1@acme.com",
      inReplyTo: "<root@acme.com>",
      referencesHeader: "<root@acme.com>",
      body: "Sounds good.\n\nOn Mon, Alice wrote:\n> Let's kick off the project on Monday.\n-- \nBob"
    });
    await seedMessage({
      uid: 3,
      subject: "Re: Project kickoff",
      fromEmail: "alice@acme.com",
      toEmails: ["bob@acme.com", "carol@acme.com"],
      ageDays: 3,
      providerThreadId: THREAD_ID,
      rfcMessageId: "<reply2@acme.com>",
      messageIdNormalized: "reply2@acme.com",
      inReplyTo: "<reply1@acme.com>",
      referencesHeader: "<root@acme.com> <reply1@acme.com>",
      body: "Carol, joining you both."
    });
    // A soft-deleted message in the same thread — must never surface.
    await seedMessage({
      uid: 4,
      subject: "Re: Project kickoff",
      fromEmail: "ghost@acme.com",
      ageDays: 2,
      providerThreadId: THREAD_ID,
      rfcMessageId: "<deleted@acme.com>",
      messageIdNormalized: "deleted@acme.com",
      inReplyTo: "<reply2@acme.com>",
      body: "this message is deleted in provider",
      deleted: true
    });
    // An unrelated message in a different thread — must never surface.
    await seedMessage({
      uid: 5,
      subject: "Unrelated",
      fromEmail: "spam@other.com",
      ageDays: 1,
      providerThreadId: `${THREAD_ID}-other`,
      rfcMessageId: "<other@other.com>",
      messageIdNormalized: "other@other.com",
      body: "nothing to do with the kickoff"
    });

    // A 3-message GENERIC-IMAP thread linked ONLY by headers (no provider_thread_id
    // on any message). Tests header-only reconstruction from the middle seed.
    await seedMessage({
      uid: 6,
      subject: "Header-linked root",
      fromEmail: "x-root@x.com",
      ageDays: 9,
      providerThreadId: null,
      rfcMessageId: "<r0@x>",
      messageIdNormalized: "r0@x",
      body: "header-only root message"
    });
    await seedMessage({
      uid: 7,
      subject: "Re: Header-linked root",
      fromEmail: "x-reply1@x.com",
      ageDays: 8,
      providerThreadId: null,
      rfcMessageId: "<r1@x>",
      messageIdNormalized: "r1@x",
      inReplyTo: "<r0@x>",
      referencesHeader: "<r0@x>",
      body: "header-only reply one"
    });
    await seedMessage({
      uid: 8,
      subject: "Re: Header-linked root",
      fromEmail: "x-reply2@x.com",
      ageDays: 7,
      providerThreadId: null,
      rfcMessageId: "<r2@x>",
      messageIdNormalized: "r2@x",
      inReplyTo: "<r1@x>",
      referencesHeader: "<r0@x> <r1@x>",
      body: "header-only reply two"
    });

    // Physical delivery copies in another folder. With no active assignment for
    // these rows, read_thread uses the exact complete-body digest + Message-ID
    // compatibility key and still returns one logical email.
    await seedMessage({
      uid: 9,
      folderPath: "Sent",
      subject: "Project kickoff",
      fromEmail: "alice@acme.com",
      fromName: "Alice Acme",
      toEmails: ["bob@acme.com"],
      ageDays: 5,
      providerThreadId: THREAD_ID,
      rfcMessageId: "<root@acme.com>",
      messageIdNormalized: "root@acme.com",
      body: "Let's kick off the project on Monday."
    });
    await seedMessage({
      uid: 10,
      folderPath: "Sent",
      subject: "Header-linked root",
      fromEmail: "x-root@x.com",
      ageDays: 9,
      providerThreadId: null,
      rfcMessageId: "<r0@x>",
      messageIdNormalized: "r0@x",
      body: "header-only root message"
    });

    // Three physical rows in one active durable conversation: uid 22 mirrors
    // uid 20 and therefore shares its delivery key. Their provider/header fields
    // intentionally do not connect, proving the active pointer drives the read.
    await seedMessage({
      uid: 20,
      subject: "Active assignment root",
      fromEmail: "active-a@example.test",
      ageDays: 12,
      body: "active root"
    });
    await seedMessage({
      uid: 21,
      subject: "Completely different subject",
      fromEmail: "active-b@example.test",
      ageDays: 11,
      body: "active reply"
    });
    await seedMessage({
      uid: 22,
      folderPath: "Sent",
      subject: "Active assignment root",
      fromEmail: "active-a@example.test",
      ageDays: 12,
      body: "active root"
    });

    const activeRun = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_thread_runs (
        account_id, algorithm_version, mode, status, stage,
        completed_at, activated_at, requested_by
      )
      VALUES ($1, 1, 'initial', 'active', 'ready', now(), now(), 'read-thread-live-test')
      RETURNING id
      `,
      [accountId]
    );
    const inactiveRun = await pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_thread_runs (
        account_id, algorithm_version, mode, status, stage, source_run_id,
        completed_at, requested_by
      )
      VALUES ($1, 2, 'upgrade', 'archived', 'ready', $2, now(), 'read-thread-live-test')
      RETURNING id
      `,
      [accountId, activeRun.rows[0].id]
    );

    const assignmentSql = `
      INSERT INTO public.imap_thread_assignments (
        run_id, message_id, account_id, delivery_key, conversation_id,
        assignment_method, confidence, algorithm_version, input_hash,
        generation, evidence
      )
      VALUES ($1, $2, $3, $4, $5, 'references', 'high', $6, $7, 1, '{}'::jsonb)
    `;
    await pool.query(assignmentSql, [
      activeRun.rows[0].id,
      idByUid.get(20),
      accountId,
      "1".repeat(64),
      ACTIVE_CONVERSATION_ID,
      1,
      "a".repeat(64)
    ]);
    await pool.query(assignmentSql, [
      activeRun.rows[0].id,
      idByUid.get(21),
      accountId,
      "2".repeat(64),
      ACTIVE_CONVERSATION_ID,
      1,
      "b".repeat(64)
    ]);
    await pool.query(assignmentSql, [
      activeRun.rows[0].id,
      idByUid.get(22),
      accountId,
      "1".repeat(64),
      ACTIVE_CONVERSATION_ID,
      1,
      "c".repeat(64)
    ]);
    // Same conversation id in a non-active archived run must remain invisible.
    await pool.query(assignmentSql, [
      inactiveRun.rows[0].id,
      idByUid.get(5),
      accountId,
      "3".repeat(64),
      ACTIVE_CONVERSATION_ID,
      2,
      "d".repeat(64)
    ]);
    await pool.query(
      `
      INSERT INTO public.imap_thread_state (account_id, active_run_id, previous_run_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (account_id) DO UPDATE SET
        active_run_id = EXCLUDED.active_run_id,
        previous_run_id = EXCLUDED.previous_run_id,
        building_run_id = NULL,
        paused_at = NULL,
        pause_reason = NULL
      `,
      [accountId, activeRun.rows[0].id, inactiveRun.rows[0].id]
    );
  });

  afterAll(async () => {
    if (accountId) {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    }
    await closePool();
  });

  it("reassembles a thread from a seed message_id, oldest-first, excluding deleted and unrelated rows", async () => {
    const out = await runReadThread(pool, { message_id: idByUid.get(2) });
    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;

    const ids = out.messages.map((m) => m.message_id);
    expect(ids).toEqual([idByUid.get(1), idByUid.get(2), idByUid.get(3)]);
    expect(ids).not.toContain(idByUid.get(9)); // mirrored Sent copy
    expect(ids).not.toContain(idByUid.get(4)); // soft-deleted
    expect(ids).not.toContain(idByUid.get(5)); // different thread
    expect(out.thread.message_count).toBe(3);
    expect(out.thread.provider_thread_id).toBe(THREAD_ID);
    expect(out.omitted_message_count).toBe(0);
  });

  it("selects directly by thread_id", async () => {
    const out = await runReadThread(pool, { thread_id: THREAD_ID, account: accountId });
    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out.messages.map((m) => m.message_id)).toEqual([idByUid.get(1), idByUid.get(2), idByUid.get(3)]);
    expect(out.messages.map((m) => m.message_id)).not.toContain(idByUid.get(9));
  });

  it("strips quoted tail and signature by default, keeps them with include_quoted", async () => {
    const stripped = await runReadThread(pool, { message_id: idByUid.get(2) });
    const withQuotes = await runReadThread(pool, { message_id: idByUid.get(2), include_quoted: true });
    expect(isResult(stripped) && isResult(withQuotes)).toBe(true);
    if (!isResult(stripped) || !isResult(withQuotes)) return;

    const strippedBody = stripped.messages.find((m) => m.message_id === idByUid.get(2))?.body ?? "";
    const quotedBody = withQuotes.messages.find((m) => m.message_id === idByUid.get(2))?.body ?? "";
    expect(strippedBody).toContain("Sounds good.");
    expect(strippedBody).not.toContain("Alice wrote:");
    expect(strippedBody).not.toContain("Bob");
    expect(quotedBody).toContain("Alice wrote:");
  });

  it("collects distinct participants and a flat attachments_index", async () => {
    const out = await runReadThread(pool, { thread_id: THREAD_ID, account: accountId });
    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;

    expect(out.thread.participants).toEqual(
      expect.arrayContaining(["alice@acme.com", "bob@acme.com", "carol@acme.com"])
    );
    expect(out.attachments_index).toHaveLength(1);
    expect(out.attachments_index[0]).toMatchObject({
      message_id: idByUid.get(1),
      filename: "agenda.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
      disposition: "attachment"
    });
  });

  it("caps to max_messages keeping the newest and reports omitted_message_count", async () => {
    const out = await runReadThread(pool, { thread_id: THREAD_ID, account: accountId, max_messages: 2 });
    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;

    expect(out.messages.map((m) => m.message_id)).toEqual([idByUid.get(2), idByUid.get(3)]);
    expect(out.thread.message_count).toBe(3);
    expect(out.omitted_message_count).toBe(1);
  });

  it("reconstructs a header-only (no provider_thread_id) thread from the middle seed", async () => {
    const out = await runReadThread(pool, { message_id: idByUid.get(7) });
    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;

    const ids = out.messages.map((m) => m.message_id);
    // parent (r0, via the seed's in_reply_to/references matching the parent's
    // message_id_normalized) + self (r1) + child (r2, via the child's in_reply_to
    // matching the seed's rfc_message_id) — all 3, with no provider thread id.
    expect(ids).toEqual([idByUid.get(6), idByUid.get(7), idByUid.get(8)]);
    expect(ids).not.toContain(idByUid.get(10)); // mirrored Sent copy
    expect(out.thread.message_count).toBe(3);
    expect(out.thread.provider_thread_id).toBeNull();
  });

  it("reads only the atomically active run and collapses its physical delivery copies", async () => {
    const out = await runReadThread(pool, { message_id: idByUid.get(20) });
    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;

    expect(out.thread.conversation_id).toBe(ACTIVE_CONVERSATION_ID);
    expect(out.messages.map((message) => message.message_id)).toEqual([
      idByUid.get(20),
      idByUid.get(21)
    ]);
    expect(out.messages.map((message) => message.message_id)).not.toContain(idByUid.get(22));
    // uid 5 has the same conversation id only in the non-active archived run.
    expect(out.messages.map((message) => message.message_id)).not.toContain(idByUid.get(5));
  });

  it("returns a sync_trust block", async () => {
    const out = await runReadThread(pool, { thread_id: THREAD_ID, account: accountId });
    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out.sync_trust.accounts.some((a) => a.account_id === accountId)).toBe(true);
  });

  it("returns a not_found error for an unknown message_id", async () => {
    const out = await runReadThread(pool, { message_id: "00000000-0000-0000-0000-000000000000" });
    expect(out).toHaveProperty("error");
  });

  it("returns an invalid_input error when neither id is given", async () => {
    const out = await runReadThread(pool, {});
    expect(out).toMatchObject({ error: { code: "invalid_input" } });
  });
});
