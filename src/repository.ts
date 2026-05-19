import type { AppConfig } from "./config.js";
import { encryptPassword } from "./crypto.js";
import type { PgPool } from "./db.js";
import { assertSafeImapTarget } from "./host-validation.js";
import { getProviderProfile } from "./provider-profiles.js";
import type {
  AccountSummary,
  BodyFetchPolicy,
  CreateAccountInput,
  ImapAccount,
  ImapFolder,
  ImapMessage,
  MessageBodyInput,
  MessageMetadata,
  SyncResult,
  SyncRunStatus,
  SyncTriggerType
} from "./types.js";

const BROKEN_FAILURE_THRESHOLD = 10;
const BACKOFF_FLOOR_MS = 1_000;
const BACKOFF_CEILING_MS = 5 * 60_000;
const ERROR_REASON_MAX_LEN = 1000;

const CREDENTIAL_LEAK_PATTERN = /\b(LOGIN|AUTHENTICATE|PLAIN|XOAUTH2?)\b[\s\S]*$/i;

export function normalizeFlags(flags: readonly string[] | null | undefined): string[] {
  return [...new Set((flags ?? []).map((flag) => flag.trim().toLowerCase()).filter(Boolean))]
    .sort();
}

function flagsEqual(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): boolean {
  const normalizedLeft = normalizeFlags(left);
  const normalizedRight = normalizeFlags(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((flag, index) => flag === normalizedRight[index]);
}

export function sanitizeErrorReason(error: string): string {
  return error
    .replace(CREDENTIAL_LEAK_PATTERN, "$1 [REDACTED]")
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_REASON_MAX_LEN);
}

const ACCOUNT_SUMMARY_COLUMNS = `
  id,
  email_address,
  provider_profile,
  body_fetch_policy,
  sync_state,
  sync_state_reason,
  last_sync_started_at,
  last_sync_finished_at,
  priority_sync_lag_seconds,
  overall_sync_lag_seconds,
  consecutive_failures,
  consecutive_successes,
  backoff_until,
  last_folder_discovery_at,
  next_folder_discovery_at,
  last_heartbeat_at,
  created_at,
  updated_at
`;

