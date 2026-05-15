import type { AppConfig } from "./config.js";
import { getConfig, getWindowCutoff } from "./config.js";
import type { PgPool } from "./db.js";
import { getPool } from "./db.js";
import { fetchFullMessageBody, fetchMessageMetadata, iterateAllUids, searchUidsSince } from "./imap-client.js";
import type { MirrorImapClient } from "./imap-client.js";
import { withAccountLock } from "./locks.js";
import { MirrorRepository, sanitizeErrorReason } from "./repository.js";
import type {
  ImapAccount,
  ImapFolder,
  ImapMessage,
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

export function isAuthError(message: string): boolean {
  return AUTH_ERROR_PATTERNS.some((p) => p.test(message));
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
      errors: []
    };

    const locked = await withAccountLock(this.pool, account.lock_id, async () => {
      await this.repository.markAccountSyncStarted(account.id, `supamail:${process.pid}`);
      let client: MirrorImapClient | null = null;

      try {
        client = await this.clientFactory(account);

        if (this.shouldDiscoverFolders(account)) {
          await this.discoverFolders(account, client);
        }

        const folders = await this.repository.getFoldersDueForSync(account.id);
        for (const folder of folders) {
          try {
            const folderResult = await this.syncFolder(account, folder, client);
            result.foldersProcessed += 1;
            result.messagesUpserted += folderResult.messagesUpserted;
            result.reconcileGapsFound += folderResult.reconcileGapsFound;
            await this.repository.heartbeat(account.id);
          } catch (error) {
            // Account-finalising errors (e.g. UIDVALIDITY reset cap exceeded)
            // must escape the per-folder catch so the outer handler sees them
            // and skips re-marking; otherwise markAccountSyncPartial overrides
            // the BROKEN state with DEGRADED.
            if (error instanceof AccountAlreadyFinalizedError) throw error;
            const sanitizedPath = folder.path.replace(/[\x00-\x1F\x7F]+/g, " ").slice(0, 200);
            const message = error instanceof Error ? error.message : String(error);
            result.errors.push(sanitizeErrorReason(`${sanitizedPath}: ${message}`));
          }
        }

        result.bodiesFetched += await this.fetchBodyBacklog(account, client);

        if (result.errors.length > 0) {
          result.outcome = result.messagesUpserted > 0 || result.foldersProcessed > 0 ? "partial_success" : "failed";
        }

        if (result.outcome === "failed") {
          await this.repository.markAccountSyncFailed(account.id, result.errors.join("; "));
        } else if (result.outcome === "partial_success") {
          await this.repository.markAccountSyncPartial(account.id, result.errors.join("; "));
        } else {
          await this.repository.markAccountSyncSucceeded(account.id);
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

    const upserted = await this.repository.upsertDiscoveredFolders(
      account,
      folders.map((folder) => ({
        path: folder.path,
        delimiter: folder.delimiter ?? null,
        specialUse: folder.specialUse ?? null
      }))
    );

    for (const folder of upserted) {
      await this.hooks.onFolderChanged?.(folder);
    }
  }

  private async syncFolder(
    account: ImapAccount,
    folder: ImapFolder,
    client: MirrorImapClient
  ): Promise<{ messagesUpserted: number; reconcileGapsFound: number }> {
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
        return { messagesUpserted: 0, reconcileGapsFound: 0 };
      }

      const windowCutoff = getWindowCutoff(this.config);
      let messagesUpserted = 0;

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
        return { messagesUpserted: initial.messagesUpserted, reconcileGapsFound: 0 };
      }

      // Spec §10.5: incremental sync — only UIDs > last_uid, in window.
      const lastUid = folder.last_uid ? Number(folder.last_uid) : 0;
      const uidFloor = lastUid + 1;
      const uidCeiling = Math.max(uidFloor, uidNext ? uidNext - 1 : uidFloor);
      const incomingUids = [
        ...new Set(
          (await searchUidsSince(client, windowCutoff, `${uidFloor}:${uidCeiling}`))
            .filter((uid) => uid > lastUid)
        )
      ].sort((a, b) => a - b);

      const incrementalBatchSize = this.config.INCREMENTAL_SYNC_BATCH_SIZE;
      for (let i = 0; i < incomingUids.length; i += incrementalBatchSize) {
        const batchUids = incomingUids.slice(i, i + incrementalBatchSize);
        const metadata = await fetchMessageMetadata(client, batchUids, incrementalBatchSize);
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
      }

      // Spec §10.7: only reconcile once initial sync is complete (otherwise
      // unfinished backfill looks like a "gap"). The temp-table stream surfaces
      // both deletions (missing-on-server) and gaps (missing-in-db).
      const reconcile = await this.repository.markMissingMessagesFromLiveUidStream(
        account.id,
        folder,
        uidValidity,
        iterateAllUids(client),
        {
          failIfEmpty: (mailbox.exists ?? 0) > 0,
          emptyError: `Reconcile returned no UIDs for non-empty mailbox ${folder.path}`
        }
      );

      // Spec §10.7 step 3: missingInDb → fetch + upsert (closes the gap).
      let backfilled = 0;
      if (reconcile.missingInDbUids.length > 0) {
        const backfillBatchSize = this.config.INCREMENTAL_SYNC_BATCH_SIZE;
        for (let i = 0; i < reconcile.missingInDbUids.length; i += backfillBatchSize) {
          const batchUids = reconcile.missingInDbUids.slice(i, i + backfillBatchSize);
          const metadata = await fetchMessageMetadata(client, batchUids, backfillBatchSize);
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

      await this.repository.markFolderSynced(folder.id, {
        uidValidity,
        uidNext,
        lastUid: incomingUids.length > 0 ? incomingUids[incomingUids.length - 1] : undefined,
        initialComplete: true,
        reconcileClean: reconcile.markedCount === 0 && reconcile.missingInDbUids.length === 0
      });

      return {
        messagesUpserted: messagesUpserted + backfilled,
        reconcileGapsFound: reconcile.markedCount + reconcile.missingInDbUids.length
      };
    } finally {
      mailboxLock.release();
    }
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
    let targetMaxUid: number | null = folder.initial_sync_target_max_uid
      ? Number(folder.initial_sync_target_max_uid)
      : null;
    let oldestSynced: number | null = folder.initial_sync_oldest_uid_synced
      ? Number(folder.initial_sync_oldest_uid_synced)
      : null;

    // First pass for this folder: take the snapshot.
    if (targetMaxUid === null || oldestSynced === null) {
      const snapshot = await searchUidsSince(client, windowCutoff);
      const sortedTargets = [...new Set(snapshot)].sort((a, b) => a - b);

      if (sortedTargets.length === 0) {
        // Empty folder in window — record the snapshot (target=0) and mark complete.
        await this.repository.setInitialSyncSnapshot(folder.id, 0, 0);
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
      await this.repository.setInitialSyncSnapshot(folder.id, targetMaxUid, oldestSynced);
    }

    // Re-search and bound by the snapshot. Any UIDs the provider has expunged
    // between cycles fall out naturally and we don't try to fetch them.
    const candidates = await searchUidsSince(client, windowCutoff);
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
    const metadata = await fetchMessageMetadata(client, batch, batchSize);
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

  private async fetchBodyBacklog(account: ImapAccount, client: MirrorImapClient): Promise<number> {
    const backlog = await this.repository.getBodyBacklog(account, this.config.BODY_BACKFILL_BATCH_SIZE);
    let fetched = 0;

    for (const message of backlog) {
      await this.fetchAndStoreBody(client, message);
      fetched += 1;
    }

    return fetched;
  }

  private async fetchAndStoreBody(client: MirrorImapClient, message: ImapMessage): Promise<void> {
    const body = await fetchFullMessageBody(client, this.config, message);
    await this.repository.storeBody(body);
    await this.hooks.onBodyFetched?.(message, body);
  }
}
