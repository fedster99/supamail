import { describe, expect, it } from "vitest";
import { conversationDiversityRatio } from "../eval/run.js";
import type { SearchResult } from "../search/types.js";

function result(
  id: string,
  thread: Pick<SearchResult["thread"], "conversation_id" | "provider_thread_id">,
  accountId = "account-a"
): Pick<SearchResult, "identity" | "thread"> {
  return {
    identity: {
      id,
      account_id: accountId,
      folder_path: "INBOX",
      uidvalidity: "1",
      uid: id
    },
    thread: {
      ...thread,
      message_count: 1
    }
  };
}

describe("search evaluation conversation diversity", () => {
  it("recognizes a header-only conversation without a provider thread id", () => {
    const results = [
      result("message-a", { conversation_id: "conversation-header-only", provider_thread_id: null }),
      result("message-b", { conversation_id: "conversation-header-only", provider_thread_id: null })
    ];

    expect(conversationDiversityRatio(results)).toBe(0.5);
  });

  it("does not let a reused provider id hide distinct protocol conversations or mailbox scopes", () => {
    const results = [
      result("message-a", { conversation_id: "conversation-a", provider_thread_id: "reused-provider-id" }),
      result("message-b", { conversation_id: "conversation-b", provider_thread_id: "reused-provider-id" }),
      result(
        "legacy-a",
        { conversation_id: null, provider_thread_id: "reused-provider-id" },
        "legacy-account-a"
      ),
      result(
        "legacy-b",
        { conversation_id: null, provider_thread_id: "reused-provider-id" },
        "legacy-account-b"
      )
    ];

    expect(conversationDiversityRatio(results)).toBe(1);
  });
});
