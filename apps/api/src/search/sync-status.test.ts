import { describe, expect, it } from "vitest";
import { buildReadAccounts, buildSyncStatus } from "./sync-status.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function statusRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: ID,
    email_address: "owner@example.test",
    sync_state: "HEALTHY",
    historical_backfill_mode: "metadata_and_bodies",
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
  const values: unknown[][] = [];
  return {
    queries,
    values,
    query: async (text: string, params: unknown[]) => {
      queries.push(text);
      values.push(params);
      return { rows };
    }
  } as unknown as Parameters<typeof buildSyncStatus>[0] & { queries: string[]; values: unknown[][] };
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

  it("keeps an empty scope empty, so it never means every account", async () => {
    // The search reader pool bypasses row-level security; an empty account scope
    // must reach SQL as an empty array, which matches no rows.
    const reader = db([]);
    expect(await buildReadAccounts(reader, [])).toEqual([]);
    expect(reader.values[0]).toEqual([[]]);
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

  it("describes each mailbox that is not fully synced, from the same reasons as fully_synced", async () => {
    const status = await buildSyncStatus(db([
      statusRow({ account_id: "1", email_address: "a@x.test", sync_state: "INITIAL_SYNC", initial_sync_in_progress: true, live_headers_complete_pct: 40, live_bodies_complete_pct: 10 }),
      statusRow({ account_id: "2", email_address: "b@x.test", sync_state: "BROKEN" }),
      statusRow({ account_id: "3", email_address: "c@x.test", historical_backfill_in_progress: true, historical_bodies_complete_pct: 0 }),
      statusRow({ account_id: "4", email_address: "d@x.test", sync_state: "DEGRADED", live_bodies_complete_pct: 98 }),
      statusRow({ account_id: "5", email_address: "e@x.test", live_headers_complete_pct: 99 }),
      statusRow({ account_id: "6", email_address: "f@x.test" })
    ]), null);
    expect(status.summary).toBe(
      "a@x.test: first sync, 40% of recent mail and 10% of its bodies stored. " +
      "b@x.test: sync stopped. " +
      "c@x.test: storing older mail, 0% of older bodies stored. " +
      "d@x.test: sync delayed, 98% of recent bodies stored. " +
      "e@x.test: 99% of recent mail stored."
    );
    expect(status.fully_synced).toBe(false);
    expect(status.degraded_reasons).toEqual([
      "initial_sync_in_progress", "headers_incomplete", "bodies_incomplete", "sync_stopped",
      "historical_backfill_in_progress", "historical_bodies_incomplete", "sync_delayed"
    ]);
  });

  it("counts older bodies still downloading after the header backfill ends", async () => {
    const storing = await buildSyncStatus(db([statusRow({ historical_bodies_complete_pct: 40 })]), [ID]);
    expect(storing.fully_synced).toBe(false);
    expect(storing.summary).toBe("owner@example.test: 40% of older bodies stored.");
    expect(storing.degraded_reasons).toEqual(["historical_bodies_incomplete"]);
    // A mailbox that stores no older bodies is not waiting for them.
    const headersOnly = await buildSyncStatus(db([
      statusRow({ historical_backfill_mode: "metadata_only", historical_bodies_complete_pct: 0 })
    ]), [ID]);
    expect(headersOnly.fully_synced).toBe(true);
  });

  it("never calls a set synced when any reason applies", async () => {
    const status = await buildSyncStatus(db([statusRow({ live_headers_complete_pct: 99 })]), [ID]);
    expect(status.fully_synced).toBe(false);
    expect(status.summary).not.toContain("synced");
  });

  it("says when no mailbox matched", async () => {
    const status = await buildSyncStatus(db([]), [ID]);
    expect(status.summary).toBe("No mailboxes matched.");
    expect(status.degraded_reasons).toEqual(["no_accounts_matched"]);
  });
});
