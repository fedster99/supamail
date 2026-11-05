import { describe, expect, it, vi } from "vitest";
import { runGetSyncStatus } from "./get-sync-status.js";

describe("runGetSyncStatus input", () => {
  it("rejects a mailbox scope that is not a UUID, or two that disagree, before any query", async () => {
    const connect = vi.fn();
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    expect(await runGetSyncStatus({ connect } as never, { account_id: "not-a-uuid" }))
      .toMatchObject({ error: { code: "invalid_input", issues: [{ rule: "format", path: ["account_id"] }] } });
    expect(await runGetSyncStatus({ connect } as never, { account_id: a, account: b }))
      .toMatchObject({ error: { code: "invalid_input", issues: [{ rule: "constraint", path: ["account_id"] }] } });
    const malformed = await runGetSyncStatus({ connect } as never, { account_id: "foo", account: "bar" });
    expect("error" in malformed && malformed.error.issues).toEqual([{ rule: "format", path: ["account_id"] }, { rule: "format", path: ["account"] }]);
    expect(connect).not.toHaveBeenCalled();
  });
});
