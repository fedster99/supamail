import type { AppConfig } from "./config.js";
import { getConfig, getWindowCutoff } from "./config.js";
import type { PgPool } from "./db.js";
import { getPool } from "./db.js";
import { fetchFullMessageBody, fetchMessageMetadata, searchAllUids, searchUidsSince } from "./imap-client.js";
import type { MirrorImapClient } from "./imap-client.js";
import { withAccountLock } from "./locks.js";
import { MirrorRepository } from "./repository.js";
import type {
  ImapAccount,
  ImapFolder,
  ImapMessage,
  MirrorHooks,
  SyncResult,
  SyncTriggerType
} from "./types.js";
import { createImapClient } from "./imap-client.js";

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

  async syncDueAccounts(limit = 10): Promise<SyncResult[]> {
    const accounts = await this.repository.getRunnableAccounts(limit);
    const results: SyncResult[] = [];

    for (const account of accounts) {
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
      await this.repository.markAccountSyncStarted(account.id, `imap-to-supabase:${process.pid}`);
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
            result.errors.push(`${folder.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        result.bodiesFetched += await this.fetchBodyBacklog(account, client);

        if (result.errors.length > 0) {
          result.outcome = result.messagesUpserted > 0 || result.foldersProcessed > 0 ? "partial_success" : "failed";
        }

        if (result.outcome === "failed") {
          await this.repository.markAccountSyncFailed(account.id, result.errors.join("; "));
        } else {
          await this.repository.markAccountSyncSucceeded(account.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.outcome = "failed";
        result.errors.push(message);
        await this.repository.markAccountSyncFailed(account.id, message);
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
        await this.repository.handleUidValidityReset(account, folder, uidValidity);
        return { messagesUpserted: 0, reconcileGapsFound: 0 };
      }

      const windowCutoff = getWindowCutoff(this.config);
      let uids: number[];

      if (!folder.initial_sync_complete) {
        uids = await searchUidsSince(client, windowCutoff);
      } else {
        const lastUid = folder.last_uid ? Number(folder.last_uid) : 0;
        const uidFloor = lastUid + 1;
        const uidCeiling = Math.max(uidFloor, uidNext ? uidNext - 1 : uidFloor);
        uids = (await searchUidsSince(client, windowCutoff, `${uidFloor}:${uidCeiling}`))
          .filter((uid) => uid > lastUid);
      }

      const uniqueUids = [...new Set(uids)].sort((a, b) => a - b);
      const metadataBatchSize = folder.initial_sync_complete
        ? this.config.INCREMENTAL_SYNC_BATCH_SIZE
        : this.config.INITIAL_SYNC_BATCH_SIZE;
      let messagesUpserted = 0;

      for (let i = 0; i < uniqueUids.length; i += metadataBatchSize) {
        const batchUids = uniqueUids.slice(i, i + metadataBatchSize);
        const metadata = await fetchMessageMetadata(client, batchUids, metadataBatchSize);
        const messages = await this.repository.upsertMessages(account.id, folder, uidValidity, metadata, windowCutoff);
        messagesUpserted += messages.length;

        for (const message of messages) {
          await this.hooks.onMessageUpsert?.(message);
        }
      }

      const liveUids = await searchAllUids(client, windowCutoff);
      const reconcileGapsFound = await this.repository.markMissingMessages(account.id, folder, uidValidity, liveUids);

      await this.repository.markFolderSynced(folder.id, {
        uidValidity,
        uidNext,
        lastUid: uniqueUids.length > 0 ? Math.max(...uniqueUids) : undefined,
        initialComplete: true
      });

      return {
        messagesUpserted,
        reconcileGapsFound
      };
    } finally {
      mailboxLock.release();
    }
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
