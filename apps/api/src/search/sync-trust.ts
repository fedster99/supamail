import type { PgClient, PgPool } from "../db.js";
import type { SyncTrust, SyncTrustAccount } from "./types.js";

export type Queryable = Pick<PgPool | PgClient, "query">;

interface TrustRow {
  account_id: string;
  account_email: string;
  sync_state: string;
  sync_state_reason: string | null;
  last_sync_finished_at: Date | null;
  currently_syncing: boolean;
  initial_sync_in_progress: boolean;
  historical_backfill_in_progress: boolean;
  live_headers_complete_pct: number;
  live_bodies_complete_pct: number;
  historical_bodies_complete_pct: number;
}

/**
 * Build the sync-trust block for the searched accounts. This is the honesty
 * differentiator: an agent must be able to tell whether the mirror it just
 * searched is complete, still doing its initial sync, backfilling history, or
 * missing bodies — so it never silently trusts a partial result set.
 */
export async function buildSyncTrust(db: Queryable, accountIds: string[] | null): Promise<SyncTrust> {
  const result = await db.query<TrustRow>(
    `
    SELECT
      a.id AS account_id,
      a.email_address AS account_email,
      a.sync_state,
      a.sync_state_reason,
      a.last_sync_finished_at,
      a.currently_syncing,
      (a.sync_state = 'INITIAL_SYNC') AS initial_sync_in_progress,
      EXISTS (
        SELECT 1 FROM public.imap_folders f
        WHERE f.account_id = a.id AND f.backfill_in_progress = true
      ) AS historical_backfill_in_progress,
      coalesce(p.live_headers_complete_pct, 0) AS live_headers_complete_pct,
      coalesce(p.live_bodies_complete_pct, 0) AS live_bodies_complete_pct,
      coalesce(p.historical_bodies_complete_pct, 0) AS historical_bodies_complete_pct
    FROM public.imap_accounts a
    LEFT JOIN public.imap_account_progress p ON p.account_id = a.id
    WHERE ($1::uuid[] IS NULL OR a.id = ANY($1::uuid[]))
    ORDER BY a.email_address
    `,
    [accountIds]
  );

  const accounts: SyncTrustAccount[] = result.rows.map((row) => ({
    account_id: row.account_id,
    account_email: row.account_email,
    sync_state: row.sync_state,
    sync_state_reason: row.sync_state_reason,
    last_sync_at: row.last_sync_finished_at ? row.last_sync_finished_at.toISOString() : null,
    currently_syncing: row.currently_syncing,
    initial_sync_in_progress: row.initial_sync_in_progress,
    historical_backfill_in_progress: row.historical_backfill_in_progress,
    live_headers_complete_pct: row.live_headers_complete_pct,
    live_bodies_complete_pct: row.live_bodies_complete_pct,
    historical_bodies_complete_pct: row.historical_bodies_complete_pct
  }));

  const reasons = new Set<string>();
  if (accounts.length === 0) reasons.add("no_accounts_matched");
  for (const account of accounts) {
    if (account.initial_sync_in_progress) reasons.add("initial_sync_in_progress");
    if (account.historical_backfill_in_progress) reasons.add("historical_backfill_in_progress");
    if (account.live_bodies_complete_pct < 100) reasons.add("bodies_incomplete");
    if (["DEGRADED", "BROKEN", "PAUSED"].includes(account.sync_state)) reasons.add("account_degraded");
  }

  const fullySynced =
    accounts.length > 0 &&
    accounts.every(
      (account) =>
        account.sync_state === "HEALTHY" &&
        !account.initial_sync_in_progress &&
        !account.historical_backfill_in_progress &&
        account.live_headers_complete_pct >= 100 &&
        account.live_bodies_complete_pct >= 100
    );

  return {
    fully_synced: fullySynced,
    results_may_be_incomplete: !fullySynced,
    degraded_reasons: [...reasons],
    accounts
  };
}
