import { createHash, randomUUID } from "node:crypto";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import type { AppConfig } from "./config.js";
import { buildSearchExtract } from "./body-store.js";
import { encryptPassword } from "./crypto.js";
import type { PgClient, PgPool } from "./db.js";
import { AccountBusyError } from "./errors.js";
import { assertSafeImapTarget } from "./host-validation.js";
import { withAccountLock } from "./locks.js";
import {
  assertMetadataProtectionProjection,
  assertRevealedMetadataValues,
  isPlaintextMetadataProtectionAdapter,
  plaintextMetadataProtection,
  protectedMetadataColumns,
  storedMetadataProjection,
  usesPlaintextMetadataStorage,
  type MetadataProtectionAdapter,
  type MetadataRecordKind,
  type MetadataValues,
  type ProtectedMetadataColumns
} from "./metadata-protection.js";
import { normalizeMessageId } from "./mime.js";
import { autodiscoverProfile, getProviderProfile } from "./provider-profiles.js";
import {
  assertFlagEventSideWithinLimits,
  MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES,
  MAX_SYNC_FLAGS_PER_EVENT_LOGICAL_BATCH,
  MAX_SYNC_BATCH_SIZE,
  PARSED_BODY_BATCH_MAX_MESSAGES,
  PARSED_BODY_BATCH_MAX_SOURCE_BYTES,
  PARSED_BODY_BATCH_MAX_TOTAL_SOURCE_BYTES,
  splitFlagEventBatches,
  splitFlagWriteBatches,
  splitMetadataWriteBatches
} from "./sync-limits.js";
import { diagnosticErrorCode, sanitizeErrorReason } from "./sync-diagnostics.js";
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
  MessageFlagSnapshot,
  MessageMetadata,
  SyncResult,
  SyncRunStatus,
  SyncTriggerType,
  UpdateAccountCredentialsInput,
  UpdateAccountSettingsInput
} from "./types.js";

const BROKEN_FAILURE_THRESHOLD = 10;
const BACKOFF_FLOOR_MS = 1_000;
const BACKOFF_CEILING_MS = 5 * 60_000;
const MANUAL_TRACK_OVERRIDE_NOTE = "manual_track_override";
const MISSING_MAILBOX_VERIFICATION_NOTE = "missing_mailbox_pending_verification";
const DEFAULT_METADATA_WRITE_TIMEOUT_MS = 5 * 60_000;
const LIVE_THREAD_RUN_STATUSES = ["building", "ready", "active", "standby"] as const;
const PURGE_MESSAGE_BATCH_SIZE = 100;
const PURGE_RECOMPUTE_PAIR_LIMIT = 25_000;
const RECONCILE_MISSING_UID_LIMIT = 5_000;
const MIME_EVIDENCE_EXTRACTOR = "mime_body";
const MIME_EVIDENCE_EXTRACTOR_VERSION = "mime_evidence_v1";
const MAX_MESSAGE_EVIDENCE_ROWS = 100;
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

const ACCOUNT_PROTECTED_FIELDS = [
  "email_address",
  "username",
  "smtp_username"
] as const;

const ACCOUNT_SUMMARY_PROTECTED_FIELDS = ["email_address"] as const;

const MESSAGE_PROTECTED_FIELDS = [
  "rfc_message_id",
  "message_id_normalized",
  "provider_message_id",
  "provider_message_id_namespace",
  "provider_thread_id",
  "provider_thread_id_namespace",
  "in_reply_to",
  "references_header",
  "subject",
  "from_email",
  "from_name",
  "to_emails",
  "to_names",
  "cc_emails",
  "cc_names",
  "bcc_emails",
  "headers_json",
  "mime_structure"
] as const;

const MESSAGE_BODY_PROTECTED_FIELDS = [
  "raw_mime_sha256",
  "parsed_delivery_sha256",
  "authored_delivery_sha256",
  "headers_json",
  "mime_structure",
  "parser_warnings",
  "structured_evidence_sha256",
  "threading_payload_sha256",
  "search_extract"
] as const;

function selectMetadataValues(
  source: object,
  fields: readonly string[]
): MetadataValues {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(record, field))
      .map((field) => [field, record[field]])
  );
}


const METADATA_WRITE_TIMEOUT_ERROR = "metadata write deadline exceeded";
const FLAG_SCAN_TIMEOUT_ERROR = "FLAG_SCAN_TOTAL_TIMEOUT_MS exceeded during flag scan write";
const SYNC_DATABASE_WRITE_INTERRUPTED_ERROR = "sync database write interrupted";

function deadlineQuery(
  text: string,
  queryTimeout: number,
  values?: unknown[]
): QueryConfig & { query_timeout: number } {
  return { text, values, query_timeout: queryTimeout };
}

async function queryWithDeadline<T extends QueryResultRow = QueryResultRow>(
  client: PgClient,
  text: string,
  values: unknown[] | undefined,
  deadlineAt: number,
  remainingMs: (deadlineAt: number) => number,
  checkAfter = true
): Promise<QueryResult<T>> {
  const queryTimeout = remainingMs(deadlineAt);
  const result = await client.query<T>(deadlineQuery(text, queryTimeout, values));
  if (checkAfter) remainingMs(deadlineAt);
  return result;
}

function createTransactionDeadline(errorMessage: string) {
  const remainingMs = (deadlineAt: number): number => {
    const remaining = Math.floor(deadlineAt - Date.now());
    if (remaining < 1) throw new Error(errorMessage);
    return remaining;
  };

  const connect = async (
    pool: PgPool,
    deadlineAt: number,
    signal?: AbortSignal
  ): Promise<PgClient> => {
    const timeoutMs = remainingMs(deadlineAt);
    return await new Promise<PgClient>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(SYNC_DATABASE_WRITE_INTERRUPTED_ERROR));
      };
      const timeout = setTimeout(() => {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(errorMessage));
      }, timeoutMs);
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }

      void pool.connect().then(
        (client) => {
          if (settled) {
            // This checkout arrived after the caller stopped waiting, before any
            // transaction or query ran on it. Return the clean client normally;
            // destroying it here would churn the whole pool during abort bursts.
            client.release();
            return;
          }
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          resolve(client);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  };

  const queryControl = async (
    client: PgClient,
    text: string,
    deadlineAt: number,
    checkAfter = true
  ): Promise<void> => {
    await queryWithDeadline(client, text, undefined, deadlineAt, remainingMs, checkAfter);
  };

  const refreshTimeout = async (client: PgClient, deadlineAt: number): Promise<void> => {
    const timeoutMs = remainingMs(deadlineAt);
    await client.query(deadlineQuery(
      "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true)",
      timeoutMs,
      [`${timeoutMs}ms`]
    ));
    remainingMs(deadlineAt);
  };

  return { connect, queryControl, refreshTimeout, remainingMs };
}

const metadataWriteDeadline = createTransactionDeadline(METADATA_WRITE_TIMEOUT_ERROR);
const flagScanDeadline = createTransactionDeadline(FLAG_SCAN_TIMEOUT_ERROR);

function bindClientAbort(client: PgClient, signal?: AbortSignal): {
  isReleased(): boolean;
  release(discard?: boolean): void;
} {
  let released = false;
  const release = (discard = false) => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", onAbort);
    client.release(discard);
  };
  const onAbort = () => release(true);

  if (signal?.aborted) {
    // The signal won the narrow race after checkout but before BEGIN/listener
    // binding. No work has run on this client, so it remains safe to reuse.
    release();
    throw new Error(SYNC_DATABASE_WRITE_INTERRUPTED_ERROR);
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  return { isReleased: () => released, release };
}

async function runMetadataWriteWithDeadline<T extends QueryResultRow>(
  pool: PgPool,
  text: string,
  values: unknown[],
  deadlineAt: number,
  signal?: AbortSignal
): Promise<QueryResult<T>> {
  const client = await metadataWriteDeadline.connect(pool, deadlineAt, signal);
  const lease = bindClientAbort(client, signal);
  let discardClient = false;
  try {
    await metadataWriteDeadline.queryControl(client, "BEGIN", deadlineAt);
    await metadataWriteDeadline.refreshTimeout(client, deadlineAt);
    const result = await queryWithDeadline<T>(
      client,
      text,
      values,
      deadlineAt,
      metadataWriteDeadline.remainingMs
    );
    await metadataWriteDeadline.refreshTimeout(client, deadlineAt);
    await metadataWriteDeadline.queryControl(client, "COMMIT", deadlineAt, false);
    return result;
  } catch (error) {
    if (!lease.isReleased()) {
      const rollbackTimeout = Math.max(1, Math.min(1_000, deadlineAt - Date.now()));
      await client.query(deadlineQuery("ROLLBACK", rollbackTimeout)).catch(() => {
        discardClient = true;
      });
    }
    throw error;
  } finally {
    lease.release(discardClient);
  }
}

export interface MetadataWriteOptions {
  preserveExistingFlags?: boolean;
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface SyncStateWriteOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
  expectedSyncOwner?: string;
}

async function runOptionalDeadlineWrite<T extends QueryResultRow>(
  pool: PgPool,
  text: string,
  values: unknown[],
  options: SyncStateWriteOptions
): Promise<QueryResult<T>> {
  return options.deadlineAt === undefined
    ? await pool.query<T>(text, values)
    : await runMetadataWriteWithDeadline<T>(
        pool,
        text,
        values,
        options.deadlineAt,
        options.signal
      );
}

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

function flagRepresentationsEqual(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined
): boolean {
  if (left == null || right == null) return left === right;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((flag, index) => flag === sortedRight[index]);
}

function headerText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const joined = value.map((entry) => String(entry).trim()).filter(Boolean).join(" ");
    return joined || null;
  }
  return value == null ? null : String(value).trim() || null;
}

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

interface PreparedMessageEvidenceRow {
  message_id: string;
  extractor: string;
  extractor_version: string;
  kind: string;
  namespace: string;
  evidence_key: string;
  evidence_key_sha256: string;
  metadata: Record<string, string | number | boolean | null>;
}

