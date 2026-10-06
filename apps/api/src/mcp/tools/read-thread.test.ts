import { describe, expect, it, vi } from "vitest";
import { runReadThread } from "./read-thread.js";
import type { ReadThreadResult } from "./read-thread.js";

const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
const BATCH_IDS = Array.from(
  { length: 11 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
);
const MESSAGE_ONE = BATCH_IDS[0];
const MESSAGE_TWO = BATCH_IDS[1];
const MISSING_MESSAGE = BATCH_IDS[2];
const BROKEN_MESSAGE = BATCH_IDS[3];
const MESSAGE_SEED = BATCH_IDS[4];
const LEGACY_SEED = BATCH_IDS[5];
const CONCURRENCY_IDS = Array.from(
  { length: 10 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`
);
const conversationFor = (messageId: string) => `conversation-${messageId}`;

function isResult(value: unknown): value is ReadThreadResult {
  return typeof value === "object" && value !== null && "thread" in value;
}

function assignedConversationPool() {
  const query = vi.fn(async (
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("WHERE m.id = $1")) {
      return {
        rows: [
          {
            id: "message-seed",
            provider_thread_id: "provider-thread",
            rfc_message_id: "<seed@example.test>",
            message_id_normalized: "seed@example.test",
            in_reply_to: null,
            references_header: null,
            account_id: ACCOUNT_ID,
            conversation_id: "conversation-1"
          }
        ]
      };
    }
    if (sql.includes("WITH delivery_copies")) {
      return {
        rows: [
          {
            id: "message-representative",
            account_id: ACCOUNT_ID,
            folder_path: "INBOX",
            provider_thread_id: "provider-thread",
            conversation_id: "conversation-1",
            subject: "A stored conversation",
            from_email: "alice@example.test",
            from_name: "Alice",
            to_emails: ["bob@example.test"],
            cc_emails: [],
            flags: [],
            internal_date: new Date("2026-01-02T03:04:05.000Z"),
            body_text: "hello",
            body_plain: null,
            selected_text_part: null,
            attachments: []
          }
        ]
      };
    }
    if (sql.includes("FROM public.imap_accounts a")) return { rows: [] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  return { pool, query };
}

function unassignedSeedPool() {
  const query = vi.fn(async (
    sql: string,
    _values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("WHERE m.id = $1")) {
      return {
        rows: [
          {
            id: "legacy-seed",
            provider_thread_id: null,
            rfc_message_id: "<legacy@example.test>",
            message_id_normalized: "legacy@example.test",
            in_reply_to: null,
            references_header: null,
            account_id: ACCOUNT_ID,
            conversation_id: null
          }
        ]
      };
    }
    if (sql.includes("WITH legacy_candidates")) {
      return {
        rows: [
          {
            id: "legacy-seed",
            account_id: ACCOUNT_ID,
            folder_path: "INBOX",
            provider_thread_id: null,
            conversation_id: null,
            subject: "Awaiting a threading run",
            from_email: "alice@example.test",
            from_name: "Alice",
            to_emails: ["bob@example.test"],
            cc_emails: [],
            flags: [],
            internal_date: new Date("2026-01-02T03:04:05.000Z"),
            body_text: "hello",
            body_plain: null,
            selected_text_part: null,
            attachments: []
          }
        ]
      };
    }
    if (sql.includes("FROM public.imap_accounts a")) return { rows: [] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  return { pool, query };
}

function batchConversationPool(conversationOf: (messageId: string) => string = conversationFor) {
  let accountQueryCount = 0;
  const connect = vi.fn(async () => {
    const query = vi.fn(async (
      sql: string,
      values?: unknown[]
    ): Promise<{ rows: Array<Record<string, unknown>> }> => {
      if (sql.includes("WHERE m.id = $1")) {
        const messageId = String(values?.[0]);
        if (messageId === MISSING_MESSAGE) return { rows: [] };
        if (messageId === BROKEN_MESSAGE) throw new Error("temporary database failure");
        return {
          rows: [{
            id: messageId,
            provider_thread_id: `provider-${messageId}`,
            rfc_message_id: `<${messageId}@example.test>`,
            message_id_normalized: `${messageId}@example.test`,
            in_reply_to: null,
            references_header: null,
            account_id: ACCOUNT_ID,
            conversation_id: conversationOf(messageId)
          }]
        };
      }
      if (sql.includes("WITH delivery_copies")) {
        const conversationId = String(values?.[1]);
        return {
          rows: [{
            id: `representative-${conversationId}`,
            account_id: ACCOUNT_ID,
            folder_path: "INBOX",
            provider_thread_id: `provider-${conversationId}`,
            conversation_id: conversationId,
            subject: conversationId,
            from_email: "alice@example.test",
            from_name: "Alice",
            to_emails: ["bob@example.test"],
            cc_emails: [],
            flags: [],
            internal_date: new Date("2026-01-02T03:04:05.000Z"),
            body_text: "hello",
            body_plain: null,
            selected_text_part: null,
            attachments: []
          }]
        };
      }
      if (sql.includes("FROM public.imap_accounts a")) {
        accountQueryCount += 1;
        return { rows: [] };
      }
      return { rows: [] };
    });
    return { query, release: vi.fn() };
  });
  return {
    pool: { connect },
    connect,
    getAccountQueryCount: () => accountQueryCount
  };
}

/** One assigned seed whose conversation holds the given rows; attachments come from `files`. */
function threadRowsPool(rows: Array<Record<string, unknown>>, files: Array<Record<string, unknown>> = []) {
  const query = vi.fn(async (
    sql: string,
    _values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("WHERE m.id = $1")) {
      return {
        rows: [{
          id: "message-seed",
          provider_thread_id: null,
          rfc_message_id: "<seed@example.test>",
          message_id_normalized: "seed@example.test",
          in_reply_to: null,
          references_header: null,
          account_id: ACCOUNT_ID,
          conversation_id: "conversation-1"
        }]
      };
    }
    if (sql.includes("WITH delivery_copies")) return { rows };
    if (sql.includes("FROM public.imap_attachments attachment")) return { rows: files };
    return { rows: [] };
  });
  return { pool: { connect: vi.fn(async () => ({ query, release: vi.fn() })) }, query };
}

function threadRow(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    account_id: ACCOUNT_ID,
    folder_path: "INBOX",
    provider_thread_id: null,
    conversation_id: "conversation-1",
    subject: "Re: Plan",
    from_email: "alice@example.test",
    from_name: "Alice",
    to_emails: ["bob@example.test"],
    cc_emails: [],
    flags: [],
    internal_date: new Date("2026-01-02T03:04:05.000Z"),
    rfc_message_id: `<${id}@example.test>`,
    in_reply_to: null,
    references_header: null,
    inline_count: 0,
    body_text: "hello",
    body_plain: null,
    selected_text_part: null,
    ...fields
  };
}

describe("read_thread response shape", () => {
  it("lists each message's files once and counts its inline parts", async () => {
    const { pool, query } = threadRowsPool(
      [threadRow("with-files", { inline_count: 3 }), threadRow("plain")],
      [{
        attachment_id: "attachment-1",
        message_id: "with-files",
        account_id: ACCOUNT_ID,
        filename: "plan.pdf",
        mime_type: "application/pdf",
        size_bytes: "2048",
        disposition: "attachment"
      }]
    );

    const out = await runReadThread(pool as never, { message_id: MESSAGE_SEED });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out).not.toHaveProperty("attachments_index");
    expect(out.thread).not.toHaveProperty("provider_thread_id");
    expect(out.messages[0]).toMatchObject({
      attachments: [{ attachment_id: "attachment-1", filename: "plan.pdf", size_bytes: 2048, disposition: "attachment" }],
      inline_count: 3
    });
    expect(out.messages[0]).not.toHaveProperty("thread_id");
    expect(out.messages[1].attachments).toEqual([]);
    expect(out.messages[1]).not.toHaveProperty("inline_count");
    const attachmentSql = query.mock.calls.find(([sql]) => sql.includes("FROM public.imap_attachments attachment"))?.[0];
    expect(attachmentSql).toContain("AND attachment.disposition = 'attachment'");
    const threadSql = query.mock.calls.find(([sql]) => sql.includes("WITH delivery_copies"))?.[0];
    expect(threadSql).toContain("a.disposition IS DISTINCT FROM 'attachment') AS inline_count");
  });

  it("reports ancestors the oldest message replies to that are not mirrored", async () => {
    const { pool } = threadRowsPool([
      threadRow("oldest", {
        rfc_message_id: "<c@example.test>",
        in_reply_to: "<b@example.test>",
        references_header: "<a@example.test> <b@example.test> <found@example.test>",
        body_text: "Agreed.\n\nOn Mon, Bob wrote:\n> The history only lives here.\n> Second quoted line."
      }),
      threadRow("found", { rfc_message_id: "<found@example.test>" })
    ]);

    const out = await runReadThread(pool as never, { message_id: MESSAGE_SEED });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out).toMatchObject({
      omitted_message_count: 0,
      missing_ancestor_count: 2,
      thread_content_status: "partial",
      thread_omissions: ["ancestors_not_mirrored"]
    });
    expect(out.messages[0].body).toContain("The history only lives here.");
  });

  it("leaves ancestors to older_messages when the cap removed older mirrored messages", async () => {
    const { pool } = threadRowsPool([
      threadRow("newest", { references_header: "<a@example.test>", thread_total_count: 2 })
    ]);

    const out = await runReadThread(pool as never, { message_id: MESSAGE_SEED, max_messages: 1 });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out).not.toHaveProperty("missing_ancestor_count");
    expect(out.thread_omissions).toEqual(["older_messages"]);
  });

  it("reports a complete thread when every ancestor is mirrored", async () => {
    const { pool } = threadRowsPool([
      threadRow("root", { rfc_message_id: "<root@example.test>" }),
      threadRow("reply", { references_header: "<root@example.test>", in_reply_to: "<root@example.test>" })
    ]);

    const out = await runReadThread(pool as never, { message_id: MESSAGE_SEED });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out).toMatchObject({ thread_content_status: "complete", thread_omissions: [] });
    expect(out).not.toHaveProperty("missing_ancestor_count");
  });
});

describe("read_thread continuation", () => {
  const CURSOR = "00000000-0000-4000-8000-000000000999";

  it("reads the page before the cursor and points at the next one", async () => {
    const { pool, query } = threadRowsPool([
      threadRow("older", {
        body_text: "Older.\n\nOn Mon, Bob wrote:\n> Quoted history.",
        thread_total_count: 6,
        thread_remaining_count: 4
      }),
      threadRow("newer", { thread_total_count: 6, thread_remaining_count: 4 })
    ]);

    const out = await runReadThread(pool as never, { message_id: MESSAGE_SEED, cursor: CURSOR });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out.thread.message_count).toBe(6);
    expect(out.messages.map((message) => message.message_id)).toEqual(["older", "newer"]);
    expect(out).toMatchObject({
      omitted_message_count: 2,
      next_cursor: "older",
      thread_content_status: "partial",
      thread_omissions: ["older_messages"]
    });
    expect(out.messages[0].body).not.toContain("Quoted history.");
    const call = query.mock.calls.find(([sql]) => sql.includes("WITH delivery_copies"));
    expect(call?.[0]).toContain("(m.internal_date, m.id) < (");
    expect(call?.[0]).toContain("WHERE cursor_message.id = $4");
    expect(call?.[1]).toEqual([ACCOUNT_ID, "conversation-1", 20, CURSOR]);
  });

  it("ends without next_cursor and keeps the oldest message's quoted content", async () => {
    const { pool } = threadRowsPool([
      threadRow("root", {
        body_text: "Root.\n\nFrom: Earlier\nSent: Friday\nSubject: Forwarded\n\nForwarded context.",
        thread_total_count: 3,
        thread_remaining_count: 1
      })
    ]);

    const out = await runReadThread(pool as never, { message_id: MESSAGE_SEED, cursor: CURSOR });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out).not.toHaveProperty("next_cursor");
    expect(out).toMatchObject({ omitted_message_count: 0, thread_content_status: "complete", thread_omissions: [] });
    expect(out.messages[0].body).toContain("Forwarded context.");
  });

  it("passes the cursor to the legacy walk and the provider selector", async () => {
    const legacy = unassignedSeedPool();
    await runReadThread(legacy.pool as never, { message_id: LEGACY_SEED, cursor: CURSOR });
    const legacyCall = legacy.query.mock.calls.find(([sql]) => sql.includes("WITH legacy_candidates"));
    expect(legacyCall?.[0]).toContain("WHERE cursor_message.id = $6");
    expect(legacyCall?.[1]?.slice(4)).toEqual([20, CURSOR]);

    const provider = assignedConversationPool();
    await runReadThread(provider.pool as never, { thread_id: "provider-thread", account: ACCOUNT_ID, cursor: CURSOR });
    const providerCall = provider.query.mock.calls.find(([sql]) => sql.includes("WHERE m.provider_thread_id = $1"));
    expect(providerCall?.[1]).toEqual(["provider-thread", ACCOUNT_ID, 20, CURSOR]);
  });

  it("returns not_found when nothing precedes the cursor", async () => {
    const { pool } = threadRowsPool([]);

    const out = await runReadThread(pool as never, { message_id: MESSAGE_SEED, cursor: CURSOR });

    expect(out).toMatchObject({ error: { code: "not_found", message: "No messages before cursor." } });
  });

  it("rejects a cursor with a message_ids batch before opening a database connection", async () => {
    const connect = vi.fn();

    const out = await runReadThread({ connect } as never, { message_ids: [MESSAGE_ONE], cursor: CURSOR });

    expect(out).toMatchObject({ error: { code: "invalid_input", message: expect.stringContaining("message_ids batch") } });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a cursor that is not a message id before opening a database connection", async () => {
    const connect = vi.fn();

    const out = await runReadThread({ connect } as never, { message_id: MESSAGE_ONE, cursor: "page-2" });

    expect(out).toMatchObject({ error: { code: "invalid_input", message: "cursor: Invalid uuid" } });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("read_thread stored assignments", () => {
  it("can select metadata without inline body columns for hosted hydration", async () => {
    const { pool, query } = assignedConversationPool();

    const out = await runReadThread(
      pool as never,
      { message_id: MESSAGE_SEED },
      undefined,
      { includeBody: false }
    );

    expect(isResult(out)).toBe(true);
    const select = query.mock.calls.find(([sql]) => String(sql).includes("WITH delivery_copies"))?.[0];
    expect(select).toContain("b.raw_truncated");
    expect(select).not.toContain("b.body_text");
  });

  it("reads several search-result seeds in one call and preserves request order", async () => {
    const { pool, connect, getAccountQueryCount } = batchConversationPool();

    const out = await runReadThread(pool as never, {
      message_ids: [MESSAGE_ONE, MESSAGE_TWO]
    });

    expect(out).toMatchObject({
      threads: [
        {
          message_id: MESSAGE_ONE,
          result: { thread: { conversation_id: conversationFor(MESSAGE_ONE) } }
        },
        {
          message_id: MESSAGE_TWO,
          result: { thread: { conversation_id: conversationFor(MESSAGE_TWO) } }
        }
      ]
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(getAccountQueryCount()).toBe(2);
  });

  it("returns a per-item error without discarding the other requested threads", async () => {
    const { pool } = batchConversationPool();

    const out = await runReadThread(pool as never, {
      message_ids: [MESSAGE_ONE, MISSING_MESSAGE, MESSAGE_TWO]
    });

    expect(out).toMatchObject({
      threads: [
        { message_id: MESSAGE_ONE, result: { thread: { conversation_id: conversationFor(MESSAGE_ONE) } } },
        { message_id: MISSING_MESSAGE, error: { code: "not_found", hint: expect.stringContaining("another email tool") } },
        { message_id: MESSAGE_TWO, result: { thread: { conversation_id: conversationFor(MESSAGE_TWO) } } }
      ]
    });
  });

  it("rejects mixing batch mode with a single-thread selector", async () => {
    const connect = vi.fn();

    const out = await runReadThread({ connect } as never, {
      message_id: MESSAGE_ONE,
      message_ids: [MESSAGE_TWO]
    });

    expect(out).toMatchObject({ error: { code: "invalid_input" } });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a secondary selector even when its account scope is absent", async () => {
    const connect = vi.fn();

    const out = await runReadThread({ connect } as never, {
      message_id: MESSAGE_ONE,
      conversation_id: "conversation-two"
    });

    expect(out).toMatchObject({ error: { code: "invalid_input" } });
    expect(connect).not.toHaveBeenCalled();
  });

  it("isolates an operational failure to its batch item", async () => {
    const { pool } = batchConversationPool();

    const out = await runReadThread(pool as never, {
      message_ids: [MESSAGE_ONE, BROKEN_MESSAGE, MESSAGE_TWO]
    });

    expect(out).toMatchObject({
      threads: [
        { message_id: MESSAGE_ONE, result: { thread: { conversation_id: conversationFor(MESSAGE_ONE) } } },
        { message_id: BROKEN_MESSAGE, error: { code: "tool_failed" } },
        { message_id: MESSAGE_TWO, result: { thread: { conversation_id: conversationFor(MESSAGE_TWO) } } }
      ]
    });
  });

  it("points a later seed from an already returned conversation at the first seed", async () => {
    const { pool } = batchConversationPool(() => "conversation-shared");

    const out = await runReadThread(pool as never, {
      message_ids: [MESSAGE_ONE, MISSING_MESSAGE, MESSAGE_TWO]
    });

    expect(out).toEqual({
      threads: [
        expect.objectContaining({ message_id: MESSAGE_ONE, result: expect.anything() }),
        expect.objectContaining({ message_id: MISSING_MESSAGE, error: expect.objectContaining({ code: "not_found" }) }),
        { message_id: MESSAGE_TWO, same_thread_as: MESSAGE_ONE }
      ]
    });
  });

  it("deduplicates repeated message seeds before reading", async () => {
    const { pool, connect } = batchConversationPool();

    const out = await runReadThread(pool as never, {
      message_ids: [MESSAGE_ONE, MESSAGE_ONE, MESSAGE_TWO]
    });

    expect(out).toMatchObject({
      threads: [
        { message_id: MESSAGE_ONE },
        { message_id: MESSAGE_TWO }
      ]
    });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("returns the batch envelope for one message seed", async () => {
    const { pool, connect } = batchConversationPool();

    const out = await runReadThread(pool as never, {
      message_ids: [MESSAGE_ONE]
    });

    expect(out).toMatchObject({
      threads: [
        { message_id: MESSAGE_ONE, result: { thread: { conversation_id: conversationFor(MESSAGE_ONE) } } }
      ]
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty message batch before opening a database connection", async () => {
    const connect = vi.fn();

    const out = await runReadThread({ connect } as never, { message_ids: [] });

    expect(out).toMatchObject({ error: { code: "invalid_input" } });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    [{ message_id: "not-a-uuid" }, "message_id: Invalid uuid"],
    [{ message_ids: ["not-a-uuid"] }, "message_ids.0: Invalid uuid"]
  ])("rejects invalid message ids before opening a database connection", async (args, message) => {
    const connect = vi.fn();

    const out = await runReadThread({ connect } as never, args);

    expect(out).toMatchObject({ error: { code: "invalid_input", message } });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects batches larger than ten before opening a database connection", async () => {
    const connect = vi.fn();

    const out = await runReadThread({ connect } as never, {
      message_ids: BATCH_IDS
    });

    expect(out).toMatchObject({ error: { code: "invalid_input" } });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([0, 101, 1.5])(
    "rejects max_messages=%s when it is outside the advertised integer range",
    async (maxMessages) => {
      const connect = vi.fn();

      const out = await runReadThread({ connect } as never, {
        message_id: MESSAGE_ONE,
        max_messages: maxMessages
      });

      expect(out).toMatchObject({ error: { code: "invalid_input" } });
      expect(connect).not.toHaveBeenCalled();
    }
  );

  it("runs at most four thread reads concurrently", async () => {
    const base = batchConversationPool();
    let active = 0;
    let peak = 0;
    const pool = {
      async connect() {
        const client = await base.pool.connect();
        active += 1;
        peak = Math.max(peak, active);
        const release = client.release;
        return {
          ...client,
          release() {
            active -= 1;
            release();
          }
        };
      }
    };

    await runReadThread(pool as never, {
      message_ids: CONCURRENCY_IDS
    });

    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(base.getAccountQueryCount()).toBe(10);
  });

  it("resolves an assigned seed to the full stored conversation and exposes its id", async () => {
    const { pool, query } = assignedConversationPool();
    const out = await runReadThread(pool as never, { message_id: MESSAGE_SEED });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out.thread).toMatchObject({
      conversation_id: "conversation-1",
      provider_thread_id: "provider-thread",
      message_count: 1
    });
    expect(out.messages.map((message) => message.message_id)).toEqual(["message-representative"]);
    expect(query).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const conversationCall = query.mock.calls.find(([sql]) => sql.includes("WITH delivery_copies"));
    expect(conversationCall?.[0]).toContain("PARTITION BY m.account_id, assignment.delivery_key");
    expect(conversationCall?.[0]).toContain("public.imap_thread_active_assignments assignment");
    expect(conversationCall?.[0]).toContain("assignment.account_id = $1");
    expect(conversationCall?.[1]).toEqual([ACCOUNT_ID, "conversation-1", 20, null]);
  });

  it("accepts a direct account-scoped conversation selector", async () => {
    const { pool, query } = assignedConversationPool();
    const out = await runReadThread(
      pool as never,
      { conversation_id: "conversation-1", account: ACCOUNT_ID },
      undefined,
      { includeBody: false }
    );

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out.thread.conversation_id).toBe("conversation-1");
    expect(query.mock.calls.some(([sql]) => sql.includes("WHERE m.id = $1"))).toBe(false);
    const select = query.mock.calls.find(([sql]) => sql.includes("WITH delivery_copies"))?.[0];
    expect(select).toContain("b.raw_truncated");
    expect(select).not.toContain("b.body_text");
  });

  it.each([
    ["conversation_id", "missing-conversation"],
    ["thread_id", "missing-provider-thread"]
  ])("returns not_found for an unknown direct %s selector", async (field, value) => {
    const { pool, query } = assignedConversationPool();
    const implementation = query.getMockImplementation();
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("WITH delivery_copies")) return { rows: [] };
      return implementation!(sql, values);
    });

    const out = await runReadThread(pool as never, {
      [field]: value,
      account: ACCOUNT_ID
    });

    expect(out).toMatchObject({
      error: {
        code: "not_found",
        message: `No thread found for ${field} ${value}.`
      }
    });
  });

  it("bounds conversation hydration in SQL while reporting the full delivery count", async () => {
    const { pool, query } = assignedConversationPool();
    const conversationQuery = query.getMockImplementation();
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      const result = await conversationQuery!(sql, values);
      if (sql.includes("WITH delivery_copies")) {
        return {
          ...result,
          rows: result.rows.map((row: Record<string, unknown>) => ({
            ...row,
            thread_total_count: 3,
            thread_participants: ["alice@example.test", "bob@example.test"]
          }))
        };
      }
      return result;
    });

    const out = await runReadThread(pool as never, {
      conversation_id: "conversation-1",
      account: ACCOUNT_ID,
      max_messages: 1
    });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out.thread.message_count).toBe(3);
    expect(out.thread.participants).toEqual(["alice@example.test", "bob@example.test"]);
    expect(out.omitted_message_count).toBe(2);
    expect(out.thread_content_status).toBe("partial");
    expect(out.thread_omissions).toEqual(["older_messages"]);
    const call = query.mock.calls.find(([sql]) => sql.includes("WITH delivery_copies"));
    expect(call?.[0]).toContain("LIMIT $3");
    expect(call?.[1]).toEqual([ACCOUNT_ID, "conversation-1", 1, null]);
    expect(out.next_cursor).toBe("message-representative");
  });

  it("deduplicates a provider selector by active delivery identity with conservative pre-activation fallbacks", async () => {
    const { pool, query } = assignedConversationPool();
    const out = await runReadThread(
      pool as never,
      { thread_id: "provider-thread", account: ACCOUNT_ID },
      undefined,
      { includeBody: false }
    );

    expect(isResult(out)).toBe(true);
    const providerCall = query.mock.calls.find(([sql]) => sql.includes("WHERE m.provider_thread_id = $1"));
    expect(providerCall?.[0]).toContain("PARTITION BY m.account_id, coalesce(");
    expect(providerCall?.[0]).toContain("ta.delivery_key");
    expect(providerCall?.[0]).toContain("b.raw_mime_sha256");
    expect(providerCall?.[0]).toContain("LEFT JOIN public.imap_thread_active_assignments ta");
    expect(providerCall?.[0]).toContain("ON ta.message_id = m.id");
    expect(providerCall?.[0]).toContain("b.raw_truncated");
    expect(providerCall?.[0]).not.toContain("b.body_text");
    expect(providerCall?.[1]).toEqual(["provider-thread", ACCOUNT_ID, 20, null]);
  });

  it("falls back to the legacy one-hop walk when the active run has no assignment", async () => {
    const { pool, query } = unassignedSeedPool();
    const out = await runReadThread(
      pool as never,
      { message_id: LEGACY_SEED },
      undefined,
      { includeBody: false }
    );

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out.thread.conversation_id).toBeNull();
    expect(out.messages.map((message) => message.message_id)).toEqual(["legacy-seed"]);

    const seedCall = query.mock.calls.find(([sql]) => sql.includes("WHERE m.id = $1"));
    expect(seedCall?.[0]).toContain("public.imap_thread_active_assignments assignment");
    const legacyCall = query.mock.calls.find(([sql]) => sql.includes("WITH legacy_candidates"));
    expect(legacyCall?.[0]).toContain("PARTITION BY m.account_id, coalesce(");
    expect(legacyCall?.[0]).toContain("LEFT JOIN public.imap_thread_active_assignments ta");
    expect(legacyCall?.[0]).toContain("ON ta.message_id = m.id");
    expect(legacyCall?.[0]).toContain("b.raw_truncated");
    expect(legacyCall?.[0]).not.toContain("b.body_text");
  });

  it.each([
    ["thread_id", "provider-thread"],
    ["conversation_id", "conversation-1"]
  ])("requires account for a direct %s selector", async (field, value) => {
    const connect = vi.fn();
    const out = await runReadThread({ connect } as never, { [field]: value });

    expect(out).toMatchObject({
      error: { code: "invalid_input", message: `${field} requires account.` }
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
