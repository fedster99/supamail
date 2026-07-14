import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import { encryptPassword } from "./crypto.js";
import type { PgClient, PgPool } from "./db.js";
import { assertSafeImapTarget } from "./host-validation.js";
import { normalizeMessageId } from "./mime.js";
import { autodiscoverProfile, getProviderProfile } from "./provider-profiles.js";
import type {
  AccountDetails,
  AccountProgress,
  AccountSummary,
  BodyFetchPolicy,
  CreateAccountInput,
  FolderProgress,
  HistoryBacklogFolder,
  ImapAccount,
  ImapFolder,
  ImapMessage,
  MessageBodyInput,
  MessageMetadata,
  SyncResult,
  SyncRunStatus,
  SyncTriggerType,
  UpdateAccountSettingsInput
} from "./types.js";

const BROKEN_FAILURE_THRESHOLD = 10;
const BACKOFF_FLOOR_MS = 1_000;
const BACKOFF_CEILING_MS = 5 * 60_000;
const ERROR_REASON_MAX_LEN = 1000;
const MANUAL_TRACK_OVERRIDE_NOTE = "manual_track_override";
const MISSING_MAILBOX_VERIFICATION_NOTE = "missing_mailbox_pending_verification";
const LIVE_THREAD_RUN_STATUSES = ["building", "ready", "active", "standby"] as const;
const PURGE_MESSAGE_BATCH_SIZE = 100;
const PURGE_RECOMPUTE_PAIR_LIMIT = 25_000;
const THREADING_BODY_HEADER_KEYS = [
  "message-id",
  "references",
  "in-reply-to",
  "auto-submitted",
  "x-auto-response-suppress",
  "list-unsubscribe",
  "list-id",
  "precedence",
  "reply-to",
  "thread-index",
  "thread-topic"
] as const;

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

function headerText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const joined = value.map((entry) => String(entry).trim()).filter(Boolean).join(" ");
    return joined || null;
  }
  return value == null ? null : String(value).trim() || null;
}

/**
 * JSONB does not preserve object insertion order, while the IMAP parser's plain
 * objects do. Comparing JSON.stringify output directly therefore turns harmless
 * key-order changes into perpetual threading work. This canonical form sorts
 * object keys recursively, preserves array order, and mirrors JSON.stringify's
 * omission of undefined object properties.
 */
