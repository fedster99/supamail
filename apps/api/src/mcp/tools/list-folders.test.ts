import { describe, expect, it, vi } from "vitest";
import { runListFolders } from "./list-folders.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

describe("runListFolders input", () => {
  it("rejects a mailbox scope that is not a UUID before opening a database connection", async () => {
    const connect = vi.fn();
    for (const args of [{ account_id: "not-a-uuid" }, { account: "not-a-uuid" }]) {
      const out = await runListFolders({ connect } as never, args);
      expect(out).toMatchObject({ error: { code: "invalid_input", issues: [{ rule: "format" }] } });
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("scopes to the one mailbox account_id or the earlier account spelling names", async () => {
    for (const args of [{ account_id: ACCOUNT_ID }, { account: ACCOUNT_ID }]) {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
      const client = { query, release: vi.fn() };
      await runListFolders({ connect: async () => client } as never, args);
      const scoped = query.mock.calls.find(([sql]) => String(sql).includes("imap_folders"));
      expect(scoped?.[1]).toEqual([ACCOUNT_ID]);
    }
  });
});
