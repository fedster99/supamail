import { describe, expect, it, vi } from "vitest";
import { runReadThread } from "./read-thread.js";
import type { ReadThreadResult } from "./read-thread.js";

const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";

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

describe("read_thread stored assignments", () => {
  it("resolves an assigned seed to the full stored conversation and exposes its id", async () => {
    const { pool, query } = assignedConversationPool();
    const out = await runReadThread(pool as never, { message_id: "message-seed" });

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
    const out = await runReadThread(pool as never, { message_id: "legacy-seed" });

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
