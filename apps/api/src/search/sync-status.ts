import type { PgClient, PgPool } from "../db.js";
import type { ReadAccount, ReadAccountNotice, SyncStatus, SyncStatusAccount } from "./types.js";
import {
  METADATA_PROTECTED_FIELDS,
  plaintextMetadataProtection,
  revealMetadataRecord,
  type MetadataProtectionAdapter,
  type ProtectedMetadataColumns
} from "../metadata-protection.js";

export type Queryable = Pick<PgPool | PgClient, "query">;

interface AccountRow extends ProtectedMetadataColumns {
  account_id: string;
  email_address: string;
  sync_state: string;
}

interface StatusRow extends AccountRow {
  sync_state_reason: string | null;
  last_sync_finished_at: Date | null;
  currently_syncing: boolean;
  initial_sync_in_progress: boolean;
  historical_backfill_in_progress: boolean;
  live_headers_complete_pct: number;
  live_bodies_complete_pct: number;
  historical_bodies_complete_pct: number;
}

const ACCOUNT_COLUMNS = `
  a.id AS account_id,
  a.email_address,
  a.sync_state,
  a.protected_metadata,
  a.protected_metadata_version,
  a.protected_metadata_key_version,
  a.protected_metadata_tokens`;

/**
 * Only states that make a read result incomplete get a notice. A delayed but
 * syncing mailbox (DEGRADED) or one still storing older bodies is complete
 * enough for an answer; `get_sync_status` reports those details on request.
 */
const READ_NOTICES: Record<string, ReadAccountNotice> = {
  INITIAL_SYNC: "first_sync_in_progress",
  BROKEN: "sync_stopped",
  PAUSED: "sync_paused"
};

async function revealAccounts<T extends AccountRow>(
  rows: T[],
  metadataProtection: MetadataProtectionAdapter
): Promise<T[]> {
  return Promise.all(rows.map((row) => revealMetadataRecord(
    metadataProtection,
    { kind: "account", accountId: row.account_id, recordId: row.account_id },
    row,
    METADATA_PROTECTED_FIELDS.account
  )));
}

/**
 * Name the Mailbox Accounts a read result came from, with a notice only when a
 * mailbox cannot give a complete answer. One indexed read of the account rows;
 * `null` means every account in this database.
 */
export async function buildReadAccounts(
  db: Queryable,
  accountIds: string[] | null,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<ReadAccount[]> {
  const result = await db.query<AccountRow>(
    `
    SELECT ${ACCOUNT_COLUMNS}
    FROM public.imap_accounts a
    WHERE ($1::uuid[] IS NULL OR a.id = ANY($1::uuid[]))
    ORDER BY a.id
    `,
    [accountIds]
  );
  const rows = await revealAccounts(result.rows, metadataProtection);
  return rows.map((row) => {
    const notice = READ_NOTICES[row.sync_state];
    return {
      account_id: row.account_id,
      account_email: row.email_address,
      ...(notice ? { notice } : {})
    };
  });
}

type StatusReason =
  | "sync_stopped"
  | "sync_paused"
  | "initial_sync_in_progress"
  | "sync_delayed"
  | "headers_incomplete"
  | "bodies_incomplete"
  | "historical_backfill_in_progress";

/** Every way one mailbox can fall short of fully synced, in summary order. */
function accountReasons(account: SyncStatusAccount): StatusReason[] {
  const reasons: StatusReason[] = [];
  if (account.sync_state === "BROKEN") reasons.push("sync_stopped");
  if (account.sync_state === "PAUSED") reasons.push("sync_paused");
  if (account.initial_sync_in_progress) reasons.push("initial_sync_in_progress");
  if (account.sync_state === "DEGRADED") reasons.push("sync_delayed");
  if (account.live_headers_complete_pct < 100) reasons.push("headers_incomplete");
  if (account.live_bodies_complete_pct < 100) reasons.push("bodies_incomplete");
  if (account.historical_backfill_in_progress) reasons.push("historical_backfill_in_progress");
  return reasons;
}

/** One sentence for a mailbox that is not fully synced; the most severe state wins. */
function describeAccount(account: SyncStatusAccount, reasons: StatusReason[]): string {
  const email = account.account_email;
  if (reasons.includes("sync_stopped")) return `${email}: sync stopped.`;
  if (reasons.includes("sync_paused")) return `${email}: sync paused.`;
  if (reasons.includes("initial_sync_in_progress")) {
    return `${email}: first sync, ${account.live_headers_complete_pct}% of recent mail and ` +
      `${account.live_bodies_complete_pct}% of its bodies stored.`;
  }
  const notes = reasons.map((reason) => {
    switch (reason) {
      case "sync_delayed": return "sync delayed";
      case "headers_incomplete": return `${account.live_headers_complete_pct}% of recent mail stored`;
      case "bodies_incomplete": return `${account.live_bodies_complete_pct}% of recent bodies stored`;
      default: return `storing older mail, ${account.historical_bodies_complete_pct}% done`;
    }
  });
  return `${email}: ${notes.join(", ")}.`;
}

/**
 * The full sync report for `get_sync_status`: per-account state and progress
 * from `imap_account_progress`, the reasons any mailbox is not fully synced,
 * and a one-line summary, all from one rule set. It reads every recent
 * message's body state, so read tools do not call it.
 */
export async function buildSyncStatus(
  db: Queryable,
  accountIds: string[] | null,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<SyncStatus> {
  const result = await db.query<StatusRow>(
    `
    SELECT ${ACCOUNT_COLUMNS},
      a.sync_state_reason,
      -- A live-notification sync of one folder does not finish an account sync, but
      -- it does bring that folder up to date, so the newest folder sync counts too.
      greatest(
        a.last_sync_finished_at,
        (SELECT max(f.last_synced_at) FROM public.imap_folders f WHERE f.account_id = a.id)
      ) AS last_sync_finished_at,
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
    ORDER BY a.id
    `,
    [accountIds]
  );

  const rows = await revealAccounts(result.rows, metadataProtection);
  const accounts: SyncStatusAccount[] = rows.map((row) => ({
    account_id: row.account_id,
    account_email: row.email_address,
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

  const perAccount = accounts.map((account) => ({ account, reasons: accountReasons(account) }));
  const behind = perAccount.filter(({ reasons }) => reasons.length > 0);
  const summary = accounts.length === 0
    ? "No mailboxes matched."
    : behind.length === 0
      ? `All ${accounts.length === 1 ? "mail is" : `${accounts.length} mailboxes are`} synced.`
      : behind.map(({ account, reasons }) => describeAccount(account, reasons)).join(" ");

  return {
    summary,
    fully_synced: accounts.length > 0 && behind.length === 0,
    degraded_reasons: accounts.length === 0
      ? ["no_accounts_matched"]
      : [...new Set(behind.flatMap(({ reasons }) => reasons))],
    accounts
  };
}
