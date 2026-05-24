export type BodyFetchPolicy = "immediate" | "lazy" | "priority_then_backfill";
export type SyncState = "INITIAL_SYNC" | "HEALTHY" | "DEGRADED" | "BROKEN" | "PAUSED";
export type FolderStatus = "PENDING" | "SYNCING" | "ACTIVE" | "NEEDS_FULL_RESYNC" | "MISSING";
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
  body_fetch_policy: BodyFetchPolicy;
  sync_state: SyncState;
  sync_state_reason: string | null;
  last_sync_started_at: Date | null;
  last_sync_finished_at: Date | null;
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
  last_heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AccountSummary {
  id: string;
  email_address: string;
  provider_profile: string;
  body_fetch_policy: BodyFetchPolicy;
  sync_state: SyncState;
  sync_state_reason: string | null;
  last_sync_started_at: Date | null;
  last_sync_finished_at: Date | null;
  priority_sync_lag_seconds: number | null;
  overall_sync_lag_seconds: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
  backoff_until: Date | null;
  last_folder_discovery_at: Date | null;
  next_folder_discovery_at: Date | null;
  last_heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

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
  backfill_in_progress: boolean;
  backfill_target_max_uid: string | null;
  backfill_oldest_uid_synced: string | null;
  backfill_since_date: Date | null;
  created_at: Date;
  updated_at: Date;
}

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
  providerProfile?: string;
  bodyFetchPolicy?: BodyFetchPolicy;
}
