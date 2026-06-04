import type { AppConfig } from "./config.js";
import { getConfig, getWindowCutoff } from "./config.js";
import type { PgPool } from "./db.js";
import { getPool } from "./db.js";
import { fetchFullMessageBody, fetchMessageMetadata, iterateAllUids, searchUidsBefore, searchUidsSince } from "./imap-client.js";
import type { MailboxListItem, MirrorImapClient } from "./imap-client.js";
import { clearOrphanedLockForAccount, withAccountLock } from "./locks.js";
import { MirrorRepository, sanitizeErrorReason } from "./repository.js";
import type {
  ImapAccount,
  ImapFolder,
  ImapMessage,
  HistoryBacklogFolder,
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
const AUTH_ERROR_PATTERNS = [
  /authentication failed/i,
  /invalid credentials/i,
  /invalid (user|username|login)/i,
  /incorrect password/i,
  /login failed/i,
  /auth(?:enticate)? failed/i,
  /AUTHENTICATIONFAILED/i,
  /\bNO LOGIN\b/i,
  /\b535\b/, // SMTP/IMAP auth fail code
];

const MISSING_MAILBOX_RESPONSE_CODES = new Set(["NONEXISTENT", "TRYCREATE"]);
const MISSING_MAILBOX_PATTERNS = [
  /\bNONEXISTENT\b/i,
  /\bTRYCREATE\b/i,
  /does not exist/i,
  /no such mailbox/i,
  /mailbox not found/i
];

const RACKSPACE_INBOX_ALIAS_PATH = "INBOX.INBOX";
const RACKSPACE_INBOX_ALIAS_CANONICAL_PATH = "INBOX";
const FOLDER_ALIAS_SAMPLE_SIZE = 5;
const FOLDER_ALIAS_SAMPLE_UID_WINDOW = 100;

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
};

type HistoryBatchResult = {
  messagesUpserted: number;
  bodiesFetched: number;
  processed: boolean;
  hitLockBudget: boolean;
};

export function isAuthError(message: string): boolean {
  return AUTH_ERROR_PATTERNS.some((p) => p.test(message));
}

