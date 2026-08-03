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

    expect(result).toMatchObject({ error: { code: "invalid_input" } });
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
            window_status: "IN_WINDOW",
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
  });
});