export class MirrorRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly config: AppConfig
  ) {}

  async createAccount(input: CreateAccountInput): Promise<AccountSummary> {
    const secure = input.secure ?? true;
    await assertSafeImapTarget(input.host, input.port, secure, {
      allowPrivateHosts: this.config.IMAP_ALLOW_PRIVATE_HOSTS
    });
    const accountCount = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_accounts"
    );
    if (Number(accountCount.rows[0]?.count ?? 0) >= this.config.SYNC_MAX_ACCOUNTS) {
      throw new Error(`SYNC_MAX_ACCOUNTS limit reached (${this.config.SYNC_MAX_ACCOUNTS})`);
    }
    const encrypted = await encryptPassword(this.pool, input.password, this.config.IMAP_ENCRYPTION_KEY);
    const result = await this.pool.query<AccountSummary>(
      `
      INSERT INTO public.imap_accounts (
        email_address,
        provider_profile,
        host,
        port,
        secure,
        username,
        encrypted_password,
        body_fetch_policy
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING ${ACCOUNT_SUMMARY_COLUMNS}
      `,
      [
        input.emailAddress,
        input.providerProfile ?? "generic-imap",
        input.host,
        input.port,
        secure,
        input.username,
        encrypted,
        input.bodyFetchPolicy ?? this.config.BODY_FETCH_POLICY
      ]
    );
    return result.rows[0];
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const result = await this.pool.query<AccountSummary>(
      `SELECT ${ACCOUNT_SUMMARY_COLUMNS} FROM public.imap_accounts ORDER BY email_address`
    );
    return result.rows;
  }

  async getAccount(id: string): Promise<ImapAccount | null> {
    const result = await this.pool.query<ImapAccount>(
      "SELECT * FROM public.imap_accounts WHERE id = $1",
      [id]
    );
    return result.rows[0] ?? null;
  }

  async getRunnableAccounts(limit = 25): Promise<ImapAccount[]> {
    const effectiveLimit = Math.min(limit, this.config.SYNC_MAX_ACCOUNTS);
    const result = await this.pool.query<ImapAccount>(
      `
      SELECT *
      FROM public.imap_accounts
      WHERE sync_state NOT IN ('PAUSED', 'BROKEN')
        AND (backoff_until IS NULL OR backoff_until <= now())
        AND (
          currently_syncing = false
          OR last_heartbeat_at IS NULL
          OR last_heartbeat_at <= now() - ($2::bigint * interval '1 millisecond')
        )
      ORDER BY COALESCE(last_sync_finished_at, 'epoch'::timestamptz), created_at
      LIMIT $1
      `,
      [effectiveLimit, this.config.STALE_HEARTBEAT_MS]
    );
    return result.rows;
  }

  async startSyncRun(accountId: string, triggerType: SyncTriggerType): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_sync_runs (account_id, trigger_type)
      VALUES ($1, $2)
      RETURNING id
      `,
      [accountId, triggerType]
    );
    return result.rows[0].id;
  }

  async finishSyncRun(result: SyncResult): Promise<void> {
    const sanitizedErrors = result.errors.map(sanitizeErrorReason);
    await this.pool.query(
      `
      UPDATE public.imap_sync_runs
      SET
        status = $2,
        finished_at = now(),
        folders_processed = $3,
        messages_upserted = $4,
        bodies_fetched = $5,
        flags_updated = $6,
        reconcile_gaps_found = $7,
        error = $8,
        metadata = $9
      WHERE id = $1
      `,
      [
        result.runId,
        result.outcome,
        result.foldersProcessed,
        result.messagesUpserted,
        result.bodiesFetched,
        result.flagsUpdated,
        result.reconcileGapsFound,
        sanitizedErrors[0] ?? null,
        JSON.stringify({ errors: sanitizedErrors })
      ]
    );
  }

  async updateSyncRunStatus(runId: string, status: SyncRunStatus, error?: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_sync_runs
      SET status = $2, finished_at = CASE WHEN $2 != 'running' THEN now() ELSE finished_at END, error = $3
      WHERE id = $1
      `,
      [runId, status, error ? sanitizeErrorReason(error) : null]
    );
  }

  async markAccountSyncStarted(accountId: string, startedBy: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = true,
        sync_started_by = $2,
        last_sync_started_at = now(),
        last_heartbeat_at = now()
      WHERE id = $1
      `,
      [accountId, startedBy]
    );
  }

  async markAccountSyncSucceeded(accountId: string): Promise<void> {
    await this.pool.query(
      `
      WITH folder_health AS (
        SELECT
          count(*) FILTER (WHERE tracked = true AND status != 'MISSING') AS tracked_count,
          count(*) FILTER (
            WHERE tracked = true
              AND status != 'MISSING'
              AND initial_sync_complete = false
          ) AS incomplete_count,
          count(*) FILTER (
            WHERE tracked = true
              AND status != 'MISSING'
              AND missing_since IS NOT NULL
              AND missing_since < now() - ($2::bigint * interval '1 millisecond')
          ) AS stale_missing_count,
          count(*) FILTER (
            WHERE tracked = true
              AND status != 'MISSING'
              AND sync_priority <= $3
              AND last_reconcile_clean = false
          ) AS priority_reconcile_gap_count,
          count(*) FILTER (
            WHERE tracked = true
              AND status != 'MISSING'
              AND sync_priority <= $3
              AND (
                last_reconcile_clean IS DISTINCT FROM true
                OR last_full_reconcile_at IS NULL
                OR last_full_reconcile_at < now() - ($6::bigint * interval '1 millisecond')
              )
          ) AS priority_reconcile_unhealthy_count,
          count(*) FILTER (
            WHERE tracked = true
              AND status != 'MISSING'
              AND (
                last_reconcile_clean IS DISTINCT FROM true
                OR last_full_reconcile_at IS NULL
                OR last_full_reconcile_at < now() - ($7::bigint * interval '1 millisecond')
              )
          ) AS overall_reconcile_unhealthy_count,
          max(extract(epoch from (now() - last_synced_at))) FILTER (
            WHERE tracked = true
              AND status != 'MISSING'
              AND sync_priority <= $3
              AND last_synced_at IS NOT NULL
          ) AS priority_lag_seconds,
          max(extract(epoch from (now() - last_synced_at))) FILTER (
            WHERE tracked = true
              AND status != 'MISSING'
              AND last_synced_at IS NOT NULL
          ) AS overall_lag_seconds
        FROM public.imap_folders
        WHERE account_id = $1
      )
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_sync_finished_at = now(),
        last_heartbeat_at = now(),
        priority_sync_lag_seconds = ceil(folder_health.priority_lag_seconds)::int,
        overall_sync_lag_seconds = ceil(folder_health.overall_lag_seconds)::int,
        sync_state = CASE
          WHEN folder_health.incomplete_count > 0 THEN 'INITIAL_SYNC'
          WHEN folder_health.stale_missing_count > 0 THEN 'DEGRADED'
          WHEN folder_health.priority_reconcile_gap_count > 0 THEN 'DEGRADED'
          WHEN folder_health.priority_reconcile_unhealthy_count > 0 THEN 'DEGRADED'
          WHEN folder_health.overall_reconcile_unhealthy_count > 0 THEN 'DEGRADED'
          WHEN (folder_health.priority_lag_seconds * 1000) > $4 THEN 'DEGRADED'
          WHEN (folder_health.overall_lag_seconds * 1000) > $5 THEN 'DEGRADED'
          ELSE 'HEALTHY'
        END,
        sync_state_reason = CASE
          WHEN folder_health.incomplete_count > 0 THEN 'INITIAL_SYNC_IN_PROGRESS'
          WHEN folder_health.stale_missing_count > 0 THEN 'FOLDER_MISSING_GRACE_EXCEEDED'
          WHEN folder_health.priority_reconcile_gap_count > 0 THEN 'RECONCILE_GAPS_FOUND'
          WHEN folder_health.priority_reconcile_unhealthy_count > 0 THEN 'PRIORITY_RECONCILE_STALE'
          WHEN folder_health.overall_reconcile_unhealthy_count > 0 THEN 'OVERALL_RECONCILE_STALE'
          WHEN (folder_health.priority_lag_seconds * 1000) > $4 THEN 'PRIORITY_SYNC_LAG'
          WHEN (folder_health.overall_lag_seconds * 1000) > $5 THEN 'OVERALL_SYNC_LAG'
          ELSE NULL
        END,
        consecutive_successes = consecutive_successes + 1,
        consecutive_failures = 0,
        current_backoff_ms = CASE
          WHEN consecutive_successes + 1 >= 3 THEN 0
          ELSE current_backoff_ms
        END,
        backoff_until = NULL
      FROM folder_health
      WHERE id = $1
      `,
      [
        accountId,
        this.config.FOLDER_MISSING_GRACE_MS,
        this.config.PRIORITY_CUTOFF,
        this.config.PRIORITY_LAG_HEALTHY_THRESHOLD_MS,
        this.config.OVERALL_LAG_HEALTHY_THRESHOLD_MS,
        this.config.PRIORITY_RECONCILE_HEALTHY_MAX_AGE_MS,
        this.config.OVERALL_RECONCILE_HEALTHY_MAX_AGE_MS
      ]
    );
  }

  // Per spec §12.2: PARTIAL_SUCCESS means priority folders succeeded but some
  // round-robin folders didn't. Counters increment as if it were SUCCESS
  // (consecutive_successes++, failures=0); sync_state stays DEGRADED until
  // round-robin folders catch up.
  async markAccountSyncPartial(accountId: string, error: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_sync_finished_at = now(),
        last_heartbeat_at = now(),
        sync_state = 'DEGRADED',
        sync_state_reason = $2,
        consecutive_successes = consecutive_successes + 1,
        consecutive_failures = 0,
        current_backoff_ms = CASE
          WHEN consecutive_successes + 1 >= 3 THEN 0
          ELSE current_backoff_ms
        END,
        backoff_until = NULL
      WHERE id = $1
      `,
      [accountId, sanitizeErrorReason(error)]
    );
  }

  // Per spec §12.4 / §13.1: AUTH_ERROR is non-retryable. Skip backoff math and
  // pin the account at BROKEN with a clear reason. Operator intervention is
  // required (rotate creds, re-add account).
  async markAccountSyncAuthFailed(accountId: string, error: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_sync_finished_at = now(),
        sync_state = 'BROKEN',
        sync_state_reason = $2,
        consecutive_failures = consecutive_failures + 1,
        consecutive_successes = 0,
        current_backoff_ms = 0,
        backoff_until = NULL
      WHERE id = $1
      `,
      [accountId, sanitizeErrorReason(`AUTH_ERROR: ${error}`)]
    );
  }

  async markAccountSyncFailed(accountId: string, error: string): Promise<void> {
    // CTE computes the doubled-and-clamped backoff once so the same value
    // feeds both `current_backoff_ms` and `backoff_until` — without it the
    // expression has to be duplicated and would drift on tuning changes.
    await this.pool.query(
      `
      WITH next_backoff AS (
        SELECT
          base_ms,
          LEAST(
            $5::int,
            GREATEST($4::int, floor(base_ms * (0.7 + random() * 0.6))::int)
          ) AS jittered_ms
        FROM (
          SELECT LEAST(GREATEST(current_backoff_ms * 2, $4::int), $5::int) AS base_ms
          FROM public.imap_accounts
          WHERE id = $1
        ) base
      )
      UPDATE public.imap_accounts a
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_sync_finished_at = now(),
        sync_state = CASE WHEN consecutive_failures + 1 >= $3 THEN 'BROKEN' ELSE 'DEGRADED' END,
        sync_state_reason = $2,
        consecutive_failures = consecutive_failures + 1,
        consecutive_successes = 0,
        current_backoff_ms = next_backoff.base_ms,
        backoff_until = now() + (next_backoff.jittered_ms * interval '1 millisecond')
      FROM next_backoff
      WHERE a.id = $1
      `,
      [
        accountId,
        sanitizeErrorReason(error),
        BROKEN_FAILURE_THRESHOLD,
        BACKOFF_FLOOR_MS,
        BACKOFF_CEILING_MS
      ]
    );
  }

  async heartbeat(accountId: string): Promise<void> {
    await this.pool.query("UPDATE public.imap_accounts SET last_heartbeat_at = now() WHERE id = $1", [
      accountId
    ]);
  }

  async runExpiryJob(): Promise<{ expired: number }> {
    const result = await this.pool.query(
      `
      UPDATE public.imap_messages
      SET window_status = 'EXPIRED'
      WHERE window_status = 'IN_WINDOW'
        AND internal_date < now() - ($1::int * interval '1 day')
      `,
      [this.config.WINDOW_DAYS]
    );
    return { expired: result.rowCount ?? 0 };
  }

  async runPurgeJob(): Promise<{ purged: number }> {
    const result = await this.pool.query(
      `
      DELETE FROM public.imap_messages
      WHERE deleted_in_provider = true
        AND deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING')
        AND provider_deleted_at < now() - interval '30 days'
      `
    );
    return { purged: result.rowCount ?? 0 };
  }

  async runRetentionJobs(): Promise<{ expired: number; purged: number }> {
    const { expired } = await this.runExpiryJob();
    const { purged } = await this.runPurgeJob();
    return { expired, purged };
  }

  async upsertDiscoveredFolders(
    account: ImapAccount,
    folders: Array<{ path: string; delimiter?: string | null; specialUse?: string | null }>
  ): Promise<ImapFolder[]> {
    const profile = getProviderProfile(account.provider_profile);
    const rows: ImapFolder[] = [];
    const seen = new Set<string>();

    for (const folder of folders) {
      seen.add(folder.path);
      const excludedReason = profile.excludedReason(folder.path, folder.specialUse);
      const result = await this.pool.query<ImapFolder>(
        `
        INSERT INTO public.imap_folders (
          account_id,
          path,
          delimiter,
          special_use,
          last_seen_in_provider_at,
          tracked,
          excluded_reason,
          sync_priority,
          status
        )
        VALUES ($1, $2, $3, $4, now(), $5, $6, $7, CASE WHEN $5 THEN 'PENDING' ELSE 'ACTIVE' END)
        ON CONFLICT (account_id, path)
        DO UPDATE SET
          delimiter = EXCLUDED.delimiter,
          special_use = EXCLUDED.special_use,
          last_seen_in_provider_at = now(),
          missing_since = NULL,
          tracked = EXCLUDED.tracked,
          excluded_reason = EXCLUDED.excluded_reason,
          sync_priority = EXCLUDED.sync_priority,
          status = CASE WHEN public.imap_folders.status = 'MISSING' THEN 'PENDING' ELSE public.imap_folders.status END
        RETURNING *
        `,
        [
          account.id,
          folder.path,
          folder.delimiter ?? null,
          folder.specialUse ?? null,
          excludedReason === null,
          excludedReason,
          profile.priorityForFolder(folder.path, folder.specialUse)
        ]
      );
      rows.push(result.rows[0]);
    }

    // Spec §10.2: folder-missing grace. Only flip to MISSING + untrack after
    // the folder has been absent for FOLDER_MISSING_GRACE_MS. A transient LIST
    // glitch (provider hiccup, lock contention) should not tombstone messages.
    const newlyMissing = await this.pool.query<{ path: string }>(
      `
      UPDATE public.imap_folders
      SET status = 'MISSING',
          tracked = false
      WHERE account_id = $1
        AND NOT (path = ANY($2::text[]))
        AND missing_since IS NOT NULL
        AND missing_since < now() - ($3::bigint * interval '1 millisecond')
        AND status != 'MISSING'
      RETURNING path
      `,
      [account.id, [...seen], this.config.FOLDER_MISSING_GRACE_MS]
    );

    for (const row of newlyMissing.rows) {
      await this.pool.query(
        `
        UPDATE public.imap_messages
        SET deleted_in_provider = true,
            provider_deleted_at = now(),
            deleted_reason = 'FOLDER_MISSING'
        WHERE account_id = $1
          AND folder_path = $2
          AND deleted_in_provider = false
          AND window_status = 'IN_WINDOW'
        `,
        [account.id, row.path]
      );
      await this.logEvent(account.id, null, null, row.path, null, "FOLDER_MISSING", {
        reason: "FOLDER_MISSING_GRACE_EXCEEDED"
      });
    }

    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET missing_since = now()
      WHERE account_id = $1
        AND NOT (path = ANY($2::text[]))
        AND missing_since IS NULL
        AND status != 'MISSING'
      `,
      [account.id, [...seen]]
    );

    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET last_folder_discovery_at = now(),
          next_folder_discovery_at = now() + ($2::bigint * interval '1 millisecond')
      WHERE id = $1
      `,
      [account.id, this.config.FOLDER_DISCOVERY_INTERVAL_MS]
    );

    return rows;
  }

  async getFoldersDueForSync(accountId: string): Promise<ImapFolder[]> {
    const priority = await this.pool.query<ImapFolder>(
      `
      SELECT *
      FROM public.imap_folders
      WHERE account_id = $1
        AND tracked = true
        AND status != 'MISSING'
        AND sync_priority <= $2
        AND (next_sync_due_at IS NULL OR next_sync_due_at <= now())
      ORDER BY sync_priority, path
      LIMIT $3
      `,
      [accountId, this.config.PRIORITY_CUTOFF, this.config.MAX_PRIORITY_FOLDERS_PER_CYCLE]
    );

    const account = await this.getAccount(accountId);
    const cursor = account?.folder_rr_cursor ?? 0;
    const rrCandidates = await this.pool.query<ImapFolder>(
      `
      SELECT *
      FROM public.imap_folders
      WHERE account_id = $1
        AND tracked = true
        AND status != 'MISSING'
        AND sync_priority > $2
        AND (next_sync_due_at IS NULL OR next_sync_due_at <= now())
      ORDER BY path
      `,
      [accountId, this.config.PRIORITY_CUTOFF]
    );
    const rrRows = rrCandidates.rows;
    const rotated = rrRows.length === 0
      ? []
      : [...rrRows.slice(cursor % rrRows.length), ...rrRows.slice(0, cursor % rrRows.length)];
    const rr = rotated.slice(0, this.config.MAX_RR_FOLDERS_PER_CYCLE);

    if (rrRows.length > 0 && rr.length > 0) {
      await this.pool.query(
        "UPDATE public.imap_accounts SET folder_rr_cursor = $2 WHERE id = $1",
        [accountId, (cursor + rr.length) % rrRows.length]
      );
    }

    return [...priority.rows, ...rr];
  }

  async markFolderSyncStarted(folderId: string): Promise<void> {
    await this.pool.query(
      "UPDATE public.imap_folders SET status = 'SYNCING', last_progress_at = now() WHERE id = $1",
      [folderId]
    );
  }

  // Spec §10.4: capture the SEARCH(since cutoff) snapshot at the start of an
  // initial sync. `oldestUidSynced` is set to `targetMaxUid + 1` as a sentinel
  // so the first downward batch picks up UIDs strictly less than it.
  async setInitialSyncSnapshot(
    folderId: string,
    targetMaxUid: number,
    oldestUidSynced: number
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET initial_sync_target_max_uid = $2,
          initial_sync_oldest_uid_synced = $3,
          last_progress_at = now()
      WHERE id = $1
      `,
      [folderId, targetMaxUid, oldestUidSynced]
    );
  }

  async advanceInitialSyncWatermark(
    folderId: string,
    newOldestUidSynced: number,
    lastProgressUid: number
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET initial_sync_oldest_uid_synced = $2,
          last_progress_at = now(),
          last_progress_uid = $3
      WHERE id = $1
      `,
      [folderId, newOldestUidSynced, lastProgressUid]
    );
  }

  async markFolderSynced(folderId: string, patch: {
    uidValidity: number;
    uidNext?: number;
    lastUid?: number;
    initialComplete?: boolean;
    reconcileClean?: boolean;
    flagScanCompleted?: boolean;
  }): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET
        status = 'ACTIVE',
        uidvalidity = $2,
        uid_next = COALESCE($3, uid_next),
        last_uid = COALESCE($4, last_uid),
        initial_sync_complete = COALESCE($5, initial_sync_complete),
        last_synced_at = now(),
        last_full_reconcile_at = CASE WHEN $6::boolean IS NOT NULL THEN now() ELSE last_full_reconcile_at END,
        last_reconcile_clean = COALESCE($6, last_reconcile_clean),
        next_sync_due_at = now() + interval '1 minute',
        next_flag_scan_at = CASE
          WHEN $7::boolean = true THEN now() + ((
            CASE WHEN sync_priority <= $11::int THEN $8::bigint ELSE $9::bigint END
          ) * interval '1 millisecond')
          WHEN next_flag_scan_at IS NULL AND $5::boolean = true THEN now()
          ELSE next_flag_scan_at
        END,
        next_reconcile_at = CASE
          WHEN $6::boolean IS NOT NULL
            THEN now()
              + ($10::bigint * interval '1 millisecond')
              + ((random() * 900000)::int * interval '1 millisecond')
          WHEN $5::boolean = true AND next_reconcile_at IS NULL
            THEN now() + ((random() * $10::double precision)::int * interval '1 millisecond')
          ELSE COALESCE(next_reconcile_at, now() + ((random() * $10::double precision)::int * interval '1 millisecond'))
        END
      WHERE id = $1
      `,
      [
        folderId,
        patch.uidValidity,
        patch.uidNext ?? null,
        patch.lastUid ?? null,
        patch.initialComplete ?? null,
        patch.reconcileClean ?? null,
        patch.flagScanCompleted ?? null,
        this.config.PRIORITY_FLAG_SCAN_INTERVAL_MS,
        this.config.RR_FLAG_SCAN_INTERVAL_MS,
        this.config.RECONCILE_INTERVAL_MS,
        this.config.PRIORITY_CUTOFF
      ]
    );
  }

  // Returns the post-reset `uidvalidity_reset_count`, scoped to a rolling
  // 24h window (resets older than 24h don't count). Caller compares against
  // MAX_UIDVALIDITY_RESETS_24H to decide whether to mark the account BROKEN.
  async handleUidValidityReset(
    account: ImapAccount,
    folder: ImapFolder,
    newUidValidity: number
  ): Promise<{ resetCountIn24h: number }> {
    const client = await this.pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `
        UPDATE public.imap_messages
        SET deleted_in_provider = true,
            provider_deleted_at = now(),
            deleted_reason = 'UIDVALIDITY_RESET'
        WHERE account_id = $1
          AND folder_path = $2
          AND deleted_in_provider = false
        `,
        [account.id, folder.path]
      );
      const folderRow = await client.query<{ uidvalidity_reset_count: number }>(
        `
        UPDATE public.imap_folders
        SET uidvalidity = $3,
            last_uid = NULL,
            initial_sync_complete = false,
            initial_sync_target_max_uid = NULL,
            initial_sync_oldest_uid_synced = NULL,
            status = 'NEEDS_FULL_RESYNC',
            uidvalidity_reset_count = CASE
              WHEN last_uidvalidity_reset_at IS NULL
                OR last_uidvalidity_reset_at < now() - interval '24 hours'
              THEN 1
              ELSE uidvalidity_reset_count + 1
            END,
            last_uidvalidity_reset_at = now()
        WHERE id = $1
          AND account_id = $2
        RETURNING uidvalidity_reset_count
        `,
        [folder.id, account.id, newUidValidity]
      );
      await client.query(
        `
        INSERT INTO public.imap_sync_events (
          account_id,
          sync_run_id,
          message_id,
          folder_path,
          provider_uid,
          event_type,
          payload
        )
        VALUES ($1, NULL, NULL, $2, NULL, 'FOLDER_RESET', $3)
        `,
        [account.id, folder.path, JSON.stringify({ reason: "UIDVALIDITY_RESET", newUidValidity })]
      );
      await client.query("COMMIT");
      return { resetCountIn24h: folderRow.rows[0]?.uidvalidity_reset_count ?? 1 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markAccountBroken(accountId: string, reason: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        sync_state = 'BROKEN',
        sync_state_reason = $2,
        current_backoff_ms = 0,
        backoff_until = NULL
      WHERE id = $1
      `,
      [accountId, sanitizeErrorReason(reason)]
    );
  }

  async upsertMessages(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    messages: MessageMetadata[],
    windowCutoff: Date
  ): Promise<ImapMessage[]> {
    if (messages.length === 0) return [];

    const rows: ImapMessage[] = [];
    const client = await this.pool.connect();

    try {
    for (const message of messages) {
      await client.query("BEGIN");
      try {
      const result = await client.query<ImapMessage>(
        `
        INSERT INTO public.imap_messages (
          account_id,
          folder_id,
          folder_path,
          uidvalidity,
          uid,
          rfc_message_id,
          message_id_normalized,
          provider_thread_id,
          in_reply_to,
          references_header,
          internal_date,
          size_bytes,
          subject,
          from_email,
          from_name,
          to_emails,
          to_names,
          cc_emails,
          cc_names,
          bcc_emails,
          flags,
          headers_json,
          mime_structure,
          window_status
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, $24
        )
        ON CONFLICT (account_id, folder_path, uidvalidity, uid)
        DO UPDATE SET
          flags = EXCLUDED.flags,
          headers_json = EXCLUDED.headers_json,
          mime_structure = EXCLUDED.mime_structure,
          deleted_in_provider = false,
          provider_deleted_at = NULL,
          deleted_reason = NULL
        RETURNING *
        `,
        [
          accountId,
          folder.id,
          folder.path,
          uidValidity,
          message.uid,
          message.rfcMessageId,
          message.messageIdNormalized,
          message.providerThreadId,
          message.inReplyTo,
          message.referencesHeader,
          message.internalDate,
          message.sizeBytes,
          message.subject,
          message.fromEmail,
          message.fromName,
          message.toEmails,
          message.toNames,
          message.ccEmails,
          message.ccNames,
          message.bccEmails,
          message.flags,
          JSON.stringify(message.headersJson),
          JSON.stringify(message.mimeStructure ?? null),
          message.internalDate < windowCutoff ? "HISTORICAL" : "IN_WINDOW"
        ]
      );

      const row = result.rows[0];

      for (const attachment of message.attachments) {
        await client.query(
          `
          INSERT INTO public.imap_attachments (
            message_id,
            filename,
            mime_type,
            size_bytes,
            part_number,
            content_id,
            disposition
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (message_id, part_number)
          DO UPDATE SET
            filename = EXCLUDED.filename,
            mime_type = EXCLUDED.mime_type,
            size_bytes = EXCLUDED.size_bytes,
            content_id = EXCLUDED.content_id,
            disposition = EXCLUDED.disposition
          `,
          [
            row.id,
            attachment.filename,
            attachment.mimeType,
            attachment.sizeBytes,
            attachment.partNumber,
            attachment.contentId,
            attachment.disposition
          ]
        );
      }
      await client.query("COMMIT");
      rows.push(row);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    } finally {
      client.release();
    }

    return rows;
  }

  async applyFlagScan(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    messages: MessageMetadata[],
    windowCutoff: Date
  ): Promise<{ messages: ImapMessage[]; flagsChanged: number }> {
    if (messages.length === 0) return { messages: [], flagsChanged: 0 };

    const uids = messages.map((message) => message.uid);
    const existing = await this.pool.query<Pick<ImapMessage, "id" | "uid" | "flags">>(
      `
      SELECT id, uid, flags
      FROM public.imap_messages
      WHERE account_id = $1
        AND folder_path = $2
        AND uidvalidity = $3
        AND uid = ANY($4::bigint[])
        AND deleted_in_provider = false
      `,
      [accountId, folder.path, uidValidity, uids]
    );
    const existingByUid = new Map(existing.rows.map((row) => [Number(row.uid), row]));
    const knownMessages = messages.filter((message) => existingByUid.has(message.uid));
    const changed = messages
      .map((message) => {
        const row = existingByUid.get(message.uid);
        if (!row || flagsEqual(row.flags, message.flags)) return null;
        return {
          row,
          message,
          previousFlags: normalizeFlags(row.flags),
          nextFlags: normalizeFlags(message.flags)
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const rows = await this.upsertMessages(accountId, folder, uidValidity, knownMessages, windowCutoff);

    for (const change of changed) {
      await this.logEvent(
        accountId,
        null,
        change.row.id,
        folder.path,
        change.message.uid,
        "FLAGS_CHANGED",
        {
          previousFlags: change.previousFlags,
          nextFlags: change.nextFlags
        }
      );
    }

    return { messages: rows, flagsChanged: changed.length };
  }

  async markMissingMessages(accountId: string, folder: ImapFolder, uidValidity: number, liveUids: number[]): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `
      WITH marked AS (
        UPDATE public.imap_messages
        SET deleted_in_provider = true,
            provider_deleted_at = now(),
            deleted_reason = 'RECONCILE_MISSING'
        WHERE account_id = $1
          AND folder_path = $2
          AND uidvalidity = $3
          AND deleted_in_provider = false
          AND window_status = 'IN_WINDOW'
          AND NOT (uid = ANY($4::bigint[]))
        RETURNING id
      )
      SELECT count(*)::text AS count FROM marked
      `,
      [accountId, folder.path, uidValidity, liveUids]
    );
    return Number(result.rows[0].count);
  }

  async hasActiveWindowMessages(accountId: string, folder: ImapFolder, uidValidity: number): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM public.imap_messages
        WHERE account_id = $1
          AND folder_path = $2
          AND uidvalidity = $3
          AND deleted_in_provider = false
          AND window_status = 'IN_WINDOW'
      ) AS exists
      `,
      [accountId, folder.path, uidValidity]
    );
    return result.rows[0]?.exists ?? false;
  }

  // Reconcile via a streamed temp table rather than a `bigint[]` parameter:
  // heavy mailboxes (e.g. Gmail "All Mail") routinely surface 100k+ UIDs,
  // which blows up array-parameter encoding and forces the entire UID set
  // into Node memory. The TEMP TABLE … ON COMMIT DROP scopes lifetime to
  // the surrounding transaction, so no cleanup is needed on failure.
  async markMissingMessagesFromLiveUidStream(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    liveUids: AsyncIterable<number>,
    options: { failIfEmpty?: boolean; emptyError?: string; batchSize?: number } = {}
  ): Promise<{ markedCount: number; liveUidCount: number; missingInDbUids: number[] }> {
    const batchSize = options.batchSize ?? 10_000;
    const client = await this.pool.connect();
    const batch: number[] = [];
    let liveUidCount = 0;

    const flush = async () => {
      if (batch.length === 0) return;
      await client.query(
        `
        INSERT INTO supamail_live_uids (uid)
        SELECT DISTINCT unnest($1::bigint[])
        ON CONFLICT DO NOTHING
        `,
        [batch.splice(0, batch.length)]
      );
    };

    await client.query("BEGIN");
    try {
      await client.query("CREATE TEMP TABLE supamail_live_uids (uid bigint PRIMARY KEY) ON COMMIT DROP");

      for await (const uid of liveUids) {
        liveUidCount += 1;
        batch.push(uid);
        if (batch.length >= batchSize) await flush();
      }
      await flush();

      if (liveUidCount === 0 && options.failIfEmpty) {
        throw new Error(options.emptyError ?? `Reconcile returned no UIDs for non-empty mailbox ${folder.path}`);
      }

      const markedResult = await client.query<{ count: string }>(
        `
        WITH marked AS (
          UPDATE public.imap_messages m
          SET deleted_in_provider = true,
              provider_deleted_at = now(),
              deleted_reason = 'RECONCILE_MISSING'
          WHERE m.account_id = $1
            AND m.folder_path = $2
            AND m.uidvalidity = $3
            AND m.deleted_in_provider = false
            AND m.window_status = 'IN_WINDOW'
            AND NOT EXISTS (
              SELECT 1
              FROM supamail_live_uids live
              WHERE live.uid = m.uid
            )
          RETURNING m.id
        )
        SELECT count(*)::text AS count FROM marked
        `,
        [accountId, folder.path, uidValidity]
      );

      // Spec §10.7 step 3: server has UIDs we don't have a live row for.
      // Caller fetches metadata for these and upserts (closes the gap).
      const missingResult = await client.query<{ uid: string }>(
        `
        SELECT live.uid::text AS uid
        FROM supamail_live_uids live
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.imap_messages m
          WHERE m.account_id = $1
            AND m.folder_path = $2
            AND m.uidvalidity = $3
            AND m.uid = live.uid
            AND m.deleted_in_provider = false
        )
        ORDER BY live.uid DESC
        LIMIT 5000
        `,
        [accountId, folder.path, uidValidity]
      );

      await client.query("COMMIT");
      return {
        markedCount: Number(markedResult.rows[0].count),
        liveUidCount,
        missingInDbUids: missingResult.rows.map((row) => Number(row.uid))
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getMessage(id: string): Promise<ImapMessage | null> {
    const result = await this.pool.query<ImapMessage>("SELECT * FROM public.imap_messages WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async storeBody(body: MessageBodyInput): Promise<void> {
    await this.pool.query(
      `
      WITH upsert AS (
        INSERT INTO public.imap_message_bodies (
          message_id,
          raw_mime,
          raw_bytes,
          raw_truncated,
          body_text,
          body_html,
          body_plain,
          selected_text_part,
          selected_text_format,
          headers_json,
          mime_structure,
          parser_warnings,
          fetched_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now(), now())
        ON CONFLICT (message_id)
        DO UPDATE SET
          raw_mime = EXCLUDED.raw_mime,
          raw_bytes = EXCLUDED.raw_bytes,
          raw_truncated = EXCLUDED.raw_truncated,
          body_text = EXCLUDED.body_text,
          body_html = EXCLUDED.body_html,
          body_plain = EXCLUDED.body_plain,
          selected_text_part = EXCLUDED.selected_text_part,
          selected_text_format = EXCLUDED.selected_text_format,
          headers_json = EXCLUDED.headers_json,
          mime_structure = EXCLUDED.mime_structure,
          parser_warnings = EXCLUDED.parser_warnings,
          fetched_at = now(),
          updated_at = now()
        RETURNING message_id
      )
      UPDATE public.imap_messages
      SET body_fetched_at = now()
      WHERE id IN (SELECT message_id FROM upsert)
      `,
      [
        body.messageId,
        body.rawMime,
        body.rawBytes,
        body.rawTruncated,
        body.bodyText,
        body.bodyHtml,
        body.bodyPlain,
        body.selectedTextPart,
        body.selectedTextFormat,
        JSON.stringify(body.headersJson),
        JSON.stringify(body.mimeStructure ?? null),
        body.parserWarnings
      ]
    );
  }

  async getBodyBacklog(account: ImapAccount, limit: number): Promise<ImapMessage[]> {
    const policy = account.body_fetch_policy || (this.config.BODY_FETCH_POLICY as BodyFetchPolicy);
    if (policy === "lazy") return [];

    const priorityClause = policy === "priority_then_backfill" ? "AND f.sync_priority <= $3" : "";
    const params: unknown[] = [account.id, limit];
    if (policy === "priority_then_backfill") params.push(this.config.PRIORITY_CUTOFF);

    const result = await this.pool.query<ImapMessage>(
      `
      SELECT m.*
      FROM public.imap_messages m
      JOIN public.imap_folders f ON f.account_id = m.account_id AND f.path = m.folder_path
      WHERE m.account_id = $1
        AND m.deleted_in_provider = false
        AND m.window_status = 'IN_WINDOW'
        AND m.body_fetched_at IS NULL
        ${priorityClause}
      ORDER BY f.sync_priority, m.uid DESC
      LIMIT $2
      `,
      params
    );
    return result.rows;
  }

  async logEvent(
    accountId: string,
    syncRunId: string | null,
    messageId: string | null,
    folderPath: string | null,
    providerUid: number | null,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO public.imap_sync_events (
        account_id,
        sync_run_id,
        message_id,
        folder_path,
        provider_uid,
        event_type,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [accountId, syncRunId, messageId, folderPath, providerUid, eventType, JSON.stringify(payload)]
    );
  }
}
