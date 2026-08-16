import type { AppConfig } from "./config.js";
import { getConfig, getWindowCutoff, isWithinBackfillWindow } from "./config.js";
import { DatabaseBodyStore, type BodyStore } from "./body-store.js";
import type { PgPool } from "./db.js";
import { getPool } from "./db.js";
import { performance } from "node:perf_hooks";
import {
  fetchFullMessageBody,
  fetchFullMessageBodyBatch,
  fetchMessageFlags,
  fetchMessageMetadata,
  iterateChangedMessageFlagBatches,
  iterateAllUids,
  MessageMovedError,
  PARSED_BODY_BATCH_MAX_MESSAGES,
  PARSED_BODY_BATCH_MAX_SOURCE_BYTES,
  PARSED_BODY_BATCH_MAX_TOTAL_SOURCE_BYTES,
  searchUidsBefore,
  searchUidsSince
} from "./imap-client.js";
import type { MailboxChange, MailboxListItem, MirrorImapClient } from "./imap-client.js";
import { clearOrphanedLockForAccount, withAccountLock } from "./locks.js";
import type { MetadataProtectionAdapter } from "./metadata-protection.js";
import { MirrorRepository, sanitizeErrorReason } from "./repository.js";
import {
  isAuthDiagnosticText,
  isMissingMailboxDiagnosticText,
} from "./sync-diagnostics.js";
import type { MetadataWriteOptions } from "./repository.js";
import { MAX_SYNC_BATCH_SIZE } from "./sync-limits.js";
import type {
  ImapAccount,
  ImapFolder,
  ImapMessage,
  HistoryBacklogFolder,
  MessageMetadata,
  MirrorHooks,
  SyncResult,
  SyncTriggerType
} from "./types.js";
import { createImapClient } from "./imap-client.js";

// Patterns from real IMAP/SASL servers. Case-insensitive. Matched against
// the full error message; one match is enough. Spec §13.1 — AUTH_ERROR is
// non-retryable, so over-matching is preferable to under-matching here
// (a legitimate transient error caught as auth means a manual unstuck;
// a missed auth error means burning through retries on bad creds).
const HISTORY_METADATA_COMMIT_GRACE_MS = 30_000;
const SYNC_STATE_WRITE_GRACE_MS = 30_000;
const SYNC_CANCELLATION_CLEANUP_TIMEOUT_MS = 1_000;
const MISSING_MAILBOX_RESPONSE_CODES = new Set(["NONEXISTENT", "TRYCREATE"]);

const RACKSPACE_INBOX_ALIAS_PATH = "INBOX.INBOX";
const RACKSPACE_INBOX_ALIAS_CANONICAL_PATH = "INBOX";
const FOLDER_ALIAS_SAMPLE_SIZE = 5;
const FOLDER_ALIAS_SAMPLE_UID_WINDOW = 100;

async function peekAsyncIterable<T>(values: AsyncIterable<T>): Promise<{
  empty: boolean;
  values: AsyncIterable<T>;
}> {
  const iterator = values[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    return { empty: true, values: (async function* empty() {})() };
  }

  return {
    empty: false,
    values: (async function* replay() {
      try {
        yield first.value;
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          yield next.value;
        }
      } finally {
        await iterator.return?.();
      }
    })()
  };
}

type DiscoveredFolder = {
  path: string;
  delimiter?: string | null;
  specialUse?: string | null;
  excludedReasonOverride?: string | null;
};

type FolderAliasFingerprint = {
  uidValidity: string;
  uidNext: number | null;
  exists: number | null;
  sample: string[];
};

type FolderSyncResult = {
  messagesUpserted: number;
  flagsUpdated: number;
  reconcileGapsFound: number;
  reconcileAttempted: boolean;
  flagScanAttempted: boolean;
  hitLockBudget: boolean;
  initialSyncComplete: boolean;
  reconcileClean: boolean;
};

type HistoryBatchResult = {
  messagesUpserted: number;
  bodiesFetched: number;
  processed: boolean;
  hitLockBudget: boolean;
};

type MetadataWriteStats = {
  rowsCommitted: number;
  durationMs: number;
  batchesAttempted: number;
  batchesFailed: number;
};

export function metadataRowsPerSecond(rowsCommitted: number, durationMs: number): number | null {
  if (!Number.isFinite(rowsCommitted) || rowsCommitted < 0) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Math.round((rowsCommitted * 1000 / durationMs) * 100) / 100;
}

export function bodyBacklogReadLimit(batchSize: number, batchesRemaining: number): number {
  const wholeBatches = Math.min(
    batchesRemaining,
    Math.max(1, Math.floor(MAX_SYNC_BATCH_SIZE / batchSize))
  );
  return batchSize * wholeBatches;
}

function applyMetadataWriteStats(result: SyncResult, stats: MetadataWriteStats): void {
  const durationMs = stats.batchesAttempted > 0
    ? Math.max(0.01, Math.round(stats.durationMs * 100) / 100)
    : 0;
  result.metadataRowsCommitted = stats.rowsCommitted;
  result.metadataWriteDurationMs = durationMs;
  result.metadataWriteBatchesAttempted = stats.batchesAttempted;
  result.metadataWriteBatchesFailed = stats.batchesFailed;
  result.metadataWriteServiceRowsPerSecond = metadataRowsPerSecond(stats.rowsCommitted, durationMs);
}

// Response codes that mean the credential itself was rejected (RFC 5530).
const AUTH_RESPONSE_CODES = new Set(["AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "EXPIRED"]);

// RFC 5530 conditions a server can answer LOGIN with that are NOT credential
// rejections (Gmail/Yahoo "NO [UNAVAILABLE] Temporary System Problem" etc.).
// imapflow tags ANY error thrown from its login/authenticate exec with
// authenticationFailed=true, so these must be exempted BEFORE trusting the flag —
// otherwise a transiently-down server terminal-bricks the account.
const TRANSIENT_RESPONSE_CODES = new Set(["UNAVAILABLE", "INUSE", "LIMIT", "SERVERBUG"]);

/**
 * Classify an auth failure from the ERROR OBJECT, not just its message. imapflow's
 * login/authenticate failures throw with `message: "Command failed"` and put the real
 * signal in structured properties (`authenticationFailed: true`, `serverResponseCode`,
 * and `response` = the server's error text). A message-only regex misses those, so a
 * bad credential classified as a generic failure and re-tried hourly forever —
 * hammering the provider with bad logins (lockout risk) instead of going terminal
 * AUTH_ERROR. Accepts a plain string for back-compat.
 */
export function isAuthError(error: unknown): boolean {
  if (typeof error === "string") {
    return isAuthDiagnosticText(error);
  }
  if (!error || typeof error !== "object") return false;

  // A dead connection is never a credential problem, even when imapflow's login
  // exec tagged the error before the close surfaced.
  if (isConnectionLostError(error)) return false;

  // Transient server conditions outrank the auth flag (see TRANSIENT_RESPONSE_CODES).
  const responseCode = extractImapResponseCode(error);
  if (responseCode && TRANSIENT_RESPONSE_CODES.has(responseCode)) return false;

  if ((error as { authenticationFailed?: unknown }).authenticationFailed === true) return true;

  if (responseCode && AUTH_RESPONSE_CODES.has(responseCode)) return true;

  // The server's error text (imapflow puts it on `response`/`responseText`) plus the
  // message itself. Note: a bare "Command failed" matches NO pattern on purpose — it
  // is imapflow's generic command error, not an auth signal by itself.
  const texts = [
    error instanceof Error ? error.message : "",
    (error as { response?: unknown }).response,
    (error as { responseText?: unknown }).responseText
  ].filter((t): t is string => typeof t === "string" && t.length > 0);
  return texts.some(isAuthDiagnosticText);
}

/**
 * Detailed transient description of a sync failure. Classification converts this
 * text to a fixed code before durable storage or worker logging.
 */
export function describeSyncError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Structured markers FIRST, free-form server text LAST: every persistence sink runs
  // sanitizeErrorReason, whose credential redaction truncates from the first
  // LOGIN/AUTHENTICATE/PLAIN token to end-of-string. Server text like "LOGIN failed."
  // trips it, so anything after that text would be redacted away — markers placed
  // before it always survive.
  const errorClass = error.constructor?.name || error.name || "Error";
  const parts = [`[${errorClass}]`];
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.trim()) parts.push(`[code=${code.trim()}]`);
  const responseCode = extractImapResponseCode(error);
  if (responseCode) parts.push(`[${responseCode}]`);
  const responseStatus = (error as { responseStatus?: unknown }).responseStatus;
  if (
    typeof responseStatus === "string"
    && responseStatus.trim()
    && responseStatus.trim().toUpperCase() !== responseCode
  ) {
    parts.push(`[status=${responseStatus.trim().toUpperCase()}]`);
  }
  if ((error as { authenticationFailed?: unknown }).authenticationFailed === true) parts.push("[AUTH]");
  parts.push(error.message);
  const response = (error as { response?: unknown }).response;
  const responseText = (error as { responseText?: unknown }).responseText;
  const serverText = typeof response === "string" ? response : typeof responseText === "string" ? responseText : null;
  if (serverText && serverText !== error.message) parts.push(`— ${serverText}`);
  return parts.join(" ");
}