export function canonicalJsonForThreadingEvidence(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? "null" : canonicalJsonForThreadingEvidence(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJsonForThreadingEvidence(entry)}`
    )).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

interface PurgeCandidate {
  id: string;
  account_id: string;
}

interface PurgeQueueTarget {
  run_id: string;
  message_id: string;
  account_id: string;
}

export function sanitizeErrorReason(error: string): string {
  return error
    .replace(CREDENTIAL_LEAK_PATTERN, "$1 [REDACTED]")
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_REASON_MAX_LEN);
}

/** Resolved IMAP connection coordinates + the chosen provider profile id for a new
 * account (the twin of {@link import("./smtp-client.js").ResolvedSmtpCreds}). */
export interface ResolvedImapCoords {
  host: string;
  port: number;
  secure: boolean;
  /** The provider_profile id to store (drives the SMTP path's smtpDefaults). */
  providerProfile: string;
}

/**
 * Resolve the IMAP coordinates for a new account (email-008, ADR 0021), the twin of
 * `resolveSmtpCreds`. Precedence (highest first):
 *   (1) explicit host/port/secure (always wins, applied via `??`),
 *   (2) an explicitly-named non-generic preset's `imapDefaults`
 *       (`--profile fastmail` supplies the fastmail coordinates),
 *   (3) email-domain autodiscovery (the domain guess),
 *   (4) clear error.
 * An explicit `--profile` thus BEATS the domain guess; an explicit host beats both.
 * The chosen preset id is returned in `providerProfile` so the SMTP path's
 * `resolveSmtpCreds` (ADR 0017) picks up the matching smtpDefaults. Pure: no DB, no
 * network (autodiscovery is a static map lookup) — tested by direct call.
 */
export function resolveImapCoords(input: {
  emailAddress: string;
  host?: string;
  port?: number;
  secure?: boolean;
  providerProfile?: string;
}): ResolvedImapCoords {
  const namedProfile =
    input.providerProfile !== undefined ? getProviderProfile(input.providerProfile) : null;
  const namedPreset = namedProfile?.imapDefaults ? namedProfile : null;
  const discovered =
    input.host === undefined && namedPreset === null
      ? autodiscoverProfile(input.emailAddress)
      : null;
  const presetDefaults = namedPreset?.imapDefaults ?? discovered?.imapDefaults;
  const host = input.host ?? presetDefaults?.host;
  const port = input.port ?? presetDefaults?.port;
  const providerProfile = input.providerProfile ?? discovered?.id ?? "generic-imap";

  if (host === undefined || port === undefined) {
    throw new Error(
      `No IMAP host/port for ${input.emailAddress}. No provider preset matched the email domain; pass host and port explicitly.`
    );
  }

  const secure = input.secure ?? presetDefaults?.secure ?? true;
  return { host, port, secure, providerProfile };
}

export class FolderTrackingRejectedError extends Error {
  constructor(
    readonly code: "provider_excluded_folder",
    message: string
  ) {
    super(message);
    this.name = "FolderTrackingRejectedError";
  }
}

const ACCOUNT_SUMMARY_COLUMNS = `
  id,
  email_address,
  provider_profile,
  body_fetch_policy,
  live_window_days,
  historical_backfill_mode,
  archive_refresh_interval,
  archive_flag_sync,
  max_backfill_rate,
  sync_state,
  sync_state_reason,
  last_sync_started_at,
  last_sync_finished_at,
  last_priority_sync_succeeded_at,
  priority_sync_lag_seconds,
  overall_sync_lag_seconds,
  consecutive_failures,
  consecutive_successes,
  backoff_until,
  last_folder_discovery_at,
  next_folder_discovery_at,
  folder_count_cap_override,
  last_heartbeat_at,
  created_at,
  updated_at
`;

const ACCOUNT_DETAILS_COLUMNS = `
  a.id,
  a.email_address,
  a.provider_profile,
  a.body_fetch_policy,
  a.live_window_days,
  a.historical_backfill_mode,
  a.archive_refresh_interval,
  a.archive_flag_sync,
  a.max_backfill_rate,
  a.sync_state,
  a.sync_state_reason,
  a.last_sync_started_at,
  a.last_sync_finished_at,
  a.last_priority_sync_succeeded_at,
  a.priority_sync_lag_seconds,
  a.overall_sync_lag_seconds,
  a.consecutive_failures,
  a.consecutive_successes,
  a.backoff_until,
  a.last_folder_discovery_at,
  a.next_folder_discovery_at,
  a.folder_count_cap_override,
  a.last_heartbeat_at,
  a.created_at,
  a.updated_at,
  p.live_headers_synced_count,
  p.live_headers_target_count,
  p.live_headers_complete_pct,
  p.priority_bodies_fetched_count,
  p.priority_bodies_target_count,
  p.priority_bodies_complete_pct,
  p.live_bodies_fetched_count,
  p.live_bodies_target_count,
  p.live_bodies_complete_pct,
  p.historical_headers_synced_count,
  p.historical_headers_target_count,
  p.historical_headers_complete_pct,
  p.historical_bodies_fetched_count,
  p.historical_bodies_target_count,
  p.historical_bodies_complete_pct,
  p.estimated_full_sync_at
`;

export class MirrorRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly config: AppConfig
  ) {}

  async createAccount(input: CreateAccountInput): Promise<AccountSummary> {
    // IMAP coordinate resolution (email-008) — the explicit > named-preset >
    // domain-autodiscovery > error precedence now lives in one place, the twin of
    // resolveSmtpCreds (ADR 0017/0021). The chosen preset id is stored in
    // provider_profile so the SMTP path picks up the matching smtpDefaults.
    const { host, port, secure, providerProfile } = resolveImapCoords(input);
    await assertSafeImapTarget(host, port, secure, {
      allowPrivateHosts: this.config.IMAP_ALLOW_PRIVATE_HOSTS
    });
    const accountCount = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_accounts"
    );
    if (Number(accountCount.rows[0]?.count ?? 0) >= this.config.SYNC_MAX_ACCOUNTS) {
      throw new Error(`SYNC_MAX_ACCOUNTS limit reached (${this.config.SYNC_MAX_ACCOUNTS})`);
    }
    const encrypted = await encryptPassword(this.pool, input.password, this.config.IMAP_ENCRYPTION_KEY);
    // SMTP secret reuses the SAME frozen AES-256-GCM envelope (encryptPassword) as
    // the IMAP password; a NULL here means the send path falls back to IMAP creds.
    const encryptedSmtp = input.smtpPassword
      ? await encryptPassword(this.pool, input.smtpPassword, this.config.IMAP_ENCRYPTION_KEY)
      : null;
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
        smtp_host,
        smtp_port,
        smtp_secure,
        smtp_username,
        encrypted_smtp_password,
        body_fetch_policy
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING ${ACCOUNT_SUMMARY_COLUMNS}
      `,
      [
        input.emailAddress,
        providerProfile,
        host,
        port,
        secure,
        input.username,
        encrypted,
        input.smtpHost ?? null,
        input.smtpPort ?? null,
        input.smtpSecure ?? null,
        input.smtpUsername ?? null,
        encryptedSmtp,
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

  async getAccountDetails(id: string): Promise<AccountDetails | null> {
    const accountResult = await this.pool.query<AccountSummary & Omit<AccountProgress, "account_id">>(
      `
      SELECT ${ACCOUNT_DETAILS_COLUMNS}
      FROM public.imap_accounts a
      JOIN public.imap_account_progress p ON p.account_id = a.id
      WHERE a.id = $1
      `,
      [id]
    );
    const account = accountResult.rows[0];
    if (!account) return null;

    const folders = await this.pool.query<FolderProgress>(
      `
      SELECT
        id,
        path,
        tracked,
        status,
        sync_priority,
        headers_synced_count,
        bodies_fetched_count,
        live_window_target_count,
        historical_target_count,
        CASE
          WHEN COALESCE(live_window_target_count, 0) > 0
            THEN LEAST(100, round((LEAST(headers_synced_count, live_window_target_count)::numeric / live_window_target_count::numeric) * 100)::int)
          WHEN live_window_target_count IS NOT NULL THEN 100
          ELSE 0
        END AS headers_pct,
        CASE
          WHEN COALESCE(live_window_target_count, 0) > 0
            THEN LEAST(100, round((LEAST(bodies_fetched_count, live_window_target_count)::numeric / live_window_target_count::numeric) * 100)::int)
          WHEN live_window_target_count IS NOT NULL THEN 100
          ELSE 0
        END AS bodies_pct,
        CASE
          WHEN COALESCE(historical_target_count, 0) > 0
            THEN LEAST(100, round((GREATEST(headers_synced_count - COALESCE(live_window_target_count, 0), 0)::numeric / historical_target_count::numeric) * 100)::int)
          WHEN historical_target_count IS NOT NULL THEN 100
          ELSE 0
        END AS historical_headers_pct,
        CASE
          WHEN COALESCE(historical_target_count, 0) > 0
            THEN LEAST(100, round((GREATEST(bodies_fetched_count - COALESCE(live_window_target_count, 0), 0)::numeric / historical_target_count::numeric) * 100)::int)
          WHEN historical_target_count IS NOT NULL THEN 100
          ELSE 0
        END AS historical_bodies_pct
      FROM public.imap_folders
      WHERE account_id = $1
      ORDER BY sync_priority, path
      `,
      [id]
    );

    return {
      ...account,
      folders: folders.rows
    };
  }

  async updateAccountSettings(accountId: string, input: UpdateAccountSettingsInput): Promise<AccountSummary | null> {
    if (
      input.historicalBackfillMode === undefined
      && input.archiveRefreshInterval === undefined
      && input.archiveFlagSync === undefined
      && input.maxBackfillRate === undefined
    ) {
      const existing = await this.pool.query<AccountSummary>(
        `SELECT ${ACCOUNT_SUMMARY_COLUMNS} FROM public.imap_accounts WHERE id = $1`,
        [accountId]
      );
      return existing.rows[0] ?? null;
    }

    const result = await this.pool.query<AccountSummary>(
      `
      UPDATE public.imap_accounts
      SET
        historical_backfill_mode = COALESCE($2::text, historical_backfill_mode),
        archive_refresh_interval = COALESCE($3::text, archive_refresh_interval),
        archive_flag_sync = COALESCE($4::boolean, archive_flag_sync),
        max_backfill_rate = COALESCE($5::text, max_backfill_rate)
      WHERE id = $1
      RETURNING ${ACCOUNT_SUMMARY_COLUMNS}
      `,
      [
        accountId,
        input.historicalBackfillMode ?? null,
        input.archiveRefreshInterval ?? null,
        input.archiveFlagSync ?? null,
        input.maxBackfillRate ?? null
      ]
    );
    return result.rows[0] ?? null;
  }

  async getRunnableAccounts(
    limit = 25,
    options: { sentDueOnly?: boolean } = {}
  ): Promise<ImapAccount[]> {
    const effectiveLimit = Math.min(limit, this.config.SYNC_MAX_ACCOUNTS);
    const sentDueClause = options.sentDueOnly
      ? `AND EXISTS (
          SELECT 1
          FROM public.imap_folders sf
          WHERE sf.account_id = public.imap_accounts.id
            AND sf.tracked = true
            AND sf.missing_since IS NULL
            AND sf.status NOT IN ('MISSING', 'PENDING_VERIFICATION')
            AND sf.sync_priority = 5
            AND (sf.next_sync_due_at IS NULL OR sf.next_sync_due_at <= now())
        )`
      : "";
    const result = await this.pool.query<ImapAccount>(
      `
      SELECT *
      FROM public.imap_accounts
      WHERE (
          sync_state NOT IN ('PAUSED', 'BROKEN')
          -- Self-heal: a BROKEN account is retried once its scheduled retry time
          -- (backoff_until) passes. backoff_until IS NOT NULL is the deliberate
          -- "this can recover on its own" marker — failure-threshold and
          -- STUCK_DEGRADED_24H BROKEN both set it, so a transient cause (a deleted
          -- folder, a brief provider outage) heals without operator action: the
          -- next clean run resets sync_state + consecutive_failures. The terminal
          -- BROKEN paths deliberately NULL backoff_until and stay out forever
          -- until a human acts: AUTH_ERROR (bad creds — retrying risks lockout),
          -- the UIDVALIDITY-reset cap, and STUCK_DEGRADED_TERMINAL.
          OR (sync_state = 'BROKEN' AND backoff_until IS NOT NULL)
        )
        AND (backoff_until IS NULL OR backoff_until <= now())
        AND (
          currently_syncing = false
          OR last_heartbeat_at IS NULL
          OR last_heartbeat_at <= now() - ($2::bigint * interval '1 millisecond')
        )
        ${sentDueClause}
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
        JSON.stringify({ errors: sanitizedErrors, hitLockBudget: result.hitLockBudget })
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

  /**
   * Finish the lightweight Sent freshness lane without claiming that the full
   * mailbox health/backoff contract was re-evaluated. The durable sync run still
   * records and logs any error; the next full sweep owns health transitions.
   */
  async markAccountSentSyncFinished(accountId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_heartbeat_at = now()
      WHERE id = $1
      `,
      [accountId]
    );
  }

  async markAccountSyncSucceeded(
    accountId: string,
    options: { countsTowardBackoff?: boolean } = {}
  ): Promise<void> {
    const countsTowardBackoff = options.countsTowardBackoff ?? true;
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
          ) AS overall_lag_seconds,
          count(*) FILTER (
            WHERE tracked = true
              AND status != 'MISSING'
              AND last_uidvalidity_reset_at IS NOT NULL
              AND last_uidvalidity_reset_at > now() - ($11::bigint * interval '1 millisecond')
          ) AS recent_uidvalidity_reset_count
        FROM public.imap_folders
        WHERE account_id = $1
      ),
      folder_cap AS (
        SELECT
          count(*) FILTER (
            WHERE status != 'MISSING'
              AND missing_since IS NULL
          ) AS current_provider_folder_count,
          COALESCE(
            (SELECT folder_count_cap_override FROM public.imap_accounts WHERE id = $1),
            $10::int
          ) AS enforce_threshold
        FROM public.imap_folders
        WHERE account_id = $1
      )
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_sync_finished_at = now(),
        last_heartbeat_at = now(),
        last_priority_sync_succeeded_at = now(),
        priority_sync_lag_seconds = ceil(folder_health.priority_lag_seconds)::int,
        overall_sync_lag_seconds = ceil(folder_health.overall_lag_seconds)::int,
        sync_state = CASE
          WHEN folder_health.incomplete_count > 0 THEN 'INITIAL_SYNC'
          WHEN folder_health.recent_uidvalidity_reset_count > 0 THEN 'DEGRADED'
          WHEN folder_health.stale_missing_count > 0 THEN 'DEGRADED'
          WHEN folder_health.priority_reconcile_gap_count > 0 THEN 'DEGRADED'
          WHEN folder_health.priority_reconcile_unhealthy_count > 0 THEN 'DEGRADED'
          WHEN folder_health.overall_reconcile_unhealthy_count > 0 THEN 'DEGRADED'
          WHEN (folder_health.priority_lag_seconds * 1000) > $4 THEN 'DEGRADED'
          WHEN (folder_health.overall_lag_seconds * 1000) > $5 THEN 'DEGRADED'
          WHEN folder_cap.current_provider_folder_count >= folder_cap.enforce_threshold THEN 'DEGRADED'
          ELSE 'HEALTHY'
        END,
        sync_state_reason = CASE
          WHEN folder_health.incomplete_count > 0 THEN 'INITIAL_SYNC_IN_PROGRESS'
          WHEN folder_health.recent_uidvalidity_reset_count > 0 THEN 'RECENT_UIDVALIDITY_RESET'
          WHEN folder_health.stale_missing_count > 0 THEN 'FOLDER_MISSING_GRACE_EXCEEDED'
          WHEN folder_health.priority_reconcile_gap_count > 0 THEN 'RECONCILE_GAPS_FOUND'
          WHEN folder_health.priority_reconcile_unhealthy_count > 0 THEN 'PRIORITY_RECONCILE_STALE'
          WHEN folder_health.overall_reconcile_unhealthy_count > 0 THEN 'OVERALL_RECONCILE_STALE'
          WHEN (folder_health.priority_lag_seconds * 1000) > $4 THEN 'PRIORITY_SYNC_LAG'
          WHEN (folder_health.overall_lag_seconds * 1000) > $5 THEN 'OVERALL_SYNC_LAG'
          WHEN folder_cap.current_provider_folder_count >= folder_cap.enforce_threshold THEN 'TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG'
          WHEN folder_cap.current_provider_folder_count >= $9::int THEN 'MANY_FOLDERS_PERFORMANCE_NOTE'
          ELSE NULL
        END,
        consecutive_successes = CASE
          WHEN $8::boolean THEN consecutive_successes + 1
          ELSE consecutive_successes
        END,
        consecutive_failures = CASE
          WHEN $8::boolean THEN 0
          ELSE consecutive_failures
        END,
        current_backoff_ms = CASE
          WHEN $8::boolean AND consecutive_successes + 1 >= 3 THEN 0
          ELSE current_backoff_ms
        END,
        backoff_until = CASE
          WHEN $8::boolean THEN NULL
          ELSE backoff_until
        END
      FROM folder_health, folder_cap
      WHERE id = $1
      `,
      [
        accountId,
        this.config.FOLDER_MISSING_GRACE_MS,
        this.config.PRIORITY_CUTOFF,
        this.config.PRIORITY_LAG_HEALTHY_THRESHOLD_MS,
        this.config.OVERALL_LAG_HEALTHY_THRESHOLD_MS,
        this.config.PRIORITY_RECONCILE_HEALTHY_MAX_AGE_MS,
        this.config.OVERALL_RECONCILE_HEALTHY_MAX_AGE_MS,
        countsTowardBackoff,
        this.config.FOLDER_COUNT_WARN_THRESHOLD,
        this.config.FOLDER_COUNT_ENFORCE_THRESHOLD,
        this.config.RECENT_UIDVALIDITY_RESET_DEGRADED_MS
      ]
    );
  }

  // Per spec §12.2: PARTIAL_SUCCESS means priority folders succeeded but some
  // round-robin folders didn't. Counters increment as if it were SUCCESS
  // (consecutive_successes++, failures=0); sync_state stays DEGRADED until
  // round-robin folders catch up.
  async markAccountSyncPartial(
    accountId: string,
    error: string,
    options: { countsTowardBackoff?: boolean } = {}
  ): Promise<void> {
    const countsTowardBackoff = options.countsTowardBackoff ?? true;
    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_sync_finished_at = now(),
        last_heartbeat_at = now(),
        last_priority_sync_succeeded_at = now(),
        sync_state = 'DEGRADED',
        sync_state_reason = $2,
        consecutive_successes = CASE
          WHEN $3::boolean THEN consecutive_successes + 1
          ELSE consecutive_successes
        END,
        consecutive_failures = CASE
          WHEN $3::boolean THEN 0
          ELSE consecutive_failures
        END,
        current_backoff_ms = CASE
          WHEN $3::boolean AND consecutive_successes + 1 >= 3 THEN 0
          ELSE current_backoff_ms
        END,
        backoff_until = CASE
          WHEN $3::boolean THEN NULL
          ELSE backoff_until
        END
      WHERE id = $1
      `,
      [accountId, sanitizeErrorReason(error), countsTowardBackoff]
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
      WITH account_state AS (
        SELECT
          current_backoff_ms,
          consecutive_failures,
          sync_state,
          sync_state_reason,
          COALESCE(last_priority_sync_succeeded_at, created_at) AS priority_success_anchor,
          (
            sync_state = 'DEGRADED'
            OR (sync_state = 'BROKEN' AND sync_state_reason = 'STUCK_DEGRADED_24H')
          ) AS stuck_degraded_eligible
        FROM public.imap_accounts
        WHERE id = $1
      ),
      stuck_state AS (
        SELECT
          *,
          stuck_degraded_eligible
            AND priority_success_anchor < now() - ($6::bigint * interval '1 millisecond') AS is_stuck_degraded,
          stuck_degraded_eligible
            AND priority_success_anchor < now() - ($7::bigint * interval '1 millisecond') AS is_terminal_stuck_degraded
        FROM account_state
      ),
      next_backoff AS (
        SELECT
          base_ms,
          LEAST(
            $5::int,
            GREATEST($4::int, floor(base_ms * (0.7 + random() * 0.6))::int)
          ) AS jittered_ms
        FROM (
          SELECT LEAST(GREATEST(current_backoff_ms * 2, $4::int), $5::int) AS base_ms
          FROM stuck_state
        ) base
      )
      UPDATE public.imap_accounts a
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_sync_finished_at = now(),
        sync_state = CASE
          WHEN stuck_state.is_terminal_stuck_degraded THEN 'BROKEN'
          WHEN stuck_state.is_stuck_degraded THEN 'BROKEN'
          WHEN a.consecutive_failures + 1 >= $3 THEN 'BROKEN'
          ELSE 'DEGRADED'
        END,
        sync_state_reason = CASE
          WHEN stuck_state.is_terminal_stuck_degraded THEN 'STUCK_DEGRADED_TERMINAL'
          WHEN stuck_state.is_stuck_degraded THEN 'STUCK_DEGRADED_24H'
          ELSE $2
        END,
        consecutive_failures = CASE
          WHEN stuck_state.is_stuck_degraded THEN a.consecutive_failures
          ELSE a.consecutive_failures + 1
        END,
        consecutive_successes = 0,
        current_backoff_ms = CASE
          WHEN stuck_state.is_stuck_degraded THEN a.current_backoff_ms
          ELSE next_backoff.base_ms
        END,
        backoff_until = CASE
          WHEN stuck_state.is_terminal_stuck_degraded THEN NULL
          WHEN stuck_state.is_stuck_degraded THEN now() + ($8::bigint * interval '1 millisecond')
          -- Failure-threshold BROKEN self-heals (getRunnableAccounts retries it once
          -- backoff_until passes), but on the calm STUCK_DEGRADED_RETRY_INTERVAL_MS
          -- ($8) cadence — not the ≤5-min exponential ceiling a DEGRADED account
          -- uses — so a genuinely-broken account is re-attempted rarely while a
          -- recovered one still heals within the interval.
          WHEN a.consecutive_failures + 1 >= $3 THEN now() + ($8::bigint * interval '1 millisecond')
          ELSE now() + (next_backoff.jittered_ms * interval '1 millisecond')
        END
      FROM stuck_state, next_backoff
      WHERE a.id = $1
      `,
      [
        accountId,
        sanitizeErrorReason(error),
        BROKEN_FAILURE_THRESHOLD,
        BACKOFF_FLOOR_MS,
        BACKOFF_CEILING_MS,
        this.config.STUCK_DEGRADED_BROKEN_THRESHOLD_MS,
        this.config.STUCK_DEGRADED_TERMINAL_THRESHOLD_MS,
        this.config.STUCK_DEGRADED_RETRY_INTERVAL_MS
      ]
    );
  }

  async heartbeat(accountId: string): Promise<void> {
    await this.pool.query("UPDATE public.imap_accounts SET last_heartbeat_at = now() WHERE id = $1", [
      accountId
    ]);
  }

  /**
   * Mirror writes take a shared lock on the small threading-state row before
   * mutating evidence. Activation/rebuild takes the same row FOR UPDATE, so it
   * cannot certify coverage across a message/body write that is still in flight.
   * The state row is created lazily for accounts that predate threading.
   */
  private async lockThreadStateForMirrorWrite(client: PgClient, accountId: string): Promise<void> {
    await client.query(
      `
      INSERT INTO public.imap_thread_state (account_id)
      SELECT id FROM public.imap_accounts WHERE id = $1
      ON CONFLICT (account_id) DO NOTHING
      `,
      [accountId]
    );
    const locked = await client.query<{ account_id: string }>(
      `
      SELECT account_id
      FROM public.imap_thread_state
      WHERE account_id = $1
      FOR SHARE
      `,
      [accountId]
    );
    if (!locked.rows[0]) throw new Error(`Account not found: ${accountId}`);
  }

  /** Queue bounded message evidence independently for every live algorithm run. */
  private async enqueueThreadingMessages(
    client: PgClient,
    accountId: string,
    messageIds: readonly string[],
    reason: string
  ): Promise<void> {
    if (messageIds.length === 0) return;
    await client.query(
      `
      INSERT INTO public.imap_thread_work_queue (
        run_id, message_id, account_id, reason, attempts, available_at,
        last_error, enqueued_at, updated_at
      )
      SELECT run.id, message.id, message.account_id, $3, 0, now(), NULL, now(), now()
      FROM public.imap_thread_runs run
      JOIN public.imap_messages message
        ON message.account_id = run.account_id
       AND message.id = ANY($2::uuid[])
      WHERE run.account_id = $1
        AND run.status = ANY($4::text[])
      ON CONFLICT (run_id, message_id)
      DO UPDATE SET
        account_id = EXCLUDED.account_id,
        reason = EXCLUDED.reason,
        attempts = 0,
        available_at = now(),
        last_error = NULL,
        enqueued_at = now(),
        updated_at = now()
      `,
      [accountId, [...messageIds], reason, [...LIVE_THREAD_RUN_STATUSES]]
    );
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Discover only a small candidate page before taking locks. We then lock
      // threading state first and re-check/row-lock the candidates, matching the
      // lock order used by message/body ingestion and activation.
      const discovered = await client.query<PurgeCandidate>(
        `
        SELECT id, account_id
        FROM public.imap_messages
        WHERE deleted_in_provider = true
          AND deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING')
          AND provider_deleted_at < now() - interval '30 days'
        ORDER BY id
        LIMIT $1
        `,
        [PURGE_MESSAGE_BATCH_SIZE]
      );
      if (discovered.rows.length === 0) {
        await client.query("COMMIT");
        return { purged: 0 };
      }

      const accountIds = [...new Set(discovered.rows.map((row) => row.account_id))].sort();
      await client.query(
        `
        INSERT INTO public.imap_thread_state (account_id)
        SELECT input.account_id
        FROM unnest($1::uuid[]) AS input(account_id)
        JOIN public.imap_accounts account ON account.id = input.account_id
        ON CONFLICT (account_id) DO NOTHING
        `,
        [accountIds]
      );
      await client.query(
        `
        SELECT account_id
        FROM public.imap_thread_state
        WHERE account_id = ANY($1::uuid[])
        ORDER BY account_id
        FOR SHARE
        `,
        [accountIds]
      );

      const locked = await client.query<PurgeCandidate>(
        `
        SELECT id, account_id
        FROM public.imap_messages
        WHERE id = ANY($1::uuid[])
          AND deleted_in_provider = true
          AND deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING')
          AND provider_deleted_at < now() - interval '30 days'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        `,
        [discovered.rows.map((row) => row.id)]
      );
      if (locked.rows.length === 0) {
        await client.query("COMMIT");
        return { purged: 0 };
      }

      // A retained message can be the canonical root/parent/copy for surviving
      // members. Queue every survivor in each live run before the cascade removes
      // the victim assignments. Recursively split a pathological batch; a single
      // >25k fan-out is retained rather than making a huge transaction or leaving
      // an active projection knowingly stale.
      const acceptedVictims: string[] = [];
      const recomputeTargets = new Map<string, PurgeQueueTarget>();
      const pending: string[][] = [locked.rows.map((row) => row.id)];
      while (pending.length > 0) {
        const victimIds = pending.shift()!;
        const remaining = PURGE_RECOMPUTE_PAIR_LIMIT - recomputeTargets.size;
        if (remaining <= 0) break;
        const existingKeys = [...recomputeTargets.keys()];
        const neighbors = await client.query<PurgeQueueTarget>(
          `
          WITH affected_components AS (
            SELECT DISTINCT assignment.run_id, assignment.account_id, assignment.conversation_id
            FROM public.imap_thread_assignments assignment
            JOIN public.imap_thread_runs source_run
              ON source_run.id = assignment.run_id
             AND source_run.status = ANY($2::text[])
            WHERE assignment.message_id = ANY($1::uuid[])
          ), surviving_messages AS (
            SELECT DISTINCT assignment.account_id, assignment.message_id
            FROM affected_components component
            JOIN public.imap_thread_assignments assignment
              ON assignment.run_id = component.run_id
             AND assignment.account_id = component.account_id
             AND assignment.conversation_id = component.conversation_id
            JOIN public.imap_messages message ON message.id = assignment.message_id
            WHERE assignment.message_id <> ALL($1::uuid[])
          )
          SELECT DISTINCT live_run.id AS run_id, survivor.message_id, survivor.account_id
          FROM surviving_messages survivor
          JOIN public.imap_thread_runs live_run
            ON live_run.account_id = survivor.account_id
           AND live_run.status = ANY($2::text[])
          WHERE (live_run.id::text || ':' || survivor.message_id::text) <> ALL($3::text[])
          ORDER BY run_id, survivor.message_id
          LIMIT $4
          `,
          [victimIds, [...LIVE_THREAD_RUN_STATUSES], existingKeys, remaining + 1]
        );
        if (neighbors.rows.length > remaining) {
          if (victimIds.length === 1) continue;
          const midpoint = Math.ceil(victimIds.length / 2);
          pending.unshift(victimIds.slice(midpoint));
          pending.unshift(victimIds.slice(0, midpoint));
          continue;
        }
        acceptedVictims.push(...victimIds);
        for (const row of neighbors.rows) {
          recomputeTargets.set(`${row.run_id}:${row.message_id}`, row);
        }
      }

      if (acceptedVictims.length === 0) {
        await client.query("COMMIT");
        return { purged: 0 };
      }

      const acceptedSet = new Set(acceptedVictims);
      const queueTargets = [...recomputeTargets.values()].filter((row) => !acceptedSet.has(row.message_id));
      if (queueTargets.length > 0) {
        await client.query(
          `
          INSERT INTO public.imap_thread_work_queue (
            run_id, message_id, account_id, reason, attempts, available_at,
            last_error, enqueued_at, updated_at
          )
          SELECT run_id, message_id, account_id, 'retained_neighbor_purged', 0, now(), NULL, now(), now()
          FROM unnest($1::uuid[], $2::uuid[], $3::uuid[])
            AS affected(run_id, message_id, account_id)
          ON CONFLICT (run_id, message_id)
          DO UPDATE SET
            reason = EXCLUDED.reason,
            attempts = 0,
            available_at = now(),
            last_error = NULL,
            enqueued_at = now(),
            updated_at = now()
          `,
          [
            queueTargets.map((row) => row.run_id),
            queueTargets.map((row) => row.message_id),
            queueTargets.map((row) => row.account_id)
          ]
        );
      }

      // Subject evidence is deliberately separate and compact: one fixed-size
      // bucket per live run. Fan keys out across all live versions so a shadow
      // build and the active/rollback projections see the same deletion.
      await client.query(
        `
        WITH affected_subjects AS (
          SELECT DISTINCT assignment.account_id, assignment.subject_key
          FROM public.imap_thread_assignments assignment
          JOIN public.imap_thread_runs source_run
            ON source_run.id = assignment.run_id
           AND source_run.status = ANY($2::text[])
          WHERE assignment.message_id = ANY($1::uuid[])
            AND assignment.subject_key IS NOT NULL
        )
        INSERT INTO public.imap_thread_subject_work (
          run_id, account_id, subject_key, attempts, available_at,
          last_error, enqueued_at, updated_at
        )
        SELECT live_run.id, subject.account_id, subject.subject_key,
               0, now(), NULL, now(), now()
        FROM affected_subjects subject
        JOIN public.imap_thread_runs live_run
          ON live_run.account_id = subject.account_id
         AND live_run.status = ANY($2::text[])
        ON CONFLICT (run_id, subject_key)
        DO UPDATE SET
          attempts = 0,
          available_at = now(),
          last_error = NULL,
          enqueued_at = now(),
          updated_at = now()
        `,
        [acceptedVictims, [...LIVE_THREAD_RUN_STATUSES]]
      );

      const result = await client.query(
        `
        DELETE FROM public.imap_messages
        WHERE id = ANY($1::uuid[])
          AND deleted_in_provider = true
          AND deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING')
          AND provider_deleted_at < now() - interval '30 days'
        `,
        [acceptedVictims]
      );
      await client.query("COMMIT");
      return { purged: result.rowCount ?? 0 };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Prune the imap_sync_events audit trail, which is INSERT-only (written on every
   * sync/reset/delete/state event) and otherwise grows without bound. Bounded per run
   * so the first prune of a large backlog can't run one huge transaction; the daily
   * retention cadence drains the rest.
   */
  async runSyncEventPruneJob(): Promise<{ prunedEvents: number }> {
    const result = await this.pool.query(
      `
      DELETE FROM public.imap_sync_events
      WHERE id IN (
        SELECT id FROM public.imap_sync_events
        WHERE occurred_at < now() - ($1::int * interval '1 day')
        LIMIT 50000
      )
      `,
      [this.config.SYNC_EVENT_RETENTION_DAYS]
    );
    return { prunedEvents: result.rowCount ?? 0 };
  }

  async runRetentionJobs(): Promise<{ expired: number; purged: number; prunedEvents: number }> {
    const { expired } = await this.runExpiryJob();
    const { purged } = await this.runPurgeJob();
    const { prunedEvents } = await this.runSyncEventPruneJob();
    return { expired, purged, prunedEvents };
  }

  async upsertDiscoveredFolders(
    account: ImapAccount,
    folders: Array<{
      path: string;
      delimiter?: string | null;
      specialUse?: string | null;
      excludedReasonOverride?: string | null;
    }>
  ): Promise<ImapFolder[]> {
    const profile = getProviderProfile(account.provider_profile);
    const rows: ImapFolder[] = [];
    const seen = new Set<string>();
    const manualOverrides = await this.pool.query<{ path: string }>(
      `
      SELECT path
      FROM public.imap_folders
      WHERE account_id = $1
        AND tracked = true
        AND last_progress_note = $2
      `,
      [account.id, MANUAL_TRACK_OVERRIDE_NOTE]
    );
    const manualOverridePaths = new Set(manualOverrides.rows.map((row) => row.path));
    const enforceThreshold = account.folder_count_cap_override ?? this.config.FOLDER_COUNT_ENFORCE_THRESHOLD;
    const enforceFolderCap = folders.length >= enforceThreshold;

    for (const folder of folders) {
      seen.add(folder.path);
      const syncPriority = profile.priorityForFolder(folder.path, folder.specialUse);
      const manuallyTracked = manualOverridePaths.has(folder.path);
      const providerExcludedReason = folder.excludedReasonOverride
        ?? profile.excludedReason(folder.path, folder.specialUse);
      const capExcludedReason = enforceFolderCap && !manuallyTracked && syncPriority > this.config.PRIORITY_CUTOFF
        ? "folder_count_cap_exceeded"
        : null;
      const excludedReason = providerExcludedReason ?? capExcludedReason;
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
          status = CASE
            WHEN public.imap_folders.status IN ('MISSING', 'PENDING_VERIFICATION') THEN 'PENDING'
            ELSE public.imap_folders.status
          END
        RETURNING *
        `,
        [
          account.id,
          folder.path,
          folder.delimiter ?? null,
          folder.specialUse ?? null,
          excludedReason === null,
          excludedReason,
          syncPriority
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

  async markFolderPendingVerification(
    accountId: string,
    folderId: string,
    folderPath: string,
    reason: string
  ): Promise<void> {
    const sanitizedReason = sanitizeErrorReason(reason);
    const client = await this.pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `
        UPDATE public.imap_folders
        SET status = 'PENDING_VERIFICATION',
            missing_since = COALESCE(missing_since, now()),
            last_progress_at = now(),
            last_progress_note = $3,
            next_sync_due_at = NULL
        WHERE account_id = $1
          AND id = $2
          AND status != 'MISSING'
        `,
        [accountId, folderId, MISSING_MAILBOX_VERIFICATION_NOTE]
      );
      await client.query(
        `
        UPDATE public.imap_accounts
        SET next_folder_discovery_at = now()
        WHERE id = $1
        `,
        [accountId]
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
        VALUES ($1, NULL, NULL, $2, NULL, 'FOLDER_PENDING_VERIFICATION', $3)
        `,
        [
          accountId,
          folderPath,
          JSON.stringify({ reason: sanitizedReason })
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async trackFolder(accountId: string, path: string): Promise<ImapFolder | null> {
    const account = await this.getAccount(accountId);
    if (!account) return null;

    const existing = await this.pool.query<ImapFolder>(
      `
      SELECT *
      FROM public.imap_folders
      WHERE account_id = $1
        AND path = $2
      `,
      [accountId, path]
    );
    const folder = existing.rows[0];
    if (!folder) return null;

    const providerExcludedReason = getProviderProfile(account.provider_profile).excludedReason(
      folder.path,
      folder.special_use
    );
    if (providerExcludedReason) {
      throw new FolderTrackingRejectedError(
        "provider_excluded_folder",
        `Folder is excluded by provider profile: ${providerExcludedReason}`
      );
    }

    const result = await this.pool.query<ImapFolder>(
      `
      UPDATE public.imap_folders
      SET tracked = true,
          excluded_reason = NULL,
          missing_since = NULL,
          status = CASE
            WHEN initial_sync_complete = false
              OR status IN ('MISSING', 'PENDING_VERIFICATION')
            THEN 'PENDING'
            ELSE status
          END,
          last_progress_note = $3,
          next_sync_due_at = now()
      WHERE account_id = $1
        AND path = $2
      RETURNING *
      `,
      [accountId, path, MANUAL_TRACK_OVERRIDE_NOTE]
    );
    return result.rows[0] ?? null;
  }

  async getFoldersDueForSync(accountId: string): Promise<ImapFolder[]> {
    const priority = await this.pool.query<ImapFolder>(
      `
      SELECT *
      FROM public.imap_folders
      WHERE account_id = $1
        AND tracked = true
        -- A folder discovery has already flagged absent from the provider
        -- (missing_since stamped) must leave the sync working set immediately.
        -- Otherwise the loop keeps SELECTing a deleted folder, the provider
        -- returns a generic error (e.g. Rackspace "Command failed", which is not a
        -- recognized NONEXISTENT/TRYCREATE missing-mailbox signal so the folder is
        -- never sidelined to PENDING_VERIFICATION), the run is marked failed, and
        -- consecutive_failures climbs to BROKEN — bricking the whole account because
        -- one folder was deleted. Discovery owns the missing-folder lifecycle: it
        -- clears missing_since on reappearance and tombstones to MISSING/untracked
        -- after FOLDER_MISSING_GRACE_MS.
        AND missing_since IS NULL
        AND status NOT IN ('MISSING', 'PENDING_VERIFICATION')
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
        -- See getFoldersDueForSync priority query: missing_since folders are owned
        -- by discovery, not the sync lane.
        AND missing_since IS NULL
        AND status NOT IN ('MISSING', 'PENDING_VERIFICATION')
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

  async getSentFoldersDueForSync(accountId: string): Promise<ImapFolder[]> {
    const result = await this.pool.query<ImapFolder>(
      `
      SELECT *
      FROM public.imap_folders
      WHERE account_id = $1
        AND tracked = true
        AND missing_since IS NULL
        AND status NOT IN ('MISSING', 'PENDING_VERIFICATION')
        -- Provider profiles reserve priority 5 for the Sent role, including
        -- SPECIAL-USE and provider-name fallbacks established at discovery.
        AND sync_priority = 5
        AND (next_sync_due_at IS NULL OR next_sync_due_at <= now())
      ORDER BY path
      LIMIT $2
      `,
      [accountId, this.config.MAX_PRIORITY_FOLDERS_PER_CYCLE]
    );
    return result.rows;
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
    oldestUidSynced: number,
    targetCount: number
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET initial_sync_target_max_uid = $2,
          initial_sync_oldest_uid_synced = $3,
          live_window_target_count = $4,
          last_progress_at = now()
      WHERE id = $1
      `,
      [folderId, targetMaxUid, oldestUidSynced, targetCount]
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
        next_sync_due_at = now() + ((
          CASE WHEN sync_priority = 5 THEN $12::bigint ELSE $13::bigint END
        ) * interval '1 millisecond'),
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
        this.config.PRIORITY_CUTOFF,
        this.config.SENT_SYNC_INTERVAL_MS,
        this.config.SYNC_INTERVAL_MS
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
            headers_synced_count = 0,
            bodies_fetched_count = 0,
            live_window_target_count = NULL,
            historical_target_count = NULL,
            backfill_in_progress = false,
            backfill_target_max_uid = NULL,
            backfill_oldest_uid_synced = NULL,
            backfill_since_date = NULL,
            last_archive_refresh_at = NULL,
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
    windowCutoff: Date,
    options: { preserveExistingFlags?: boolean } = {}
  ): Promise<ImapMessage[]> {
    if (messages.length === 0) return [];

    const rows: ImapMessage[] = [];
    const client = await this.pool.connect();

    try {
    for (const message of messages) {
      await client.query("BEGIN");
      try {
      await this.lockThreadStateForMirrorWrite(client, accountId);
      const existing = await client.query<{
        id: string;
        rfc_message_id: string | null;
        message_id_normalized: string | null;
        provider_message_id: string | null;
        provider_message_id_namespace: string | null;
        provider_thread_id: string | null;
        provider_thread_id_namespace: string | null;
        in_reply_to: string | null;
        references_header: string | null;
        internal_date: Date;
        size_bytes: string | null;
        subject: string | null;
        from_email: string | null;
        from_name: string | null;
        to_emails: string[] | null;
        to_names: (string | null)[] | null;
        cc_emails: string[] | null;
        cc_names: (string | null)[] | null;
        bcc_emails: string[] | null;
        headers_json: Record<string, string>;
        thread_assignment_missing: boolean;
      }>(
        `
        SELECT
          m.id,
          m.rfc_message_id,
          m.message_id_normalized,
          m.provider_message_id,
          m.provider_message_id_namespace,
          m.provider_thread_id,
          m.provider_thread_id_namespace,
          m.in_reply_to,
          m.references_header,
          m.internal_date,
          m.size_bytes,
          m.subject,
          m.from_email,
          m.from_name,
          m.to_emails,
          m.to_names,
          m.cc_emails,
          m.cc_names,
          m.bcc_emails,
          m.headers_json,
          EXISTS (
            SELECT 1
            FROM public.imap_thread_runs run
            WHERE run.account_id = m.account_id
              AND run.status = ANY($5::text[])
              AND NOT EXISTS (
                SELECT 1
                FROM public.imap_thread_assignments assignment
                WHERE assignment.run_id = run.id
                  AND assignment.message_id = m.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.imap_thread_work_queue queued
                WHERE queued.run_id = run.id
                  AND queued.message_id = m.id
              )
          ) AS thread_assignment_missing
        FROM public.imap_messages m
        WHERE m.account_id = $1
          AND m.folder_path = $2
          AND m.uidvalidity = $3
          AND m.uid = $4
        `,
        [accountId, folder.path, uidValidity, message.uid, [...LIVE_THREAD_RUN_STATUSES]]
      );
      const existingMessage = existing.rows[0];
      const isNewMessage = !existingMessage;
      const threadingInputChanged = isNewMessage
        || existingMessage.thread_assignment_missing
        || canonicalJsonForThreadingEvidence([
          existingMessage.rfc_message_id,
          existingMessage.message_id_normalized,
          existingMessage.provider_message_id,
          existingMessage.provider_message_id_namespace,
          existingMessage.provider_thread_id,
          existingMessage.provider_thread_id_namespace,
          existingMessage.in_reply_to,
          existingMessage.references_header,
          existingMessage.internal_date?.toISOString(),
          existingMessage.size_bytes === null ? null : Number(existingMessage.size_bytes),
          existingMessage.subject,
          existingMessage.from_email,
          existingMessage.from_name,
          existingMessage.to_emails ?? [],
          existingMessage.to_names ?? [],
          existingMessage.cc_emails ?? [],
          existingMessage.cc_names ?? [],
          existingMessage.bcc_emails ?? [],
          existingMessage.headers_json ?? {}
        ]) !== canonicalJsonForThreadingEvidence([
          message.rfcMessageId ?? existingMessage.rfc_message_id,
          message.messageIdNormalized ?? existingMessage.message_id_normalized,
          message.providerMessageId,
          message.providerMessageIdNamespace,
          message.providerThreadId,
          message.providerThreadIdNamespace,
          message.inReplyTo ?? existingMessage.in_reply_to,
          message.referencesHeader ?? existingMessage.references_header,
          message.internalDate.toISOString(),
          message.sizeBytes,
          message.subject,
          message.fromEmail,
          message.fromName,
          message.toEmails,
          message.toNames,
          message.ccEmails,
          message.ccNames,
          message.bccEmails,
          { ...(existingMessage.headers_json ?? {}), ...message.headersJson }
        ]);

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
          provider_message_id,
          provider_message_id_namespace,
          provider_thread_id,
          provider_thread_id_namespace,
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
          $17, $18, $19, $20, $21, $22, $23, $24,
          $25, $26, $27
        )
        ON CONFLICT (account_id, folder_path, uidvalidity, uid)
        DO UPDATE SET
          folder_id = EXCLUDED.folder_id,
          rfc_message_id = COALESCE(EXCLUDED.rfc_message_id, public.imap_messages.rfc_message_id),
          message_id_normalized = COALESCE(EXCLUDED.message_id_normalized, public.imap_messages.message_id_normalized),
          provider_message_id = EXCLUDED.provider_message_id,
          provider_message_id_namespace = EXCLUDED.provider_message_id_namespace,
          provider_thread_id = EXCLUDED.provider_thread_id,
          provider_thread_id_namespace = EXCLUDED.provider_thread_id_namespace,
          in_reply_to = COALESCE(EXCLUDED.in_reply_to, public.imap_messages.in_reply_to),
          references_header = COALESCE(EXCLUDED.references_header, public.imap_messages.references_header),
          internal_date = EXCLUDED.internal_date,
          size_bytes = EXCLUDED.size_bytes,
          subject = EXCLUDED.subject,
          from_email = EXCLUDED.from_email,
          from_name = EXCLUDED.from_name,
          to_emails = EXCLUDED.to_emails,
          to_names = EXCLUDED.to_names,
          cc_emails = EXCLUDED.cc_emails,
          cc_names = EXCLUDED.cc_names,
          bcc_emails = EXCLUDED.bcc_emails,
          flags = CASE WHEN $28::boolean THEN public.imap_messages.flags ELSE EXCLUDED.flags END,
          headers_json = public.imap_messages.headers_json || EXCLUDED.headers_json,
          mime_structure = EXCLUDED.mime_structure,
          window_status = EXCLUDED.window_status,
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
          message.providerMessageId,
          message.providerMessageIdNamespace,
          message.providerThreadId,
          message.providerThreadIdNamespace,
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
          message.internalDate < windowCutoff ? "HISTORICAL" : "IN_WINDOW",
          options.preserveExistingFlags === true
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
      if (isNewMessage) {
        await client.query(
          `
          UPDATE public.imap_folders
          SET headers_synced_count = headers_synced_count + 1
          WHERE id = $1
          `,
          [folder.id]
        );
      }
      if (threadingInputChanged) {
        await this.enqueueThreadingMessages(client, accountId, [row.id], "metadata_changed");
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

  /**
   * A single message whose UID vanished from its folder between metadata sync and
   * body fetch (see MessageMovedError). Soft-delete it as MOVED_OUT so it drops out
   * of getBodyBacklog instead of being re-fetched — and re-thrown — every backfill.
   * MOVED_OUT is the deleted_reason reserved for exactly this case.
   */
  async markMessageMovedOut(messageId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_messages
      SET deleted_in_provider = true,
          provider_deleted_at = now(),
          deleted_reason = 'MOVED_OUT'
      WHERE id = $1
        AND deleted_in_provider = false
      `,
      [messageId]
    );
  }

  /**
   * Mark a message's body fetch as attempted without storing a body. Used when a UID
   * moved out (MessageMovedError) for a non-IN_WINDOW row: unlike IN_WINDOW rows,
   * HISTORICAL/EXPIRED rows are never re-observed and reconcile is IN_WINDOW-only, so
   * tombstoning them (markMessageMovedOut) would be unrecoverable. This just removes
   * the row from getHistoryBacklog (which filters body_fetched_at IS NULL) — a benign,
   * reversible "we tried, the body is gone" watermark, not a soft-delete.
   */
  async markBodyFetchAttempted(messageId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_messages
      SET body_fetched_at = now()
      WHERE id = $1
        AND body_fetched_at IS NULL
      `,
      [messageId]
    );
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

  /**
   * Write a flag change through to a KNOWN message row (organize mutations,
   * email-002/ADR 0018). After a successful IMAP STORE we update the mirrored
   * `flags` array so mark-read/star reflect immediately — the flag-scan sync only
   * re-reads flags within FLAG_DIFF_WINDOW_DAYS, so older mail would otherwise
   * never reconcile. This is a deterministic update of a known row to a known
   * value, account-scoped and parameterized; it does NOT fabricate identity.
   *
   * `add`/`remove` are raw IMAP flag tokens (e.g. "\\Seen"). Matching is
   * case-insensitive so we never duplicate an existing flag. Returns the new flag
   * array, or null if the row was not found for that account.
   */
  async applyMessageFlags(
    messageId: string,
    accountId: string,
    change: { add?: string[]; remove?: string[] }
  ): Promise<string[] | null> {
    const add = change.add ?? [];
    const remove = change.remove ?? [];
    const removeLower = new Set(remove.map((flag) => flag.toLowerCase()));

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ flags: string[] | null }>(
        `
        SELECT flags
        FROM public.imap_messages
        WHERE id = $1 AND account_id = $2
        FOR UPDATE
        `,
        [messageId, accountId]
      );
      const row = current.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }

      const existing = row.flags ?? [];
      const existingLower = new Set(existing.map((flag) => flag.toLowerCase()));
      const kept = existing.filter((flag) => !removeLower.has(flag.toLowerCase()));
      const toAdd = add.filter((flag) => !existingLower.has(flag.toLowerCase()) && !removeLower.has(flag.toLowerCase()));
      const next = [...kept, ...toAdd];

      await client.query(
        `
        UPDATE public.imap_messages
        SET flags = $3::text[]
        WHERE id = $1 AND account_id = $2
        `,
        [messageId, accountId, next]
      );
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async storeBody(body: MessageBodyInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ account_id: string }>(
        "SELECT account_id FROM public.imap_messages WHERE id = $1",
        [body.messageId]
      );
      const ownerAccountId = owner.rows[0]?.account_id;
      if (!ownerAccountId) throw new Error(`Message not found for body storage: ${body.messageId}`);
      await this.lockThreadStateForMirrorWrite(client, ownerAccountId);

      const target = await client.query<{
        account_id: string;
        folder_path: string;
        body_fetched_at: Date | null;
        rfc_message_id: string | null;
        in_reply_to: string | null;
        references_header: string | null;
        headers_json: Record<string, unknown>;
        raw_mime_sha256: string | null;
        body_headers_json: Record<string, unknown> | null;
      }>(
        `
        SELECT
          account_id,
          folder_path,
          body_fetched_at,
          rfc_message_id,
          in_reply_to,
          references_header,
          m.headers_json,
          b.raw_mime_sha256,
          b.headers_json AS body_headers_json
        FROM public.imap_messages m
        LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
        WHERE m.id = $1
        FOR UPDATE OF m
        `,
        [body.messageId]
      );
      const message = target.rows[0];
      if (!message) throw new Error(`Message not found for body storage: ${body.messageId}`);

      // A metadata FETCH can be incomplete or malformed while the later full MIME
      // parse has usable threading headers. Fill only missing mirror fields; never
      // overwrite provider-observed metadata with parser output. Any newly learned
      // threading/automation header requeues this message for the derived thread
      // projection, while body storage itself remains independent.
      const recoveredHeaders: Record<string, unknown> = {};
      for (const key of THREADING_BODY_HEADER_KEYS) {
        const value = body.headersJson[key];
        if (value !== undefined && message.headers_json[key] === undefined) {
          recoveredHeaders[key] = value;
        }
      }
      const recoveredMessageId = message.rfc_message_id ? null : headerText(body.headersJson["message-id"]);
      const recoveredInReplyTo = message.in_reply_to ? null : headerText(body.headersJson["in-reply-to"]);
      const recoveredReferences = message.references_header ? null : headerText(body.headersJson.references);
      const learnedThreadingEvidence = Boolean(
        recoveredMessageId
        || recoveredInReplyTo
        || recoveredReferences
        || Object.keys(recoveredHeaders).length > 0
      );
      const rawMimeSha256 = body.rawTruncated
        ? null
        : createHash("sha256").update(body.rawMime).digest("hex");
      const learnedDeliveryEvidence = rawMimeSha256 !== message.raw_mime_sha256;
      const bodyHeadersChanged = canonicalJsonForThreadingEvidence(message.body_headers_json ?? {})
        !== canonicalJsonForThreadingEvidence(body.headersJson);

      if (learnedThreadingEvidence) {
        await client.query(
          `
          UPDATE public.imap_messages
          SET
            rfc_message_id = COALESCE(rfc_message_id, $2),
            message_id_normalized = COALESCE(message_id_normalized, $3),
            in_reply_to = COALESCE(in_reply_to, $4),
            references_header = COALESCE(references_header, $5),
            headers_json = headers_json || $6::jsonb
          WHERE id = $1
          `,
          [
            body.messageId,
            recoveredMessageId,
            normalizeMessageId(recoveredMessageId),
            recoveredInReplyTo,
            recoveredReferences,
            JSON.stringify(recoveredHeaders)
          ]
        );
      }

      await client.query(
        `
        INSERT INTO public.imap_message_bodies (
          message_id,
          raw_mime,
          raw_mime_sha256,
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now(), now())
        ON CONFLICT (message_id)
        DO UPDATE SET
          raw_mime = EXCLUDED.raw_mime,
          raw_mime_sha256 = EXCLUDED.raw_mime_sha256,
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
        `,
        [
          body.messageId,
          this.config.BODY_STORAGE_MODE === "parsed_only" ? null : body.rawMime,
          rawMimeSha256,
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

      if (learnedThreadingEvidence || bodyHeadersChanged || learnedDeliveryEvidence) {
        await this.enqueueThreadingMessages(
          client,
          message.account_id,
          [body.messageId],
          learnedThreadingEvidence || bodyHeadersChanged
            ? "body_headers_changed"
            : "body_fingerprint_changed"
        );
      }

      await client.query(
        `
        UPDATE public.imap_messages
        SET body_fetched_at = now()
        WHERE id = $1
        `,
        [body.messageId]
      );

      if (!message.body_fetched_at) {
        await client.query(
          `
          UPDATE public.imap_folders
          SET bodies_fetched_count = bodies_fetched_count + 1
          WHERE account_id = $1
            AND path = $2
          `,
          [message.account_id, message.folder_path]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getHistoryBacklog(account: ImapAccount, limit: number): Promise<HistoryBacklogFolder[]> {
    if (account.historical_backfill_mode === "off") return [];

    const result = await this.pool.query<HistoryBacklogFolder>(
      `
      WITH candidates AS (
        SELECT
          f.*,
          CASE
            WHEN f.backfill_in_progress = true THEN 'metadata'
            WHEN f.historical_target_count IS NULL THEN 'snapshot'
            WHEN $2::text = 'metadata_and_bodies'
              AND EXISTS (
                SELECT 1
                FROM public.imap_messages m
                WHERE m.account_id = f.account_id
                  AND m.folder_path = f.path
                  AND m.deleted_in_provider = false
                  AND m.window_status = 'HISTORICAL'
                  AND m.body_fetched_at IS NULL
              )
            THEN 'body'
            WHEN $3::text = 'weekly'
              AND (
                f.last_archive_refresh_at IS NULL
                OR f.last_archive_refresh_at <= now() - interval '7 days'
              )
            THEN 'refresh'
            WHEN $3::text = 'monthly'
              AND (
                f.last_archive_refresh_at IS NULL
                OR f.last_archive_refresh_at <= now() - interval '30 days'
              )
            THEN 'refresh'
            ELSE NULL
          END AS history_backlog_reason
        FROM public.imap_folders f
        WHERE f.account_id = $1
          AND f.tracked = true
          -- A deleted folder discovery has flagged (missing_since) must not be
          -- backfilled either; the history lane SELECTs it too and would fail.
          AND f.missing_since IS NULL
          AND f.status NOT IN ('MISSING', 'PENDING_VERIFICATION')
          AND f.initial_sync_complete = true
      )
      SELECT *
      FROM candidates
      WHERE history_backlog_reason IS NOT NULL
      ORDER BY
        CASE history_backlog_reason
          WHEN 'metadata' THEN 0
          WHEN 'snapshot' THEN 1
          WHEN 'body' THEN 2
          WHEN 'refresh' THEN 3
          ELSE 4
        END,
        sync_priority,
        path
      LIMIT $4
      `,
      [
        account.id,
        account.historical_backfill_mode,
        account.archive_refresh_interval,
        limit
      ]
    );
    return result.rows;
  }

  async getHistoricalBodyBacklog(
    accountId: string,
    folder: ImapFolder,
    limit: number
  ): Promise<ImapMessage[]> {
    const result = await this.pool.query<ImapMessage>(
      `
      SELECT *
      FROM public.imap_messages
      WHERE account_id = $1
        AND folder_path = $2
        AND deleted_in_provider = false
        AND window_status = 'HISTORICAL'
        AND body_fetched_at IS NULL
      ORDER BY uid DESC
      LIMIT $3
      `,
      [accountId, folder.path, limit]
    );
    return result.rows;
  }

  async setHistoryBackfillSnapshot(
    folderId: string,
    targetMaxUid: number,
    oldestUidSynced: number,
    targetCount: number,
    cutoff: Date
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET backfill_in_progress = ($4::int > 0),
          backfill_target_max_uid = $2,
          backfill_oldest_uid_synced = $3,
          backfill_since_date = $5,
          historical_target_count = $4,
          last_archive_refresh_at = CASE WHEN $4::int = 0 THEN now() ELSE last_archive_refresh_at END,
          last_progress_at = now(),
          last_progress_note = 'history_backfill_snapshot'
      WHERE id = $1
      `,
      [folderId, targetMaxUid, oldestUidSynced, targetCount, cutoff]
    );
  }

  async advanceHistoryBackfillWatermark(
    folderId: string,
    newOldestUidSynced: number,
    lastProgressUid: number
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET backfill_oldest_uid_synced = $2,
          last_progress_at = now(),
          last_progress_uid = $3,
          last_progress_note = 'history_backfill_metadata'
      WHERE id = $1
      `,
      [folderId, newOldestUidSynced, lastProgressUid]
    );
  }

  async markHistoryBackfillComplete(folderId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET backfill_in_progress = false,
          last_archive_refresh_at = now(),
          last_progress_at = now(),
          last_progress_note = 'history_backfill_complete'
      WHERE id = $1
      `,
      [folderId]
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
        AND f.tracked = true
        -- The body lane SELECTs the folder too (getMailboxLock on folder_path), so a
        -- folder discovery flagged missing/gone must be excluded here as well — the
        -- body fetch is the one un-try/caught reader, so a deleted folder here throws
        -- straight to the account-level catch and bricks the account to BROKEN. Keep
        -- this filter in lockstep with getFoldersDueForSync / getHistoryBacklog.
        AND f.missing_since IS NULL
        AND f.status NOT IN ('MISSING', 'PENDING_VERIFICATION')
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