function prepareMessageEvidence(body: MessageBodyInput): PreparedMessageEvidenceRow[] {
  if (body.evidence.length > MAX_MESSAGE_EVIDENCE_ROWS) {
    throw new Error(`Message evidence exceeds ${MAX_MESSAGE_EVIDENCE_ROWS} rows`);
  }
  const rows = new Map<string, PreparedMessageEvidenceRow>();
  for (const item of body.evidence) {
    if (!item.namespace || item.namespace.length > 64 || !/^[a-z0-9_]+$/.test(item.namespace)) {
      throw new Error("Message evidence namespace is invalid");
    }
    if (!item.key || Buffer.byteLength(item.key, "utf8") > 2_048) {
      throw new Error("Message evidence key is invalid");
    }
    const metadataJson = canonicalJsonForThreadingEvidence(item.metadata);
    if (Buffer.byteLength(metadataJson, "utf8") > 16_384) {
      throw new Error("Message evidence metadata is too large");
    }
    const evidenceKeySha256 = createHash("sha256").update(item.key).digest("hex");
    const identity = `${item.kind}\u0000${item.namespace}\u0000${evidenceKeySha256}`;
    rows.set(identity, {
      message_id: body.messageId,
      extractor: MIME_EVIDENCE_EXTRACTOR,
      extractor_version: MIME_EVIDENCE_EXTRACTOR_VERSION,
      kind: item.kind,
      namespace: item.namespace,
      evidence_key: item.key,
      evidence_key_sha256: evidenceKeySha256,
      metadata: JSON.parse(metadataJson) as Record<string, string | number | boolean | null>
    });
  }
  return [...rows.values()].sort((left, right) => {
    const leftIdentity = `${left.kind}\u0000${left.namespace}\u0000${left.evidence_key_sha256}`;
    const rightIdentity = `${right.kind}\u0000${right.namespace}\u0000${right.evidence_key_sha256}`;
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
}

interface BodyThreadingEnvelope {
  subject: string | null;
  from_email: string | null;
  to_emails: string[] | null;
  cc_emails: string[] | null;
  bcc_emails: string[] | null;
  size_bytes: number | string | null;
}

function threadingPayloadSha256(body: MessageBodyInput): string | null {
  if (
    body.rawTruncated
    || (body.bodyText ?? body.bodyPlain ?? body.selectedTextPart ?? body.bodyHtml) === null
  ) {
    return null;
  }
  const encode = (value: string | null): string =>
    value === null ? "-:" : `${Buffer.byteLength(value, "utf8")}:${value}`;
  return createHash("sha256")
    .update([
      body.bodyText,
      body.bodyHtml,
      body.bodyPlain,
      body.selectedTextPart,
      body.selectedTextFormat
    ].map(encode).join(""))
    .digest("hex");
}

function hasBodyThreadingEnvelope(
  message: BodyThreadingEnvelope,
  body: MessageBodyInput,
  payloadSha256: string | null
): boolean {
  return body.rawBytes > 0
    && message.from_email !== null
    && body.headersJson["message-id"] !== undefined
    && body.headersJson.from !== undefined
    && [
      ...(message.to_emails ?? []),
      ...(message.cc_emails ?? []),
      ...(message.bcc_emails ?? [])
    ].length > 0
    && payloadSha256 !== null;
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

export { diagnosticErrorCode, sanitizeErrorReason } from "./sync-diagnostics.js";

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
  protected_metadata,
  protected_metadata_version,
  protected_metadata_key_version,
  protected_metadata_tokens,
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
  a.protected_metadata,
  a.protected_metadata_version,
  a.protected_metadata_key_version,
  a.protected_metadata_tokens,
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
    private readonly config: AppConfig,
    private readonly metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
  ) {}

  private async protectMetadata(
    kind: MetadataRecordKind,
    accountId: string,
    recordId: string,
    values: MetadataValues
  ) {
    const projection = await this.metadataProtection.protect(
      { kind, accountId, recordId },
      values
    );
    assertMetadataProtectionProjection(projection, Object.keys(values));
    return {
      values: projection.values,
      columns: protectedMetadataColumns(projection)
    };
  }

  private async revealMetadata<T extends ProtectedMetadataColumns>(
    row: T,
    kind: MetadataRecordKind,
    accountId: string,
    recordId: string,
    fields: readonly string[]
  ): Promise<T> {
    let revealed: MetadataValues;
    const usesPlaintextStorage = usesPlaintextMetadataStorage(this.metadataProtection, row);
    if (usesPlaintextStorage
      && !Object.hasOwn(row, "protected_metadata")
      && !Object.hasOwn(row, "protected_metadata_version")
      && !Object.hasOwn(row, "protected_metadata_key_version")
      && !Object.hasOwn(row, "protected_metadata_tokens")) {
      return row;
    }
    if (usesPlaintextStorage) {
      revealed = selectMetadataValues(row, fields);
    } else {
      revealed = await this.metadataProtection.reveal(
        { kind, accountId, recordId },
        storedMetadataProjection(row, selectMetadataValues(row, fields))
      );
    }
    assertRevealedMetadataValues(revealed, fields);
    const result = { ...(row as unknown as Record<string, unknown>) };
    for (const field of fields) {
      if (Object.hasOwn(revealed, field)) result[field] = revealed[field];
    }
    delete result.protected_metadata;
    delete result.protected_metadata_version;
    delete result.protected_metadata_key_version;
    delete result.protected_metadata_tokens;
    return result as unknown as T;
  }

  private async revealAccountSummary<T extends AccountSummary & ProtectedMetadataColumns>(
    row: T
  ): Promise<T> {
    return this.revealMetadata(
      row,
      "account",
      row.id,
      row.id,
      ACCOUNT_SUMMARY_PROTECTED_FIELDS
    );
  }

  private async revealAccount<T extends ImapAccount & ProtectedMetadataColumns>(
    row: T
  ): Promise<T> {
    return this.revealMetadata(row, "account", row.id, row.id, ACCOUNT_PROTECTED_FIELDS);
  }

  private async revealMessage<T extends ImapMessage & ProtectedMetadataColumns>(
    row: T
  ): Promise<T> {
    return this.revealMetadata(row, "message", row.account_id, row.id, MESSAGE_PROTECTED_FIELDS);
  }

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
    const accountId = randomUUID();
    const protectedAccount = await this.protectMetadata("account", accountId, accountId, {
      email_address: input.emailAddress,
      username: input.username,
      smtp_username: input.smtpUsername ?? null
    });
    const protectedColumns = protectedAccount.columns;
    const result = await this.pool.query<AccountSummary & ProtectedMetadataColumns>(
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
        body_fetch_policy,
        id,
        protected_metadata,
        protected_metadata_version,
        protected_metadata_key_version,
        protected_metadata_tokens,
        metadata_protection_mode
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19
      )
      RETURNING ${ACCOUNT_SUMMARY_COLUMNS}
      `,
      [
        protectedAccount.values.email_address,
        providerProfile,
        host,
        port,
        secure,
        protectedAccount.values.username,
        encrypted,
        input.smtpHost ?? null,
        input.smtpPort ?? null,
        input.smtpSecure ?? null,
        protectedAccount.values.smtp_username,
        encryptedSmtp,
        input.bodyFetchPolicy ?? this.config.BODY_FETCH_POLICY,
        accountId,
        protectedColumns.protected_metadata,
        protectedColumns.protected_metadata_version,
        protectedColumns.protected_metadata_key_version,
        protectedColumns.protected_metadata_tokens,
        isPlaintextMetadataProtectionAdapter(this.metadataProtection) ? "plaintext" : "protected"
      ]
    );
    return await this.revealAccountSummary(result.rows[0]);
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const result = await this.pool.query<AccountSummary & ProtectedMetadataColumns>(
      `SELECT ${ACCOUNT_SUMMARY_COLUMNS} FROM public.imap_accounts ORDER BY email_address`
    );
    return await Promise.all(result.rows.map((row) => this.revealAccountSummary(row)));
  }

  async getAccount(id: string): Promise<ImapAccount | null> {
    const result = await this.pool.query<ImapAccount & ProtectedMetadataColumns>(
      "SELECT * FROM public.imap_accounts WHERE id = $1",
      [id]
    );
    return result.rows[0] ? await this.revealAccount(result.rows[0]) : null;
  }

  /** Active Mailbox Accounts that a host may keep on an Inbox IDLE session. */
  async getIdleWatchAccounts(): Promise<ImapAccount[]> {
    const result = await this.pool.query<ImapAccount & ProtectedMetadataColumns>(
      `SELECT *
       FROM public.imap_accounts
       WHERE sync_state <> 'PAUSED'
         AND sync_state <> 'INITIAL_SYNC'
         AND (sync_state <> 'BROKEN' OR backoff_until IS NOT NULL)
         AND (backoff_until IS NULL OR backoff_until <= now())
       ORDER BY id`
    );
    return await Promise.all(result.rows.map((row) => this.revealAccount(row)));
  }

  async getAccountDetails(id: string): Promise<AccountDetails | null> {
    const accountResult = await this.pool.query<
      AccountSummary & Omit<AccountProgress, "account_id"> & ProtectedMetadataColumns
    >(
      `
      SELECT ${ACCOUNT_DETAILS_COLUMNS}
      FROM public.imap_accounts a
      JOIN public.imap_account_progress p ON p.account_id = a.id
      WHERE a.id = $1
      `,
      [id]
    );
    const storedAccount = accountResult.rows[0];
    if (!storedAccount) return null;
    const account = await this.revealAccountSummary(storedAccount);

    const folders = await this.pool.query<FolderProgress>(
      `
      WITH live_body_progress AS (
        SELECT
          m.folder_path,
          count(*)::int AS live_bodies_target_count,
          count(*) FILTER (
            WHERE m.body_fetched_at IS NOT NULL
              AND b.message_id IS NOT NULL
              AND NOT b.raw_truncated
          )::int AS live_bodies_fetched_count
        FROM public.imap_messages m
        LEFT JOIN public.imap_message_bodies b
          ON b.message_id = m.id
        WHERE m.account_id = $1
          AND m.deleted_in_provider = false
          AND m.window_status = 'IN_WINDOW'
        GROUP BY m.folder_path
      )
      SELECT
        f.id,
        f.path,
        f.tracked,
        f.status,
        f.sync_priority,
        f.headers_synced_count,
        f.bodies_fetched_count,
        f.live_window_target_count,
        f.historical_target_count,
        COALESCE(b.live_bodies_fetched_count, 0) AS live_bodies_fetched_count,
        COALESCE(b.live_bodies_target_count, 0) AS live_bodies_target_count,
        CASE
          WHEN COALESCE(f.live_window_target_count, 0) > 0
            THEN LEAST(100, round((LEAST(f.headers_synced_count, f.live_window_target_count)::numeric / f.live_window_target_count::numeric) * 100)::int)
          WHEN f.live_window_target_count IS NOT NULL THEN 100
          ELSE 0
        END AS headers_pct,
        CASE
          WHEN COALESCE(b.live_bodies_target_count, 0) > 0
            THEN round((b.live_bodies_fetched_count::numeric / b.live_bodies_target_count::numeric) * 100)::int
          WHEN f.live_window_target_count IS NOT NULL THEN 100
          ELSE 0
        END AS bodies_pct,
        CASE
          WHEN COALESCE(f.historical_target_count, 0) > 0
            THEN LEAST(100, round((GREATEST(f.headers_synced_count - COALESCE(f.live_window_target_count, 0), 0)::numeric / f.historical_target_count::numeric) * 100)::int)
          WHEN f.historical_target_count IS NOT NULL THEN 100
          ELSE 0
        END AS historical_headers_pct,
        CASE
          WHEN COALESCE(f.historical_target_count, 0) > 0
            THEN LEAST(100, round((GREATEST(f.bodies_fetched_count - COALESCE(f.live_window_target_count, 0), 0)::numeric / f.historical_target_count::numeric) * 100)::int)
          WHEN f.historical_target_count IS NOT NULL THEN 100
          ELSE 0
        END AS historical_bodies_pct
      FROM public.imap_folders f
      LEFT JOIN live_body_progress b
        ON b.folder_path = f.path
      WHERE f.account_id = $1
      ORDER BY f.sync_priority, f.path
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
      input.bodyFetchPolicy === undefined
      && input.historicalBackfillMode === undefined
      && input.archiveRefreshInterval === undefined
      && input.archiveFlagSync === undefined
      && input.maxBackfillRate === undefined
    ) {
      const existing = await this.pool.query<AccountSummary & ProtectedMetadataColumns>(
        `SELECT ${ACCOUNT_SUMMARY_COLUMNS} FROM public.imap_accounts WHERE id = $1`,
        [accountId]
      );
      return existing.rows[0] ? await this.revealAccountSummary(existing.rows[0]) : null;
    }

    const result = await this.pool.query<AccountSummary & ProtectedMetadataColumns>(
      `
      UPDATE public.imap_accounts
      SET
        historical_backfill_mode = COALESCE($2::text, historical_backfill_mode),
        archive_refresh_interval = COALESCE($3::text, archive_refresh_interval),
        archive_flag_sync = COALESCE($4::boolean, archive_flag_sync),
        max_backfill_rate = COALESCE($5::text, max_backfill_rate),
        body_fetch_policy = COALESCE($6::text, body_fetch_policy)
      WHERE id = $1
      RETURNING ${ACCOUNT_SUMMARY_COLUMNS}
      `,
      [
        accountId,
        input.historicalBackfillMode ?? null,
        input.archiveRefreshInterval ?? null,
        input.archiveFlagSync ?? null,
        input.maxBackfillRate ?? null,
        input.bodyFetchPolicy ?? null
      ]
    );
    return result.rows[0] ? await this.revealAccountSummary(result.rows[0]) : null;
  }

  async updateAccountCredentials(
    accountId: string,
    input: UpdateAccountCredentialsInput
  ): Promise<AccountSummary | null> {
    const current = await this.pool.query<{ lock_id: string }>(
      `SELECT lock_id
       FROM public.imap_accounts
       WHERE id = $1`,
      [accountId]
    );
    const existing = current.rows[0];
    if (!existing) return null;

    const encrypted = await encryptPassword(
      this.pool,
      input.password,
      this.config.IMAP_ENCRYPTION_KEY
    );
    const updated = await withAccountLock(this.pool, existing.lock_id, async (lock) => {
      const result = await lock.client.query<AccountSummary & ProtectedMetadataColumns>(
        `UPDATE public.imap_accounts
         SET encrypted_password = $2,
             sync_state = 'DEGRADED',
             sync_state_reason = 'CREDENTIALS_UPDATED_PENDING_SYNC',
             consecutive_failures = 0,
             consecutive_successes = 0,
             current_backoff_ms = 0,
             backoff_until = NULL,
             currently_syncing = false,
             sync_started_by = NULL,
             next_folder_discovery_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING ${ACCOUNT_SUMMARY_COLUMNS}`,
        [accountId, encrypted]
      );
      return result.rows[0] ?? null;
    });

    if (updated === null) {
      throw new AccountBusyError(
        `Account ${accountId} is busy syncing; retry credential replacement shortly`
      );
    }
    return updated ? await this.revealAccountSummary(updated) : null;
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
    const result = await this.pool.query<ImapAccount & ProtectedMetadataColumns>(
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
          -- currently_syncing is an observability projection, not ownership.
          -- If cancellation cleanup was briefly blocked but the session lock is
          -- already gone, make the account immediately schedulable; the
          -- authoritative pg_try_advisory_lock still closes the selection race.
          OR NOT EXISTS (
            SELECT 1
            FROM pg_locks active_lock
            WHERE active_lock.locktype = 'advisory'
              AND active_lock.classid::bigint = 0
              AND active_lock.objid::bigint = public.imap_accounts.lock_id
              AND active_lock.granted = true
          )
        )
        ${sentDueClause}
      ORDER BY COALESCE(last_sync_finished_at, 'epoch'::timestamptz), created_at
      LIMIT $1
      `,
      [effectiveLimit, this.config.STALE_HEARTBEAT_MS]
    );
    return await Promise.all(result.rows.map((row) => this.revealAccount(row)));
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
    const diagnosticCodes = [...new Set(result.errors.map(diagnosticErrorCode))];
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
        diagnosticCodes[0] ?? null,
        JSON.stringify({
          errors: diagnosticCodes,
          hitLockBudget: result.hitLockBudget,
          metadataRowsCommitted: result.metadataRowsCommitted ?? 0,
          metadataWriteDurationMs: result.metadataWriteDurationMs ?? 0,
          metadataWriteBatchesAttempted: result.metadataWriteBatchesAttempted ?? 0,
          metadataWriteBatchesFailed: result.metadataWriteBatchesFailed ?? 0,
          metadataWriteServiceRowsPerSecond: result.metadataWriteServiceRowsPerSecond ?? null,
          reconcileFoldersAttempted: result.reconcileFoldersAttempted ?? 0,
          reconcileProviderUidsSeen: result.reconcileProviderUidsSeen ?? 0,
          reconcileDurationMs: result.reconcileDurationMs ?? 0
        })
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
      [runId, status, error ? diagnosticErrorCode(error) : null]
    );
  }

  async markAccountSyncStarted(
    accountId: string,
    startedBy: string,
    options: SyncStateWriteOptions = {}
  ): Promise<void> {
    await runOptionalDeadlineWrite(
      this.pool,
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = true,
        sync_started_by = $2,
        last_sync_started_at = now(),
        last_heartbeat_at = now()
      WHERE id = $1
      `,
      [accountId, startedBy],
      options
    );
  }

  /** Clear active-sync state after scheduler cancellation without changing health. */
  async markAccountSyncYielded(
    accountId: string,
    options: SyncStateWriteOptions = {}
  ): Promise<void> {
    const query = `
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_heartbeat_at = now()
      WHERE id = $1
        AND ($2::text IS NULL OR sync_started_by = $2)
      RETURNING id
    `;
    const result = await runOptionalDeadlineWrite<{ id: string }>(
      this.pool,
      query,
      [accountId, options.expectedSyncOwner ?? null],
      options
    );
    if (result.rows.length !== 1 && options.expectedSyncOwner === undefined) {
      throw new Error(`Sync cleanup lost account ${accountId}`);
    }
  }

  async markAccountSyncSucceeded(
    accountId: string,
    options: SyncStateWriteOptions & { countsTowardBackoff?: boolean } = {}
  ): Promise<void> {
    const countsTowardBackoff = options.countsTowardBackoff ?? true;
    const result = await runOptionalDeadlineWrite<{ id: string }>(
      this.pool,
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
        AND ($12::text IS NULL OR sync_started_by = $12)
      RETURNING id
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
        this.config.RECENT_UIDVALIDITY_RESET_DEGRADED_MS,
        options.expectedSyncOwner ?? null
      ],
      options
    );
    if (result.rows.length !== 1 && options.expectedSyncOwner === undefined) {
      throw new Error(`Sync finalization lost account ${accountId}`);
    }
  }

  // Per spec §12.2: PARTIAL_SUCCESS means priority folders succeeded but some
  // round-robin folders didn't. Counters increment as if it were SUCCESS
  // (consecutive_successes++, failures=0); sync_state stays DEGRADED until
  // round-robin folders catch up.
  async markAccountSyncPartial(
    accountId: string,
    error: string,
    options: SyncStateWriteOptions & { countsTowardBackoff?: boolean } = {}
  ): Promise<void> {
    const countsTowardBackoff = options.countsTowardBackoff ?? true;
    const result = await runOptionalDeadlineWrite<{ id: string }>(
      this.pool,
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
        AND ($4::text IS NULL OR sync_started_by = $4)
      RETURNING id
      `,
      [accountId, diagnosticErrorCode(error), countsTowardBackoff, options.expectedSyncOwner ?? null],
      options
    );
    if (result.rows.length !== 1 && options.expectedSyncOwner === undefined) {
      throw new Error(`Sync finalization lost account ${accountId}`);
    }
  }

  // Per spec §12.4 / §13.1: AUTH_ERROR is non-retryable. Skip backoff math and
  // pin the account at BROKEN with a clear reason. Operator intervention is
  // required (rotate creds, re-add account).
  async markAccountSyncAuthFailed(
    accountId: string,
    error: string,
    options: SyncStateWriteOptions = {}
  ): Promise<void> {
    const result = await runOptionalDeadlineWrite<{ id: string }>(
      this.pool,
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
        AND ($3::text IS NULL OR sync_started_by = $3)
      RETURNING id
      `,
      [accountId, diagnosticErrorCode(`AUTH_ERROR: ${error}`), options.expectedSyncOwner ?? null],
      options
    );
    if (result.rows.length !== 1 && options.expectedSyncOwner === undefined) {
      throw new Error(`Sync finalization lost account ${accountId}`);
    }
  }

  async markAccountSyncFailed(
    accountId: string,
    error: string,
    options: SyncStateWriteOptions = {}
  ): Promise<void> {
    // CTE computes the doubled-and-clamped backoff once so the same value
    // feeds both `current_backoff_ms` and `backoff_until` — without it the
    // expression has to be duplicated and would drift on tuning changes.
    const result = await runOptionalDeadlineWrite<{ id: string }>(
      this.pool,
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
        AND ($9::text IS NULL OR a.sync_started_by = $9)
      RETURNING a.id
      `,
      [
        accountId,
        diagnosticErrorCode(error),
        BROKEN_FAILURE_THRESHOLD,
        BACKOFF_FLOOR_MS,
        BACKOFF_CEILING_MS,
        this.config.STUCK_DEGRADED_BROKEN_THRESHOLD_MS,
        this.config.STUCK_DEGRADED_TERMINAL_THRESHOLD_MS,
        this.config.STUCK_DEGRADED_RETRY_INTERVAL_MS,
        options.expectedSyncOwner ?? null
      ],
      options
    );
    if (result.rows.length !== 1 && options.expectedSyncOwner === undefined) {
      throw new Error(`Sync finalization lost account ${accountId}`);
    }
  }

  async heartbeat(accountId: string): Promise<void> {
    await this.pool.query("UPDATE public.imap_accounts SET last_heartbeat_at = now() WHERE id = $1", [
      accountId
    ]);
  }

  private async lockThreadStateForMirrorWrite(client: PgClient, accountId: string): Promise<void> {
    let locked = await client.query<{ account_id: string }>(
      `SELECT account_id FROM public.imap_thread_state
       WHERE account_id = $1 FOR SHARE`,
      [accountId]
    );
    if (!locked.rows[0]) {
      await client.query(
        `INSERT INTO public.imap_thread_state (account_id)
         SELECT id FROM public.imap_accounts WHERE id = $1
         ON CONFLICT (account_id) DO NOTHING`,
        [accountId]
      );
      locked = await client.query<{ account_id: string }>(
        `SELECT account_id FROM public.imap_thread_state
         WHERE account_id = $1 FOR SHARE`,
        [accountId]
      );
    }
    if (!locked.rows[0]) throw new Error(`Account not found: ${accountId}`);
  }

  private async enqueueThreadingMessages(
    client: PgClient,
    accountId: string,
    messageIds: readonly string[],
    reason: string
  ): Promise<void> {
    if (messageIds.length === 0) return;
    await client.query(
      `INSERT INTO public.imap_thread_work_queue (
         run_id, message_id, account_id, reason, attempts, available_at,
         last_error, enqueued_at, updated_at
       )
       SELECT run.id, message.id, message.account_id, $3, 0, now(), NULL, now(), now()
       FROM public.imap_thread_runs run
       JOIN public.imap_messages message
         ON message.account_id = run.account_id
        AND message.id = ANY($2::uuid[])
       WHERE run.account_id = $1 AND run.status = ANY($4::text[])
       ON CONFLICT (run_id, message_id) DO UPDATE SET
         account_id = EXCLUDED.account_id, reason = EXCLUDED.reason,
         attempts = 0, available_at = now(), last_error = NULL,
         enqueued_at = now(), updated_at = now()`,
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
      const discovered = await client.query<PurgeCandidate>(
        `SELECT id, account_id FROM public.imap_messages
         WHERE deleted_in_provider = true
           AND deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING')
           AND provider_deleted_at < now() - interval '30 days'
         ORDER BY id LIMIT $1`,
        [PURGE_MESSAGE_BATCH_SIZE]
      );
      if (discovered.rows.length === 0) {
        await client.query("COMMIT");
        return { purged: 0 };
      }

      const accountIds = [...new Set(discovered.rows.map((row) => row.account_id))].sort();
      await client.query(
        `INSERT INTO public.imap_thread_state (account_id)
         SELECT input.account_id FROM unnest($1::uuid[]) AS input(account_id)
         JOIN public.imap_accounts account ON account.id = input.account_id
         ON CONFLICT (account_id) DO NOTHING`,
        [accountIds]
      );
      await client.query(
        `SELECT account_id FROM public.imap_thread_state
         WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR SHARE`,
        [accountIds]
      );

      const locked = await client.query<PurgeCandidate>(
        `SELECT id, account_id FROM public.imap_messages
         WHERE id = ANY($1::uuid[])
           AND deleted_in_provider = true
           AND deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING')
           AND provider_deleted_at < now() - interval '30 days'
         ORDER BY id FOR UPDATE SKIP LOCKED`,
        [discovered.rows.map((row) => row.id)]
      );
      if (locked.rows.length === 0) {
        await client.query("COMMIT");
        return { purged: 0 };
      }

      const acceptedVictims: string[] = [];
      const recomputeTargets = new Map<string, PurgeQueueTarget>();
      const pending: string[][] = [locked.rows.map((row) => row.id)];
      while (pending.length > 0) {
        const victimIds = pending.shift()!;
        const remaining = PURGE_RECOMPUTE_PAIR_LIMIT - recomputeTargets.size;
        if (remaining <= 0) break;
        const neighbors = await client.query<PurgeQueueTarget>(
          `WITH affected_components AS (
             SELECT DISTINCT assignment.run_id, assignment.account_id, assignment.conversation_id
             FROM public.imap_thread_assignments assignment
             JOIN public.imap_thread_runs source_run
               ON source_run.id = assignment.run_id AND source_run.status = ANY($2::text[])
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
             ON live_run.account_id = survivor.account_id AND live_run.status = ANY($2::text[])
           WHERE (live_run.id::text || ':' || survivor.message_id::text) <> ALL($3::text[])
           ORDER BY run_id, survivor.message_id LIMIT $4`,
          [victimIds, [...LIVE_THREAD_RUN_STATUSES], [...recomputeTargets.keys()], remaining + 1]
        );
        if (neighbors.rows.length > remaining) {
          if (victimIds.length === 1) continue;
          const midpoint = Math.ceil(victimIds.length / 2);
          pending.unshift(victimIds.slice(midpoint));
          pending.unshift(victimIds.slice(0, midpoint));
          continue;
        }
        acceptedVictims.push(...victimIds);
        for (const row of neighbors.rows) recomputeTargets.set(`${row.run_id}:${row.message_id}`, row);
      }
      if (acceptedVictims.length === 0) {
        await client.query("COMMIT");
        return { purged: 0 };
      }

      const acceptedSet = new Set(acceptedVictims);
      const queueTargets = [...recomputeTargets.values()].filter((row) => !acceptedSet.has(row.message_id));
      if (queueTargets.length > 0) {
        await client.query(
          `INSERT INTO public.imap_thread_work_queue (
             run_id, message_id, account_id, reason, attempts, available_at,
             last_error, enqueued_at, updated_at
           )
           SELECT run_id, message_id, account_id, 'retained_neighbor_purged', 0, now(), NULL, now(), now()
           FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS affected(run_id, message_id, account_id)
           ON CONFLICT (run_id, message_id) DO UPDATE SET
             reason = EXCLUDED.reason, attempts = 0, available_at = now(),
             last_error = NULL, enqueued_at = now(), updated_at = now()`,
          [
            queueTargets.map((row) => row.run_id),
            queueTargets.map((row) => row.message_id),
            queueTargets.map((row) => row.account_id)
          ]
        );
      }

      await client.query(
        `WITH affected_subjects AS (
           SELECT DISTINCT assignment.account_id, assignment.subject_key
           FROM public.imap_thread_assignments assignment
           JOIN public.imap_thread_runs source_run
             ON source_run.id = assignment.run_id AND source_run.status = ANY($2::text[])
           WHERE assignment.message_id = ANY($1::uuid[]) AND assignment.subject_key IS NOT NULL
         )
         INSERT INTO public.imap_thread_subject_work (
           run_id, account_id, subject_key, attempts, available_at,
           last_error, enqueued_at, updated_at
         )
         SELECT live_run.id, subject.account_id, subject.subject_key,
                0, now(), NULL, now(), now()
         FROM affected_subjects subject
         JOIN public.imap_thread_runs live_run
           ON live_run.account_id = subject.account_id AND live_run.status = ANY($2::text[])
         ON CONFLICT (run_id, subject_key) DO UPDATE SET
           attempts = 0, available_at = now(), last_error = NULL,
           enqueued_at = now(), updated_at = now()`,
        [acceptedVictims, [...LIVE_THREAD_RUN_STATUSES]]
      );

      const result = await client.query(
        `DELETE FROM public.imap_messages
         WHERE id = ANY($1::uuid[]) AND deleted_in_provider = true
           AND deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING')
           AND provider_deleted_at < now() - interval '30 days'`,
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
      const syncPriority = profile.priorityForFolder(
        folder.path,
        folder.specialUse,
        folder.delimiter
      );
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
    const diagnosticCode = diagnosticErrorCode(reason);
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
          JSON.stringify({ reason: diagnosticCode })
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

  /**
   * Return the tracked Inbox even when its normal polling deadline is in the
   * future. An IDLE wake is an explicit reason to run this one folder now.
   */
  async getInboxFolderForWake(accountId: string): Promise<ImapFolder | null> {
    const result = await this.pool.query<ImapFolder>(
      `
      SELECT *
      FROM public.imap_folders
      WHERE account_id = $1
        AND lower(path) = 'inbox'
        AND tracked = true
        AND missing_since IS NULL
        AND status NOT IN ('MISSING', 'PENDING_VERIFICATION')
      ORDER BY CASE WHEN path = 'INBOX' THEN 0 ELSE 1 END
      LIMIT 1
      `,
      [accountId]
    );
    return result.rows[0] ?? null;
  }

  /** Active tracked mailboxes eligible for the shared IDLE connection's STATUS sweep. */
  async getTrackedFoldersForWake(accountId: string): Promise<ImapFolder[]> {
    const result = await this.pool.query<ImapFolder>(
      `
      SELECT *
      FROM public.imap_folders
      WHERE account_id = $1
        AND tracked = true
        AND lower(path) <> 'inbox'
        AND missing_since IS NULL
        AND status NOT IN ('MISSING', 'PENDING_VERIFICATION')
      ORDER BY sync_priority, path
      LIMIT COALESCE(
        (SELECT folder_count_cap_override FROM public.imap_accounts WHERE id = $1),
        $2
      )
      `,
      [accountId, this.config.FOLDER_COUNT_ENFORCE_THRESHOLD]
    );
    return result.rows;
  }

  /** Changed mailboxes bypass normal due times but remain constrained to tracked rows. */
  async getFoldersForWake(accountId: string, paths: readonly string[]): Promise<ImapFolder[]> {
    if (paths.length === 0) return [];
    const result = await this.pool.query<ImapFolder>(
      `
      SELECT *
      FROM public.imap_folders
      WHERE account_id = $1
        AND path = ANY($2::text[])
        AND tracked = true
        AND missing_since IS NULL
        AND status NOT IN ('MISSING', 'PENDING_VERIFICATION')
      ORDER BY array_position($2::text[], path)
      `,
      [accountId, paths]
    );
    return result.rows;
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

  async markFolderSyncStarted(
    folderId: string,
    options: SyncStateWriteOptions = {}
  ): Promise<void> {
    await runOptionalDeadlineWrite(
      this.pool,
      "UPDATE public.imap_folders SET status = 'SYNCING', last_progress_at = now() WHERE id = $1",
      [folderId],
      options
    );
  }

  // Spec §10.4: capture the SEARCH(since cutoff) snapshot at the start of an
  // initial sync. `oldestUidSynced` is set to `targetMaxUid + 1` as a sentinel
  // so the first downward batch picks up UIDs strictly less than it.
  async setInitialSyncSnapshot(
    folderId: string,
    targetMaxUid: number,
    oldestUidSynced: number,
    targetCount: number,
    expectedUidValidity: number,
    options: { deadlineAt?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    const query = `
      UPDATE public.imap_folders
      SET initial_sync_target_max_uid = $2,
          initial_sync_oldest_uid_synced = $3,
          live_window_target_count = $4,
          last_progress_at = now()
      WHERE id = $1
        AND (uidvalidity IS NULL OR uidvalidity = $5)
      RETURNING id
    `;
    const values = [folderId, targetMaxUid, oldestUidSynced, targetCount, expectedUidValidity];
    const result = options.deadlineAt === undefined
      ? await this.pool.query<{ id: string }>(query, values)
      : await runMetadataWriteWithDeadline<{ id: string }>(
          this.pool, query, values, options.deadlineAt, options.signal
        );
    if (result.rows.length !== 1) {
      throw new Error(`Initial sync snapshot lost folder generation ${folderId}`);
    }
  }

  async advanceInitialSyncWatermark(
    folderId: string,
    newOldestUidSynced: number,
    lastProgressUid: number,
    expectedUidValidity: number,
    options: { deadlineAt?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    const query = `
      UPDATE public.imap_folders
      SET initial_sync_oldest_uid_synced = $2,
          last_progress_at = now(),
          last_progress_uid = $3
      WHERE id = $1
        AND uidvalidity = $4
      RETURNING id
    `;
    const values = [folderId, newOldestUidSynced, lastProgressUid, expectedUidValidity];
    const result = options.deadlineAt === undefined
      ? await this.pool.query<{ id: string }>(query, values)
      : await runMetadataWriteWithDeadline<{ id: string }>(
          this.pool, query, values, options.deadlineAt, options.signal
        );
    if (result.rows.length !== 1) {
      throw new Error(`Initial sync watermark lost folder generation ${folderId}`);
    }
  }

  async advanceInitialSyncLiveHead(
    folderId: string,
    lastUid: number,
    expectedUidValidity: number,
    options: { deadlineAt?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    const query = `
      UPDATE public.imap_folders
      SET last_uid = GREATEST(COALESCE(last_uid, 0), $2),
          last_progress_at = now()
      WHERE id = $1
        AND uidvalidity = $3
      RETURNING id
    `;
    const values = [folderId, lastUid, expectedUidValidity];
    const result = options.deadlineAt === undefined
      ? await this.pool.query<{ id: string }>(query, values)
      : await runMetadataWriteWithDeadline<{ id: string }>(
          this.pool, query, values, options.deadlineAt, options.signal
        );
    if (result.rows.length !== 1) {
      throw new Error(`Initial sync live head lost folder generation ${folderId}`);
    }
  }

  async markFolderSynced(folderId: string, patch: {
    uidValidity: number;
    uidNext?: number;
    highestModseq?: string;
    qresyncHighestModseq?: string;
    lastUid?: number;
    initialComplete?: boolean;
    reconcileClean?: boolean;
    flagScanCompleted?: boolean;
  }, options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<void> {
    const query = `
      UPDATE public.imap_folders
      SET
        status = 'ACTIVE',
        uidvalidity = $2,
        uid_next = COALESCE($3, uid_next),
        highest_modseq = COALESCE($14::numeric, highest_modseq),
        qresync_highest_modseq = COALESCE($15::numeric, qresync_highest_modseq),
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
          -- A completed clean reconcile returns to the normal six-hour
          -- cadence. An incomplete bounded repair must retry on the next full
          -- sync cadence instead of pinning degraded health for six hours.
          WHEN $6::boolean = false
            THEN now() + ($13::bigint * interval '1 millisecond')
          WHEN $6::boolean = true
            THEN now()
              + ($10::bigint * interval '1 millisecond')
              + ((random() * 900000)::int * interval '1 millisecond')
          WHEN $5::boolean = true AND next_reconcile_at IS NULL
            THEN now() + ((random() * $10::double precision)::int * interval '1 millisecond')
          ELSE COALESCE(next_reconcile_at, now() + ((random() * $10::double precision)::int * interval '1 millisecond'))
        END
      WHERE id = $1
        AND (uidvalidity IS NULL OR uidvalidity = $2)
      RETURNING id
    `;
    const values = [
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
      this.config.SYNC_INTERVAL_MS,
      patch.highestModseq ?? null,
      patch.qresyncHighestModseq ?? null
    ];
    const result = options.deadlineAt === undefined
      ? await this.pool.query<{ id: string }>(query, values)
      : await runMetadataWriteWithDeadline<{ id: string }>(
          this.pool, query, values, options.deadlineAt, options.signal
        );
    if (result.rows.length !== 1) {
      throw new Error(`Folder sync state lost generation ${folderId}`);
    }
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
      const lockedFolder = await client.query<{
        uidvalidity: string | null;
        uidvalidity_reset_count: number;
      }>(
        `
        SELECT uidvalidity::text, uidvalidity_reset_count
        FROM public.imap_folders
        WHERE id = $1
          AND account_id = $2
        FOR UPDATE
        `,
        [folder.id, account.id]
      );
      const currentFolder = lockedFolder.rows[0];
      if (!currentFolder) throw new Error(`UIDVALIDITY reset lost folder ${folder.id}`);
      if (currentFolder.uidvalidity !== null
        && Number(currentFolder.uidvalidity) === newUidValidity) {
        await client.query("COMMIT");
        return { resetCountIn24h: currentFolder.uidvalidity_reset_count };
      }

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
            highest_modseq = NULL,
            qresync_highest_modseq = NULL,
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
      [accountId, diagnosticErrorCode(reason)]
    );
  }

  async upsertMessages(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    messages: MessageMetadata[],
    windowCutoff: Date,
    options: MetadataWriteOptions = {}
  ): Promise<ImapMessage[]> {
    if (messages.length === 0) return [];
    if (messages.length > MAX_SYNC_BATCH_SIZE) {
      throw new Error(
        `Metadata batch size ${messages.length} exceeds maximum ${MAX_SYNC_BATCH_SIZE}`
      );
    }
    const writeBatches = splitMetadataWriteBatches(messages);

    const uniqueUids = new Set(messages.map((message) => message.uid));
    if (uniqueUids.size !== messages.length) {
      throw new Error("Metadata batch contains duplicate UIDs");
    }
    for (const message of messages) {
      if (!Number.isSafeInteger(message.sizeBytes) || message.sizeBytes < 0) {
        throw new Error(`Metadata batch has invalid size for UID ${message.uid}`);
      }
      for (const attachment of message.attachments) {
        if (attachment.sizeBytes !== null
          && (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0)) {
          throw new Error(`Metadata batch has invalid attachment size for UID ${message.uid}`);
        }
      }
    }
    const deadlineAt = options.deadlineAt
      ?? Date.now() + (this.config.INCREMENTAL_TOTAL_TIMEOUT_MS ?? DEFAULT_METADATA_WRITE_TIMEOUT_MS);
    const client = await metadataWriteDeadline.connect(this.pool, deadlineAt, options.signal);
    const lease = bindClientAbort(client, options.signal);
    let discardClient = false;

    try {
      await metadataWriteDeadline.queryControl(client, "BEGIN", deadlineAt);
      await metadataWriteDeadline.refreshTimeout(client, deadlineAt);
      await queryWithDeadline(
        client,
        `INSERT INTO public.imap_thread_state (account_id)
         SELECT id FROM public.imap_accounts WHERE id = $1
         ON CONFLICT (account_id) DO NOTHING`,
        [accountId],
        deadlineAt,
        metadataWriteDeadline.remainingMs
      );
      const threadState = await queryWithDeadline<{ account_id: string }>(
        client,
        `SELECT account_id FROM public.imap_thread_state
         WHERE account_id = $1 FOR SHARE`,
        [accountId],
        deadlineAt,
        metadataWriteDeadline.remainingMs
      );
      if (!threadState.rows[0]) throw new Error(`Account not found: ${accountId}`);
      const lockedFolder = await queryWithDeadline<{ id: string; uidvalidity: string | null }>(
        client,
        `
        SELECT id, uidvalidity::text
        FROM public.imap_folders
        WHERE id = $1
          AND account_id = $2
          AND path = $3
        FOR UPDATE
        `,
        [folder.id, accountId, folder.path],
        deadlineAt,
        metadataWriteDeadline.remainingMs
      );
      if (lockedFolder.rows.length !== 1) {
        throw new Error(`Metadata batch lost folder ${folder.id}`);
      }
      const lockedUidValidity = lockedFolder.rows[0].uidvalidity;
      if (lockedUidValidity !== null && Number(lockedUidValidity) !== uidValidity) {
        throw new Error(
          `Metadata batch UIDVALIDITY ${uidValidity} no longer matches folder ${lockedUidValidity}`
        );
      }
      if (lockedUidValidity === null) {
        await metadataWriteDeadline.refreshTimeout(client, deadlineAt);
        const initialized = await queryWithDeadline<{ id: string }>(
          client,
          `
          UPDATE public.imap_folders
          SET uidvalidity = $2
          WHERE id = $1
            AND uidvalidity IS NULL
          RETURNING id
          `,
          [folder.id, uidValidity],
          deadlineAt,
          metadataWriteDeadline.remainingMs
        );
        if (initialized.rows.length !== 1) {
          throw new Error(`Metadata batch could not initialize UIDVALIDITY for folder ${folder.id}`);
        }
      }

      // Use a fresh READ COMMITTED statement after the folder lock is acquired.
      // Combining both reads into one SELECT can retain a pre-wait snapshot and
      // double-count an overlapping UID inserted by the transaction ahead of us.
      await metadataWriteDeadline.refreshTimeout(client, deadlineAt);
      const existing = await queryWithDeadline<ImapMessage & ProtectedMetadataColumns>(
        client,
        `
        SELECT *
        FROM public.imap_messages
        WHERE account_id = $1
          AND folder_path = $2
          AND uidvalidity = $3
          AND uid = ANY($4::bigint[])
        FOR UPDATE
        `,
        [accountId, folder.path, uidValidity, [...uniqueUids]],
        deadlineAt,
        metadataWriteDeadline.remainingMs
      );
      const existingUids = new Set(existing.rows.map((row) => Number(row.uid)));
      const revealedExisting = await Promise.all(
        existing.rows.map((row) => this.revealMessage(row))
      );
      const existingMessagesByUid = new Map(
        revealedExisting.map((row) => [Number(row.uid), row])
      );
      const messageIdsByUid = new Map(
        existing.rows.map((row) => [Number(row.uid), row.id])
      );
      for (const message of messages) {
        if (!messageIdsByUid.get(message.uid)) messageIdsByUid.set(message.uid, randomUUID());
      }

      const rowsByUid = new Map<number, ImapMessage>();
      for (const writeBatch of writeBatches) {
        const input = await Promise.all(writeBatch.map(async (message, ordinal) => {
          const messageId = messageIdsByUid.get(message.uid);
          if (!messageId) throw new Error(`Metadata batch lost message id for UID ${message.uid}`);
          const previous = existingMessagesByUid.get(message.uid);
          const protectedMessage = await this.protectMetadata(
            "message",
            accountId,
            messageId,
            {
              rfc_message_id: message.rfcMessageId ?? previous?.rfc_message_id ?? null,
              message_id_normalized:
                message.messageIdNormalized ?? previous?.message_id_normalized ?? null,
              provider_message_id: message.providerMessageId,
              provider_message_id_namespace: message.providerMessageIdNamespace,
              provider_thread_id: message.providerThreadId,
              provider_thread_id_namespace: message.providerThreadIdNamespace,
              in_reply_to: message.inReplyTo ?? previous?.in_reply_to ?? null,
              references_header:
                message.referencesHeader ?? previous?.references_header ?? null,
              subject: message.subject,
              from_email: message.fromEmail,
              from_name: message.fromName,
              to_emails: message.toEmails,
              to_names: message.toNames,
              cc_emails: message.ccEmails,
              cc_names: message.ccNames,
              bcc_emails: message.bccEmails,
              headers_json: message.headersJson,
              mime_structure: message.mimeStructure ?? null
            }
          );
          return {
            ordinal,
            id: messageId,
            uid: message.uid,
            ...protectedMessage.values,
            internal_date: message.internalDate.toISOString(),
            size_bytes: message.sizeBytes,
            flags: message.flags,
            window_status: message.internalDate < windowCutoff ? "HISTORICAL" : "IN_WINDOW",
            protected_metadata_base64:
              protectedMessage.columns.protected_metadata?.toString("base64") ?? null,
            protected_metadata_version:
              protectedMessage.columns.protected_metadata_version,
            protected_metadata_key_version:
              protectedMessage.columns.protected_metadata_key_version,
            protected_metadata_tokens:
              protectedMessage.columns.protected_metadata_tokens
          };
        }));
        await metadataWriteDeadline.refreshTimeout(client, deadlineAt);
        const result = await queryWithDeadline<ImapMessage & ProtectedMetadataColumns>(
          client,
          `
        WITH input AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb) AS message (
            ordinal integer,
            id uuid,
            uid bigint,
            rfc_message_id text,
            message_id_normalized text,
            provider_message_id text,
            provider_message_id_namespace text,
            provider_thread_id text,
            provider_thread_id_namespace text,
            in_reply_to text,
            references_header text,
            internal_date timestamptz,
            size_bytes bigint,
            subject text,
            from_email text,
            from_name text,
            to_emails text[],
            to_names text[],
            cc_emails text[],
            cc_names text[],
            bcc_emails text[],
            flags text[],
            headers_json jsonb,
            mime_structure jsonb,
            window_status text,
            protected_metadata_base64 text,
            protected_metadata_version smallint,
            protected_metadata_key_version integer,
            protected_metadata_tokens jsonb
          )
        )
        INSERT INTO public.imap_messages (
          id,
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
          window_status,
          protected_metadata,
          protected_metadata_version,
          protected_metadata_key_version,
          protected_metadata_tokens
        )
        SELECT
          input.id,
          $2::uuid,
          $3::uuid,
          $4::text,
          $5::bigint,
          input.uid,
          input.rfc_message_id,
          input.message_id_normalized,
          input.provider_message_id,
          input.provider_message_id_namespace,
          input.provider_thread_id,
          input.provider_thread_id_namespace,
          input.in_reply_to,
          input.references_header,
          input.internal_date,
          input.size_bytes,
          input.subject,
          input.from_email,
          input.from_name,
          input.to_emails,
          input.to_names,
          input.cc_emails,
          input.cc_names,
          input.bcc_emails,
          input.flags,
          input.headers_json,
          input.mime_structure,
          input.window_status,
          CASE
            WHEN input.protected_metadata_base64 IS NULL THEN NULL
            ELSE decode(input.protected_metadata_base64, 'base64')
          END,
          input.protected_metadata_version,
          input.protected_metadata_key_version,
          input.protected_metadata_tokens
        FROM input
        ORDER BY input.ordinal
        ON CONFLICT (account_id, folder_path, uidvalidity, uid)
        DO UPDATE SET
          folder_id = EXCLUDED.folder_id,
          rfc_message_id = EXCLUDED.rfc_message_id,
          message_id_normalized = EXCLUDED.message_id_normalized,
          provider_message_id = EXCLUDED.provider_message_id,
          provider_message_id_namespace = EXCLUDED.provider_message_id_namespace,
          provider_thread_id = EXCLUDED.provider_thread_id,
          provider_thread_id_namespace = EXCLUDED.provider_thread_id_namespace,
          in_reply_to = EXCLUDED.in_reply_to,
          references_header = EXCLUDED.references_header,
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
          flags = CASE WHEN $6::boolean THEN public.imap_messages.flags ELSE EXCLUDED.flags END,
          headers_json = EXCLUDED.headers_json,
          mime_structure = EXCLUDED.mime_structure,
          protected_metadata = EXCLUDED.protected_metadata,
          protected_metadata_version = EXCLUDED.protected_metadata_version,
          protected_metadata_key_version = EXCLUDED.protected_metadata_key_version,
          protected_metadata_tokens = EXCLUDED.protected_metadata_tokens,
          deleted_in_provider = false,
          provider_deleted_at = NULL,
          deleted_reason = NULL
        RETURNING *
        `,
          [
            JSON.stringify(input),
            accountId,
            folder.id,
            folder.path,
            uidValidity,
            options.preserveExistingFlags === true
          ],
          deadlineAt,
          metadataWriteDeadline.remainingMs
        );
        if (result.rows.length !== writeBatch.length) {
          throw new Error(
            `Metadata batch wrote ${result.rows.length}/${writeBatch.length} requested messages`
          );
        }
        const revealedRows = await Promise.all(
          result.rows.map((row) => this.revealMessage(row))
        );
        for (const row of revealedRows) rowsByUid.set(Number(row.uid), row);

        const attachmentSources = new Map<string, {
          message_id: string;
          filename: string | null;
          mime_type: string | null;
          size_bytes: number | null;
          part_number: string;
          content_id: string | null;
          disposition: "attachment" | "inline";
        }>();
        for (const message of writeBatch) {
          const row = rowsByUid.get(message.uid);
          if (!row) throw new Error(`Metadata batch lost message UID ${message.uid}`);
          for (const attachment of message.attachments) {
            attachmentSources.set(`${row.id}\u0000${attachment.partNumber}`, {
              message_id: row.id,
              filename: attachment.filename,
              mime_type: attachment.mimeType,
              size_bytes: attachment.sizeBytes,
              part_number: attachment.partNumber,
              content_id: attachment.contentId,
              disposition: attachment.disposition
            });
          }
        }
        const existingAttachments = attachmentSources.size === 0
          ? []
          : await queryWithDeadline<{ id: string; message_id: string; part_number: string }>(
            client,
            `
            SELECT id, message_id, part_number
            FROM public.imap_attachments
            WHERE message_id = ANY($1::uuid[])
            `,
            [[...new Set([...attachmentSources.values()].map((value) => value.message_id))]],
            deadlineAt,
            metadataWriteDeadline.remainingMs
          ).then((value) => value.rows);
        const attachmentIdsByIdentity = new Map(
          existingAttachments.map((row) => [
            `${row.message_id}\u0000${row.part_number}`,
            row.id
          ])
        );
        const attachmentsByIdentity = new Map<string, Record<string, unknown>>();
        for (const [identity, attachment] of attachmentSources) {
          const attachmentId = attachmentIdsByIdentity.get(identity) ?? randomUUID();
          const protectedAttachment = await this.protectMetadata(
            "attachment",
            accountId,
            attachmentId,
            {
              filename: attachment.filename,
              content_id: attachment.content_id
            }
          );
          attachmentsByIdentity.set(identity, {
            id: attachmentId,
            ...attachment,
            ...protectedAttachment.values,
            protected_metadata_base64:
              protectedAttachment.columns.protected_metadata?.toString("base64") ?? null,
            protected_metadata_version:
              protectedAttachment.columns.protected_metadata_version,
            protected_metadata_key_version:
              protectedAttachment.columns.protected_metadata_key_version,
            protected_metadata_tokens:
              protectedAttachment.columns.protected_metadata_tokens
          });
        }
        if (attachmentsByIdentity.size > 0) {
          await metadataWriteDeadline.refreshTimeout(client, deadlineAt);
          const attachmentResult = await queryWithDeadline<{ id: string }>(
            client,
            `
          WITH input AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS attachment (
              id uuid,
              message_id uuid,
              filename text,
              mime_type text,
              size_bytes bigint,
              part_number text,
              content_id text,
              disposition text,
              protected_metadata_base64 text,
              protected_metadata_version smallint,
              protected_metadata_key_version integer,
              protected_metadata_tokens jsonb
            )
          )
          INSERT INTO public.imap_attachments (
            id,
            message_id,
            filename,
            mime_type,
            size_bytes,
            part_number,
            content_id,
            disposition,
            protected_metadata,
            protected_metadata_version,
            protected_metadata_key_version,
            protected_metadata_tokens
          )
          SELECT
            input.id,
            input.message_id,
            input.filename,
            input.mime_type,
            input.size_bytes,
            input.part_number,
            input.content_id,
            input.disposition,
            CASE
              WHEN input.protected_metadata_base64 IS NULL THEN NULL
              ELSE decode(input.protected_metadata_base64, 'base64')
            END,
            input.protected_metadata_version,
            input.protected_metadata_key_version,
            input.protected_metadata_tokens
          FROM input
          ON CONFLICT (message_id, part_number)
          DO UPDATE SET
            filename = EXCLUDED.filename,
            mime_type = EXCLUDED.mime_type,
            size_bytes = EXCLUDED.size_bytes,
            content_id = EXCLUDED.content_id,
            disposition = EXCLUDED.disposition,
            protected_metadata = EXCLUDED.protected_metadata,
            protected_metadata_version = EXCLUDED.protected_metadata_version,
            protected_metadata_key_version = EXCLUDED.protected_metadata_key_version,
            protected_metadata_tokens = EXCLUDED.protected_metadata_tokens
          RETURNING id
          `,
            [JSON.stringify([...attachmentsByIdentity.values()])],
            deadlineAt,
            metadataWriteDeadline.remainingMs
          );
          if (attachmentResult.rows.length !== attachmentsByIdentity.size) {
            throw new Error(
              `Metadata batch wrote ${attachmentResult.rows.length}/${attachmentsByIdentity.size} attachments`
            );
          }
        }
      }
      const rows = messages.map((message) => {
        const row = rowsByUid.get(message.uid);
        if (!row) throw new Error(`Metadata batch lost message UID ${message.uid}`);
        return row;
      });
      const newMessageCount = messages.length - existingUids.size;
      if (newMessageCount > 0) {
        await metadataWriteDeadline.refreshTimeout(client, deadlineAt);
        const folderUpdate = await queryWithDeadline<{ id: string }>(
          client,
          `
          UPDATE public.imap_folders
          SET headers_synced_count = headers_synced_count + $2
          WHERE id = $1
          RETURNING id
          `,
          [folder.id, newMessageCount],
          deadlineAt,
          metadataWriteDeadline.remainingMs
        );
        if (folderUpdate.rows.length !== 1) {
          throw new Error(`Metadata batch lost folder ${folder.id}`);
        }
      }
      await metadataWriteDeadline.refreshTimeout(client, deadlineAt);
      // Once Postgres acknowledges COMMIT, the durable rows are authoritative even
      // if the JS event loop observes the wall clock just beyond the deadline.
      await metadataWriteDeadline.queryControl(client, "COMMIT", deadlineAt, false);
      return rows;
    } catch (error) {
      if (!lease.isReleased()) {
        const rollbackTimeout = Math.max(1, Math.min(1_000, deadlineAt - Date.now()));
        await client.query(deadlineQuery("ROLLBACK", rollbackTimeout)).catch(() => {
          discardClient = true;
        });
      }
      throw error;
    } finally {
      lease.release(discardClient);
    }
  }

  async applyFlagScan(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    messages: MessageMetadata[],
    windowCutoff: Date
  ): Promise<{ messages: ImapMessage[]; flagsChanged: number }>;
  async applyFlagScan(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    messages: MessageFlagSnapshot[],
    options?: { deadlineAt?: number; signal?: AbortSignal }
  ): Promise<{ messages: ImapMessage[]; flagsChanged: number }>;
  async applyFlagScan(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    messages: MessageFlagSnapshot[] | MessageMetadata[],
    options: Date | { deadlineAt?: number; signal?: AbortSignal } = {}
  ): Promise<{ messages: ImapMessage[]; flagsChanged: number }> {
    if (messages.length === 0) return { messages: [], flagsChanged: 0 };
    if (messages.length > MAX_SYNC_BATCH_SIZE) {
      throw new Error(
        `Flag scan batch size ${messages.length} exceeds maximum ${MAX_SYNC_BATCH_SIZE}`
      );
    }
    const writeBatches = splitFlagWriteBatches(messages);
    const uniqueUids = new Set(messages.map((message) => message.uid));
    if (uniqueUids.size !== messages.length) {
      throw new Error("Flag scan batch contains duplicate UIDs");
    }

    if (options instanceof Date) {
      // Preserve the exported pre-projection API: Date callers supplied complete
      // metadata and expected headers, MIME, and attachments to refresh too.
      const metadata = messages as MessageMetadata[];
      const uids = metadata.map((message) => message.uid);
      const boundedExisting = await this.pool.query<Pick<ImapMessage, "id" | "uid" | "flags"> & {
        stored_bytes: string;
        stored_flags: string;
      }>(
        `
        WITH candidates AS MATERIALIZED (
          SELECT id,
                 uid,
                 flags,
                 octet_length(to_json(flags)::text)::bigint AS flag_bytes,
                 cardinality(flags)::bigint AS flag_count
          FROM public.imap_messages
          WHERE account_id = $1
            AND folder_path = $2
            AND uidvalidity = $3
            AND uid = ANY($4::bigint[])
            AND deleted_in_provider = false
        ), totals AS (
          SELECT COALESCE(sum(flag_bytes), 0)::bigint AS stored_bytes,
                 COALESCE(sum(flag_count), 0)::bigint AS stored_flags
          FROM candidates
        )
        SELECT candidate.id,
               candidate.uid,
               candidate.flags,
               totals.stored_bytes::text,
               totals.stored_flags::text
        FROM totals
        LEFT JOIN candidates AS candidate
          ON totals.stored_bytes <= $5::bigint
         AND totals.stored_flags <= $6::bigint
        `,
        [
          accountId,
          folder.path,
          uidValidity,
          uids,
          MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES,
          MAX_SYNC_FLAGS_PER_EVENT_LOGICAL_BATCH
        ]
      );
      const storedBytes = Number(boundedExisting.rows[0]?.stored_bytes ?? 0);
      const storedFlags = Number(boundedExisting.rows[0]?.stored_flags ?? 0);
      if (storedBytes > MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES
        || storedFlags > MAX_SYNC_FLAGS_PER_EVENT_LOGICAL_BATCH) {
        throw new Error("Stored flags exceed the aggregate logical event limit");
      }
      const existing = boundedExisting.rows.filter(
        (row): row is typeof row & { id: string } => typeof row.id === "string"
      );
      const existingByUid = new Map(existing.map((row) => [Number(row.uid), row]));
      const knownMessages = metadata.filter((message) => existingByUid.has(message.uid));
      const changed = metadata
        .map((message) => {
          const row = existingByUid.get(message.uid);
          if (!row) return null;
          assertFlagEventSideWithinLimits(message.uid, row.flags ?? []);
          if (flagsEqual(row.flags, message.flags)) return null;
          return {
            row,
            message,
            previousFlags: normalizeFlags(row.flags),
            nextFlags: normalizeFlags(message.flags)
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      const rows = await this.upsertMessages(
        accountId,
        folder,
        uidValidity,
        knownMessages,
        options
      );
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

    const uids = messages.map((message) => message.uid);
    const deadlineAt = options.deadlineAt
      ?? Date.now() + this.config.FLAG_SCAN_TOTAL_TIMEOUT_MS;
    const client = await flagScanDeadline.connect(this.pool, deadlineAt, options.signal);
    const lease = bindClientAbort(client, options.signal);
    let discardClient = false;

    try {
      await flagScanDeadline.queryControl(client, "BEGIN", deadlineAt);
      await flagScanDeadline.refreshTimeout(client, deadlineAt);

      // Lock and size the stored side before selecting any flag arrays into the
      // worker. Legacy rows may individually satisfy the per-message limit but
      // collectively exceed the transaction budget; materializing them first
      // defeats the memory bound this guard is meant to provide.
      const storedFootprint = await queryWithDeadline<{
        stored_bytes: string;
        stored_flags: string;
      }>(
        client,
        `
        WITH locked AS MATERIALIZED (
          SELECT octet_length(to_json(flags)::text)::bigint AS flag_bytes,
                 cardinality(flags)::bigint AS flag_count
          FROM public.imap_messages
          WHERE account_id = $1
            AND folder_path = $2
            AND uidvalidity = $3
            AND uid = ANY($4::bigint[])
            AND deleted_in_provider = false
          FOR UPDATE
        )
        SELECT COALESCE(sum(flag_bytes), 0)::text AS stored_bytes,
               COALESCE(sum(flag_count), 0)::text AS stored_flags
        FROM locked
        `,
        [accountId, folder.path, uidValidity, uids],
        deadlineAt,
        flagScanDeadline.remainingMs
      );
      const storedBytes = Number(storedFootprint.rows[0]?.stored_bytes ?? 0);
      const storedFlags = Number(storedFootprint.rows[0]?.stored_flags ?? 0);
      if (storedBytes > MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES
        || storedFlags > MAX_SYNC_FLAGS_PER_EVENT_LOGICAL_BATCH) {
        throw new Error("Stored flags exceed the aggregate logical event limit");
      }

      await flagScanDeadline.refreshTimeout(client, deadlineAt);
      const existing = await queryWithDeadline<ImapMessage>(
        client,
        `
        SELECT *
        FROM public.imap_messages
        WHERE account_id = $1
          AND folder_path = $2
          AND uidvalidity = $3
          AND uid = ANY($4::bigint[])
          AND deleted_in_provider = false
        FOR UPDATE
        `,
        [accountId, folder.path, uidValidity, uids],
        deadlineAt,
        flagScanDeadline.remainingMs
      );
      const existingByUid = new Map(existing.rows.map((row) => [Number(row.uid), row]));
      const updatedByUid = new Map<number, ImapMessage>();
      const changed = messages
        .map((message) => {
          const row = existingByUid.get(message.uid);
          if (!row) return null;
          assertFlagEventSideWithinLimits(message.uid, row.flags ?? []);
          if (flagRepresentationsEqual(row.flags, message.flags)) return null;
          const semanticallyChanged = !flagsEqual(row.flags, message.flags);
          return {
            row,
            message,
            semanticallyChanged,
            previousFlags: semanticallyChanged ? normalizeFlags(row.flags) : [],
            nextFlags: semanticallyChanged ? normalizeFlags(message.flags) : []
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const changedByUid = new Map(changed.map((entry) => [entry.message.uid, entry]));

      if (changed.length > 0) {
        for (const writeBatch of writeBatches) {
          const changedBatch = writeBatch
            .map((message) => changedByUid.get(message.uid))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
          if (changedBatch.length === 0) continue;

          await flagScanDeadline.refreshTimeout(client, deadlineAt);
          const updated = await queryWithDeadline<ImapMessage>(
            client,
            `
          WITH input AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS changed_flag (
              id uuid,
              flags text[]
            )
          )
          UPDATE public.imap_messages AS message
          SET flags = input.flags
          FROM input
          WHERE message.id = input.id
          RETURNING message.*
          `,
            [JSON.stringify(changedBatch.map(({ row, message }) => ({
              id: row.id,
              flags: message.flags
            })))],
            deadlineAt,
            flagScanDeadline.remainingMs
          );
          if (updated.rows.length !== changedBatch.length) {
            throw new Error(
              `Flag scan updated ${updated.rows.length}/${changedBatch.length} changed messages`
            );
          }
          for (const row of updated.rows) {
            updatedByUid.set(Number(row.uid), row);
          }
        }

        const semanticChanges = changed.filter((entry) => entry.semanticallyChanged);
        if (semanticChanges.length > 0) {
          let eventsWritten = 0;
          for (const eventBatch of splitFlagEventBatches(semanticChanges)) {
            await flagScanDeadline.refreshTimeout(client, deadlineAt);
            const events = await queryWithDeadline<{ id: string }>(
              client,
              `
            WITH input AS (
              SELECT *
              FROM jsonb_to_recordset($1::jsonb) AS changed_flag (
                message_id uuid,
                uid bigint,
                previous_flags text[],
                next_flags text[]
              )
            )
            INSERT INTO public.imap_sync_events (
              account_id,
              sync_run_id,
              message_id,
              folder_path,
              provider_uid,
              event_type,
              payload
            )
            SELECT
              $2,
              NULL,
              input.message_id,
              $3,
              input.uid,
              'FLAGS_CHANGED',
              jsonb_build_object(
                'previousFlags', input.previous_flags,
                'nextFlags', input.next_flags
              )
            FROM input
            RETURNING id
            `,
              [
                JSON.stringify(eventBatch.map(({ row, message, previousFlags, nextFlags }) => ({
                  message_id: row.id,
                  uid: message.uid,
                  previous_flags: previousFlags,
                  next_flags: nextFlags
                }))),
                accountId,
                folder.path,
              ],
              deadlineAt,
              flagScanDeadline.remainingMs
            );
            if (events.rows.length !== eventBatch.length) {
              throw new Error(
                `Flag scan logged ${events.rows.length}/${eventBatch.length} semantic changes`
              );
            }
            eventsWritten += events.rows.length;
          }
          if (eventsWritten !== semanticChanges.length) {
            throw new Error(
              `Flag scan logged ${eventsWritten}/${semanticChanges.length} semantic changes`
            );
          }
        }
      }

      await flagScanDeadline.refreshTimeout(client, deadlineAt);
      await flagScanDeadline.queryControl(client, "COMMIT", deadlineAt, false);
      return {
        messages: messages
          .map((message) => updatedByUid.get(message.uid) ?? existingByUid.get(message.uid))
          .filter((message): message is ImapMessage => message !== undefined),
        flagsChanged: changed.filter((entry) => entry.semanticallyChanged).length
      };
    } catch (error) {
      if (!lease.isReleased()) {
        const rollbackTimeout = Math.max(1, Math.min(1_000, deadlineAt - Date.now()));
        await client.query(deadlineQuery("ROLLBACK", rollbackTimeout)).catch(() => {
          discardClient = true;
        });
      }
      throw error;
    } finally {
      lease.release(discardClient);
    }
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

  async markVanishedMessages(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    vanishedUids: number[],
    options: { deadlineAt?: number; signal?: AbortSignal } = {}
  ): Promise<number> {
    const uniqueUids = [...new Set(vanishedUids)];
    if (uniqueUids.length === 0) return 0;
    if (uniqueUids.length > MAX_SYNC_BATCH_SIZE
      || uniqueUids.some((uid) => !Number.isSafeInteger(uid) || uid <= 0)) {
      throw new Error("QRESYNC VANISHED batch is invalid or exceeds the sync batch limit");
    }
    const query = `
      WITH marked AS (
        UPDATE public.imap_messages
        SET deleted_in_provider = true,
            provider_deleted_at = now(),
            deleted_reason = 'RECONCILE_MISSING'
        WHERE account_id = $1
          AND folder_path = $2
          AND uidvalidity = $3
          AND uid = ANY($4::bigint[])
          AND deleted_in_provider = false
          AND window_status = 'IN_WINDOW'
        RETURNING id
      )
      SELECT count(*)::text AS count FROM marked
    `;
    const values = [accountId, folder.path, uidValidity, uniqueUids];
    const result = options.deadlineAt === undefined
      ? await this.pool.query<{ count: string }>(query, values)
      : await runMetadataWriteWithDeadline<{ count: string }>(
          this.pool, query, values, options.deadlineAt, options.signal
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
  // heavy mailboxes routinely surface 100k+ UIDs. Provider iteration and
  // staging are intentionally outside the final mutation transaction so a slow
  // IMAP stream cannot leave Postgres idle in transaction.
  async markMissingMessagesFromLiveUidStream(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    liveUids: AsyncIterable<number>,
    options: {
      failIfEmpty?: boolean;
      emptyError?: string;
      batchSize?: number;
      findMissingInDb?: boolean;
      progress?: { providerUidsSeen: number };
    } = {}
  ): Promise<{
    markedCount: number;
    liveUidCount: number;
    missingInDbUids: number[];
    missingInDbTruncated: boolean;
  }> {
    const batchSize = options.batchSize ?? 10_000;
    const client = await this.pool.connect();
    const batch: number[] = [];
    let liveUidCount = 0;
    let inTransaction = false;
    let discardClient = false;

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

    try {
      await client.query("DROP TABLE IF EXISTS pg_temp.supamail_live_uids");
      await client.query(
        "CREATE TEMP TABLE supamail_live_uids (uid bigint PRIMARY KEY) ON COMMIT PRESERVE ROWS"
      );

      for await (const uid of liveUids) {
        liveUidCount += 1;
        if (options.progress) options.progress.providerUidsSeen += 1;
        batch.push(uid);
        if (batch.length >= batchSize) await flush();
      }
      await flush();

      if (liveUidCount === 0 && options.failIfEmpty) {
        throw new Error(options.emptyError ?? `Reconcile returned no UIDs for non-empty mailbox ${folder.path}`);
      }

      await client.query("BEGIN");
      inTransaction = true;
      const generation = await client.query<{ uidvalidity: string | null }>(
        `SELECT uidvalidity::text AS uidvalidity
           FROM public.imap_folders
          WHERE id = $1 AND account_id = $2
          FOR SHARE`,
        [folder.id, accountId]
      );
      if (Number(generation.rows[0]?.uidvalidity) !== uidValidity) {
        throw new Error(`Reconcile lost folder generation ${folder.id}`);
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
          AND $5::boolean
        ORDER BY live.uid DESC
        LIMIT $4
        `,
        [
          accountId,
          folder.path,
          uidValidity,
          RECONCILE_MISSING_UID_LIMIT + 1,
          options.findMissingInDb !== false
        ]
      );

      await client.query("COMMIT");
      inTransaction = false;
      return {
        markedCount: Number(markedResult.rows[0].count),
        liveUidCount,
        missingInDbUids: missingResult.rows
          .slice(0, RECONCILE_MISSING_UID_LIMIT)
          .map((row) => Number(row.uid)),
        missingInDbTruncated: missingResult.rows.length > RECONCILE_MISSING_UID_LIMIT
      };
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK").catch(() => {
          discardClient = true;
        });
        inTransaction = false;
      }
      throw error;
    } finally {
      if (!discardClient) {
        await client.query("DROP TABLE IF EXISTS pg_temp.supamail_live_uids").catch(() => {
          discardClient = true;
        });
      }
      client.release(discardClient);
    }
  }

  async getMessage(id: string): Promise<ImapMessage | null> {
    const result = await this.pool.query<ImapMessage & ProtectedMetadataColumns>(
      "SELECT * FROM public.imap_messages WHERE id = $1",
      [id]
    );
    return result.rows[0] ? await this.revealMessage(result.rows[0]) : null;
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

  /** Backward-compatible convenience for callers that use the OSS database store directly. */
  async storeBody(body: MessageBodyInput): Promise<void> {
    await this.storeBodyEvidence(body);
    await this.storeBodyPayload(body);
    await this.completeBodyStorage(body.messageId);
  }

  /**
   * Commit every search/threading input before any body-store implementation
   * receives the full payload.
   */
  async storeBodyEvidence(body: MessageBodyInput): Promise<void> {
    await this.storeBodyEvidenceTransaction([body]);
  }

  /** Commit a bounded body-fetch batch atomically with one database transaction. */
  async storeBodyEvidenceBatch(bodies: readonly MessageBodyInput[]): Promise<void> {
    if (bodies.length === 0) return;
    if (bodies.length > PARSED_BODY_BATCH_MAX_MESSAGES) {
      throw new Error(
        `Body evidence batch exceeds ${PARSED_BODY_BATCH_MAX_MESSAGES} messages`
      );
    }
    let totalSourceBytes = 0;
    for (const body of bodies) {
      if (!Number.isSafeInteger(body.rawBytes)
        || body.rawBytes < 0
        || body.rawBytes > PARSED_BODY_BATCH_MAX_SOURCE_BYTES) {
        throw new Error(
          `Body evidence for ${body.messageId} exceeds the parsed batch source limit`
        );
      }
      totalSourceBytes += body.rawBytes;
    }
    if (totalSourceBytes > PARSED_BODY_BATCH_MAX_TOTAL_SOURCE_BYTES) {
      throw new Error("Body evidence batch exceeds the aggregate source limit");
    }
    await this.storeBodyEvidenceTransaction(bodies);
  }

  private async storeBodyEvidenceTransaction(
    bodies: readonly MessageBodyInput[]
  ): Promise<void> {
    const messageIds = bodies.map((body) => body.messageId);
    if (new Set(messageIds).size !== messageIds.length) {
      throw new Error("Body evidence batch contains duplicate message ids");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owners = await client.query<{ id: string; account_id: string }>(
        `SELECT id::text, account_id::text
         FROM public.imap_messages
         WHERE id = ANY($1::uuid[])`,
        [messageIds]
      );
      if (owners.rows.length !== messageIds.length) {
        throw new Error("Message not found for batched body storage");
      }
      const ownerAccountIds = new Set(owners.rows.map((row) => row.account_id));
      if (ownerAccountIds.size !== 1) {
        throw new Error("Body evidence batch must belong to one IMAP account");
      }
      const ownerAccountId = owners.rows[0].account_id;
      await this.lockThreadStateForMirrorWrite(client, ownerAccountId);
      for (const body of bodies) {
        await this.storeBodyEvidenceInTransaction(client, body, ownerAccountId);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async storeBodyEvidenceInTransaction(
    client: PgClient,
    body: MessageBodyInput,
    ownerAccountId: string
  ): Promise<void> {
    const preparedEvidence = body.rawTruncated ? [] : prepareMessageEvidence(body);
    const structuredEvidenceComplete = !body.rawTruncated
      && !body.parserWarnings.includes("artifact_evidence_truncated");
    const structuredEvidenceSha256 = !structuredEvidenceComplete
      ? null
      : createHash("sha256")
        .update(canonicalJsonForThreadingEvidence(preparedEvidence))
        .digest("hex");
      const target = await client.query<
        ImapMessage & ProtectedMetadataColumns & {
        body_raw_mime_sha256: string | null;
        body_message_id: string | null;
        body_parsed_delivery_sha256: string | null;
        body_authored_delivery_sha256: string | null;
        raw_mime_sha256?: string | null;
        parsed_delivery_sha256?: string | null;
        authored_delivery_sha256?: string | null;
        body_headers_json: Record<string, unknown> | null;
        body_mime_structure: unknown;
        body_parser_warnings: string[] | null;
        body_structured_evidence_sha256: string | null;
        body_threading_payload_sha256: string | null;
        body_search_extract: string | null;
        body_protected_metadata: Buffer | null;
        body_protected_metadata_version: number | null;
        body_protected_metadata_key_version: number | null;
        body_protected_metadata_tokens: Record<string, string> | null;
      }>(
        `
        SELECT m.*,
               b.message_id AS body_message_id,
               b.raw_mime_sha256 AS body_raw_mime_sha256,
               b.parsed_delivery_sha256 AS body_parsed_delivery_sha256,
               b.authored_delivery_sha256 AS body_authored_delivery_sha256,
               b.headers_json AS body_headers_json,
               b.mime_structure AS body_mime_structure,
               b.parser_warnings AS body_parser_warnings,
               b.structured_evidence_sha256 AS body_structured_evidence_sha256,
               b.threading_payload_sha256 AS body_threading_payload_sha256,
               b.search_extract AS body_search_extract,
               b.protected_metadata AS body_protected_metadata,
               b.protected_metadata_version AS body_protected_metadata_version,
               b.protected_metadata_key_version AS body_protected_metadata_key_version,
               b.protected_metadata_tokens AS body_protected_metadata_tokens
        FROM public.imap_messages m
        LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
        WHERE m.id = $1 FOR UPDATE OF m
        `,
        [body.messageId]
      );
      const storedMessage = target.rows[0];
      if (!storedMessage) throw new Error(`Message not found for body storage: ${body.messageId}`);
      const message = await this.revealMessage(storedMessage);
      const storedBodyValues = {
        raw_mime_sha256: storedMessage.body_raw_mime_sha256,
        parsed_delivery_sha256: storedMessage.body_parsed_delivery_sha256,
        authored_delivery_sha256: storedMessage.body_authored_delivery_sha256,
        headers_json: storedMessage.body_headers_json ?? {},
        mime_structure: storedMessage.body_mime_structure,
        parser_warnings: storedMessage.body_parser_warnings ?? [],
        structured_evidence_sha256: storedMessage.body_structured_evidence_sha256,
        threading_payload_sha256: storedMessage.body_threading_payload_sha256,
        search_extract: storedMessage.body_search_extract
      };
      const revealedBody = storedMessage.body_message_id === null
        ? storedBodyValues
        : await this.metadataProtection.reveal(
          {
            kind: "message_body",
            accountId: ownerAccountId,
            recordId: body.messageId
          },
          storedMetadataProjection(
            {
              protected_metadata: storedMessage.body_protected_metadata,
              protected_metadata_version: storedMessage.body_protected_metadata_version,
              protected_metadata_key_version: storedMessage.body_protected_metadata_key_version,
              protected_metadata_tokens: storedMessage.body_protected_metadata_tokens
            },
            storedBodyValues
          )
        );
      assertRevealedMetadataValues(revealedBody, MESSAGE_BODY_PROTECTED_FIELDS);

      const recoveredHeaders: Record<string, unknown> = {};
      for (const key of THREADING_BODY_HEADER_KEYS) {
        const value = body.headersJson[key];
        if (value !== undefined && message.headers_json[key] === undefined) recoveredHeaders[key] = value;
      }
      const recoveredMessageId = message.rfc_message_id ? null : headerText(body.headersJson["message-id"]);
      const recoveredInReplyTo = message.in_reply_to ? null : headerText(body.headersJson["in-reply-to"]);
      const recoveredReferences = message.references_header ? null : headerText(body.headersJson.references);
      const learnedThreadingEvidence = Boolean(
        recoveredMessageId || recoveredInReplyTo || recoveredReferences || Object.keys(recoveredHeaders).length > 0
      );
      const rawMimeSha256 = body.rawTruncated
        ? null
        : body.rawMimeSha256 === undefined
          ? createHash("sha256").update(body.rawMime).digest("hex")
          : body.rawMimeSha256;
      const payloadSha256 = threadingPayloadSha256(body);
      const hasThreadingEnvelope = hasBodyThreadingEnvelope(message, body, payloadSha256);
      const digests = await client.query<{
        parsed_delivery_sha256: string | null;
        authored_delivery_sha256: string | null;
      }>(
        `SELECT
           CASE WHEN $13::boolean
             THEN encode(extensions.digest(convert_to(jsonb_build_object(
               'subject', $1::text,
               'from_email', $2::text,
               'to_emails', $3::text[],
               'cc_emails', $4::text[],
               'bcc_emails', $5::text[],
               'size_bytes', $6::bigint,
               'raw_bytes', $7::bigint,
               'threading_payload_sha256', $8::text,
               'headers_json', $9::jsonb,
               'mime_structure', $10::jsonb,
               'parser_warnings', $11::text[]
             )::text, 'UTF8'), 'sha256'), 'hex')
             ELSE NULL
           END AS parsed_delivery_sha256,
           CASE WHEN $14::boolean
             THEN encode(extensions.digest(convert_to(jsonb_build_object(
               'message_id', $9::jsonb -> 'message-id',
               'date', $9::jsonb -> 'date',
               'subject', $1::text,
               'from_email', $2::text,
               'to_emails', $3::text[],
               'cc_emails', $4::text[],
               'bcc_emails', $5::text[],
               'threading_payload_sha256', $8::text,
               'content_type', $9::jsonb -> 'content-type',
               'content_transfer_encoding', $9::jsonb -> 'content-transfer-encoding',
               'mime_version', $9::jsonb -> 'mime-version',
               'mime_structure', $10::jsonb,
               'parser_warnings', $11::text[],
               'structured_evidence_sha256', $12::text
             )::text, 'UTF8'), 'sha256'), 'hex')
             ELSE NULL
           END AS authored_delivery_sha256`,
        [
          message.subject,
          message.from_email,
          message.to_emails,
          message.cc_emails,
          message.bcc_emails,
          message.size_bytes,
          body.rawBytes,
          payloadSha256,
          JSON.stringify(body.headersJson),
          JSON.stringify(body.mimeStructure),
          body.parserWarnings,
          structuredEvidenceSha256,
          !body.rawTruncated && rawMimeSha256 === null && hasThreadingEnvelope,
          !body.rawTruncated
            && hasThreadingEnvelope
            && body.headersJson.date !== undefined
            && body.mimeStructure !== null
            && structuredEvidenceComplete
            && structuredEvidenceSha256 !== null
        ]
      );
      const parsedSha256 = digests.rows[0]?.parsed_delivery_sha256 ?? null;
      const authoredSha256 = digests.rows[0]?.authored_delivery_sha256 ?? null;
      const learnedDeliveryEvidence = rawMimeSha256 !== revealedBody.raw_mime_sha256
        || parsedSha256 !== revealedBody.parsed_delivery_sha256
        || authoredSha256 !== revealedBody.authored_delivery_sha256;
      const bodyHeadersChanged = canonicalJsonForThreadingEvidence(revealedBody.headers_json ?? {})
        !== canonicalJsonForThreadingEvidence(body.headersJson);

      if (learnedThreadingEvidence) {
        const nextMessageValues = {
          ...selectMetadataValues(message, MESSAGE_PROTECTED_FIELDS),
          rfc_message_id: message.rfc_message_id ?? recoveredMessageId,
          message_id_normalized:
            message.message_id_normalized ?? normalizeMessageId(recoveredMessageId),
          in_reply_to: message.in_reply_to ?? recoveredInReplyTo,
          references_header: message.references_header ?? recoveredReferences,
          headers_json: { ...message.headers_json, ...recoveredHeaders }
        };
        const protectedMessage = await this.protectMetadata(
          "message",
          ownerAccountId,
          body.messageId,
          nextMessageValues
        );
        const messageWrite = {
          ...protectedMessage.values,
          protected_metadata_base64:
            protectedMessage.columns.protected_metadata?.toString("base64") ?? null,
          protected_metadata_version:
            protectedMessage.columns.protected_metadata_version,
          protected_metadata_key_version:
            protectedMessage.columns.protected_metadata_key_version,
          protected_metadata_tokens:
            protectedMessage.columns.protected_metadata_tokens
        };
        await client.query(
          `
          WITH input AS (
            SELECT *
            FROM jsonb_to_record($2::jsonb) AS value (
              rfc_message_id text,
              message_id_normalized text,
              provider_message_id text,
              provider_message_id_namespace text,
              provider_thread_id text,
              provider_thread_id_namespace text,
              in_reply_to text,
              references_header text,
              subject text,
              from_email text,
              from_name text,
              to_emails text[],
              to_names text[],
              cc_emails text[],
              cc_names text[],
              bcc_emails text[],
              headers_json jsonb,
              mime_structure jsonb,
              protected_metadata_base64 text,
              protected_metadata_version smallint,
              protected_metadata_key_version integer,
              protected_metadata_tokens jsonb
            )
          )
          UPDATE public.imap_messages SET
            rfc_message_id = input.rfc_message_id,
            message_id_normalized = input.message_id_normalized,
            provider_message_id = input.provider_message_id,
            provider_message_id_namespace = input.provider_message_id_namespace,
            provider_thread_id = input.provider_thread_id,
            provider_thread_id_namespace = input.provider_thread_id_namespace,
            in_reply_to = input.in_reply_to,
            references_header = input.references_header,
            subject = input.subject,
            from_email = input.from_email,
            from_name = input.from_name,
            to_emails = input.to_emails,
            to_names = input.to_names,
            cc_emails = input.cc_emails,
            cc_names = input.cc_names,
            bcc_emails = input.bcc_emails,
            headers_json = input.headers_json,
            mime_structure = input.mime_structure,
            protected_metadata = CASE
              WHEN input.protected_metadata_base64 IS NULL THEN NULL
              ELSE decode(input.protected_metadata_base64, 'base64')
            END,
            protected_metadata_version = input.protected_metadata_version,
            protected_metadata_key_version = input.protected_metadata_key_version,
            protected_metadata_tokens = input.protected_metadata_tokens
          FROM input
          WHERE public.imap_messages.id = $1
          `,
          [body.messageId, JSON.stringify(messageWrite)]
        );
      }

      const protectedBody = await this.protectMetadata(
        "message_body",
        ownerAccountId,
        body.messageId,
        {
          raw_mime_sha256: rawMimeSha256,
          parsed_delivery_sha256: parsedSha256,
          authored_delivery_sha256: authoredSha256,
          headers_json: body.headersJson,
          mime_structure: body.mimeStructure ?? null,
          parser_warnings: body.parserWarnings,
          structured_evidence_sha256: structuredEvidenceSha256,
          threading_payload_sha256: payloadSha256,
          search_extract: buildSearchExtract(body.bodyText)
        }
      );
      const protectedBodyColumns = protectedBody.columns;
      await client.query(
        `
        INSERT INTO public.imap_message_bodies (
          message_id,
          raw_mime,
          raw_mime_sha256,
          parsed_delivery_sha256,
          authored_delivery_sha256,
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
          structured_evidence_extractor_version,
          structured_evidence_sha256,
          structured_evidence_complete,
          structured_evidence_extracted_at,
          threading_payload_sha256,
          search_extract,
          protected_metadata,
          protected_metadata_version,
          protected_metadata_key_version,
          protected_metadata_tokens,
          fetched_at,
          created_at,
          updated_at
        )
        VALUES (
          $1, NULL, $2, $3, $4, $5, $6, NULL, NULL, NULL, NULL, NULL,
          $7, $8, $9, $10, $11, $12, now(), $13, $14,
          $15, $16, $17, $18, now(), now(), now()
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          raw_mime_sha256 = EXCLUDED.raw_mime_sha256,
          parsed_delivery_sha256 = EXCLUDED.parsed_delivery_sha256,
          authored_delivery_sha256 = EXCLUDED.authored_delivery_sha256,
          raw_bytes = EXCLUDED.raw_bytes,
          raw_truncated = EXCLUDED.raw_truncated,
          headers_json = EXCLUDED.headers_json,
          mime_structure = EXCLUDED.mime_structure,
          parser_warnings = EXCLUDED.parser_warnings,
          structured_evidence_extractor_version = EXCLUDED.structured_evidence_extractor_version,
          structured_evidence_sha256 = EXCLUDED.structured_evidence_sha256,
          structured_evidence_complete = EXCLUDED.structured_evidence_complete,
          structured_evidence_extracted_at = EXCLUDED.structured_evidence_extracted_at,
          threading_payload_sha256 = EXCLUDED.threading_payload_sha256,
          search_extract = EXCLUDED.search_extract,
          protected_metadata = EXCLUDED.protected_metadata,
          protected_metadata_version = EXCLUDED.protected_metadata_version,
          protected_metadata_key_version = EXCLUDED.protected_metadata_key_version,
          protected_metadata_tokens = EXCLUDED.protected_metadata_tokens,
          fetched_at = now(),
          updated_at = now()
        `,
        [
          body.messageId,
          protectedBody.values.raw_mime_sha256,
          protectedBody.values.parsed_delivery_sha256,
          protectedBody.values.authored_delivery_sha256,
          body.rawBytes,
          body.rawTruncated,
          JSON.stringify(protectedBody.values.headers_json),
          JSON.stringify(protectedBody.values.mime_structure ?? null),
          protectedBody.values.parser_warnings,
          MIME_EVIDENCE_EXTRACTOR_VERSION,
          protectedBody.values.structured_evidence_sha256,
          structuredEvidenceComplete,
          protectedBody.values.threading_payload_sha256,
          protectedBody.values.search_extract,
          protectedBodyColumns.protected_metadata,
          protectedBodyColumns.protected_metadata_version,
          protectedBodyColumns.protected_metadata_key_version,
          protectedBodyColumns.protected_metadata_tokens
        ]
      );

      if (!body.rawTruncated) {
        const existingEvidenceByIdentity = new Map<string, string>();
        if (preparedEvidence.length > 0) {
          const existingEvidence = await client.query<{
            id: string;
            message_id: string;
            extractor: string;
            kind: string;
            namespace: string;
            evidence_key: string;
            evidence_key_sha256: string;
            metadata: Record<string, unknown>;
          } & ProtectedMetadataColumns>(
            `
            SELECT id, message_id, extractor, kind, namespace,
                   evidence_key, evidence_key_sha256, metadata,
                   protected_metadata, protected_metadata_version,
                   protected_metadata_key_version, protected_metadata_tokens
            FROM public.imap_message_evidence
            WHERE message_id = $1 AND extractor = $2
            `,
            [body.messageId, MIME_EVIDENCE_EXTRACTOR]
          );
          for (const row of existingEvidence.rows) {
            const revealed = await this.revealMetadata(
              row,
              "message_evidence",
              ownerAccountId,
              row.id,
              ["evidence_key", "evidence_key_sha256", "metadata"]
            );
            existingEvidenceByIdentity.set(
              `${revealed.kind}\u0000${revealed.namespace}\u0000${revealed.evidence_key_sha256}`,
              row.id
            );
          }
        }
        const protectedEvidence = await Promise.all(preparedEvidence.map(async (evidence) => {
          const identity =
            `${evidence.kind}\u0000${evidence.namespace}\u0000${evidence.evidence_key_sha256}`;
          const evidenceId = existingEvidenceByIdentity.get(identity) ?? randomUUID();
          const projection = await this.protectMetadata(
            "message_evidence",
            ownerAccountId,
            evidenceId,
            {
              evidence_key: evidence.evidence_key,
              evidence_key_sha256: evidence.evidence_key_sha256,
              metadata: evidence.metadata
            }
          );
          return {
            id: evidenceId,
            ...evidence,
            ...projection.values,
            protected_metadata_base64:
              projection.columns.protected_metadata?.toString("base64") ?? null,
            protected_metadata_version:
              projection.columns.protected_metadata_version,
            protected_metadata_key_version:
              projection.columns.protected_metadata_key_version,
            protected_metadata_tokens:
              projection.columns.protected_metadata_tokens
          };
        }));
        if (protectedEvidence.length > 0) {
          await client.query(
            `
            INSERT INTO public.imap_message_evidence (
              id,
              message_id,
              extractor,
              extractor_version,
              kind,
              namespace,
              evidence_key,
              evidence_key_sha256,
              metadata,
              protected_metadata,
              protected_metadata_version,
              protected_metadata_key_version,
              protected_metadata_tokens,
              created_at,
              updated_at
            )
            SELECT
              input.id,
              input.message_id,
              input.extractor,
              input.extractor_version,
              input.kind,
              input.namespace,
              input.evidence_key,
              input.evidence_key_sha256,
              input.metadata,
              CASE
                WHEN input.protected_metadata_base64 IS NULL THEN NULL
                ELSE decode(input.protected_metadata_base64, 'base64')
              END,
              input.protected_metadata_version,
              input.protected_metadata_key_version,
              input.protected_metadata_tokens,
              now(),
              now()
            FROM jsonb_to_recordset($1::jsonb) AS input (
              id uuid,
              message_id uuid,
              extractor text,
              extractor_version text,
              kind text,
              namespace text,
              evidence_key text,
              evidence_key_sha256 text,
              metadata jsonb,
              protected_metadata_base64 text,
              protected_metadata_version smallint,
              protected_metadata_key_version integer,
              protected_metadata_tokens jsonb
            )
            ON CONFLICT (message_id, extractor, kind, namespace, evidence_key_sha256)
            DO UPDATE SET
              extractor_version = EXCLUDED.extractor_version,
              evidence_key = EXCLUDED.evidence_key,
              metadata = EXCLUDED.metadata,
              protected_metadata = EXCLUDED.protected_metadata,
              protected_metadata_version = EXCLUDED.protected_metadata_version,
              protected_metadata_key_version = EXCLUDED.protected_metadata_key_version,
              protected_metadata_tokens = EXCLUDED.protected_metadata_tokens,
              updated_at = now()
            `,
            [JSON.stringify(protectedEvidence)]
          );
        }
        await client.query(
          `
          DELETE FROM public.imap_message_evidence existing
          WHERE existing.message_id = $1
            AND existing.extractor = $2
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_to_recordset($3::jsonb) AS current_evidence (
                kind text,
                namespace text,
                evidence_key_sha256 text
              )
              WHERE current_evidence.kind = existing.kind
                AND current_evidence.namespace = existing.namespace
                AND current_evidence.evidence_key_sha256 = existing.evidence_key_sha256
            )
          `,
          [body.messageId, MIME_EVIDENCE_EXTRACTOR, JSON.stringify(protectedEvidence)]
        );
      }

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

  }

  /** Persist only the full body payload; search and threading never read these fields. */
  async storeBodyPayload(body: MessageBodyInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const stored = await client.query(
        `
        UPDATE public.imap_message_bodies
        SET raw_mime = $2,
            body_text = $3,
            body_html = $4,
            body_plain = $5,
            selected_text_part = $6,
            selected_text_format = $7,
            fetched_at = now(),
            updated_at = now()
        WHERE message_id = $1
        RETURNING message_id
        `,
        [
          body.messageId,
          this.config.BODY_STORAGE_MODE === "parsed_only" ? null : body.rawMime,
          body.bodyText,
          body.bodyHtml,
          body.bodyPlain,
          body.selectedTextPart,
          body.selectedTextFormat
        ]
      );
      if (stored.rowCount !== 1) {
        throw new Error(`Body evidence must be stored before body payload: ${body.messageId}`);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Mark the body readable only after the selected BodyStore succeeds. */
  async completeBodyStorage(messageId: string): Promise<void> {
    const result = await this.pool.query<{ message_id: string }>(
      `
      WITH target AS MATERIALIZED (
        SELECT id, account_id, folder_path
        FROM public.imap_messages
        WHERE id = $1
        FOR UPDATE
      ), completed AS (
        UPDATE public.imap_messages message
        SET body_fetched_at = now()
        FROM target
        WHERE message.id = target.id
          AND message.body_fetched_at IS NULL
        RETURNING target.account_id, target.folder_path
      ), folder_progress AS (
        UPDATE public.imap_folders folder
        SET bodies_fetched_count = folder.bodies_fetched_count + 1
        FROM completed
        WHERE folder.account_id = completed.account_id
          AND folder.path = completed.folder_path
        RETURNING folder.id
      )
      SELECT target.id AS message_id
      FROM target
      `,
      [messageId]
    );
    if (!result.rows[0]) {
      throw new Error(`Message not found after body storage: ${messageId}`);
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
                LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
                WHERE m.account_id = f.account_id
                  AND m.folder_path = f.path
                  AND m.deleted_in_provider = false
                  AND m.window_status = 'HISTORICAL'
                  AND (
                    m.body_fetched_at IS NULL
                    OR b.structured_evidence_extractor_version IS DISTINCT FROM $5
                  )
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
        limit,
        MIME_EVIDENCE_EXTRACTOR_VERSION
      ]
    );
    return result.rows;
  }

  async getHistoricalBodyBacklog(
    accountId: string,
    folder: ImapFolder,
    limit: number
  ): Promise<ImapMessage[]> {
    const result = await this.pool.query<ImapMessage & ProtectedMetadataColumns>(
      `
      SELECT m.*
      FROM public.imap_messages m
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      WHERE m.account_id = $1
        AND m.folder_path = $2
        AND m.deleted_in_provider = false
        AND m.window_status = 'HISTORICAL'
        AND (
          m.body_fetched_at IS NULL
          OR b.structured_evidence_extractor_version IS DISTINCT FROM $4
        )
      ORDER BY m.uid DESC
      LIMIT $3
      `,
      [accountId, folder.path, limit, MIME_EVIDENCE_EXTRACTOR_VERSION]
    );
    return await Promise.all(result.rows.map((row) => this.revealMessage(row)));
  }

  async setHistoryBackfillSnapshot(
    folderId: string,
    targetMaxUid: number,
    oldestUidSynced: number,
    targetCount: number,
    cutoff: Date,
    expectedUidValidity: number,
    options: SyncStateWriteOptions = {}
  ): Promise<void> {
    const result = await runOptionalDeadlineWrite<{ id: string }>(
      this.pool,
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
        AND uidvalidity = $6
      RETURNING id
      `,
      [folderId, targetMaxUid, oldestUidSynced, targetCount, cutoff, expectedUidValidity],
      options
    );
    if (result.rows.length !== 1) {
      throw new Error(`History snapshot lost folder generation ${folderId}`);
    }
  }

  async advanceHistoryBackfillWatermark(
    folderId: string,
    newOldestUidSynced: number,
    lastProgressUid: number,
    expectedUidValidity: number,
    options: { complete?: boolean; deadlineAt?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    const query = `
      UPDATE public.imap_folders
      SET backfill_oldest_uid_synced = $2,
          backfill_in_progress = CASE WHEN $4::boolean THEN false ELSE backfill_in_progress END,
          last_archive_refresh_at = CASE WHEN $4::boolean THEN now() ELSE last_archive_refresh_at END,
          last_progress_at = now(),
          last_progress_uid = $3,
          last_progress_note = CASE
            WHEN $4::boolean THEN 'history_backfill_complete'
            ELSE 'history_backfill_metadata'
          END
      WHERE id = $1
        AND uidvalidity = $5
      RETURNING id
    `;
    const values = [
      folderId,
      newOldestUidSynced,
      lastProgressUid,
      options.complete === true,
      expectedUidValidity
    ];
    const result = options.deadlineAt === undefined
      ? await this.pool.query<{ id: string }>(query, values)
      : await runMetadataWriteWithDeadline<{ id: string }>(
          this.pool,
          query,
          values,
          options.deadlineAt,
          options.signal
        );
    if (result.rows.length !== 1) {
      throw new Error(`History watermark lost folder generation ${folderId}`);
    }
  }

  async markHistoryBackfillComplete(
    folderId: string,
    expectedUidValidity: number,
    options: SyncStateWriteOptions = {}
  ): Promise<void> {
    const result = await runOptionalDeadlineWrite<{ id: string }>(
      this.pool,
      `
      UPDATE public.imap_folders
      SET backfill_in_progress = false,
          last_archive_refresh_at = now(),
          last_progress_at = now(),
          last_progress_note = 'history_backfill_complete'
      WHERE id = $1
        AND uidvalidity = $2
      RETURNING id
      `,
      [folderId, expectedUidValidity],
      options
    );
    if (result.rows.length !== 1) {
      throw new Error(`History completion lost folder generation ${folderId}`);
    }
  }

  async getBodyBacklog(account: ImapAccount, limit: number): Promise<ImapMessage[]> {
    const policy = account.body_fetch_policy || (this.config.BODY_FETCH_POLICY as BodyFetchPolicy);
    if (policy === "lazy") return [];

    const priorityClause = policy === "priority_then_backfill" ? "AND f.sync_priority <= $4" : "";
    const params: unknown[] = [account.id, limit, MIME_EVIDENCE_EXTRACTOR_VERSION];
    if (policy === "priority_then_backfill") params.push(this.config.PRIORITY_CUTOFF);

    const result = await this.pool.query<ImapMessage & ProtectedMetadataColumns>(
      `
      SELECT m.*
      FROM public.imap_messages m
      JOIN public.imap_folders f ON f.account_id = m.account_id AND f.path = m.folder_path
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
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
        AND (
          m.body_fetched_at IS NULL
          OR b.structured_evidence_extractor_version IS DISTINCT FROM $3
        )
        ${priorityClause}
      ORDER BY f.sync_priority, m.uid DESC
      LIMIT $2
      `,
      params
    );
    return await Promise.all(result.rows.map((row) => this.revealMessage(row)));
  }

  async logEvent(
    accountId: string,
    syncRunId: string | null,
    messageId: string | null,
    folderPath: string | null,
    providerUid: number | null,
    eventType: string,
    payload: Record<string, unknown>,
    options: { deadlineAt?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    const query = `
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
      `;
    const values = [
      accountId,
      syncRunId,
      messageId,
      folderPath,
      providerUid,
      eventType,
      JSON.stringify(payload)
    ];
    if (options.deadlineAt === undefined) {
      await this.pool.query(query, values);
      return;
    }
    await runMetadataWriteWithDeadline(
      this.pool,
      query,
      values,
      options.deadlineAt,
      options.signal
    );
  }
}
