import { describe, expect, it } from "vitest";
import { buildReadAccounts, buildSyncStatus } from "./sync-status.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function statusRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: ID,
    email_address: "owner@example.test",
    sync_state: "HEALTHY",
    sync_state_reason: null,
    last_sync_finished_at: new Date("2026-10-05T10:00:00Z"),
    currently_syncing: false,
    initial_sync_in_progress: false,
    historical_backfill_in_progress: false,
    live_headers_complete_pct: 100,
    live_bodies_complete_pct: 100,
    historical_bodies_complete_pct: 100,
    ...overrides
  };
}

function db(rows: unknown[]) {
  const queries: string[] = [];
  return {
    queries,
    query: async (text: string) => {
      queries.push(text);
      return { rows };
    }
  } as unknown as Parameters<typeof buildSyncStatus>[0] & { queries: string[] };
}

describe("buildReadAccounts", () => {
  it("adds a notice only when a mailbox cannot answer completely", async () => {
    const states = ["HEALTHY", "DEGRADED", "INITIAL_SYNC", "BROKEN", "PAUSED"];
    const accounts = await buildReadAccounts(
      db(states.map((sync_state, i) => ({ account_id: `${i}`, email_address: `${i}@x.test`, sync_state }))),
      null
    );
    expect(accounts.map((a) => a.notice ?? null)).toEqual([
      null,
      null,
      "first_sync_in_progress",
      "sync_stopped",
      "sync_paused"
    ]);
  });

  it("reads only account rows, never body progress", async () => {
    const reader = db([]);
    await buildReadAccounts(reader, [ID]);
    expect(reader.queries[0]).toContain("FROM public.imap_accounts a");
    expect(reader.queries[0]).not.toContain("imap_account_progress");
  });
});

describe("buildSyncStatus", () => {
  it("summarizes a synced mailbox in one line", async () => {
    const status = await buildSyncStatus(db([statusRow()]), [ID]);
    expect(status.summary).toBe("All mail is synced.");
    expect(status.fully_synced).toBe(true);
  });

  it("describes each mailbox that is not fully synced", async () => {
    const status = await buildSyncStatus(db([
      statusRow({ account_id: "1", email_address: "a@x.test", sync_state: "INITIAL_SYNC", initial_sync_in_progress: true, live_headers_complete_pct: 40, live_bodies_complete_pct: 10 }),
      statusRow({ account_id: "2", email_address: "b@x.test", sync_state: "BROKEN" }),
      statusRow({ account_id: "3", email_address: "c@x.test", historical_backfill_in_progress: true, historical_bodies_complete_pct: 60 }),
      statusRow({ account_id: "4", email_address: "d@x.test" })
    ]), null);
    expect(status.summary).toBe(
      "a@x.test: first sync, 40% of recent mail and 10% of its bodies stored. " +
      "b@x.test: sync stopped. " +
      "c@x.test: storing older mail, 60% done."
    );
    expect(status.fully_synced).toBe(false);
    expect(status.degraded_reasons).toEqual(["initial_sync_in_progress", "bodies_incomplete", "account_degraded", "historical_backfill_in_progress"]);
  });

  it("says when no mailbox matched", async () => {
    const status = await buildSyncStatus(db([]), [ID]);
    expect(status.summary).toBe("No mailboxes matched.");
    expect(status.degraded_reasons).toEqual(["no_accounts_matched"]);
  });
});