export function isMissingMailboxError(error: unknown): boolean {
  const responseCode = extractImapResponseCode(error);
  if (responseCode) {
    return MISSING_MAILBOX_RESPONSE_CODES.has(responseCode);
  }

  const message = error instanceof Error ? error.message : String(error);
  return MISSING_MAILBOX_PATTERNS.some((pattern) => pattern.test(message));
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

export interface MirrorEngineOptions {
  pool?: PgPool;
  config?: AppConfig;
  repository?: MirrorRepository;
  hooks?: MirrorHooks;
  clientFactory?: (account: ImapAccount) => Promise<MirrorImapClient>;
}

export class MirrorEngine {
  private readonly pool: PgPool;
  private readonly config: AppConfig;
  private readonly repository: MirrorRepository;
  private readonly hooks: MirrorHooks;
  private readonly clientFactory: (account: ImapAccount) => Promise<MirrorImapClient>;

  constructor(options: MirrorEngineOptions = {}) {
    this.pool = options.pool ?? getPool();
    this.config = options.config ?? getConfig();
    this.repository = options.repository ?? new MirrorRepository(this.pool, this.config);
    this.hooks = options.hooks ?? {};
    this.clientFactory = options.clientFactory ?? ((account) => createImapClient(this.pool, this.config, account));
  }

  async syncDueAccounts(
    limit = 10,
    options: { signal?: AbortSignal } = {}
  ): Promise<SyncResult[]> {
    const accounts = await this.repository.getRunnableAccounts(limit);
    const results: SyncResult[] = [];

    for (const account of accounts) {
      if (options.signal?.aborted) break;
      results.push(await this.syncAccount(account.id, "scheduled"));
    }

    return results;
  }

  async syncAccount(accountId: string, triggerType: SyncTriggerType = "manual"): Promise<SyncResult> {
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);

    const runId = await this.repository.startSyncRun(account.id, triggerType);
    const result: SyncResult = {
      runId,
      outcome: "success",
      foldersProcessed: 0,
      messagesUpserted: 0,
      bodiesFetched: 0,
      flagsUpdated: 0,
      reconcileGapsFound: 0,
      hitLockBudget: false,
      errors: []
    };

    const runLockedSync = () => withAccountLock(this.pool, account.lock_id, async () => {
      const lockDeadline = Date.now() + this.config.MAX_LOCK_HOLD_MS;
      await this.repository.markAccountSyncStarted(account.id, `supamail:${process.pid}`);
      let client: MirrorImapClient | null = null;

      try {
        client = await this.clientFactory(account);

        if (this.shouldDiscoverFolders(account)) {
          await this.discoverFolders(account, client);
        }

        const folders = await this.repository.getFoldersDueForSync(account.id);
        let priorityFolderFailed = false;
        let remainingReconciles = this.config.MAX_RECONCILES_PER_CYCLE;
        let remainingFlagScans = this.config.MAX_FLAG_SCANS_PER_CYCLE;
        for (const folder of folders) {
          const isPriorityFolder = folder.sync_priority <= this.config.PRIORITY_CUTOFF;
          if (this.isLockBudgetExpired(lockDeadline) && !isPriorityFolder) {
            result.hitLockBudget = true;
            break;
          }

          try {
            const folderResult = await this.syncFolder(account, folder, client, {
              allowReconcile: remainingReconciles > 0,
              allowFlagScan: remainingFlagScans > 0,
              enforceLockDeadline: !isPriorityFolder,
              lockDeadline
            });
            result.foldersProcessed += 1;
            result.messagesUpserted += folderResult.messagesUpserted;
            result.flagsUpdated += folderResult.flagsUpdated;
            result.reconcileGapsFound += folderResult.reconcileGapsFound;
            if (folderResult.hitLockBudget || this.isLockBudgetExpired(lockDeadline)) {
              result.hitLockBudget = true;
            }
            if (folderResult.reconcileAttempted) remainingReconciles -= 1;
            if (folderResult.flagScanAttempted) remainingFlagScans -= 1;
            await this.repository.heartbeat(account.id);
          } catch (error) {
            // Account-finalising errors (e.g. UIDVALIDITY reset cap exceeded)
            // must escape the per-folder catch so the outer handler sees them
            // and skips re-marking; otherwise markAccountSyncPartial overrides
            // the BROKEN state with DEGRADED.
            if (error instanceof AccountAlreadyFinalizedError) throw error;
            const sanitizedPath = folder.path.replace(/[\x00-\x1F\x7F]+/g, " ").slice(0, 200);
            const message = error instanceof Error ? error.message : String(error);
            if (isMissingMailboxError(error)) {
              await this.repository.markFolderPendingVerification(
                account.id,
                folder.id,
                folder.path,
                message
              );
            }
            if (folder.sync_priority <= this.config.PRIORITY_CUTOFF) priorityFolderFailed = true;
            result.errors.push(sanitizeErrorReason(`${sanitizedPath}: ${message}`));
          }
        }

        if (this.isLockBudgetExpired(lockDeadline)) {
          result.hitLockBudget = true;
        } else {
          const bodyResult = await this.fetchBodyBacklog(account, client, lockDeadline);
          result.bodiesFetched += bodyResult.fetched;
          if (bodyResult.hitLockBudget) result.hitLockBudget = true;
        }

        if (this.isLockBudgetExpired(lockDeadline)) {
          result.hitLockBudget = true;
        } else {
          const historyResult = await this.runHistoryLane(account, client, lockDeadline);
          result.messagesUpserted += historyResult.messagesUpserted;
          result.bodiesFetched += historyResult.bodiesFetched;
          result.errors.push(...historyResult.errors);
          if (historyResult.hitLockBudget) result.hitLockBudget = true;
        }

        if (result.errors.length > 0) {
          result.outcome = priorityFolderFailed ? "failed" : "partial_success";
        }

        if (result.outcome === "failed") {
          await this.repository.markAccountSyncFailed(account.id, result.errors.join("; "));
        } else if (result.outcome === "partial_success") {
          await this.repository.markAccountSyncPartial(account.id, result.errors.join("; "), {
            countsTowardBackoff: !result.hitLockBudget
          });
        } else {
          await this.repository.markAccountSyncSucceeded(account.id, {
            countsTowardBackoff: !result.hitLockBudget
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.outcome = "failed";
        result.errors.push(sanitizeErrorReason(message));
        if (error instanceof AccountAlreadyFinalizedError) {
          // Account state was already persisted (e.g. UIDVALIDITY reset limit
          // exceeded → BROKEN). Don't re-mark; that would override BROKEN with
          // the DEGRADED/BROKEN-via-threshold CASE expression.
        } else if (isAuthError(message)) {
          await this.repository.markAccountSyncAuthFailed(account.id, message);
        } else {
          await this.repository.markAccountSyncFailed(account.id, message);
        }
      } finally {
        if (client) await client.logout().catch(() => undefined);
      }
    });

    let locked = await runLockedSync();
    if (locked === null) {
      const recovered = await clearOrphanedLockForAccount(
        this.pool,
        account.lock_id,
        this.config.STALE_HEARTBEAT_MS
      );
      if (recovered) {
        locked = await runLockedSync();
      }
    }

    if (locked === null) {
      result.outcome = "failed";
      result.errors.push("Account lock busy");
      await this.repository.updateSyncRunStatus(runId, "failed", "Account lock busy");
      return result;
    }

    await this.repository.finishSyncRun(result);
    await this.hooks.onSyncRunCompleted?.(result);
    return result;
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
    }
  ): Promise<FolderSyncResult> {
    await this.repository.markFolderSyncStarted(folder.id);
    const mailboxLock = await client.getMailboxLock(folder.path);

    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error("Mailbox not available after lock");

      const uidValidity = Number(mailbox.uidValidity);
      const uidNext = mailbox.uidNext ?? undefined;
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
          hitLockBudget: false
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
          windowCutoff
        );
        return {
          messagesUpserted: initial.messagesUpserted,
          flagsUpdated: 0,
          reconcileGapsFound: 0,
          reconcileAttempted: false,
          flagScanAttempted: false,
          hitLockBudget: this.folderHitLockBudget(options)
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
        const messages = await this.repository.upsertMessages(
          account.id,
          folder,
          uidValidity,
          metadata,
          windowCutoff
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

      const flagScanDue = !folder.next_flag_scan_at || new Date(folder.next_flag_scan_at).getTime() <= Date.now();
      if (this.folderHitLockBudget(options)) hitLockBudget = true;
      if (!hitLockBudget && flagScanDue && options.allowFlagScan) {
        flagScanAttempted = true;
        const flagScanDeadline = Date.now() + this.config.FLAG_SCAN_TOTAL_TIMEOUT_MS;
        const flagCutoff = new Date();
        flagCutoff.setDate(flagCutoff.getDate() - this.config.FLAG_DIFF_WINDOW_DAYS);
        const flagUids = [
          ...new Set(await this.withOperationDeadline(
            client,
            flagScanDeadline,
            "FLAG_SCAN_TOTAL_TIMEOUT_MS",
            "flag scan SEARCH",
            () => searchUidsSince(client, flagCutoff)
          ))
        ].sort((a, b) => a - b);
        if (flagUids.length > 0) {
          const metadata = await this.withOperationDeadline(
            client,
            flagScanDeadline,
            "FLAG_SCAN_TOTAL_TIMEOUT_MS",
            "flag scan FETCH",
            () => fetchMessageMetadata(client, flagUids, incrementalBatchSize)
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
            metadata,
            windowCutoff
          );
          flagsUpdated += scan.flagsChanged;
          for (const message of scan.messages) {
            await this.hooks.onMessageUpsert?.(message);
          }
        }
      }

      if (this.folderHitLockBudget(options)) hitLockBudget = true;
      let reconcileClean: boolean | undefined;
      const reconcileDue = !folder.last_full_reconcile_at
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
        const reconcile = await this.repository.markMissingMessagesFromLiveUidStream(
          account.id,
          folder,
          uidValidity,
          this.withAsyncIterableDeadline(
            client,
            reconcileDeadline,
            "RECONCILE_TOTAL_TIMEOUT_MS",
            "reconcile UID stream",
            iterateAllUids(client, windowCutoff)
          ),
          {
            failIfEmpty: shouldFailOnEmptyReconcile,
            emptyError: `Reconcile returned no UIDs for non-empty mailbox ${folder.path}`
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
            const messages = await this.repository.upsertMessages(
              account.id,
              folder,
              uidValidity,
              metadata,
              windowCutoff
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
        reconcileClean = reconcileGapsFound === 0;
      }

      await this.repository.markFolderSynced(folder.id, {
        uidValidity,
        uidNext,
        lastUid: lastProcessedUid,
        initialComplete: true,
        reconcileClean,
        flagScanCompleted: flagScanAttempted ? true : undefined
      });

      return {
        messagesUpserted: messagesUpserted + backfilled,
        flagsUpdated,
        reconcileGapsFound,
        reconcileAttempted,
        flagScanAttempted,
        hitLockBudget
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

  // Spec §10.4: process ONE batch per cycle, newest-first, advancing the
  // watermark only after a successful upsert. Multi-cycle runs gives big
  // mailboxes resumability and prevents one folder from monopolising a tick.
  private async runInitialSyncBatch(
    account: ImapAccount,
    folder: ImapFolder,
    client: MirrorImapClient,
    uidValidity: number,
    uidNext: number | undefined,
    windowCutoff: Date
  ): Promise<{ messagesUpserted: number }> {
    const initialSyncDeadline = Date.now() + this.config.INITIAL_SYNC_BATCH_TIMEOUT_MS;
    let targetMaxUid: number | null = folder.initial_sync_target_max_uid
      ? Number(folder.initial_sync_target_max_uid)
      : null;
    let oldestSynced: number | null = folder.initial_sync_oldest_uid_synced
      ? Number(folder.initial_sync_oldest_uid_synced)
      : null;

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
        await this.repository.setInitialSyncSnapshot(folder.id, 0, 0, 0);
        await this.repository.markFolderSynced(folder.id, {
          uidValidity,
          uidNext,
          lastUid: 0,
          initialComplete: true
        });
        return { messagesUpserted: 0 };
      }

      targetMaxUid = sortedTargets[sortedTargets.length - 1];
      oldestSynced = targetMaxUid + 1;
      await this.repository.setInitialSyncSnapshot(folder.id, targetMaxUid, oldestSynced, sortedTargets.length);
    }

    // Re-search and bound by the snapshot. Any UIDs the provider has expunged
    // between cycles fall out naturally and we don't try to fetch them.
    const candidates = await this.withInitialSyncDeadline(
      client,
      initialSyncDeadline,
      "initial sync SEARCH",
      () => searchUidsSince(client, windowCutoff)
    );
    const inSnapshot = [...new Set(candidates)]
      .filter((uid) => uid <= targetMaxUid!)
      .sort((a, b) => a - b);

    if (inSnapshot.length === 0) {
      // Everything in the original snapshot has gone away — done.
      await this.repository.markFolderSynced(folder.id, {
        uidValidity,
        uidNext,
        lastUid: targetMaxUid,
        initialComplete: true
      });
      return { messagesUpserted: 0 };
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
        lastUid: targetMaxUid,
        initialComplete: true
      });
      return { messagesUpserted: 0 };
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
    const messages = await this.repository.upsertMessages(
      account.id,
      folder,
      uidValidity,
      metadata,
      windowCutoff
    );
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
      batch[batch.length - 1]
    );

    // Was that the last batch?
    const stillRemaining = inSnapshot.some((uid) => uid < newOldestSynced);
    if (!stillRemaining) {
      await this.repository.markFolderSynced(folder.id, {
        uidValidity,
        uidNext,
        lastUid: targetMaxUid,
        initialComplete: true
      });
    }

    return { messagesUpserted: messages.length };
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
    lockDeadline: number
  ): Promise<{ messagesUpserted: number; bodiesFetched: number; hitLockBudget: boolean; errors: string[] }> {
    if (account.historical_backfill_mode === "off") {
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
        batch = await this.runHistoryBatch(account, folder, client, lockDeadline);
      } catch (error) {
        if (error instanceof AccountAlreadyFinalizedError) throw error;
        const message = error instanceof Error ? error.message : String(error);
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
    lockDeadline: number
  ): Promise<HistoryBatchResult> {
    if (this.isLockBudgetExpired(lockDeadline)) {
      return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: true };
    }

    if (folder.history_backlog_reason === "body") {
      return await this.fetchHistoricalBodyBatch(account, folder, client, lockDeadline);
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
          await this.repository.setHistoryBackfillSnapshot(folder.id, 0, 0, 0, windowCutoff);
          return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: false };
        }

        targetMaxUid = sortedTargets[sortedTargets.length - 1];
        oldestSynced = targetMaxUid + 1;
        await this.repository.setHistoryBackfillSnapshot(
          folder.id,
          targetMaxUid,
          oldestSynced,
          sortedTargets.length,
          windowCutoff
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
        await this.repository.markHistoryBackfillComplete(folder.id);
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
        await this.repository.markHistoryBackfillComplete(folder.id);
        return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: false };
      }

      const batch = descending.slice().reverse();
      const metadata = await fetchMessageMetadata(client, batch, batchSize);
      const messages = await this.repository.upsertMessages(
        account.id,
        folder,
        uidValidity,
        metadata,
        windowCutoff,
        { preserveExistingFlags: !account.archive_flag_sync }
      );
      for (const message of messages) {
        await this.hooks.onMessageUpsert?.(message);
      }

      let bodiesFetched = 0;
      if (account.historical_backfill_mode === "metadata_and_bodies") {
        for (const message of messages.filter((row) => !row.body_fetched_at)) {
          if (this.isLockBudgetExpired(lockDeadline)) {
            break;
          }
          // We already hold the mailbox lock for `folder` here; skip re-locking inside
          // fetchFullMessageBody so it doesn't deadlock on imapflow's non-reentrant lock.
          await this.fetchAndStoreBody(client, message, true);
          bodiesFetched += 1;
        }
      }

      await this.repository.advanceHistoryBackfillWatermark(
        folder.id,
        batch[0],
        batch[batch.length - 1]
      );

      const stillRemaining = inSnapshot.some((uid) => uid < batch[0]);
      if (!stillRemaining) {
        await this.repository.markHistoryBackfillComplete(folder.id);
      }

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
    lockDeadline: number
  ): Promise<HistoryBatchResult> {
    const backlog = await this.repository.getHistoricalBodyBacklog(
      account.id,
      folder,
      this.config.BODY_BACKFILL_BATCH_SIZE
    );
    if (backlog.length === 0) {
      await this.repository.markHistoryBackfillComplete(folder.id);
      return { messagesUpserted: 0, bodiesFetched: 0, processed: false, hitLockBudget: false };
    }

    let fetched = 0;
    for (const message of backlog) {
      if (this.isLockBudgetExpired(lockDeadline)) {
        return { messagesUpserted: 0, bodiesFetched: fetched, processed: fetched > 0, hitLockBudget: true };
      }
      await this.fetchAndStoreBody(client, message);
      fetched += 1;
    }

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

    for (let batch = 0; batch < this.config.MAX_BODY_BATCHES_PER_TICK; batch += 1) {
      if (this.isLockBudgetExpired(lockDeadline)) {
        hitLockBudget = true;
        break;
      }

      const backlog = await this.repository.getBodyBacklog(account, this.config.BODY_BACKFILL_BATCH_SIZE);
      if (backlog.length === 0) break;

      for (const message of backlog) {
        await this.fetchAndStoreBody(client, message);
        fetched += 1;
      }

      if (backlog.length < this.config.BODY_BACKFILL_BATCH_SIZE) break;
      if (this.isLockBudgetExpired(lockDeadline)) {
        hitLockBudget = true;
        break;
      }
    }

    return { fetched, hitLockBudget };
  }

  private async fetchAndStoreBody(
    client: MirrorImapClient,
    message: ImapMessage,
    skipMailboxLock = false
  ): Promise<void> {
    const body = await fetchFullMessageBody(client, this.config, message, { skipMailboxLock });
    await this.repository.storeBody(body);
    await this.hooks.onBodyFetched?.(message, body);
  }
}
