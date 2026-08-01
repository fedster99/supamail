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
    if (sql.includes("WITH delivery_representatives")) {
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
            window_status: "IN_WINDOW",
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
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
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
            window_status: "IN_WINDOW",
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

function batchConversationPool() {
  let syncTrustQueryCount = 0;
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
            conversation_id: conversationFor(messageId)
          }]
        };
      }
      if (sql.includes("WITH delivery_representatives")) {
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
            window_status: "IN_WINDOW",
            internal_date: new Date("2026-01-02T03:04:05.000Z"),
            body_text: "hello",
            body_plain: null,
            selected_text_part: null,
            attachments: []
          }]
        };
      }
      if (sql.includes("FROM public.imap_accounts a")) {
        syncTrustQueryCount += 1;
        return { rows: [] };
      }
      return { rows: [] };
    });
    return { query, release: vi.fn() };
  });
  return {
    pool: { connect },
    connect,
    getSyncTrustQueryCount: () => syncTrustQueryCount
  };
}

describe("read_thread stored assignments", () => {
  it("reads several search-result seeds in one call and preserves request order", async () => {
    const { pool, connect, getSyncTrustQueryCount } = batchConversationPool();

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
    expect(getSyncTrustQueryCount()).toBe(2);
  });

  it("returns a per-item error without discarding the other requested threads", async () => {
    const { pool } = batchConversationPool();

    const out = await runReadThread(pool as never, {
      message_ids: [MESSAGE_ONE, MISSING_MESSAGE, MESSAGE_TWO]
    });

    expect(out).toMatchObject({
      threads: [
        { message_id: MESSAGE_ONE, result: { thread: { conversation_id: conversationFor(MESSAGE_ONE) } } },
        { message_id: MISSING_MESSAGE, error: { code: "not_found" } },
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
    { message_id: "not-a-uuid" },
    { message_ids: ["not-a-uuid"] }
  ])("rejects invalid message ids before opening a database connection", async (args) => {
    const connect = vi.fn();

    const out = await runReadThread({ connect } as never, args);

    expect(out).toMatchObject({ error: { code: "invalid_input" } });
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
    expect(base.getSyncTrustQueryCount()).toBe(10);
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

    const conversationCall = query.mock.calls.find(([sql]) => sql.includes("WITH delivery_representatives"));
    expect(conversationCall?.[0]).toContain("DISTINCT ON (assignment.delivery_key)");
    expect(conversationCall?.[0]).toContain("public.imap_thread_active_assignments assignment");
    expect(conversationCall?.[0]).toContain("assignment.account_id = $1");
    expect(conversationCall?.[1]).toEqual([ACCOUNT_ID, "conversation-1", 20]);
  });

  it("accepts a direct account-scoped conversation selector", async () => {
    const { pool, query } = assignedConversationPool();
    const out = await runReadThread(pool as never, {
      conversation_id: "conversation-1",
      account: ACCOUNT_ID
    });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out.thread.conversation_id).toBe("conversation-1");
    expect(query.mock.calls.some(([sql]) => sql.includes("WHERE m.id = $1"))).toBe(false);
  });

  it.each([
    ["conversation_id", "missing-conversation"],
    ["thread_id", "missing-provider-thread"]
  ])("returns not_found for an unknown direct %s selector", async (field, value) => {
    const { pool, query } = assignedConversationPool();
    const implementation = query.getMockImplementation();
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("WITH delivery_representatives")) return { rows: [] };
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
      if (sql.includes("WITH delivery_representatives")) {
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
    const call = query.mock.calls.find(([sql]) => sql.includes("WITH delivery_representatives"));
    expect(call?.[0]).toContain("LIMIT $3");
    expect(call?.[1]).toEqual([ACCOUNT_ID, "conversation-1", 1]);
  });

  it("deduplicates a provider selector by active delivery identity with conservative pre-activation fallbacks", async () => {
    const { pool, query } = assignedConversationPool();
    const out = await runReadThread(pool as never, {
      thread_id: "provider-thread",
      account: ACCOUNT_ID
    });

    expect(isResult(out)).toBe(true);
    const providerCall = query.mock.calls.find(([sql]) => sql.includes("WHERE m.provider_thread_id = $1"));
    expect(providerCall?.[0]).toContain("DISTINCT ON (m.account_id");
    expect(providerCall?.[0]).toContain("ta.delivery_key");
    expect(providerCall?.[0]).toContain("b.raw_mime_sha256");
    expect(providerCall?.[0]).toContain("public.imap_thread_active_assignments ta");
    expect(providerCall?.[1]).toEqual(["provider-thread", ACCOUNT_ID, 20]);
  });

  it("falls back to the legacy one-hop walk when the active run has no assignment", async () => {
    const { pool, query } = unassignedSeedPool();
    const out = await runReadThread(pool as never, { message_id: LEGACY_SEED });

    expect(isResult(out)).toBe(true);
    if (!isResult(out)) return;
    expect(out.thread.conversation_id).toBeNull();
    expect(out.messages.map((message) => message.message_id)).toEqual(["legacy-seed"]);

    const seedCall = query.mock.calls.find(([sql]) => sql.includes("WHERE m.id = $1"));
    expect(seedCall?.[0]).toContain("public.imap_thread_active_assignments assignment");
    const legacyCall = query.mock.calls.find(([sql]) => sql.includes("WITH legacy_candidates"));
    expect(legacyCall?.[0]).toContain("DISTINCT ON (m.account_id");
    expect(legacyCall?.[0]).toContain("public.imap_thread_active_assignments ta");
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