export function isMissingMailboxError(error: unknown): boolean {
  const responseCode = extractImapResponseCode(error);
  if (responseCode) {
    return MISSING_MAILBOX_RESPONSE_CODES.has(responseCode);
  }

  const message = error instanceof Error ? error.message : String(error);
  return isMissingMailboxDiagnosticText(message);
}

// imapflow error codes for a closed/unusable IMAP connection ("Connection not
// available" / "Connection closed"). Once one of these surfaces, every later
// command on the same client fails identically.
const CONNECTION_LOST_CODES = new Set(["NoConnection", "EConnectionClosed"]);

export function isConnectionLostError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CONNECTION_LOST_CODES.has(code);
}

function extractImapResponseCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    serverResponseCode?: unknown;
    responseCode?: unknown;
    responseStatus?: unknown;
  };
  for (const raw of [
    candidate.serverResponseCode,
    candidate.responseCode,
    candidate.responseStatus
  ]) {
    if (typeof raw === "string" && raw.trim()) return raw.trim().toUpperCase();
  }
  return null;
}

// Thrown when the engine has already persisted the account's terminal state
// (e.g. markAccountBroken for UIDVALIDITY_RESET_LIMIT_EXCEEDED). The outer
// catch must NOT re-mark via markAccountSyncFailed — that would clobber the
// BROKEN state back to DEGRADED via the failure-threshold CASE expression.
export class AccountAlreadyFinalizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountAlreadyFinalizedError";
  }
}

class SyncInterruptedError extends Error {
  constructor() {
    super("Sync interrupted by scheduler");
    this.name = "SyncInterruptedError";
  }
}

export interface MirrorEngineOptions {
  pool?: PgPool;
  config?: AppConfig;
  repository?: MirrorRepository;
  bodyStore?: BodyStore;
  metadataProtection?: MetadataProtectionAdapter;
  hooks?: MirrorHooks;
  clientFactory?: (
    account: ImapAccount,
    options?: { signal?: AbortSignal }
  ) => Promise<MirrorImapClient>;
}

export interface SyncAccountOptions {
  sentOnly?: boolean;
  /** Run the supplemental live-change lane (the name is retained for host compatibility). */
  liveInboxOnly?: boolean;
  /** EXPUNGE is only a hint; force authoritative UID reconciliation now. */
  forceInboxReconcile?: boolean;
  /** A flags notification may arrive before the normal flag deadline. */
  forceInboxFlagScan?: boolean;
  signal?: AbortSignal;
  /** Reuse a host-owned session, such as an Inbox IDLE connection. */
  client?: MirrorImapClient;
  /** Mailbox Account identity bound to the host-owned session. */
  clientAccountId?: string;
  /** Leave a healthy host-owned session open after this pass. */
  keepClientOpen?: boolean;
}

export class MirrorEngine {
  private readonly pool: PgPool;
  private readonly config: AppConfig;
  private readonly repository: MirrorRepository;
  private readonly bodyStore: BodyStore;
  private readonly hooks: MirrorHooks;
  private readonly clientFactory: (
    account: ImapAccount,
    options?: { signal?: AbortSignal }
  ) => Promise<MirrorImapClient>;

  constructor(options: MirrorEngineOptions = {}) {
    this.pool = options.pool ?? getPool();
    this.config = options.config ?? getConfig();
    this.repository = options.repository
      ?? new MirrorRepository(this.pool, this.config, options.metadataProtection);
    this.bodyStore = options.bodyStore ?? new DatabaseBodyStore(this.repository);
    this.hooks = options.hooks ?? {};
    this.clientFactory = options.clientFactory
      ?? ((account, clientOptions) => createImapClient(this.pool, this.config, account, clientOptions));
  }

  async syncDueAccounts(
    limit = 10,
    options: { signal?: AbortSignal } = {}
  ): Promise<SyncResult[]> {
    const accounts = await this.repository.getRunnableAccounts(limit);
    const results: SyncResult[] = [];

    for (const account of accounts) {
      if (options.signal?.aborted) break;
      results.push(await this.syncAccount(account.id, "scheduled", { signal: options.signal }));
    }

    return results;
  }

  /** Refresh only due Sent folders, leaving expensive secondary lanes to the full sweep. */
  async syncDueSentFolders(
    limit = this.config.SYNC_MAX_ACCOUNTS,
    options: { signal?: AbortSignal } = {}
  ): Promise<SyncResult[]> {
    const accounts = await this.repository.getRunnableAccounts(limit, { sentDueOnly: true });
    const results: SyncResult[] = [];

    for (const account of accounts) {
      if (options.signal?.aborted) break;
      results.push(await this.syncAccount(account.id, "scheduled", {
        sentOnly: true,
        signal: options.signal
      }));
    }

    return results;
  }

  async syncAccount(
    accountId: string,
    triggerType: SyncTriggerType = "manual",
    options: SyncAccountOptions = {}
  ): Promise<SyncResult> {
    if (options.sentOnly && options.liveInboxOnly) {
      throw new Error("sentOnly and liveInboxOnly cannot be combined");
    }
    if (options.client && options.keepClientOpen !== true) {
      throw new Error("A host-owned client requires keepClientOpen");
    }
    if (options.keepClientOpen && !options.client) {
      throw new Error("keepClientOpen requires a host-owned client");
    }
    if (options.client && options.clientAccountId !== accountId) {
      throw new Error("Host-owned client does not match the Mailbox Account");
    }
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);
    const supplemental = options.sentOnly === true || options.liveInboxOnly === true;

    const runId = await this.repository.startSyncRun(account.id, triggerType);
    const metadataWriteStats: MetadataWriteStats = {
      rowsCommitted: 0,
      durationMs: 0,
      batchesAttempted: 0,
      batchesFailed: 0
    };
    const result: SyncResult = {
      runId,
      outcome: "success",
      foldersProcessed: 0,
      messagesUpserted: 0,
      metadataRowsCommitted: 0,
      metadataWriteDurationMs: 0,
      metadataWriteBatchesAttempted: 0,
      metadataWriteBatchesFailed: 0,
      metadataWriteServiceRowsPerSecond: null,
      bodiesFetched: 0,
      flagsUpdated: 0,
      reconcileGapsFound: 0,
      hitLockBudget: false,
      errors: []
    };
    let cancellationCleanupRequired = false;
    const syncOwner = `supamail:${process.pid}:${runId}`;

