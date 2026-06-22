export type BodyFetchPolicy = "immediate" | "lazy" | "priority_then_backfill";
export type BodyStorageMode = "raw_mime" | "parsed_only";
export type LiveWindowDays = 30 | 90 | 180;
export type HistoricalBackfillMode = "off" | "metadata_only" | "metadata_and_bodies";
export type ArchiveRefreshInterval = "never" | "monthly" | "weekly";
export type MaxBackfillRate = "small" | "normal" | "aggressive";
export type SyncState = "INITIAL_SYNC" | "HEALTHY" | "DEGRADED" | "BROKEN" | "PAUSED";
export type FolderStatus = "PENDING" | "SYNCING" | "ACTIVE" | "NEEDS_FULL_RESYNC" | "MISSING" | "PENDING_VERIFICATION";
export type WindowStatus = "IN_WINDOW" | "EXPIRED" | "HISTORICAL";
export type SyncRunStatus = "running" | "success" | "partial_success" | "failed";
export type SyncTriggerType = "scheduled" | "manual" | "api" | "backfill";

export interface ImapAccount {
  id: string;
  email_address: string;
  provider_profile: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encrypted_password: Buffer;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean | null;
  smtp_username: string | null;
  encrypted_smtp_password: Buffer | null;
  body_fetch_policy: BodyFetchPolicy;
  live_window_days: LiveWindowDays;
  historical_backfill_mode: HistoricalBackfillMode;
  archive_refresh_interval: ArchiveRefreshInterval;
  archive_flag_sync: boolean;
  max_backfill_rate: MaxBackfillRate;
  sync_state: SyncState;
  sync_state_reason: string | null;
  last_sync_started_at: Date | null;
  last_sync_finished_at: Date | null;
  last_priority_sync_succeeded_at: Date | null;
  priority_sync_lag_seconds: number | null;
  overall_sync_lag_seconds: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
  currently_syncing: boolean;
  sync_started_by: string | null;
  current_backoff_ms: number;
  backoff_until: Date | null;
  lock_id: string;
  folder_rr_cursor: number;
  last_folder_discovery_at: Date | null;
  next_folder_discovery_at: Date | null;
  folder_count_cap_override: number | null;
  last_heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AccountSummary {
  id: string;
  email_address: string;
  provider_profile: string;
  body_fetch_policy: BodyFetchPolicy;
  live_window_days: LiveWindowDays;
  historical_backfill_mode: HistoricalBackfillMode;
  archive_refresh_interval: ArchiveRefreshInterval;
  archive_flag_sync: boolean;
  max_backfill_rate: MaxBackfillRate;
  sync_state: SyncState;
  sync_state_reason: string | null;
  last_sync_started_at: Date | null;
  last_sync_finished_at: Date | null;
  last_priority_sync_succeeded_at: Date | null;
  priority_sync_lag_seconds: number | null;
  overall_sync_lag_seconds: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
  backoff_until: Date | null;
  last_folder_discovery_at: Date | null;
  next_folder_discovery_at: Date | null;
  folder_count_cap_override: number | null;
  last_heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AccountProgress {
  account_id: string;
  live_headers_synced_count: number;
  live_headers_target_count: number;
  live_headers_complete_pct: number;
  priority_bodies_fetched_count: number;
  priority_bodies_target_count: number;
  priority_bodies_complete_pct: number;
  live_bodies_fetched_count: number;
  live_bodies_target_count: number;
  live_bodies_complete_pct: number;
  historical_headers_synced_count: number;
  historical_headers_target_count: number;
  historical_headers_complete_pct: number;
  historical_bodies_fetched_count: number;
  historical_bodies_target_count: number;
  historical_bodies_complete_pct: number;
  estimated_full_sync_at: Date | null;
}

export interface FolderProgress {
  id: string;
  path: string;
  tracked: boolean;
  status: FolderStatus;
  sync_priority: number;
  headers_synced_count: number;
  bodies_fetched_count: number;
  live_window_target_count: number | null;
  historical_target_count: number | null;
  headers_pct: number;
  bodies_pct: number;
  historical_headers_pct: number;
  historical_bodies_pct: number;
}

export type AccountDetails = AccountSummary & Omit<AccountProgress, "account_id"> & {
  folders: FolderProgress[];
};

export interface ImapFolder {
  id: string;
  account_id: string;
  path: string;
  delimiter: string | null;
  special_use: string | null;
  last_seen_in_provider_at: Date | null;
  missing_since: Date | null;
  tracked: boolean;
  excluded_reason: string | null;
  sync_priority: number;
  status: FolderStatus;
  uidvalidity: string | null;
  uid_next: string | null;
  highest_modseq: string | null;
  last_uid: string | null;
  last_synced_at: Date | null;
  initial_sync_complete: boolean;
  initial_sync_target_max_uid: string | null;
  initial_sync_oldest_uid_synced: string | null;
  last_progress_at: Date | null;
  last_progress_uid: string | null;
  last_progress_note: string | null;
  next_sync_due_at: Date | null;
  next_flag_scan_at: Date | null;
  next_reconcile_at: Date | null;
  last_full_reconcile_at: Date | null;
  last_reconcile_clean: boolean | null;
  uidvalidity_reset_count: number;
  last_uidvalidity_reset_at: Date | null;
  headers_synced_count: number;
  bodies_fetched_count: number;
  live_window_target_count: number | null;
  historical_target_count: number | null;
  backfill_in_progress: boolean;
  backfill_target_max_uid: string | null;
  backfill_oldest_uid_synced: string | null;
  backfill_since_date: Date | null;
  last_archive_refresh_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type HistoryBacklogReason = "snapshot" | "metadata" | "body" | "refresh";

export type HistoryBacklogFolder = ImapFolder & {
  history_backlog_reason: HistoryBacklogReason;
};

export interface ImapMessage {
  id: string;
  account_id: string;
  folder_id: string | null;
  folder_path: string;
  uidvalidity: string;
  uid: string;
  rfc_message_id: string | null;
  message_id_normalized: string | null;
  provider_thread_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  internal_date: Date;
  size_bytes: number | null;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  to_names: (string | null)[] | null;
  cc_emails: string[] | null;
  cc_names: (string | null)[] | null;
  bcc_emails: string[] | null;
  flags: string[] | null;
  headers_json: Record<string, unknown>;
  mime_structure: unknown;
  body_fetched_at: Date | null;
  deleted_in_provider: boolean;
  provider_deleted_at: Date | null;
  deleted_reason: string | null;
  window_status: WindowStatus;
  created_at: Date;
  updated_at: Date;
}

export interface MessageBodyInput {
  messageId: string;
  rawMime: Buffer;
  rawBytes: number;
  rawTruncated: boolean;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyPlain: string | null;
  selectedTextPart: string | null;
  selectedTextFormat: "plain" | "html" | null;
  headersJson: Record<string, unknown>;
  mimeStructure: unknown;
  parserWarnings: string[];
}

export interface AttachmentMetadata {
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  disposition: "attachment" | "inline";
  contentId: string | null;
  partNumber: string;
}

export interface MessageMetadata {
  uid: number;
  internalDate: Date;
  sizeBytes: number;
  flags: string[];
  rfcMessageId: string | null;
  messageIdNormalized: string | null;
  providerThreadId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
  toEmails: string[];
  toNames: (string | null)[];
  ccEmails: string[];
  ccNames: (string | null)[];
  bccEmails: string[];
  headersJson: Record<string, string>;
  mimeStructure: unknown;
  attachments: AttachmentMetadata[];
}

export interface SyncResult {
  runId: string;
  outcome: Exclude<SyncRunStatus, "running">;
  foldersProcessed: number;
  messagesUpserted: number;
  bodiesFetched: number;
  flagsUpdated: number;
  reconcileGapsFound: number;
  hitLockBudget: boolean;
  errors: string[];
}

export interface MirrorHooks {
  onMessageUpsert?: (message: ImapMessage) => void | Promise<void>;
  onBodyFetched?: (message: ImapMessage, body: MessageBodyInput) => void | Promise<void>;
  onMessageDeleted?: (message: ImapMessage) => void | Promise<void>;
  onFolderChanged?: (folder: ImapFolder) => void | Promise<void>;
  onSyncRunCompleted?: (result: SyncResult) => void | Promise<void>;
}

export interface CreateAccountInput {
  emailAddress: string;
  host: string;
  port: number;
  secure?: boolean;
  username: string;
  password: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  providerProfile?: string;
  bodyFetchPolicy?: BodyFetchPolicy;
}

/** One send recipient. `name` is optional; nodemailer formats `Name <email>`. */
export interface SendRecipient {
  email: string;
  name?: string;
}

/**
 * One outbound attachment on a send/draft (email-004, ADR 0020). `content` is the
 * raw bytes base64-encoded (the JSON/base64 transport); nodemailer's MailComposer
 * builds the MIME part. Set `cid` for an inline image referenced from the HTML body
 * as `cid:<that-value>`; `inline: true` marks any part `Content-Disposition: inline`
 * (a `cid` implies inline). Otherwise the part is a regular `attachment`.
 */
export interface SendAttachment {
  filename: string;
  contentType?: string;
  /** Base64-encoded bytes of the part. */
  content: string;
  /** Content-ID for an inline image (referenced as `cid:<value>` in the HTML body). */
  cid?: string;
  /** Force `Content-Disposition: inline` (implied when `cid` is set). */
  inline?: boolean;
}

/**
 * The canonical send superset. A reply is `sendMessage()` fed the draft payload
 * (To/Subject + In-Reply-To/References); a brand-new message is the same call
 * with no threading headers. "Build once," exposed as two product verbs.
 */
export interface SendRequest {
  accountId: string;
  to: SendRecipient[];
  cc?: SendRecipient[];
  bcc?: SendRecipient[];
  subject: string;
  body: { format: "plain" | "html"; text?: string; html?: string };
  /** In-Reply-To / References / custom headers (merged with the convenience fields below). */
  headers?: Record<string, string>;
  inReplyTo?: string;
  references?: string;
  /** Caller-supplied for a stable Message-ID; else one is generated at compose time. */
  messageId?: string;
  /** Attachments + inline images (email-004, ADR 0020). MailComposer builds the MIME. */
  attachments?: SendAttachment[];
}

export interface SendResult {
  /** The Message-ID actually stamped on the delivered + filed bytes. */
  rfcMessageId: string;
  delivered: boolean;
  appendedToSent: boolean;
  /** From UIDPLUS APPENDUID when available, else null. */
  appendedUid: number | null;
  sentFolderPath: string | null;
  warnings: string[];
}

export interface UpdateAccountSettingsInput {
  historicalBackfillMode?: HistoricalBackfillMode;
  archiveRefreshInterval?: ArchiveRefreshInterval;
  archiveFlagSync?: boolean;
  maxBackfillRate?: MaxBackfillRate;
}
