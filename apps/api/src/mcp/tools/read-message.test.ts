import { describe, expect, it, vi } from "vitest";
import { runReadMessage } from "./read-message.js";

const MESSAGE_ID = "00000000-0000-4000-8000-000000000001";

describe("runReadMessage library options", () => {
  it("returns invalid_input without opening a database connection", async () => {
    const connect = vi.fn();

    const result = await runReadMessage(
      { connect } as never,
      { message_id: "not-a-uuid" }
    );

    expect(result).toMatchObject({ error: { code: "invalid_input", message: "message_id: Invalid uuid" } });
    expect(connect).not.toHaveBeenCalled();
  });

  it("can select metadata without inline body columns while retaining source truncation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.imap_messages m")) {
        return {
          rows: [{
            id: MESSAGE_ID,
            account_id: "account-1",
            folder_path: "INBOX",
            provider_thread_id: null,
            subject: "Partial source",
            from_email: "alice@example.test",
            from_name: "Alice",
            to_emails: ["me@example.test"],
            cc_emails: [],
            flags: [],
            internal_date: new Date("2026-08-01T00:00:00.000Z"),
            headers_json: {},
            protected_metadata: null,
            protected_metadata_version: null,
            protected_metadata_key_version: null,
            protected_metadata_tokens: null,
            raw_truncated: true,
            body_text: null,
            body_plain: null,
            selected_text_part: null
          }]
        };
      }
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() }))
    };

    const result = await runReadMessage(
      pool as never,
      { message_id: MESSAGE_ID },
      undefined,
      { includeBody: false }
    );

    if ("error" in result) throw new Error("unexpected error envelope");
    const select = query.mock.calls.find(([sql]) => String(sql).includes("FROM public.imap_messages m"))?.[0];
    expect(select).toContain("b.raw_truncated");
    expect(select).not.toContain("b.body_text");
    expect(result).toMatchObject({
      body: null,
      body_content_status: "partial",
      body_omissions: ["source_truncated"]
    });
    expect(result).not.toHaveProperty("duplicate_message_ids");
  });

  it("lists the other stored copies that share the message's delivery key", async () => {
    const copyId = "00000000-0000-4000-8000-000000000002";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.imap_messages m")) {
        return {
          rows: [{
            id: MESSAGE_ID,
            account_id: "account-1",
            folder_path: "INBOX",
            provider_thread_id: null,
            subject: "Copied",
            from_email: "alice@example.test",
            from_name: "Alice",
            to_emails: ["me@example.test"],
            cc_emails: [],
            flags: [],
            internal_date: new Date("2026-08-01T00:00:00.000Z"),
            headers_json: {},
            raw_truncated: false,
            body_text: "hello",
            body_plain: null,
            selected_text_part: null,
            duplicate_message_ids: [copyId]
          }]
        };
      }
      return { rows: [] };
    });
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })) };

    const result = await runReadMessage(pool as never, { message_id: MESSAGE_ID });

    if ("error" in result) throw new Error("unexpected error envelope");
    expect(result.duplicate_message_ids).toEqual([copyId]);
    const select = query.mock.calls.find(([sql]) => String(sql).includes("FROM public.imap_messages m"))?.[0];
    expect(select).toContain("copy.delivery_key = ta.delivery_key");
    expect(select).toContain("copy_message.deleted_in_provider = false");
  });

  it("reads the message, its files, and its account in one transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(String(sql).trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("FROM public.imap_messages m")) {
        return { rows: [{
          id: MESSAGE_ID, account_id: "00000000-0000-4000-8000-0000000000aa", folder_path: "INBOX",
          provider_thread_id: null, subject: "One", from_email: "alice@example.test", from_name: null,
          to_emails: [], cc_emails: [], flags: [], internal_date: new Date("2026-08-01T00:00:00.000Z"),
          headers_json: {}, raw_truncated: false, body_text: "hello", body_plain: null,
          selected_text_part: null, duplicate_message_ids: null
        }] };
      }
      if (sql.includes("FROM public.imap_accounts a")) {
        return { rows: [{ account_id: "00000000-0000-4000-8000-0000000000aa", email_address: "me@example.test", sync_state: "SYNCED" }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query, release }));

    const result = await runReadMessage({ connect } as never, { message_id: MESSAGE_ID });
    if ("error" in result) throw new Error("unexpected error envelope");
    expect(result.accounts).toEqual([{ account_id: "00000000-0000-4000-8000-0000000000aa", account_email: "me@example.test" }]);
    expect(connect).toHaveBeenCalledOnce();
    expect(statements).toEqual(["BEGIN ISOLATION", "SELECT m.id,", "SELECT attachment.id", "SELECT a.id", "COMMIT"]);

    // In a host's transaction the same read is three statements and no connection.
    statements.length = 0;
    const hosted = await runReadMessage({ hostTransaction: { query, release } } as never, { message_id: MESSAGE_ID });
    expect(hosted).toMatchObject({ message_id: MESSAGE_ID, accounts: [{ account_email: "me@example.test" }] });
    expect(statements).toEqual(["SELECT m.id,", "SELECT attachment.id", "SELECT a.id"]);
    expect(connect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