    const runLockedSync = () => withAccountLock(this.pool, account.lock_id, async () => {
      const lockDeadline = Date.now() + this.config.MAX_LOCK_HOLD_MS;
      let accountSyncStarted = false;
      let client: MirrorImapClient | null = null;
      const interruptActiveClient = () => {
        if (client) this.abortClient(client);
      };
      const throwIfInterrupted = () => {
        if (!options.signal?.aborted) return;
        interruptActiveClient();
        throw new SyncInterruptedError();
      };
      options.signal?.addEventListener("abort", interruptActiveClient, { once: true });

      try {
        throwIfInterrupted();
        await this.repository.markAccountSyncStarted(account.id, syncOwner, {
          deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
          signal: options.signal
        });
        accountSyncStarted = true;
        throwIfInterrupted();
        const sentFolders = options.sentOnly
          ? await this.repository.getSentFoldersDueForSync(account.id)
          : null;
        if (options.sentOnly && sentFolders?.length === 0) {
          await this.repository.markAccountSyncYielded(account.id, {
            deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
            signal: options.signal,
            expectedSyncOwner: syncOwner
          });
          return;
        }

        client = options.client
          ?? await this.clientFactory(account, { signal: options.signal });
        throwIfInterrupted();

        const mailboxChanges = options.liveInboxOnly
          ? [...(client.peekMailboxChanges?.(
              this.config.MAX_PRIORITY_FOLDERS_PER_CYCLE + this.config.MAX_RR_FOLDERS_PER_CYCLE
            ) ?? [])]
          : [];
        const mailboxChangeByPath = new Map(
          mailboxChanges.map((change) => [change.path, change] as const)
        );

        if (!supplemental && this.shouldDiscoverFolders(account)) {
          await this.discoverFolders(account, client);
        }

        const folders = sentFolders ?? (options.liveInboxOnly
          ? mailboxChanges.length > 0
            ? await this.repository.getFoldersForWake(
                account.id,
                mailboxChanges.map((change) => change.path)
              )
            : [await this.repository.getInboxFolderForWake(account.id)].filter(
                (folder): folder is ImapFolder => folder !== null
              )
          : await this.repository.getFoldersDueForSync(account.id));
        let priorityFolderFailed = false;
        let connectionLost = false;
        let remainingReconciles = this.config.MAX_RECONCILES_PER_CYCLE;
        let remainingFlagScans = this.config.MAX_FLAG_SCANS_PER_CYCLE;
        let attemptedMailboxChanges = 0;
        const handledMailboxChanges: MailboxChange[] = [];
        for (const folder of folders) {
          throwIfInterrupted();
          const mailboxChange = mailboxChangeByPath.get(folder.path);
          const isPriorityFolder = mailboxChange !== undefined
            || folder.sync_priority <= this.config.PRIORITY_CUTOFF;
          if (this.isLockBudgetExpired(lockDeadline) && !isPriorityFolder) {
            result.hitLockBudget = true;
            break;
          }
          if (mailboxChange !== undefined && attemptedMailboxChanges > 0
            && this.isLockBudgetExpired(lockDeadline)) {
            result.hitLockBudget = true;
            break;
          }
          if (mailboxChange !== undefined) attemptedMailboxChanges += 1;

          try {
            const folderResult = await this.syncFolder(account, folder, client, {
              allowReconcile: !options.sentOnly && remainingReconciles > 0,
              allowFlagScan: !options.sentOnly && remainingFlagScans > 0,
              enforceLockDeadline: !isPriorityFolder,
              lockDeadline,
              metadataWriteStats,
              forceReconcile: options.liveInboxOnly
                && (mailboxChange?.forceReconcile === true
                  || (folder.path.toLowerCase() === "inbox" && options.forceInboxReconcile === true)),
              forceFlagScan: options.liveInboxOnly
                && (mailboxChange?.forceFlagScan === true
                  || (folder.path.toLowerCase() === "inbox" && options.forceInboxFlagScan === true)),
              signal: options.signal
            });
            throwIfInterrupted();
            result.foldersProcessed += 1;
            result.messagesUpserted += folderResult.messagesUpserted;
            result.flagsUpdated += folderResult.flagsUpdated;
            result.reconcileGapsFound += folderResult.reconcileGapsFound;
            if (folderResult.hitLockBudget || this.isLockBudgetExpired(lockDeadline)) {
              result.hitLockBudget = true;
            }
            if (folderResult.reconcileAttempted) remainingReconciles -= 1;
            if (folderResult.flagScanAttempted) remainingFlagScans -= 1;
            if (mailboxChange !== undefined
              && folderResult.initialSyncComplete
              && !folderResult.hitLockBudget
              && (!mailboxChange.forceReconcile
                || (folderResult.reconcileAttempted && folderResult.reconcileClean))
              && (!mailboxChange.forceFlagScan || folderResult.flagScanAttempted)) {
              handledMailboxChanges.push(mailboxChange);
            }
            await this.repository.heartbeat(account.id);
          } catch (error) {
            throwIfInterrupted();
            // Account-finalising errors (e.g. UIDVALIDITY reset cap exceeded)
            // must escape the per-folder catch so the outer handler sees them
            // and skips re-marking; otherwise markAccountSyncPartial overrides
            // the BROKEN state with DEGRADED.
            if (error instanceof AccountAlreadyFinalizedError) throw error;
            const sanitizedPath = folder.path.replace(/[\x00-\x1F\x7F]+/g, " ").slice(0, 200);
            const message = describeSyncError(error);
            if (isConnectionLostError(error)) {
              // The IMAP connection is gone (an engine timeout closed it or the
              // server dropped it) — every remaining folder would fail with the
              // same error. Record one line, skip the rest of this pass, and let
              // the next scheduled run reconnect. Deliberately does not count as
              // a priority-folder failure: the folder didn't fail, the
              // connection did, and the real cause was recorded by the folder
              // that hit it.
              result.errors.push(
                sanitizeErrorReason(`${sanitizedPath}: ${message}; connection lost, remaining sync deferred to next run`)
              );
              connectionLost = true;
              break;
            }
            if (isMissingMailboxError(error)) {
              await this.repository.markFolderPendingVerification(
                account.id,
                folder.id,
                folder.path,
                message
              );
            }
            if (isPriorityFolder) priorityFolderFailed = true;
            result.errors.push(sanitizeErrorReason(`${sanitizedPath}: ${message}`));
          }
        }

        if (mailboxChanges.length > 0 && folders.length !== mailboxChanges.length) {
          priorityFolderFailed = true;
          result.errors.push("Mailbox change set no longer matches tracked folders");
        }

        if (!options.sentOnly && this.isLockBudgetExpired(lockDeadline)) {
          result.hitLockBudget = true;
        } else if (!options.sentOnly && !options.liveInboxOnly && !connectionLost) {
          const bodyResult = await this.fetchBodyBacklog(account, client, lockDeadline);
          throwIfInterrupted();
          result.bodiesFetched += bodyResult.fetched;
          if (bodyResult.hitLockBudget) result.hitLockBudget = true;
        }

        if (!options.sentOnly && this.isLockBudgetExpired(lockDeadline)) {
          result.hitLockBudget = true;
        } else if (!options.sentOnly && !options.liveInboxOnly && !connectionLost) {
          const historyResult = await this.runHistoryLane(
            account,
            client,
            lockDeadline,
            metadataWriteStats,
            options.signal
          );
          throwIfInterrupted();
          result.messagesUpserted += historyResult.messagesUpserted;
          result.bodiesFetched += historyResult.bodiesFetched;
          result.errors.push(...historyResult.errors);
          if (historyResult.hitLockBudget) result.hitLockBudget = true;
        }

        if (result.errors.length > 0) {
          result.outcome = priorityFolderFailed ? "failed" : "partial_success";
        }

        if (handledMailboxChanges.length > 0) {
          client.acknowledgeMailboxChanges?.(handledMailboxChanges);
        }

        if (supplemental) {
          await this.repository.markAccountSyncYielded(account.id, {
            deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
            signal: options.signal,
            expectedSyncOwner: syncOwner
          });
        } else if (result.outcome === "failed") {
          await this.repository.markAccountSyncFailed(account.id, result.errors.join("; "), {
            deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
            signal: options.signal,
            expectedSyncOwner: syncOwner
          });
        } else if (result.outcome === "partial_success") {
          await this.repository.markAccountSyncPartial(account.id, result.errors.join("; "), {
            countsTowardBackoff: !result.hitLockBudget,
            deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
            signal: options.signal,
            expectedSyncOwner: syncOwner
          });
        } else {
          await this.repository.markAccountSyncSucceeded(account.id, {
            countsTowardBackoff: !result.hitLockBudget,
            deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
            signal: options.signal,
            expectedSyncOwner: syncOwner
          });
        }
      } catch (error) {
        if (
          error instanceof SyncInterruptedError
          || options.signal?.aborted === true
        ) {
          // Scheduler cancellation (shutdown or a due full sweep preempting Sent)
          // is normal, not a mailbox/provider failure or an outage signal.
          // Defer database cleanup until withAccountLock has released the
          // advisory lock. A locked account row must not pin mailbox ownership.
          cancellationCleanupRequired = accountSyncStarted;
          if (!supplemental) {
            result.outcome = "partial_success";
            result.errors.push("Sync interrupted by scheduler");
          }
          return;
        }
        // Classify on the ERROR OBJECT (imapflow auth failures say "Command failed"
        // in the message and carry the truth in structured props), and persist the
        // enriched description so the stored reason explains WHY.
        const message = describeSyncError(error);
        result.outcome = "failed";
        result.errors.push(sanitizeErrorReason(message));
        try {
          if (supplemental) {
            await this.repository.markAccountSyncYielded(account.id, {
              deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
              signal: options.signal,
              expectedSyncOwner: syncOwner
            });
          } else if (error instanceof AccountAlreadyFinalizedError) {
            // Account state was already persisted (e.g. UIDVALIDITY reset limit
            // exceeded → BROKEN). Don't re-mark; that would override BROKEN with
            // the DEGRADED/BROKEN-via-threshold CASE expression.
          } else if (isAuthError(error)) {
            await this.repository.markAccountSyncAuthFailed(account.id, message, {
              deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
              signal: options.signal,
              expectedSyncOwner: syncOwner
            });
          } else {
            await this.repository.markAccountSyncFailed(account.id, message, {
              deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
              signal: options.signal,
              expectedSyncOwner: syncOwner
            });
          }
        } catch (finalizationError) {
          if (!options.signal?.aborted) throw finalizationError;
          // An abort can arrive after the provider error was classified but
          // while its account-state write is waiting on Postgres. Defer the
          // owner-fenced projection cleanup until after the advisory lock is
          // released, then still finish the durable sync run below.
          cancellationCleanupRequired = accountSyncStarted;
          return;
        }
      } finally {
        options.signal?.removeEventListener("abort", interruptActiveClient);
        if (
          client
          && (!options.keepClientOpen || client.usable === false || options.signal?.aborted)
        ) {
          await client.logout().catch(() => this.abortClient(client!));
        }
      }
    });

    let runFinished = false;
    try {
      let locked = await runLockedSync();
      // Supplemental Sent and live Inbox lanes defer to the authoritative full
      // sweep when another worker owns the Mailbox Account.
      const yieldedBeforeLock = locked === null && supplemental;
      if (locked === null && !yieldedBeforeLock) {
        const recovered = await clearOrphanedLockForAccount(
          this.pool,
          account.lock_id,
          this.config.STALE_HEARTBEAT_MS
        );
        if (recovered) {
          locked = await runLockedSync();
        }
      }

      if (cancellationCleanupRequired) {
        await this.repository.markAccountSyncYielded(account.id, {
          deadlineAt: Date.now() + SYNC_CANCELLATION_CLEANUP_TIMEOUT_MS,
          expectedSyncOwner: syncOwner
        }).catch(() => undefined);
      }

      applyMetadataWriteStats(result, metadataWriteStats);

      if (locked === null && !yieldedBeforeLock) {
        result.outcome = "failed";
        result.errors.push("Account lock busy");
        await this.repository.updateSyncRunStatus(runId, "failed", "Account lock busy");
        runFinished = true;
        return result;
      }

      await this.repository.finishSyncRun(result);
      runFinished = true;
      await this.hooks.onSyncRunCompleted?.(result);
      return result;
    } catch (error) {
      if (!runFinished) {
        const message = sanitizeErrorReason(describeSyncError(error));
        result.outcome = "failed";
        if (!result.errors.includes(message)) result.errors.push(message);
        applyMetadataWriteStats(result, metadataWriteStats);
        try {
          await this.repository.finishSyncRun(result);
          runFinished = true;
        } catch (finalizationError) {
          throw new AggregateError(
            [error, finalizationError],
            `Sync run ${runId} escaped and could not be terminalized`
          );
        }
      }
      throw error;
    }
  }

  async fetchBody(messageId: string, force = false): Promise<boolean> {
    const message = await this.repository.getMessage(messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    if (message.body_fetched_at && !force) return false;

    const account = await this.repository.getAccount(message.account_id);
    if (!account) throw new Error(`Account not found for message: ${messageId}`);

    const fetched = await withAccountLock(this.pool, account.lock_id, async () => {
      const client = await this.clientFactory(account);
      try {
        await this.fetchAndStoreBody(client, message);
        return true;
      } finally {
        await client.logout().catch(() => undefined);
      }
    });

    if (fetched === null) throw new Error("Account lock busy");
    return fetched;
  }

  private shouldDiscoverFolders(account: ImapAccount): boolean {
    if (!account.next_folder_discovery_at) return true;
    return new Date(account.next_folder_discovery_at).getTime() <= Date.now();
  }

  private async discoverFolders(account: ImapAccount, client: MirrorImapClient): Promise<void> {
    const folders = await client.list();
    if (folders.length === 0) {
      throw new Error(`Provider returned no folders for ${account.email_address}`);
    }

    const discoveredFolders = await this.applyVerifiedFolderAliasExclusions(
      account,
      client,
      folders.map((folder) => ({
        path: folder.path,
        delimiter: folder.delimiter ?? null,
        specialUse: folder.specialUse ?? null
      }))
    );

    const upserted = await this.repository.upsertDiscoveredFolders(
      account,
      discoveredFolders
    );

    for (const folder of upserted) {
      await this.hooks.onFolderChanged?.(folder);
    }
  }

  private async applyVerifiedFolderAliasExclusions(
    account: ImapAccount,
    client: MirrorImapClient,
    folders: DiscoveredFolder[]
  ): Promise<DiscoveredFolder[]> {
    if (account.provider_profile !== "rackspace") return folders;

    const byPath = new Map(folders.map((folder) => [folder.path, folder]));
    const canonical = byPath.get(RACKSPACE_INBOX_ALIAS_CANONICAL_PATH);
    const alias = byPath.get(RACKSPACE_INBOX_ALIAS_PATH);
    if (!canonical || !alias) return folders;

    try {
      const canonicalFingerprint = await this.fingerprintFolderAliasCandidate(client, canonical);
      const aliasFingerprint = await this.fingerprintFolderAliasCandidate(client, alias);
      if (!this.areVerifiedFolderAliases(canonicalFingerprint, aliasFingerprint)) return folders;

      return folders.map((folder) => {
        if (folder.path !== RACKSPACE_INBOX_ALIAS_PATH) return folder;
        return {
          ...folder,
          excludedReasonOverride: `excluded_duplicate_alias:${RACKSPACE_INBOX_ALIAS_CANONICAL_PATH}`
        };
      });
    } catch {
      return folders;
    }
  }

  private async fingerprintFolderAliasCandidate(
    client: MirrorImapClient,
    folder: Pick<MailboxListItem, "path">
  ): Promise<FolderAliasFingerprint | null> {
    const mailboxLock = await client.getMailboxLock(folder.path);
    try {
      const mailbox = client.mailbox;
      if (!mailbox) return null;

      const uidNext = mailbox.uidNext ?? null;
      const exists = mailbox.exists ?? null;
      const uidValidity = String(mailbox.uidValidity);
      const rows: Array<{ uid: number; value: string }> = [];

      if (uidNext !== null && uidNext > 1 && exists !== 0) {
        const lastUid = uidNext - 1;
        const firstUid = Math.max(1, lastUid - FOLDER_ALIAS_SAMPLE_UID_WINDOW + 1);

        for await (const message of client.fetch(
          { uid: `${firstUid}:${lastUid}` },
          {
            uid: true,
            internalDate: true,
            size: true,
            envelope: true
          },
          { uid: true }
        )) {
          rows.push({
            uid: message.uid,
            value: [
              message.uid,
              message.envelope?.messageId ?? "",
              message.internalDate?.toISOString() ?? "",
              message.size ?? "",
              message.envelope?.subject ?? ""
            ].join("|")
          });
        }
      }

      return {
        uidValidity,
        uidNext,
        exists,
        sample: rows
          .sort((left, right) => right.uid - left.uid)
          .slice(0, FOLDER_ALIAS_SAMPLE_SIZE)
          .map((row) => row.value)
      };
    } finally {
      mailboxLock.release();
    }
  }

  private areVerifiedFolderAliases(
    left: FolderAliasFingerprint | null,
    right: FolderAliasFingerprint | null
  ): boolean {
    if (!left || !right) return false;
    if (left.uidValidity !== right.uidValidity) return false;
    if (left.uidNext !== right.uidNext) return false;
    if (left.exists !== right.exists) return false;
    if (left.sample.length === 0 || right.sample.length === 0) return false;
    if (left.sample.length !== right.sample.length) return false;
    return left.sample.every((value, index) => value === right.sample[index]);
  }

  private async syncFolder(
    account: ImapAccount,
    folder: ImapFolder,
    client: MirrorImapClient,
    options: {
      allowReconcile: boolean;
      allowFlagScan: boolean;
      enforceLockDeadline: boolean;
      lockDeadline: number;
      metadataWriteStats: MetadataWriteStats;
      forceReconcile?: boolean;
      forceFlagScan?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<FolderSyncResult> {
    await this.repository.markFolderSyncStarted(folder.id, {
      deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
      signal: options.signal
    });
    const mailboxLock = await client.getMailboxLock(folder.path);

    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error("Mailbox not available after lock");

      const uidValidity = Number(mailbox.uidValidity);
      const uidNext = mailbox.uidNext ?? undefined;
      const highestModseq = mailbox.highestModseq === undefined
        ? undefined
        : String(mailbox.highestModseq);
      const storedUidValidity = folder.uidvalidity ? Number(folder.uidvalidity) : null;

      if (storedUidValidity && storedUidValidity !== uidValidity) {
        const { resetCountIn24h } = await this.repository.handleUidValidityReset(
          account,
          folder,
          uidValidity
        );
        if (resetCountIn24h > this.config.MAX_UIDVALIDITY_RESETS_24H) {
          await this.repository.markAccountBroken(
            account.id,
            `UIDVALIDITY_RESET_LIMIT_EXCEEDED: ${resetCountIn24h} resets in 24h on ${folder.path}`
          );
          throw new AccountAlreadyFinalizedError(
            `UIDVALIDITY_RESET_LIMIT_EXCEEDED: ${folder.path}`
          );
        }
        return {
          messagesUpserted: 0,
          flagsUpdated: 0,
          reconcileGapsFound: 0,
          reconcileAttempted: false,
          flagScanAttempted: false,
          hitLockBudget: false,
          initialSyncComplete: false,
          reconcileClean: false
        };
      }

      const windowCutoff = getWindowCutoff(this.config);
      let messagesUpserted = 0;
      let flagsUpdated = 0;
      let reconcileGapsFound = 0;
      let reconcileAttempted = false;
      let flagScanAttempted = false;
      let hitLockBudget = false;

      // Spec §10.4: initial sync is snapshot-based and newest-first, with a
      // watermark (`initial_sync_oldest_uid_synced`) so a crash mid-backfill
      // resumes from where we left off instead of rescanning the world.
      if (!folder.initial_sync_complete) {
        const initial = await this.runInitialSyncBatch(
          account,
          folder,
          client,
          uidValidity,
          uidNext,
          windowCutoff,
          options.metadataWriteStats,
          options.signal
        );
        return {
          messagesUpserted: initial.messagesUpserted,
          flagsUpdated: 0,
          reconcileGapsFound: 0,
          reconcileAttempted: false,
          flagScanAttempted: false,
          hitLockBudget: this.folderHitLockBudget(options),
          initialSyncComplete: initial.initialSyncComplete,
          reconcileClean: false
        };
      }

      // Spec §10.5: incremental sync — only UIDs > last_uid, in window.
      const incrementalDeadline = Date.now() + this.config.INCREMENTAL_TOTAL_TIMEOUT_MS;
      const lastUid = folder.last_uid ? Number(folder.last_uid) : 0;
      const uidFloor = lastUid + 1;
      const uidCeiling = Math.max(uidFloor, uidNext ? uidNext - 1 : uidFloor);
      const incomingUids = [
        ...new Set(
          (await this.withIncrementalDeadline(
            client,
            incrementalDeadline,
            "incremental SEARCH",
            () => searchUidsSince(client, windowCutoff, `${uidFloor}:${uidCeiling}`)
          )).filter((uid) => uid > lastUid)
        )
      ].sort((a, b) => a - b);

      const incrementalBatchSize = this.config.INCREMENTAL_SYNC_BATCH_SIZE;
      let lastProcessedUid: number | undefined;
      for (let i = 0; i < incomingUids.length; i += incrementalBatchSize) {
        const batchUids = incomingUids.slice(i, i + incrementalBatchSize);
        const metadata = await this.withIncrementalDeadline(
          client,
          incrementalDeadline,
          "incremental FETCH",
          () => fetchMessageMetadata(client, batchUids, incrementalBatchSize)
        );
        const messages = await this.upsertMetadataBatch(
          options.metadataWriteStats,
          account.id,
          folder,
          uidValidity,
          metadata,
          windowCutoff,
          { deadlineAt: incrementalDeadline, signal: options.signal }
        );
        messagesUpserted += messages.length;
        for (const message of messages) {
          await this.hooks.onMessageUpsert?.(message);
        }
        lastProcessedUid = batchUids[batchUids.length - 1];
        if (this.folderHitLockBudget(options)) {
          hitLockBudget = true;
          break;
        }
      }

      const flagScanDue = options.forceFlagScan
        || !folder.next_flag_scan_at
        || new Date(folder.next_flag_scan_at).getTime() <= Date.now();
      if (this.folderHitLockBudget(options)) hitLockBudget = true;
      if (!hitLockBudget && flagScanDue && options.allowFlagScan) {
        flagScanAttempted = true;
        const flagScanDeadline = Date.now() + this.config.FLAG_SCAN_TOTAL_TIMEOUT_MS;
        const canUseChangedSince = folder.highest_modseq !== null
          && highestModseq !== undefined
          && BigInt(highestModseq) > BigInt(folder.highest_modseq);
        const condstoreCursorUnchanged = folder.highest_modseq !== null
          && highestModseq !== undefined
          && BigInt(highestModseq) === BigInt(folder.highest_modseq);
        if (canUseChangedSince) {
          for await (const flags of this.withAsyncIterableDeadline(
            client,
            flagScanDeadline,
            "FLAG_SCAN_TOTAL_TIMEOUT_MS",
            "CONDSTORE flag delta",
            iterateChangedMessageFlagBatches(
              client,
              BigInt(folder.highest_modseq!),
              incrementalBatchSize
            )
          )) {
            this.assertDeadlineAvailable(
              client,
              flagScanDeadline,
              "FLAG_SCAN_TOTAL_TIMEOUT_MS",
              "flag scan write"
            );
            const scan = await this.repository.applyFlagScan(
              account.id,
              folder,
              uidValidity,
              flags,
              { deadlineAt: flagScanDeadline, signal: options.signal }
            );
            flagsUpdated += scan.flagsChanged;
            for (const message of scan.messages) {
              await this.hooks.onMessageUpsert?.(message);
            }
          }
        } else if (!condstoreCursorUnchanged) {
          // Establishing a CONDSTORE cursor must cover the entire active mirror
          // window. Otherwise a flag changed before the first persisted modseq
          // could be skipped forever when the cursor advances.
          const establishingCondstoreCursor = folder.highest_modseq === null
            && highestModseq !== undefined;
          const scanEntireWindow = establishingCondstoreCursor || options.forceFlagScan === true;
          const flagCutoff = scanEntireWindow ? windowCutoff : new Date();
          if (!scanEntireWindow) {
            flagCutoff.setDate(flagCutoff.getDate() - this.config.FLAG_DIFF_WINDOW_DAYS);
          }
          const flagUids = [
            ...new Set(await this.withOperationDeadline(
              client,
              flagScanDeadline,
              "FLAG_SCAN_TOTAL_TIMEOUT_MS",
              "flag scan SEARCH",
              () => searchUidsSince(client, flagCutoff)
            ))
          ].sort((a, b) => a - b);
          for (let i = 0; i < flagUids.length; i += incrementalBatchSize) {
            const batchUids = flagUids.slice(i, i + incrementalBatchSize);
            const flags = await this.withOperationDeadline(
              client,
              flagScanDeadline,
              "FLAG_SCAN_TOTAL_TIMEOUT_MS",
              "flag scan FETCH",
              () => fetchMessageFlags(client, batchUids, incrementalBatchSize)
            );
            this.assertDeadlineAvailable(
              client,
              flagScanDeadline,
              "FLAG_SCAN_TOTAL_TIMEOUT_MS",
              "flag scan write"
            );
            const scan = await this.repository.applyFlagScan(
              account.id,
              folder,
              uidValidity,
              flags,
              { deadlineAt: flagScanDeadline, signal: options.signal }
            );
            flagsUpdated += scan.flagsChanged;
            for (const message of scan.messages) {
              await this.hooks.onMessageUpsert?.(message);
            }
          }
        }
      }

      if (this.folderHitLockBudget(options)) hitLockBudget = true;
      let reconcileClean: boolean | undefined;
      const reconcileDue = options.forceReconcile
        || !folder.last_full_reconcile_at
        || !folder.next_reconcile_at
        || new Date(folder.next_reconcile_at).getTime() <= Date.now();
      let backfilled = 0;
      if (!hitLockBudget && options.allowReconcile && reconcileDue) {
        reconcileAttempted = true;
        const reconcileDeadline = Date.now() + this.config.RECONCILE_TOTAL_TIMEOUT_MS;
        // Spec §10.7: only reconcile once initial sync is complete and only
        // inside the active sync window. HISTORICAL/EXPIRED rows are static
        // archive, not part of the hot mirror safety loop.
        this.assertDeadlineAvailable(
          client,
          reconcileDeadline,
          "RECONCILE_TOTAL_TIMEOUT_MS",
          "reconcile UID stream"
        );
        const shouldFailOnEmptyReconcile = await this.repository.hasActiveWindowMessages(
          account.id,
          folder,
          uidValidity
        );
        const windowUidStream = await peekAsyncIterable(this.withAsyncIterableDeadline(
          client,
          reconcileDeadline,
          "RECONCILE_TOTAL_TIMEOUT_MS",
          "reconcile UID stream",
          iterateAllUids(client, windowCutoff)
        ));
        const needsAllUidConfirmation = shouldFailOnEmptyReconcile && windowUidStream.empty;
        const reconcile = await this.repository.markMissingMessagesFromLiveUidStream(
          account.id,
          folder,
          uidValidity,
          needsAllUidConfirmation
            ? this.withAsyncIterableDeadline(
                client,
                reconcileDeadline,
                "RECONCILE_TOTAL_TIMEOUT_MS",
                "reconcile all-UID confirmation stream",
                iterateAllUids(client)
              )
            : windowUidStream.values,
          {
            failIfEmpty: shouldFailOnEmptyReconcile,
            emptyError: `Reconcile returned no UIDs for non-empty mailbox ${folder.path}`,
            // The unfiltered fallback confirms provider deletions only. Feeding its
            // archive UIDs into missing-in-DB repair would violate the live-window
            // boundary and turn a rare safety probe into unbounded history backfill.
            findMissingInDb: !needsAllUidConfirmation
          }
        );

        // Spec §10.7 step 3: missingInDb → fetch + upsert (closes the gap).
        if (reconcile.missingInDbUids.length > 0) {
          const backfillBatchSize = this.config.INCREMENTAL_SYNC_BATCH_SIZE;
          for (let i = 0; i < reconcile.missingInDbUids.length; i += backfillBatchSize) {
            const batchUids = reconcile.missingInDbUids.slice(i, i + backfillBatchSize);
            const metadata = await this.withOperationDeadline(
              client,
              reconcileDeadline,
              "RECONCILE_TOTAL_TIMEOUT_MS",
              "reconcile backfill FETCH",
              () => fetchMessageMetadata(client, batchUids, backfillBatchSize)
            );
            this.assertDeadlineAvailable(
              client,
              reconcileDeadline,
              "RECONCILE_TOTAL_TIMEOUT_MS",
              "reconcile backfill write"
            );
            const messages = await this.upsertMetadataBatch(
              options.metadataWriteStats,
              account.id,
              folder,
              uidValidity,
              metadata,
              windowCutoff,
              { deadlineAt: reconcileDeadline, signal: options.signal }
            );
            backfilled += messages.length;
            for (const message of messages) {
              await this.hooks.onMessageUpsert?.(message);
            }
            if (this.folderHitLockBudget(options)) {
              hitLockBudget = true;
              break;
            }
          }
          await this.repository.logEvent(
            account.id,
            null,
            null,
            folder.path,
            null,
            "RECONCILE_BACKFILL",
            { backfilled, attempted: reconcile.missingInDbUids.length }
          );
        }
        reconcileGapsFound = reconcile.markedCount + reconcile.missingInDbUids.length;
        // Gap count is evidence that the mirror drifted before this pass, not
        // evidence that it is still dirty afterward. Provider-missing rows are
        // tombstoned inside markMissingMessagesFromLiveUidStream, and every
        // returned missing-in-DB UID has been fetched and upserted by this point.
        // Keep health degraded only when the bounded repair was interrupted or
        // the missing-UID result overflowed this pass.
        reconcileClean = !hitLockBudget
          && !reconcile.missingInDbTruncated
          && backfilled === reconcile.missingInDbUids.length;
      }

      await this.repository.markFolderSynced(folder.id, {
        uidValidity,
        uidNext,
        highestModseq: flagScanAttempted ? highestModseq : undefined,
        lastUid: lastProcessedUid,
        initialComplete: true,
        reconcileClean,
        flagScanCompleted: flagScanAttempted ? true : undefined
      }, {
        deadlineAt: Date.now() + SYNC_STATE_WRITE_GRACE_MS,
        signal: options.signal
      });

      return {
        messagesUpserted: messagesUpserted + backfilled,
        flagsUpdated,
        reconcileGapsFound,
        reconcileAttempted,
        flagScanAttempted,
        hitLockBudget,
        initialSyncComplete: true,
        reconcileClean: reconcileClean === true
      };
    } finally {
      mailboxLock.release();
    }
  }

  private async withIncrementalDeadline<T>(
    client: MirrorImapClient,
    deadline: number,
    operation: string,
    run: () => Promise<T>
  ): Promise<T> {
    return this.withOperationDeadline(
      client,
      deadline,
      "INCREMENTAL_TOTAL_TIMEOUT_MS",
      operation,
      run
    );
  }

  private async withInitialSyncDeadline<T>(
    client: MirrorImapClient,
    deadline: number,
    operation: string,
    run: () => Promise<T>
  ): Promise<T> {
    return this.withOperationDeadline(
      client,
      deadline,
      "INITIAL_SYNC_BATCH_TIMEOUT_MS",
      operation,
      run
    );
  }

  private async withOperationDeadline<T>(
    client: MirrorImapClient,
    deadline: number,
    timeoutName: string,
    operation: string,
    run: () => Promise<T>
  ): Promise<T> {
    const remainingMs = this.assertDeadlineAvailable(client, deadline, timeoutName, operation);

    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        this.abortClient(client);
        reject(new Error(`${timeoutName} exceeded during ${operation}`));
      }, remainingMs);
    });

    try {
      return await Promise.race([run(), timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private assertDeadlineAvailable(
    client: MirrorImapClient,
    deadline: number,
    timeoutName: string,
    operation: string
  ): number {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      this.abortClient(client);
      throw new Error(`${timeoutName} exceeded before ${operation}`);
    }
    return remainingMs;
  }

  private async *withAsyncIterableDeadline<T>(
    client: MirrorImapClient,
    deadline: number,
    timeoutName: string,
    operation: string,
    iterable: AsyncIterable<T>
  ): AsyncIterable<T> {
    const iterator = iterable[Symbol.asyncIterator]();
    while (true) {
      const next = await this.withOperationDeadline(
        client,
        deadline,
        timeoutName,
        operation,
        () => iterator.next()
      );
      if (next.done) break;
      yield next.value;
    }
  }

  private abortClient(client: MirrorImapClient): void {
    if (client.close) {
      client.close();
      return;
    }
    void client.logout().catch(() => undefined);
  }

  private isLockBudgetExpired(deadline: number): boolean {
    return Date.now() >= deadline;
  }

  private folderHitLockBudget(options: { enforceLockDeadline: boolean; lockDeadline: number }): boolean {
    return options.enforceLockDeadline && this.isLockBudgetExpired(options.lockDeadline);
  }

  private async upsertMetadataBatch(
    stats: MetadataWriteStats,
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    metadata: MessageMetadata[],
    windowCutoff: Date,
    options: MetadataWriteOptions = {}
  ): Promise<ImapMessage[]> {
    const startedAt = performance.now();
    stats.batchesAttempted += 1;
    try {
      const rows = await this.repository.upsertMessages(
        accountId,
        folder,
        uidValidity,
        metadata,
        windowCutoff,
        options
      );
      stats.rowsCommitted += rows.length;
      return rows;
    } catch (error) {
      stats.batchesFailed += 1;
      throw error;
    } finally {
      stats.durationMs += Math.max(0, performance.now() - startedAt);
    }
  }

  // Spec §10.4: process one bounded live-head batch, then one snapshot batch
  // newest-first. Separate watermarks keep new mail current without moving the
  // frozen snapshot or starving its resumable backfill.
  private async runInitialSyncBatch(
    account: ImapAccount,
    folder: ImapFolder,
    client: MirrorImapClient,
    uidValidity: number,
    uidNext: number | undefined,
    windowCutoff: Date,
    metadataWriteStats: MetadataWriteStats,
    signal?: AbortSignal
  ): Promise<{ messagesUpserted: number; initialSyncComplete: boolean }> {
    const initialSyncDeadline = Date.now() + this.config.INITIAL_SYNC_BATCH_TIMEOUT_MS;
    let targetMaxUid: number | null = folder.initial_sync_target_max_uid
      ? Number(folder.initial_sync_target_max_uid)
      : null;
    let oldestSynced: number | null = folder.initial_sync_oldest_uid_synced
      ? Number(folder.initial_sync_oldest_uid_synced)
      : null;
    let liveHeadUid = folder.last_uid ? Number(folder.last_uid) : 0;

    // First pass for this folder: take the snapshot.
    if (targetMaxUid === null || oldestSynced === null) {
      const snapshot = await this.withInitialSyncDeadline(
        client,
        initialSyncDeadline,
        "initial sync snapshot SEARCH",
        () => searchUidsSince(client, windowCutoff)
      );
      const sortedTargets = [...new Set(snapshot)].sort((a, b) => a - b);

      if (sortedTargets.length === 0) {
        // Empty folder in window — record the snapshot (target=0) and mark complete.
        await this.repository.setInitialSyncSnapshot(
          folder.id,
          0,
          0,
          0,
          uidValidity,
          { deadlineAt: initialSyncDeadline, signal }
        );
        await this.repository.markFolderSynced(folder.id, {
          uidValidity,
          uidNext,
          lastUid: 0,
          initialComplete: true
        }, { deadlineAt: initialSyncDeadline, signal });
        return { messagesUpserted: 0, initialSyncComplete: true };
      }

      targetMaxUid = sortedTargets[sortedTargets.length - 1];
      oldestSynced = targetMaxUid + 1;
      await this.repository.setInitialSyncSnapshot(
        folder.id,
        targetMaxUid,
        oldestSynced,
        sortedTargets.length,
        uidValidity,
        { deadlineAt: initialSyncDeadline, signal }
      );
    }

    // Re-search and bound by the snapshot. Any UIDs the provider has expunged
    // between cycles fall out naturally and we don't try to fetch them.
    const candidates = await this.withInitialSyncDeadline(
      client,
      initialSyncDeadline,
      "initial sync SEARCH",
      () => searchUidsSince(client, windowCutoff)
    );
    const sortedCandidates = [...new Set(candidates)].sort((a, b) => a - b);
    let messagesUpserted = 0;

    const liveBatch = sortedCandidates
      .filter((uid) => uid > targetMaxUid! && uid > liveHeadUid)
      .slice(0, this.config.INCREMENTAL_SYNC_BATCH_SIZE);
    if (liveBatch.length > 0) {
      const liveMetadata = await this.withInitialSyncDeadline(
        client,
        initialSyncDeadline,
        "initial sync live-head FETCH",
        () => fetchMessageMetadata(
          client,
          liveBatch,
          this.config.INCREMENTAL_SYNC_BATCH_SIZE
        )
      );
      this.assertDeadlineAvailable(
        client,
        initialSyncDeadline,
        "INITIAL_SYNC_BATCH_TIMEOUT_MS",
        "initial sync live-head write"
      );
      const liveMessages = await this.upsertMetadataBatch(
        metadataWriteStats,
        account.id,
        folder,
        uidValidity,
        liveMetadata,
        windowCutoff,
        { deadlineAt: initialSyncDeadline, signal }
      );
      messagesUpserted += liveMessages.length;
      for (const message of liveMessages) {
        await this.hooks.onMessageUpsert?.(message);
      }

      liveHeadUid = liveBatch[liveBatch.length - 1];
      this.assertDeadlineAvailable(
        client,
        initialSyncDeadline,
        "INITIAL_SYNC_BATCH_TIMEOUT_MS",
        "initial sync live-head watermark"
      );
      await this.repository.advanceInitialSyncLiveHead(
        folder.id,
        liveHeadUid,
        uidValidity,
        { deadlineAt: initialSyncDeadline, signal }
      );
    }

    const completionLastUid = Math.max(targetMaxUid, liveHeadUid);
    const inSnapshot = sortedCandidates
      .filter((uid) => uid <= targetMaxUid!)
      .sort((a, b) => a - b);

    if (inSnapshot.length === 0) {
      // Everything in the original snapshot has gone away — done.
      await this.repository.markFolderSynced(folder.id, {
        uidValidity,
        uidNext,
        lastUid: completionLastUid,
        initialComplete: true
      }, { deadlineAt: initialSyncDeadline, signal });
      return { messagesUpserted, initialSyncComplete: true };
    }

    // Collect up to one batch of UIDs strictly less than the watermark,
    // walking from the top down (newest-first within the unsynced region).
    const batchSize = this.config.INITIAL_SYNC_BATCH_SIZE;
    const descending: number[] = [];
    for (let i = inSnapshot.length - 1; i >= 0; i--) {
      if (inSnapshot[i] < oldestSynced!) {
        descending.push(inSnapshot[i]);
        if (descending.length >= batchSize) break;
      }
    }

    if (descending.length === 0) {
      // Watermark already at or below the minimum — initial sync is complete.
      await this.repository.markFolderSynced(folder.id, {
        uidValidity,
        uidNext,
        lastUid: completionLastUid,
        initialComplete: true
      }, { deadlineAt: initialSyncDeadline, signal });
      return { messagesUpserted, initialSyncComplete: true };
    }

    const batch = descending.slice().reverse(); // ascending order for FETCH
    const metadata = await this.withInitialSyncDeadline(
      client,
      initialSyncDeadline,
      "initial sync FETCH",
      () => fetchMessageMetadata(client, batch, batchSize)
    );
    this.assertDeadlineAvailable(
      client,
      initialSyncDeadline,
      "INITIAL_SYNC_BATCH_TIMEOUT_MS",
      "initial sync write"
    );
    const messages = await this.upsertMetadataBatch(
      metadataWriteStats,
      account.id,
      folder,
      uidValidity,
      metadata,
      windowCutoff,
      { deadlineAt: initialSyncDeadline, signal }
    );
    messagesUpserted += messages.length;
    for (const message of messages) {
      await this.hooks.onMessageUpsert?.(message);
    }

    const newOldestSynced = batch[0];
    this.assertDeadlineAvailable(
      client,
      initialSyncDeadline,
      "INITIAL_SYNC_BATCH_TIMEOUT_MS",
      "initial sync watermark"
    );
    await this.repository.advanceInitialSyncWatermark(
      folder.id,
      newOldestSynced,
      batch[batch.length - 1],
      uidValidity,
      { deadlineAt: initialSyncDeadline, signal }
    );

    // Was that the last batch?
    const stillRemaining = inSnapshot.some((uid) => uid < newOldestSynced);
    if (!stillRemaining) {
      await this.repository.markFolderSynced(folder.id, {
        uidValidity,
        uidNext,
        lastUid: completionLastUid,
        initialComplete: true
      }, { deadlineAt: initialSyncDeadline, signal });
    }

    return { messagesUpserted, initialSyncComplete: !stillRemaining };
  }

  private historyBatchLimit(account: ImapAccount): number {
    switch (account.max_backfill_rate) {
      case "small":
        return 1;
      case "normal":
        return 3;
      case "aggressive":
        return Number.POSITIVE_INFINITY;
      default:
        return 3;
    }
  }

  private async runHistoryLane(
    account: ImapAccount,
    client: MirrorImapClient,
    lockDeadline: number,
    metadataWriteStats: MetadataWriteStats,
    signal?: AbortSignal
  ): Promise<{ messagesUpserted: number; bodiesFetched: number; hitLockBudget: boolean; errors: string[] }> {
    if (account.historical_backfill_mode === "off") {
      return { messagesUpserted: 0, bodiesFetched: 0, hitLockBudget: false, errors: [] };
    }
    if (!isWithinBackfillWindow(this.config)) {
      return { messagesUpserted: 0, bodiesFetched: 0, hitLockBudget: false, errors: [] };
    }

    let messagesUpserted = 0;
    let bodiesFetched = 0;
    let hitLockBudget = false;
    const errors: string[] = [];
    let batchesProcessed = 0;
    const maxBatches = this.historyBatchLimit(account);

    while (batchesProcessed < maxBatches) {
      if (this.isLockBudgetExpired(lockDeadline)) {
        hitLockBudget = true;
        break;
      }

      const [folder] = await this.repository.getHistoryBacklog(account, 1);
      if (!folder) break;

      let batch: HistoryBatchResult;
      try {
        batch = await this.runHistoryBatch(
          account,
          folder,
          client,
          lockDeadline,
          metadataWriteStats,
          signal
        );
      } catch (error) {
        if (error instanceof AccountAlreadyFinalizedError) throw error;
        const message = describeSyncError(error);
        if (isMissingMailboxError(error)) {
          await this.repository.markFolderPendingVerification(
            account.id,
            folder.id,
            folder.path,
            message
          );
        }
        errors.push(sanitizeErrorReason(`${folder.path}: ${message}`));
        break;
      }
      messagesUpserted += batch.messagesUpserted;
      bodiesFetched += batch.bodiesFetched;
      if (batch.hitLockBudget) {
        hitLockBudget = true;
        break;
      }

      batchesProcessed += 1;
      await this.repository.heartbeat(account.id);

      if (!batch.processed) {
        continue;
      }
    }

    return { messagesUpserted, bodiesFetched, hitLockBudget, errors };
  }

  private async runHistoryBatch(
    account: ImapAccount,
    folder: HistoryBacklogFolder,
    client: MirrorImapClient,
    lockDeadline: number,
    metadataWriteStats: MetadataWriteStats,
    signal?: AbortSignal
  ): Promise<HistoryBatchResult> {
    if (this.isLockBudgetExpired(lockDeadline)) {
      return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: true };
    }

    if (folder.history_backlog_reason === "body") {
      return await this.fetchHistoricalBodyBatch(account, folder, client, lockDeadline, signal);
    }

    const mailboxLock = await client.getMailboxLock(folder.path);

    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error("Mailbox not available after lock");

      const uidValidity = Number(mailbox.uidValidity);
      const storedUidValidity = folder.uidvalidity ? Number(folder.uidvalidity) : null;
      if (storedUidValidity && storedUidValidity !== uidValidity) {
        const { resetCountIn24h } = await this.repository.handleUidValidityReset(
          account,
          folder,
          uidValidity
        );
        if (resetCountIn24h > this.config.MAX_UIDVALIDITY_RESETS_24H) {
          await this.repository.markAccountBroken(
            account.id,
            `UIDVALIDITY_RESET_LIMIT_EXCEEDED: ${resetCountIn24h} resets in 24h on ${folder.path}`
          );
          throw new AccountAlreadyFinalizedError(
            `UIDVALIDITY_RESET_LIMIT_EXCEEDED: ${folder.path}`
          );
        }
        return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: false };
      }

      const windowCutoff = getWindowCutoff(this.config);
      let targetMaxUid: number | null = folder.backfill_target_max_uid
        ? Number(folder.backfill_target_max_uid)
        : null;
      let oldestSynced: number | null = folder.backfill_oldest_uid_synced
        ? Number(folder.backfill_oldest_uid_synced)
        : null;
      const shouldStartSnapshot = folder.history_backlog_reason === "snapshot"
        || folder.history_backlog_reason === "refresh"
        || targetMaxUid === null
        || oldestSynced === null;

      if (shouldStartSnapshot) {
        const snapshot = await searchUidsBefore(client, windowCutoff);
        const sortedTargets = [...new Set(snapshot)].sort((a, b) => a - b);

        if (sortedTargets.length === 0) {
          await this.repository.setHistoryBackfillSnapshot(
            folder.id,
            0,
            0,
            0,
            windowCutoff,
            uidValidity,
            { deadlineAt: Date.now() + HISTORY_METADATA_COMMIT_GRACE_MS, signal }
          );
          return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: false };
        }

        targetMaxUid = sortedTargets[sortedTargets.length - 1];
        oldestSynced = targetMaxUid + 1;
        await this.repository.setHistoryBackfillSnapshot(
          folder.id,
          targetMaxUid,
          oldestSynced,
          sortedTargets.length,
          windowCutoff,
          uidValidity,
          { deadlineAt: Date.now() + HISTORY_METADATA_COMMIT_GRACE_MS, signal }
        );
      }

      if (this.isLockBudgetExpired(lockDeadline)) {
        return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: true };
      }

      const candidates = await searchUidsBefore(client, windowCutoff);
      const inSnapshot = [...new Set(candidates)]
        .filter((uid) => uid <= targetMaxUid!)
        .sort((a, b) => a - b);

      if (inSnapshot.length === 0) {
        await this.repository.markHistoryBackfillComplete(folder.id, uidValidity, {
          deadlineAt: Date.now() + HISTORY_METADATA_COMMIT_GRACE_MS,
          signal
        });
        return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: false };
      }

      const batchSize = this.config.BODY_BACKFILL_BATCH_SIZE;
      const descending: number[] = [];
      for (let i = inSnapshot.length - 1; i >= 0; i--) {
        if (inSnapshot[i] < oldestSynced!) {
          descending.push(inSnapshot[i]);
          if (descending.length >= batchSize) break;
        }
      }

      if (descending.length === 0) {
        await this.repository.markHistoryBackfillComplete(folder.id, uidValidity, {
          deadlineAt: Date.now() + HISTORY_METADATA_COMMIT_GRACE_MS,
          signal
        });
        return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: false };
      }

      const batch = descending.slice().reverse();
      const metadata = await fetchMessageMetadata(client, batch, batchSize);
      const stillRemaining = inSnapshot.some((uid) => uid < batch[0]);
      const historyWriteDeadline = Date.now() + Math.min(
        HISTORY_METADATA_COMMIT_GRACE_MS,
        this.config.INCREMENTAL_TOTAL_TIMEOUT_MS
      );
      const messages = await this.upsertMetadataBatch(
        metadataWriteStats,
        account.id,
        folder,
        uidValidity,
        metadata,
        windowCutoff,
        {
          preserveExistingFlags: !account.archive_flag_sync,
          deadlineAt: historyWriteDeadline,
          signal
        }
      );
      for (const message of messages) {
        await this.hooks.onMessageUpsert?.(message);
      }

      let bodiesFetched = 0;
      if (account.historical_backfill_mode === "metadata_and_bodies") {
        // We already hold the mailbox lock for `folder` here; skip re-locking
        // inside the body helpers so imapflow's non-reentrant lock cannot
        // deadlock.
        bodiesFetched = await this.fetchAndStoreBodies(
          client,
          messages.filter((row) => !row.body_fetched_at),
          {
            skipMailboxLock: true,
            shouldStop: () => this.isLockBudgetExpired(lockDeadline)
          }
        );
      }

      const progressDeadline = Date.now() + HISTORY_METADATA_COMMIT_GRACE_MS;
      await this.repository.advanceHistoryBackfillWatermark(
        folder.id,
        batch[0],
        batch[batch.length - 1],
        uidValidity,
        { complete: !stillRemaining, deadlineAt: progressDeadline, signal }
      );

      return {
        messagesUpserted: messages.length,
        bodiesFetched,
        processed: true,
        hitLockBudget: this.isLockBudgetExpired(lockDeadline)
      };
    } finally {
      mailboxLock.release();
    }
  }

  private async fetchHistoricalBodyBatch(
    account: ImapAccount,
    folder: ImapFolder,
    client: MirrorImapClient,
    lockDeadline: number,
    signal?: AbortSignal
  ): Promise<HistoryBatchResult> {
    const backlog = await this.repository.getHistoricalBodyBacklog(
      account.id,
      folder,
      this.config.BODY_BACKFILL_BATCH_SIZE
    );
    if (backlog.length === 0) {
      const expectedUidValidity = Number(folder.uidvalidity);
      if (!Number.isSafeInteger(expectedUidValidity) || expectedUidValidity <= 0) {
        throw new Error(`History completion missing UIDVALIDITY for ${folder.path}`);
      }
      await this.repository.markHistoryBackfillComplete(folder.id, expectedUidValidity, {
        deadlineAt: Date.now() + HISTORY_METADATA_COMMIT_GRACE_MS,
        signal
      });
      return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: false };
    }

    const fetched = await this.fetchAndStoreBodies(client, backlog, {
      shouldStop: () => this.isLockBudgetExpired(lockDeadline)
    });

    return {
      messagesUpserted: 0,
      bodiesFetched: fetched,
      processed: fetched > 0,
      hitLockBudget: this.isLockBudgetExpired(lockDeadline)
    };
  }

  private async fetchBodyBacklog(
    account: ImapAccount,
    client: MirrorImapClient,
    lockDeadline: number
  ): Promise<{ fetched: number; hitLockBudget: boolean }> {
    let fetched = 0;
    let hitLockBudget = false;
    let batchesRemaining = this.config.MAX_BODY_BATCHES_PER_TICK;

    while (batchesRemaining > 0) {
      if (this.isLockBudgetExpired(lockDeadline)) {
        hitLockBudget = true;
        break;
      }

      const readLimit = bodyBacklogReadLimit(
        this.config.BODY_BACKFILL_BATCH_SIZE,
        batchesRemaining
      );
      const backlog = await this.repository.getBodyBacklog(account, readLimit);
      if (backlog.length === 0) break;

      for (
        let offset = 0;
        offset < backlog.length && batchesRemaining > 0;
        offset += this.config.BODY_BACKFILL_BATCH_SIZE
      ) {
        const logicalBatch = backlog.slice(
          offset,
          offset + this.config.BODY_BACKFILL_BATCH_SIZE
        );

        fetched += await this.fetchAndStoreBodies(client, logicalBatch);

        batchesRemaining -= 1;
        if (this.isLockBudgetExpired(lockDeadline)) {
          hitLockBudget = true;
          break;
        }
      }

      if (hitLockBudget || backlog.length < readLimit) break;
    }

    return { fetched, hitLockBudget };
  }

  private parsedBodyBatchAt(backlog: ImapMessage[], start: number): ImapMessage[] {
    if (this.config.BODY_STORAGE_MODE !== "parsed_only") return [];
    const first = backlog[start];
    if (!this.isSmallCompleteBody(first)) return [];

    const messages: ImapMessage[] = [];
    let totalSourceBytes = 0;
    for (
      let index = start;
      index < backlog.length && messages.length < PARSED_BODY_BATCH_MAX_MESSAGES;
      index += 1
    ) {
      const message = backlog[index];
      if (message.folder_path !== first.folder_path || !this.isSmallCompleteBody(message)) break;
      const sourceBytes = Number(message.size_bytes);
      if (totalSourceBytes + sourceBytes > PARSED_BODY_BATCH_MAX_TOTAL_SOURCE_BYTES) break;
      messages.push(message);
      totalSourceBytes += sourceBytes;
    }
    return messages;
  }

  private isSmallCompleteBody(message: ImapMessage): boolean {
    const size = Number(message.size_bytes);
    return Number.isSafeInteger(size)
      && size > 0
      && size <= this.config.BODY_RAW_MAX_BYTES
      && size <= PARSED_BODY_BATCH_MAX_SOURCE_BYTES;
  }

  private async fetchAndStoreBodyBatch(
    client: MirrorImapClient,
    messages: ImapMessage[],
    skipMailboxLock = false
  ): Promise<number> {
    const result = await fetchFullMessageBodyBatch(
      client,
      this.config,
      messages,
      { skipMailboxLock }
    );
    await this.repository.storeBodyEvidenceBatch(result.bodies.map(({ body }) => body));
    let processed = 0;
    for (const { message, body } of result.bodies) {
      await this.commitBodyPayload(message, body);
      processed += 1;
    }
    for (const message of result.missingMessages) {
      // A successful set FETCH can still omit a response or its source. That
      // is not enough evidence to tombstone the row. Retry the exact UID
      // through the individual path, which marks MOVED_OUT only when the
      // dedicated download confirms that the message is gone.
      await this.fetchAndStoreBody(client, message, skipMailboxLock);
      processed += 1;
    }
    return processed;
  }

  private async fetchAndStoreBodies(
    client: MirrorImapClient,
    messages: ImapMessage[],
    options: {
      skipMailboxLock?: boolean;
      shouldStop?: () => boolean;
    } = {}
  ): Promise<number> {
    const ordered = this.config.BODY_STORAGE_MODE === "parsed_only"
      ? this.groupBodiesByFolder(messages)
      : messages;
    let processed = 0;

    for (let index = 0; index < ordered.length;) {
      if (options.shouldStop?.()) break;
      const batchMessages = this.parsedBodyBatchAt(ordered, index);
      if (batchMessages.length > 1) {
        processed += await this.fetchAndStoreBodyBatch(
          client,
          batchMessages,
          options.skipMailboxLock
        );
        index += batchMessages.length;
        continue;
      }

      await this.fetchAndStoreBody(client, ordered[index], options.skipMailboxLock);
      processed += 1;
      index += 1;
    }
    return processed;
  }

  private groupBodiesByFolder(messages: ImapMessage[]): ImapMessage[] {
    const byFolder = new Map<string, ImapMessage[]>();
    for (const message of messages) {
      const folder = byFolder.get(message.folder_path);
      if (folder) {
        folder.push(message);
      } else {
        byFolder.set(message.folder_path, [message]);
      }
    }
    return [...byFolder.values()].flat();
  }

  private async fetchAndStoreBody(
    client: MirrorImapClient,
    message: ImapMessage,
    skipMailboxLock = false
  ): Promise<void> {
    let body;
    try {
      body = await fetchFullMessageBody(client, this.config, message, { skipMailboxLock });
    } catch (error) {
      if (error instanceof MessageMovedError) {
        await this.recordMovedBody(message);
        return;
      }
      throw error;
    }
    await this.commitBody(message, body);
  }

  private async recordMovedBody(message: ImapMessage): Promise<void> {
    // The UID vanished between metadata sync and body fetch. Get it out of the
    // backlog without re-throwing into the account-level catch (which bricks the
    // account to BROKEN and re-loops every backfill) — but scope the tombstone by
    // window, because only IN_WINDOW rows self-heal.
    if (message.window_status === "IN_WINDOW") {
      // A later metadata sync's ON CONFLICT resets deleted_in_provider, so a rare
      // transient false-negative recovers. Safe to soft-delete MOVED_OUT.
      await this.repository.markMessageMovedOut(message.id);
    } else {
      // HISTORICAL/EXPIRED rows are never re-observed (backfill walks strictly
      // backward) and reconcile is IN_WINDOW-only, so tombstoning would be
      // unrecoverable. Mark the body fetch attempted instead — non-destructive.
      await this.repository.markBodyFetchAttempted(message.id);
    }
  }

  private async commitBody(
    message: ImapMessage,
    body: Awaited<ReturnType<typeof fetchFullMessageBody>>
  ): Promise<void> {
    await this.repository.storeBodyEvidence(body);
    await this.commitBodyPayload(message, body);
  }

  private async commitBodyPayload(
    message: ImapMessage,
    body: Awaited<ReturnType<typeof fetchFullMessageBody>>
  ): Promise<void> {
    await this.bodyStore.store(body);
    await this.repository.completeBodyStorage(body.messageId);
    await this.hooks.onBodyFetched?.(message, body);
  }
}
