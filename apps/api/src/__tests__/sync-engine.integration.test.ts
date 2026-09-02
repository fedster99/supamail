import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, getPool } from "../db.js";
import { DatabaseBodyStore, type BodyStore } from "../body-store.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import type {
  MailboxChange,
  MailboxLock,
  MirrorImapClient,
  QresyncRequest
} from "../imap-client.js";
import { resetConfigForTests } from "../config.js";
import { createApiApp } from "../api.js";
import { MirrorEngine } from "../sync-engine.js";
import {
  plaintextMetadataProtection,
  type MetadataProtectionAdapter
} from "../metadata-protection.js";
import {
  backdateMissingSince,
  buildInboxAndSentFolders,
  dueAllFolders,
  forceFolderDiscovery,
  setupIntegration,
  teardownIntegration
} from "./helpers/integration-harness.js";

const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);

// CI exports DATABASE_URL for the integration job; local dev exports it on
// demand. Without a DB the unit suite still runs — these scenarios just skip.
const integration = DB_AVAILABLE ? describe : describe.skip;

function buildEmptyFolders(count: number): FixtureFolder[] {
  const folders: FixtureFolder[] = [
    {
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 50_001,
      messages: []
    },
    {
      path: "Sent",
      delimiter: "/",
      specialUse: "\\Sent",
      uidValidity: 50_002,
      messages: []
    }
  ];

  for (let i = folders.length; i < count; i += 1) {
    folders.push({
      path: `Archive-${String(i + 1).padStart(3, "0")}`,
      delimiter: "/",
      uidValidity: 50_000 + i + 1,
      messages: []
    });
  }

  return folders;
}

async function markCurrentTrackedFoldersClean(h: { pool: ReturnType<typeof getPool>; repository: { markAccountSyncSucceeded(accountId: string): Promise<void> }; account: { id: string } }): Promise<void> {
  await h.pool.query(
    `
    UPDATE public.imap_folders
    SET status = 'ACTIVE',
        uidvalidity = COALESCE(uidvalidity, 1),
        last_uid = COALESCE(last_uid, 0),
        initial_sync_complete = true,
        last_synced_at = now(),
        last_full_reconcile_at = now(),
        last_reconcile_clean = true,
        next_sync_due_at = now() + interval '1 minute'
    WHERE account_id = $1
      AND tracked = true
      AND missing_since IS NULL
    `,
    [h.account.id]
  );
  await h.repository.markAccountSyncSucceeded(h.account.id);
}

async function accountHealthSnapshot(pool: ReturnType<typeof getPool>, accountId: string) {
  return (
    await pool.query<{
      sync_state: string;
      sync_state_reason: string | null;
      consecutive_failures: number;
      consecutive_successes: number;
      last_sync_finished_at: Date | null;
      last_priority_sync_succeeded_at: Date | null;
      backoff_until: Date | null;
    }>(
      `SELECT sync_state, sync_state_reason, consecutive_failures, consecutive_successes,
              last_sync_finished_at, last_priority_sync_succeeded_at, backoff_until
       FROM public.imap_accounts WHERE id = $1`,
      [accountId]
    )
  ).rows[0];
}

integration("sync-engine integration (real Postgres + fixture IMAP)", () => {
  const activeAccountIds: string[] = [];

  beforeAll(() => {
    resetConfigForTests();
  });

  afterEach(async () => {
    const pool = getPool();
    while (activeAccountIds.length > 0) {
      const id = activeAccountIds.pop()!;
      await teardownIntegration(pool, id).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it("forces folder discovery during an authoritative safety pass", async () => {
    const h = await setupIntegration("forced-safety-discovery", {
      MAX_RR_FOLDERS_PER_CYCLE: 1
    });
    activeAccountIds.push(h.account.id);
    const initialFolders = buildInboxAndSentFolders();

    await h.buildEngine({ folders: initialFolders }).syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_folders
       SET status = 'ACTIVE', initial_sync_complete = true
       WHERE account_id = $1 AND lower(path) = 'inbox'`,
      [h.account.id]
    );
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET next_folder_discovery_at = now() + interval '10 minutes'
       WHERE id = $1`,
      [h.account.id]
    );

    const newFolder: FixtureFolder = {
      path: "Projects/00-New",
      delimiter: "/",
      uidValidity: 70_001,
      messages: [makeTextMessage({
        uid: 1,
        subject: "created after listener startup",
        from: "sender@example.test",
        to: "owner@example.test",
        body: "new folder safety proof"
      })]
    };
    const deferredFolders: FixtureFolder[] = [
      { path: "Projects/10-Deferred", delimiter: "/", uidValidity: 70_002, messages: [] },
      { path: "Projects/20-Deferred", delimiter: "/", uidValidity: 70_003, messages: [] }
    ];
    const result = await h.buildEngine({
      folders: [...initialFolders, newFolder, ...deferredFolders]
    }).syncAccount(h.account.id, "scheduled", {
      forceFolderDiscovery: true
    });

    expect(result.outcome).toBe("success");
    const mirrored = await h.pool.query<{ folder_path: string; subject: string | null }>(
      `SELECT folder_path, subject
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = $2`,
      [h.account.id, newFolder.path]
    );
    expect(mirrored.rows).toEqual([{
      folder_path: newFolder.path,
      subject: "created after listener startup"
    }]);
    const state = await h.pool.query<{ sync_state: string }>(
      "SELECT sync_state FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(state.rows[0]?.sync_state).toBe("INITIAL_SYNC");
    expect((await h.repository.getIdleWatchAccounts()).map((row) => row.id))
      .not.toContain(h.account.id);
    expect((await h.repository.getIdleWatchAccounts({
      includeWarmInitialSync: true
    })).map((row) => row.id)).toContain(h.account.id);
  });

  it("runs a lightweight Sent-only pass without consuming other due folder work", async () => {
    const h = await setupIntegration("sent-fast-pass");
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({ folders });

    // Discovery happens in the regular lane. Make both folders due afterward;
    // the fast lane must still touch only Sent.
    await engine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET body_fetch_policy = 'immediate',
           last_priority_sync_succeeded_at = '2026-01-01T00:00:00.000Z',
           last_sync_finished_at = '2026-01-01T00:00:00.000Z'
       WHERE id = $1`,
      [h.account.id]
    );
    await dueAllFolders(h.pool, h.account.id);

    const [result] = await engine.syncDueSentFolders(1);

    expect(result.outcome).toBe("success");
    expect(result.foldersProcessed).toBe(1);
    expect(result.bodiesFetched).toBe(0);
    const stillDue = await h.repository.getFoldersDueForSync(h.account.id);
    expect(stillDue.map((folder) => folder.path)).toContain("INBOX");
    expect(stillDue.map((folder) => folder.path)).not.toContain("Sent");
    const account = await h.repository.getAccount(h.account.id);
    expect(account?.last_priority_sync_succeeded_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(account?.last_sync_finished_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    const runsBeforeNoop = await h.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_sync_runs WHERE account_id = $1",
      [h.account.id]
    );
    const noDueWork = await engine.syncDueSentFolders(1);
    const runsAfterNoop = await h.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_sync_runs WHERE account_id = $1",
      [h.account.id]
    );

    expect(noDueWork).toEqual([]);
    expect(runsAfterNoop.rows[0].count).toBe(runsBeforeNoop.rows[0].count);
  });

  it("uses an IDLE wake for Inbox delete, move, and flag repair without consuming other folders", async () => {
    const h = await setupIntegration("idle-inbox-reconcile", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_003,
      messages: []
    });
    const engine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50 }
    });

    await engine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_folders
       SET next_sync_due_at = now() + interval '1 hour',
           next_reconcile_at = now() + interval '1 hour',
           next_flag_scan_at = now() + interval '1 hour'
       WHERE account_id = $1`,
      [h.account.id]
    );
    await h.pool.query(
      `DELETE FROM public.imap_message_bodies
       WHERE message_id IN (
         SELECT id FROM public.imap_messages
         WHERE account_id = $1 AND folder_path = 'Sent' AND uid = 201
       )`,
      [h.account.id]
    );
    await h.pool.query(
      `UPDATE public.imap_messages
       SET body_fetched_at = NULL
       WHERE account_id = $1 AND folder_path = 'Sent' AND uid = 201`,
      [h.account.id]
    );
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );

    const moved = folders[0].messages.find((message) => message.uid === 103)!;
    folders[0].messages = folders[0].messages.filter(
      (message) => message.uid !== 101 && message.uid !== 103
    );
    folders[0].messages.find((message) => message.uid === 102)!.flags = ["\\Seen"];
    folders[0].messages.push(
      makeTextMessage({
        uid: 106,
        subject: "arrived via idle",
        from: "fresh@x.test",
        to: "u@x.test",
        body: "fresh"
      })
    );
    folders[1].messages.push(
      makeTextMessage({
        uid: 202,
        subject: "sent outside idle lane",
        from: "u@x.test",
        to: "fresh@x.test",
        body: "sent"
      })
    );
    folders[2].messages.push({ ...moved, uid: 301 });

    const idleClient = new FixtureImapClient(folders);
    const logout = vi.spyOn(idleClient, "logout");
    const list = vi.spyOn(idleClient, "list");
    const beforeWake = await h.pool.query<{ last_sync_finished_at: Date | null }>(
      "SELECT last_sync_finished_at FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    await expect(engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: "00000000-0000-4000-8000-000000000000",
      keepClientOpen: true
    })).rejects.toThrow("Host-owned client does not match the Mailbox Account");
    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      forceInboxReconcile: true,
      forceInboxFlagScan: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(result.foldersProcessed).toBe(1);
    expect(result.reconcileGapsFound).toBe(2);
    expect(result.flagsUpdated).toBe(1);
    expect(list).not.toHaveBeenCalled();
    const afterWake = await h.pool.query<{ last_sync_finished_at: Date | null }>(
      "SELECT last_sync_finished_at FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(afterWake.rows[0].last_sync_finished_at?.toISOString()).toBe(
      beforeWake.rows[0].last_sync_finished_at?.toISOString()
    );

    const messages = await h.pool.query<{
      folder_path: string;
      uid: string;
      deleted_in_provider: boolean;
      deleted_reason: string | null;
      flags: string[];
    }>(
      `SELECT folder_path, uid::text, deleted_in_provider, deleted_reason, flags
       FROM public.imap_messages
       WHERE account_id = $1 AND uid IN (101, 102, 103, 106, 202, 301)
       ORDER BY folder_path, uid`,
      [h.account.id]
    );
    expect(messages.rows).toEqual([
      {
        folder_path: "INBOX",
        uid: "101",
        deleted_in_provider: true,
        deleted_reason: "RECONCILE_MISSING",
        flags: []
      },
      {
        folder_path: "INBOX",
        uid: "102",
        deleted_in_provider: false,
        deleted_reason: null,
        flags: ["\\Seen"]
      },
      {
        folder_path: "INBOX",
        uid: "103",
        deleted_in_provider: true,
        deleted_reason: "RECONCILE_MISSING",
        flags: []
      },
      {
        folder_path: "INBOX",
        uid: "106",
        deleted_in_provider: false,
        deleted_reason: null,
        flags: []
      }
    ]);

    expect(logout).not.toHaveBeenCalled();
    const unrelatedBody = await h.pool.query<{ body_fetched_at: Date | null }>(
      `SELECT body_fetched_at
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'Sent' AND uid = 201`,
      [h.account.id]
    );
    expect(unrelatedBody.rows[0].body_fetched_at).toBeNull();

    const followupAccount = await h.repository.getAccount(h.account.id);
    expect(followupAccount).not.toBeNull();
    const followupBacklog = await h.repository.getBodyBacklog(followupAccount!, 10);
    const followupKeys = followupBacklog.map((message) => `${message.folder_path}:${message.uid}`);
    expect(followupKeys).toContain("INBOX:106");
    expect(followupKeys).toContain("Sent:201");
    const bodyFollowup = await engine.syncAccount(h.account.id, "scheduled", {
      bodyBacklogOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });
    expect(bodyFollowup.outcome).toBe("success");
    expect(bodyFollowup.foldersProcessed).toBe(0);
    expect(bodyFollowup.messagesUpserted).toBe(0);
    expect(bodyFollowup.bodiesFetched).toBeGreaterThanOrEqual(2);
    expect(list).not.toHaveBeenCalled();
    const fetchedByFollowup = await h.pool.query<{ body_fetched_at: Date | null }>(
      `SELECT body_fetched_at
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'Sent' AND uid = 201`,
      [h.account.id]
    );
    expect(fetchedByFollowup.rows[0].body_fetched_at).not.toBeNull();
    const afterBodyFollowup = await h.pool.query<{ last_sync_finished_at: Date | null }>(
      "SELECT last_sync_finished_at FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(afterBodyFollowup.rows[0].last_sync_finished_at?.toISOString()).toBe(
      beforeWake.rows[0].last_sync_finished_at?.toISOString()
    );

    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "scheduled");
    const movedDestination = await h.pool.query<{ folder_path: string; uid: string }>(
      `SELECT folder_path, uid::text
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'Archive' AND uid = 301`,
      [h.account.id]
    );
    expect(movedDestination.rows).toEqual([{ folder_path: "Archive", uid: "301" }]);
  });

  it("uses a STATUS wake to reconcile only the changed non-Inbox folder", async () => {
    const h = await setupIntegration("idle-archive-reconcile", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_003,
      messages: [makeTextMessage({
        uid: 301,
        subject: "old archive",
        from: "a@x.test",
        to: "u@x.test",
        body: "old"
      })]
    });
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");

    folders[2].messages = [makeTextMessage({
      uid: 302,
      subject: "new archive",
      from: "b@x.test",
      to: "u@x.test",
      body: "new"
    })];
    const idleClient = new FixtureImapClient(folders);
    const change: MailboxChange = {
      path: "Archive",
      forceReconcile: true,
      forceFlagScan: false,
      observed: {
        path: "Archive",
        uidValidity: 50_003,
        uidNext: 303,
        messages: 1
      }
    };
    const acknowledge = vi.fn();
    const acknowledgeWithStatuses = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChanges = acknowledge;
    idleClient.acknowledgeMailboxChangesWithStatuses = acknowledgeWithStatuses;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(result.foldersProcessed).toBe(1);
    expect(result.reconcileGapsFound).toBe(1);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(acknowledgeWithStatuses).toHaveBeenCalledWith([change], [{
      status: {
        path: "Archive",
        uidValidity: 50_003,
        uidNext: 303,
        exists: 1,
        messages: 1,
        highestModseq: undefined
      },
      reconcileComplete: true,
      flagScanComplete: true
    }]);
    const rows = await h.pool.query<{
      uid: string;
      deleted_in_provider: boolean;
    }>(
      `SELECT uid::text, deleted_in_provider
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'Archive'
       ORDER BY uid`,
      [h.account.id]
    );
    expect(rows.rows).toEqual([
      { uid: "301", deleted_in_provider: true },
      { uid: "302", deleted_in_provider: false }
    ]);
  });

  it("reconciles known move folders without waiting for a provider wake", async () => {
    const h = await setupIntegration("known-move-folders", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders[0].messages = [makeTextMessage({
      uid: 101,
      subject: "move me",
      from: "a@x.test",
      to: "u@x.test",
      body: "known move"
    })];
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_003,
      messages: []
    });
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");

    folders[0].messages = [];
    folders[2].messages = [makeTextMessage({
      uid: 301,
      subject: "move me",
      from: "a@x.test",
      to: "u@x.test",
      body: "known move"
    })];
    const workClient = new FixtureImapClient(folders);
    const acknowledge = vi.fn();
    workClient.peekMailboxChanges = () => [];
    workClient.acknowledgeMailboxChanges = acknowledge;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      forceReconcileFolders: ["INBOX", "Archive"],
      client: workClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(result.foldersProcessed).toBe(2);
    // Inbox needs a delete reconcile. Archive inserts its new UID through the
    // ordinary incremental path, so that side is exact without a second gap.
    expect(result.reconcileGapsFound).toBe(1);
    expect(acknowledge).not.toHaveBeenCalled();
    const rows = await h.pool.query<{
      folder_path: string;
      uid: string;
      deleted_in_provider: boolean;
    }>(
      `SELECT folder_path, uid::text, deleted_in_provider
       FROM public.imap_messages
       WHERE account_id = $1 AND (
         (folder_path = 'INBOX' AND uid = 101)
         OR (folder_path = 'Archive' AND uid = 301)
       )
       ORDER BY folder_path, uid`,
      [h.account.id]
    );
    expect(rows.rows).toEqual([
      { folder_path: "Archive", uid: "301", deleted_in_provider: false },
      { folder_path: "INBOX", uid: "101", deleted_in_provider: true }
    ]);

    const lateClient = new FixtureImapClient(folders);
    const lateChange: MailboxChange = {
      path: "Archive",
      forceReconcile: true,
      forceFlagScan: false,
      observed: {
        path: "Archive",
        uidValidity: 50_003,
        uidNext: 302,
        messages: 1
      }
    };
    const acknowledgeLate = vi.fn();
    lateClient.peekMailboxChanges = () => [lateChange];
    lateClient.acknowledgeMailboxChangesWithStatuses = acknowledgeLate;

    const duplicate = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: lateClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(duplicate.outcome).toBe("success");
    expect(duplicate.reconcileGapsFound).toBe(0);
    expect(acknowledgeLate).toHaveBeenCalledWith([lateChange], [expect.objectContaining({
      reconcileComplete: true,
      flagScanComplete: false
    })]);
  });

  it("reconciles the tracked side of a known move when its destination is intentionally untracked", async () => {
    const h = await setupIntegration("known-move-untracked-destination", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders[0].messages = [makeTextMessage({
      uid: 101,
      subject: "delete me",
      from: "a@x.test",
      to: "u@x.test",
      body: "known delete"
    })];
    folders.push({
      path: "Trash",
      delimiter: "/",
      uidValidity: 50_004,
      messages: []
    });
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_folders SET tracked = false WHERE account_id = $1 AND path = 'Trash'`,
      [h.account.id]
    );

    folders[0].messages = [];
    folders[2].messages = [makeTextMessage({
      uid: 401,
      subject: "delete me",
      from: "a@x.test",
      to: "u@x.test",
      body: "known delete"
    })];
    const workClient = new FixtureImapClient(folders);
    workClient.peekMailboxChanges = () => [];

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      forceReconcileFolders: ["INBOX", "Trash"],
      client: workClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(result.errors).toEqual([]);
    expect(result.foldersProcessed).toBe(1);
    expect(result.reconcileGapsFound).toBe(1);
    const rows = await h.pool.query<{
      folder_path: string;
      uid: string;
      deleted_in_provider: boolean;
    }>(
      `SELECT folder_path, uid::text, deleted_in_provider
       FROM public.imap_messages
       WHERE account_id = $1
         AND folder_path IN ('INBOX', 'Trash')
       ORDER BY folder_path, uid`,
      [h.account.id]
    );
    expect(rows.rows).toEqual([
      { folder_path: "INBOX", uid: "101", deleted_in_provider: true }
    ]);
  });

  it("accepts an empty selected mailbox as authoritative deletion evidence", async () => {
    const h = await setupIntegration("idle-empty-archive-reconcile", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_004,
      messages: [makeTextMessage({
        uid: 301,
        subject: "last archive message",
        from: "a@x.test",
        to: "u@x.test",
        body: "last"
      })]
    });
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");

    folders[2].messages = [];
    const idleClient = new FixtureImapClient(folders);
    const change: MailboxChange = {
      path: "Archive",
      forceReconcile: true,
      forceFlagScan: false,
      observed: {
        path: "Archive",
        uidValidity: 50_004,
        uidNext: 302,
        messages: 0
      }
    };
    const acknowledgeWithStatuses = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChangesWithStatuses = acknowledgeWithStatuses;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(result.reconcileGapsFound).toBe(1);
    expect(acknowledgeWithStatuses).toHaveBeenCalledWith([change], [{
      status: {
        path: "Archive",
        uidValidity: 50_004,
        uidNext: 1,
        exists: 0,
        messages: 0,
        highestModseq: undefined
      },
      reconcileComplete: true,
      flagScanComplete: true
    }]);
    const row = await h.pool.query<{
      deleted_in_provider: boolean;
      deleted_reason: string | null;
    }>(
      `SELECT deleted_in_provider, deleted_reason
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'Archive' AND uid = 301`,
      [h.account.id]
    );
    expect(row.rows[0]).toEqual({
      deleted_in_provider: true,
      deleted_reason: "RECONCILE_MISSING"
    });
  });

  it("uses QRESYNC replay for flags and deletions without an immediate exact UID scan", async () => {
    const h = await setupIntegration("qresync-archive-replay", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      IMAP_QRESYNC_ENABLED: true
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_013,
      highestModseq: 10n,
      messages: [
        makeTextMessage({
          uid: 301,
          subject: "kept archive",
          from: "a@x.test",
          to: "u@x.test",
          body: "kept"
        }),
        makeTextMessage({
          uid: 302,
          subject: "removed archive",
          from: "b@x.test",
          to: "u@x.test",
          body: "removed"
        })
      ]
    });
    const initialEngine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50, IMAP_QRESYNC_ENABLED: true }
    });
    await initialEngine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_folders
       SET highest_modseq = 10,
           qresync_highest_modseq = 10,
           last_full_reconcile_at = now(),
           next_reconcile_at = now() + interval '6 hours',
           next_flag_scan_at = now() + interval '6 hours'
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );

    folders[2].highestModseq = 12n;
    folders[2].messages[0].flags = ["\\Seen"];
    folders[2].messages.splice(1, 1, makeTextMessage({
      uid: 303,
      subject: "new archive",
      from: "c@x.test",
      to: "u@x.test",
      body: "new"
    }));

    class QresyncFixtureClient extends FixtureImapClient {
      capabilities = new Map<string, boolean>([["QRESYNC", true]]);

      override async getMailboxLock(
        path: string,
        options: { qresync?: QresyncRequest } = {}
      ): Promise<MailboxLock> {
        const lock = await super.getMailboxLock(path);
        if (!options.qresync || path !== "Archive") return lock;
        return {
          ...lock,
          qresync: {
            accepted: true,
            complete: true,
            vanishedUids: [302],
            changedFlags: [{ uid: 301, flags: ["\\Seen"] }]
          }
        };
      }
    }

    const idleClient = new QresyncFixtureClient(folders);
    const fetch = vi.spyOn(idleClient, "fetch");
    const change: MailboxChange = {
      path: "Archive",
      forceReconcile: true,
      forceFlagScan: true,
      observed: {
        path: "Archive",
        uidValidity: 50_013,
        uidNext: 304,
        messages: 2,
        highestModseq: 12n
      }
    };
    const acknowledge = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChanges = acknowledge;
    const engine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50, IMAP_QRESYNC_ENABLED: true }
    });

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(result.flagsUpdated).toBe(1);
    expect(result.reconcileGapsFound).toBe(1);
    expect(acknowledge).toHaveBeenCalledWith([change]);
    expect(fetch.mock.calls.some(([range]) => range === "1:*")).toBe(false);
    const rows = await h.pool.query<{
      uid: string;
      flags: string[];
      deleted_in_provider: boolean;
    }>(
      `SELECT uid::text, flags, deleted_in_provider
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'Archive'
       ORDER BY uid`,
      [h.account.id]
    );
    expect(rows.rows).toEqual([
      { uid: "301", flags: ["\\Seen"], deleted_in_provider: false },
      { uid: "302", flags: [], deleted_in_provider: true },
      { uid: "303", flags: [], deleted_in_provider: false }
    ]);
    const folder = await h.pool.query<{
      highest_modseq: string | null;
      qresync_highest_modseq: string | null;
    }>(
      `SELECT highest_modseq::text, qresync_highest_modseq::text
       FROM public.imap_folders
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );
    expect(folder.rows[0].highest_modseq).toBe("12");
    expect(folder.rows[0].qresync_highest_modseq).toBe("12");
    const replayEvent = await h.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
       FROM public.imap_sync_events
       WHERE account_id = $1 AND folder_path = 'Archive' AND event_type = 'QRESYNC_REPLAY'
       ORDER BY created_at DESC
       LIMIT 1`,
      [h.account.id]
    );
    expect(replayEvent.rows[0].payload).toMatchObject({
      accepted: true,
      complete: true,
      fallbackRequired: false,
      changedFlagCount: 1,
      vanishedUidCount: 1
    });
  });

  it("falls back to exact UID reconciliation when QRESYNC capture is incomplete", async () => {
    const h = await setupIntegration("qresync-incomplete-fallback", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      IMAP_QRESYNC_ENABLED: true
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_014,
      highestModseq: 10n,
      messages: [
        makeTextMessage({ uid: 301, subject: "kept", from: "a@x.test", to: "u@x.test", body: "kept" }),
        makeTextMessage({ uid: 302, subject: "gone", from: "b@x.test", to: "u@x.test", body: "gone" })
      ]
    });
    const initialEngine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50, IMAP_QRESYNC_ENABLED: true }
    });
    await initialEngine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_folders
       SET highest_modseq = 10,
           qresync_highest_modseq = 10,
           last_full_reconcile_at = now(),
           next_reconcile_at = now() + interval '6 hours',
           next_flag_scan_at = now() + interval '6 hours'
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );
    folders[2].highestModseq = 12n;
    folders[2].messages.splice(1, 1);

    class IncompleteQresyncClient extends FixtureImapClient {
      capabilities = new Map<string, boolean>([["QRESYNC", true]]);

      override async getMailboxLock(
        path: string,
        options: { qresync?: QresyncRequest } = {}
      ): Promise<MailboxLock> {
        const lock = await super.getMailboxLock(path);
        if (!options.qresync || path !== "Archive") return lock;
        return {
          ...lock,
          qresync: {
            accepted: true,
            complete: false,
            vanishedUids: [],
            changedFlags: []
          }
        };
      }
    }

    const idleClient = new IncompleteQresyncClient(folders);
    const fetch = vi.spyOn(idleClient, "fetch");
    const change: MailboxChange = {
      path: "Archive",
      forceReconcile: true,
      forceFlagScan: false,
      observed: {
        path: "Archive",
        uidValidity: 50_014,
        uidNext: 302,
        messages: 1,
        highestModseq: 12n
      }
    };
    const acknowledge = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChanges = acknowledge;
    const engine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50, IMAP_QRESYNC_ENABLED: true }
    });

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(result.reconcileGapsFound).toBe(1);
    expect(fetch.mock.calls.some(([range]) => range === "1:*")).toBe(true);
    expect(acknowledge).toHaveBeenCalledWith([change]);
    const deleted = await h.pool.query<{ deleted_in_provider: boolean }>(
      `SELECT deleted_in_provider
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'Archive' AND uid = 302`,
      [h.account.id]
    );
    expect(deleted.rows[0].deleted_in_provider).toBe(true);
    const replayEvent = await h.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
       FROM public.imap_sync_events
       WHERE account_id = $1 AND folder_path = 'Archive' AND event_type = 'QRESYNC_REPLAY'
       ORDER BY created_at DESC
       LIMIT 1`,
      [h.account.id]
    );
    expect(replayEvent.rows[0].payload).toMatchObject({
      accepted: true,
      complete: false,
      fallbackRequired: true
    });
  });

  it("retries plain selection and exact reconciliation when QRESYNC is rejected", async () => {
    const h = await setupIntegration("qresync-command-rejected", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      IMAP_QRESYNC_ENABLED: true
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_015,
      highestModseq: 10n,
      messages: [
        makeTextMessage({ uid: 301, subject: "kept", from: "a@x.test", to: "u@x.test", body: "kept" }),
        makeTextMessage({ uid: 302, subject: "gone", from: "b@x.test", to: "u@x.test", body: "gone" })
      ]
    });
    const engine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50, IMAP_QRESYNC_ENABLED: true }
    });
    await engine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_folders
       SET highest_modseq = 10,
           qresync_highest_modseq = 10,
           last_full_reconcile_at = now(),
           next_reconcile_at = now() + interval '6 hours',
           next_flag_scan_at = now() + interval '6 hours'
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );
    folders[2].highestModseq = 12n;
    folders[2].messages.splice(1, 1);

    class RejectingQresyncClient extends FixtureImapClient {
      capabilities = new Map<string, boolean>([["QRESYNC", true]]);
      readonly lockRequests: Array<{ path: string; qresync?: QresyncRequest }> = [];

      override async getMailboxLock(
        path: string,
        options: { qresync?: QresyncRequest } = {}
      ): Promise<MailboxLock> {
        this.lockRequests.push({ path, ...options });
        if (options.qresync) throw new Error("provider rejected QRESYNC SELECT");
        return await super.getMailboxLock(path);
      }
    }

    const idleClient = new RejectingQresyncClient(folders);
    const change: MailboxChange = {
      path: "Archive",
      forceReconcile: true,
      forceFlagScan: true,
      observed: {
        path: "Archive",
        uidValidity: 50_015,
        uidNext: 302,
        messages: 1,
        highestModseq: 12n
      }
    };
    const acknowledge = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChanges = acknowledge;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(idleClient.lockRequests).toEqual([
      { path: "Archive", qresync: { uidValidity: 50_015n, changedSince: 10n } },
      { path: "Archive" }
    ]);
    expect(acknowledge).toHaveBeenCalledWith([change]);
    const deleted = await h.pool.query<{ deleted_in_provider: boolean }>(
      `SELECT deleted_in_provider
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'Archive' AND uid = 302`,
      [h.account.id]
    );
    expect(deleted.rows[0].deleted_in_provider).toBe(true);
    const replayEvent = await h.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
       FROM public.imap_sync_events
       WHERE account_id = $1 AND folder_path = 'Archive' AND event_type = 'QRESYNC_REPLAY'
       ORDER BY created_at DESC
       LIMIT 1`,
      [h.account.id]
    );
    expect(replayEvent.rows[0].payload).toMatchObject({
      accepted: false,
      complete: false,
      commandRejected: true,
      fallbackRequired: true
    });
  });

  it("keeps the QRESYNC cursor behind changes deferred by the replay budget", async () => {
    const h = await setupIntegration("qresync-replay-budget", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      IMAP_QRESYNC_ENABLED: true,
      MAX_RECONCILES_PER_CYCLE: 1,
      MAX_FLAG_SCANS_PER_CYCLE: 1
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push(
      {
        path: "Archive",
        delimiter: "/",
        uidValidity: 50_016,
        highestModseq: 10n,
        messages: [makeTextMessage({ uid: 301, subject: "archive", from: "a@x.test", to: "u@x.test", body: "a" })]
      },
      {
        path: "Projects",
        delimiter: "/",
        uidValidity: 50_017,
        highestModseq: 10n,
        messages: [makeTextMessage({ uid: 401, subject: "project", from: "b@x.test", to: "u@x.test", body: "b" })]
      }
    );
    const engine = h.buildEngine({
      folders,
      overrides: {
        INITIAL_SYNC_BATCH_SIZE: 50,
        IMAP_QRESYNC_ENABLED: true,
        MAX_RECONCILES_PER_CYCLE: 1,
        MAX_FLAG_SCANS_PER_CYCLE: 1
      }
    });
    await engine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_folders
       SET highest_modseq = 10,
           qresync_highest_modseq = 10,
           last_full_reconcile_at = now(),
           next_reconcile_at = now() + interval '6 hours',
           next_flag_scan_at = now() + interval '6 hours'
       WHERE account_id = $1 AND path IN ('Archive', 'Projects')`,
      [h.account.id]
    );
    folders[2].highestModseq = 12n;
    folders[3].highestModseq = 12n;

    class BudgetedQresyncClient extends FixtureImapClient {
      capabilities = new Map<string, boolean>([["QRESYNC", true]]);
      readonly lockRequests: Array<{ path: string; qresync?: QresyncRequest }> = [];

      override async getMailboxLock(
        path: string,
        options: { qresync?: QresyncRequest } = {}
      ): Promise<MailboxLock> {
        this.lockRequests.push({ path, ...options });
        const lock = await super.getMailboxLock(path);
        if (!options.qresync) return lock;
        return {
          ...lock,
          qresync: {
            accepted: true,
            complete: true,
            vanishedUids: [],
            changedFlags: []
          }
        };
      }
    }

    const idleClient = new BudgetedQresyncClient(folders);
    let pending: MailboxChange[] = [
      {
        path: "Archive",
        forceReconcile: true,
        forceFlagScan: true,
        observed: { path: "Archive", uidValidity: 50_016, uidNext: 302, messages: 1, highestModseq: 12n }
      },
      {
        path: "Projects",
        forceReconcile: true,
        forceFlagScan: true,
        observed: { path: "Projects", uidValidity: 50_017, uidNext: 402, messages: 1, highestModseq: 12n }
      }
    ];
    idleClient.peekMailboxChanges = () => pending;
    idleClient.acknowledgeMailboxChanges = (handled) => {
      pending = pending.filter((change) => !handled.includes(change));
    };

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(pending.map((change) => change.path)).toEqual(["Projects"]);
    expect(idleClient.lockRequests).toEqual([
      { path: "Archive", qresync: { uidValidity: 50_016n, changedSince: 10n } },
      { path: "Projects" }
    ]);
    const cursors = await h.pool.query<{
      path: string;
      highest_modseq: string | null;
      qresync_highest_modseq: string | null;
    }>(
      `SELECT path, highest_modseq::text, qresync_highest_modseq::text
       FROM public.imap_folders
       WHERE account_id = $1 AND path IN ('Archive', 'Projects')
       ORDER BY path`,
      [h.account.id]
    );
    expect(cursors.rows).toEqual([
      { path: "Archive", highest_modseq: "12", qresync_highest_modseq: "12" },
      { path: "Projects", highest_modseq: "10", qresync_highest_modseq: "10" }
    ]);
  });

  it("scans the full active window for a forced flag wake without CONDSTORE", async () => {
    const h = await setupIntegration("status-old-flag-no-condstore", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      FLAG_DIFF_WINDOW_DAYS: 7,
      WINDOW_DAYS: 90
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_009,
      messages: [makeTextMessage({
        uid: 301,
        subject: "old archive flag",
        from: "a@x.test",
        to: "u@x.test",
        body: "old",
        internalDate: new Date(Date.now() - 30 * 24 * 60 * 60_000)
      })]
    });
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");
    folders[2].messages[0].flags = ["\\Seen"];

    const idleClient = new FixtureImapClient(folders);
    const change: MailboxChange = {
      path: "Archive",
      forceReconcile: false,
      forceFlagScan: true,
      observed: { path: "Archive", uidValidity: 50_009, uidNext: 302, messages: 1, unseen: 0 }
    };
    const acknowledge = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChanges = acknowledge;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(result.flagsUpdated).toBe(1);
    expect(acknowledge).toHaveBeenCalledWith([change]);
  });

  it("does not let a pending non-Inbox hint shadow a concurrent Inbox wake", async () => {
    const h = await setupIntegration("idle-inbox-with-archive", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      MAX_RECONCILES_PER_CYCLE: 1
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({ path: "Archive", delimiter: "/", uidValidity: 50_006, messages: [] });
    const engine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50, MAX_RECONCILES_PER_CYCLE: 1 }
    });
    await engine.syncAccount(h.account.id, "manual");
    const removedInboxUid = folders[0].messages[0].uid;
    folders[0].messages.shift();
    folders[0].messages.push(makeTextMessage({
      uid: 106,
      subject: "new inbox",
      from: "a@x.test",
      to: "u@x.test",
      body: "new"
    }));

    const archiveChange: MailboxChange = {
      path: "Archive",
      forceReconcile: true,
      forceFlagScan: false,
      observed: { path: "Archive", uidValidity: 50_006, uidNext: 1, messages: 0 }
    };
    const idleClient = new FixtureImapClient(folders);
    const acknowledge = vi.fn();
    idleClient.peekMailboxChanges = () => [archiveChange];
    idleClient.acknowledgeMailboxChanges = acknowledge;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true,
      forceInboxReconcile: true
    });

    expect(result.outcome).toBe("success");
    expect(result.foldersProcessed).toBe(2);
    expect(acknowledge).not.toHaveBeenCalled();
    const inbox = await h.pool.query<{ uid: string }>(
      `SELECT uid::text FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = 106`,
      [h.account.id]
    );
    expect(inbox.rows).toEqual([{ uid: "106" }]);
    const removedInbox = await h.pool.query<{ deleted_in_provider: boolean }>(
      `SELECT deleted_in_provider
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = $2`,
      [h.account.id, removedInboxUid]
    );
    expect(removedInbox.rows).toEqual([{ deleted_in_provider: true }]);
  });

  it("drains forced mailbox reconciles across bounded live passes", async () => {
    const h = await setupIntegration("idle-bounded-reconciles", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      MAX_RECONCILES_PER_CYCLE: 1
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push(
      { path: "Archive", delimiter: "/", uidValidity: 50_007, messages: [] },
      { path: "Projects", delimiter: "/", uidValidity: 50_008, messages: [] }
    );
    const engine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50, MAX_RECONCILES_PER_CYCLE: 1 }
    });
    await engine.syncAccount(h.account.id, "manual");

    let pending: MailboxChange[] = [
      {
        path: "Archive",
        forceReconcile: true,
        forceFlagScan: false,
        observed: { path: "Archive", uidValidity: 50_007, uidNext: 1, messages: 0 }
      },
      {
        path: "Projects",
        forceReconcile: true,
        forceFlagScan: false,
        observed: { path: "Projects", uidValidity: 50_008, uidNext: 1, messages: 0 }
      }
    ];
    const idleClient = new FixtureImapClient(folders);
    const acknowledge = vi.fn((handled: readonly MailboxChange[]) => {
      pending = pending.filter((change) => !handled.includes(change));
    });
    idleClient.peekMailboxChanges = (limit) => pending.slice(0, limit);
    idleClient.acknowledgeMailboxChanges = acknowledge;
    const liveOptions = {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    } as const;

    const first = await engine.syncAccount(h.account.id, "scheduled", liveOptions);
    expect(first.outcome).toBe("success");
    expect(pending.map((change) => change.path)).toEqual(["Projects"]);

    const second = await engine.syncAccount(h.account.id, "scheduled", liveOptions);
    expect(second.outcome).toBe("success");
    expect(pending).toEqual([]);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it("retries a changed folder after initial sync completes, then acknowledges reconcile", async () => {
    const h = await setupIntegration("live-change-finishes-initial", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_004,
      messages: [makeTextMessage({
        uid: 301,
        subject: "archive",
        from: "a@x.test",
        to: "u@x.test",
        body: "archive"
      })]
    });
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_folders
       SET initial_sync_complete = false,
           initial_sync_target_max_uid = 301,
           initial_sync_oldest_uid_synced = 302
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );

    const idleClient = new FixtureImapClient(folders);
    const change: MailboxChange = {
      path: "Archive",
      forceReconcile: true,
      forceFlagScan: false,
      observed: { path: "Archive", uidValidity: 50_004, uidNext: 302, messages: 1 }
    };
    const acknowledge = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChanges = acknowledge;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(acknowledge).not.toHaveBeenCalled();
    const folder = await h.pool.query<{ initial_sync_complete: boolean }>(
      `SELECT initial_sync_complete FROM public.imap_folders
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );
    expect(folder.rows[0].initial_sync_complete).toBe(true);

    const retry = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });
    expect(retry.outcome).toBe("success");
    expect(acknowledge).toHaveBeenCalledWith([change]);
  });

  it("retains a mailbox change when its tracked folder no longer matches", async () => {
    const h = await setupIntegration("live-change-missing-folder");
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({ folders });
    await engine.syncAccount(h.account.id, "manual");

    const idleClient = new FixtureImapClient(folders);
    const change: MailboxChange = {
      path: "Gone",
      forceReconcile: true,
      forceFlagScan: false,
      observed: { path: "Gone", uidValidity: 90_001, uidNext: 2, messages: 1 }
    };
    const acknowledge = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChanges = acknowledge;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("failed");
    expect(result.errors).toContain("Live folder set no longer matches tracked folders");
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("retains a structural mailbox change when forced reconcile is truncated", async () => {
    const h = await setupIntegration("live-change-truncated-reconcile");
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({ folders });
    await engine.syncAccount(h.account.id, "manual");
    vi.spyOn(h.repository, "markMissingMessagesFromLiveUidStream").mockResolvedValue({
      markedCount: 0,
      liveUidCount: 1,
      missingInDbUids: [],
      missingInDbTruncated: true
    });

    const idleClient = new FixtureImapClient(folders);
    const change: MailboxChange = {
      path: "INBOX",
      forceReconcile: true,
      forceFlagScan: false,
      observed: { path: "INBOX", uidValidity: 11_001, uidNext: 106, messages: 5 }
    };
    const acknowledge = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChanges = acknowledge;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("records exact-reconcile cost when the reconcile attempt fails", async () => {
    const h = await setupIntegration("failed-reconcile-telemetry", {
      IMAP_QRESYNC_ENABLED: false,
      INITIAL_SYNC_BATCH_SIZE: 500
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({ folders });
    await engine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_folders
       SET next_sync_due_at = now() - interval '1 second',
           next_reconcile_at = now() - interval '1 second'
       WHERE account_id = $1`,
      [h.account.id]
    );
    const reconcile = vi.spyOn(h.repository, "markMissingMessagesFromLiveUidStream")
      .mockImplementation(async (_accountId, _folder, _uidValidity, liveUids, options) => {
        let consumed = 0;
        for await (const _uid of liveUids) {
          consumed += 1;
          if (options?.progress) options.progress.providerUidsSeen += 1;
          if (consumed === 2) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error("staged reconcile failed");
          }
        }
        throw new Error("reconcile fixture did not yield two UIDs");
      });

    const idleClient = new FixtureImapClient(folders);
    const result = await engine.syncAccount(h.account.id, "scheduled", {
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("failed");
    expect(result.reconcileFoldersAttempted).toBe(1);
    expect(result.reconcileProviderUidsSeen).toBe(2);
    expect(result.reconcileDurationMs).toBeGreaterThan(0);
    expect(reconcile).toHaveBeenCalledTimes(1);

    const run = await h.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM public.imap_sync_runs WHERE id = $1",
      [result.runId]
    );
    expect(run.rows[0]?.metadata).toMatchObject({
      reconcileFoldersAttempted: 1,
      reconcileProviderUidsSeen: 2,
      reconcileDurationMs: result.reconcileDurationMs
    });
  });

  it("chunks a CONDSTORE flag delta larger than the repository write limit", async () => {
    const h = await setupIntegration("condstore-large-delta", {
      INITIAL_SYNC_BATCH_SIZE: 500,
      INCREMENTAL_SYNC_BATCH_SIZE: 500
    });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    folders.push({
      path: "Archive",
      delimiter: "/",
      uidValidity: 50_005,
      highestModseq: 2n,
      messages: Array.from({ length: 501 }, (_, index) => makeTextMessage({
        uid: index + 1,
        subject: `archive ${index + 1}`,
        from: "a@x.test",
        to: "u@x.test",
        body: "archive"
      }))
    });
    const engine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 500, INCREMENTAL_SYNC_BATCH_SIZE: 500 }
    });
    await engine.syncAccount(h.account.id, "manual");
    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");
    const initialFolder = await h.pool.query<{
      initial_sync_complete: boolean;
      highest_modseq: string | null;
    }>(
      `SELECT initial_sync_complete, highest_modseq::text
       FROM public.imap_folders
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );
    expect(initialFolder.rows[0]).toEqual({
      initial_sync_complete: true,
      highest_modseq: null
    });
    for (const message of folders[2].messages) message.flags = ["\\Seen"];
    await h.pool.query(
      `UPDATE public.imap_folders
       SET highest_modseq = 1,
           next_flag_scan_at = now() - interval '1 second'
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );

    const idleClient = new FixtureImapClient(folders);
    const change: MailboxChange = {
      path: "Archive",
      forceReconcile: false,
      forceFlagScan: true,
      observed: {
        path: "Archive",
        uidValidity: 50_005,
        uidNext: 502,
        messages: 501,
        highestModseq: 2n
      }
    };
    const acknowledge = vi.fn();
    idleClient.peekMailboxChanges = () => [change];
    idleClient.acknowledgeMailboxChanges = acknowledge;

    const result = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: idleClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(result.outcome).toBe("success");
    expect(result.flagsUpdated).toBe(501);
    expect(acknowledge).toHaveBeenCalledWith([change]);
    const folder = await h.pool.query<{ highest_modseq: string | null }>(
      `SELECT highest_modseq::text FROM public.imap_folders
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );
    expect(folder.rows[0].highest_modseq).toBe("2");

    folders[2].highestModseq = 3n;
    const manyFlags = Array.from({ length: 40 }, (_, index) => `$Keyword-${index}`);
    for (const message of folders[2].messages) message.flags = manyFlags;
    const overflowClient = new FixtureImapClient(folders);
    const overflowChange: MailboxChange = {
      ...change,
      observed: { ...change.observed, highestModseq: 3n }
    };
    const acknowledgeOverflow = vi.fn();
    overflowClient.peekMailboxChanges = () => [overflowChange];
    overflowClient.acknowledgeMailboxChanges = acknowledgeOverflow;

    const overflowResult = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: overflowClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(overflowResult.outcome).toBe("success");
    expect(overflowResult.flagsUpdated).toBe(501);
    expect(acknowledgeOverflow).toHaveBeenCalledWith([overflowChange]);
    const overflowFolder = await h.pool.query<{ highest_modseq: string | null }>(
      `SELECT highest_modseq::text FROM public.imap_folders
       WHERE account_id = $1 AND path = 'Archive'`,
      [h.account.id]
    );
    expect(overflowFolder.rows[0].highest_modseq).toBe("3");

    const quietClient = new FixtureImapClient(folders);
    const quietFetch = vi.spyOn(quietClient, "fetch");
    const quietChange: MailboxChange = {
      ...change,
      observed: { ...change.observed, highestModseq: 3n }
    };
    quietClient.peekMailboxChanges = () => [quietChange];
    quietClient.acknowledgeMailboxChanges = vi.fn();

    const quietResult = await engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      client: quietClient,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });

    expect(quietResult.outcome).toBe("success");
    expect(quietFetch.mock.calls.some((call) => call[1]?.flags === true)).toBe(false);
  });

  it("closes an in-flight Sent IMAP operation when its scheduler deadline aborts", async () => {
    const h = await setupIntegration("sent-fast-pass-abort");
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");
    await dueAllFolders(h.pool, h.account.id);

    let releaseLock!: () => void;
    let markStarted!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let closeCalls = 0;

    class BlockingSentClient extends FixtureImapClient {
      close(): void {
        closeCalls += 1;
        releaseLock();
      }

      override async getMailboxLock(path: string) {
        if (path === "Sent") {
          markStarted();
          await lockGate;
        }
        return await super.getMailboxLock(path);
      }
    }

    const client = new BlockingSentClient(folders);
    const engine = h.buildEngine({
      folders,
      clientFactory: async () => client
    });
    const abort = new AbortController();
    const sync = engine.syncDueSentFolders(1, { signal: abort.signal });

    await started;
    abort.abort();
    try {
      const stoppedPromptly = await Promise.race([
        sync.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
      ]);
      expect(stoppedPromptly).toBe(true);
      expect(closeCalls).toBeGreaterThan(0);
      const [result] = await sync;
      expect(result.outcome).toBe("success");
      expect(result.errors).toEqual([]);
    } finally {
      releaseLock();
      await sync;
    }
  });

  it("closes an in-flight full sync when the worker shutdown signal aborts", async () => {
    const h = await setupIntegration("full-sync-abort");
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");
    await dueAllFolders(h.pool, h.account.id);
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing account");

    let releaseLock!: () => void;
    let markStarted!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let closeCalls = 0;
    let closed = false;

    class BlockingFullSyncClient extends FixtureImapClient {
      close(): void {
        closeCalls += 1;
        closed = true;
        releaseLock();
      }

      override async getMailboxLock(path: string) {
        if (path === "INBOX") {
          markStarted();
          await lockGate;
          if (closed) throw new Error("IMAP connection closed");
        }
        return await super.getMailboxLock(path);
      }
    }

    const client = new BlockingFullSyncClient(folders);
    const engine = h.buildEngine({
      folders,
      clientFactory: async () => client
    });
    const abort = new AbortController();
    const sync = engine.syncDueAccounts(1, { signal: abort.signal });

    await started;
    abort.abort();
    try {
      const stoppedPromptly = await Promise.race([
        sync.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
      ]);
      expect(stoppedPromptly).toBe(true);
      expect(closeCalls).toBeGreaterThan(0);
      const [result] = await sync;
      expect(result.outcome).toBe("partial_success");
      expect(result.errors).toEqual(["Sync interrupted by scheduler"]);
      const locks = await h.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_locks
         WHERE locktype = 'advisory'
           AND granted = true
           AND objid::bigint = $1::bigint`,
        [account.lock_id]
      );
      expect(locks.rows[0].count).toBe("0");
      const state = await h.pool.query<{ currently_syncing: boolean; sync_started_by: string | null }>(
        "SELECT currently_syncing, sync_started_by FROM public.imap_accounts WHERE id = $1",
        [h.account.id]
      );
      expect(state.rows[0]).toEqual({ currently_syncing: false, sync_started_by: null });
      const run = await h.pool.query<{ status: string; error: string | null }>(
        "SELECT status, error FROM public.imap_sync_runs WHERE id = $1",
        [result.runId]
      );
      expect(run.rows[0]).toEqual({
        status: "partial_success",
        error: "SYNC_ERROR"
      });
    } finally {
      releaseLock();
      await sync;
    }
  });

  it("treats shutdown during full-sync connection setup as cancellation", async () => {
    const h = await setupIntegration("full-sync-connect-abort");
    activeAccountIds.push(h.account.id);
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing account");
    const healthBefore = await accountHealthSnapshot(h.pool, h.account.id);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine = h.buildEngine({
      folders: buildInboxAndSentFolders(),
      clientFactory: async (_account, options) => {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("IMAP connection interrupted")),
            { once: true }
          );
        });
        throw new Error("unreachable");
      }
    });
    const abort = new AbortController();
    const sync = engine.syncDueAccounts(1, { signal: abort.signal });

    await started;
    abort.abort();
    const [result] = await sync;

    expect(result.outcome).toBe("partial_success");
    expect(result.errors).toEqual(["Sync interrupted by scheduler"]);
    const locks = await h.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND granted = true
         AND objid::bigint = $1::bigint`,
      [account.lock_id]
    );
    expect(locks.rows[0].count).toBe("0");
    const state = await h.repository.getAccount(h.account.id);
    expect(state?.currently_syncing).toBe(false);
    expect(state?.sync_started_by).toBeNull();
    expect(await accountHealthSnapshot(h.pool, h.account.id)).toEqual(healthBefore);
  });

  it("finishes a failed run when shutdown interrupts failure finalization", async () => {
    const h = await setupIntegration("failure-finalization-abort");
    activeAccountIds.push(h.account.id);
    const abort = new AbortController();
    const originalMarkFailed = h.repository.markAccountSyncFailed.bind(h.repository);
    vi.spyOn(h.repository, "markAccountSyncFailed").mockImplementation(async (...args) => {
      abort.abort();
      return await originalMarkFailed(...args);
    });
    const engine = h.buildEngine({
      folders: [],
      clientFactory: async () => {
        throw new Error("provider failed before shutdown");
      }
    });

    const result = await engine.syncAccount(h.account.id, "scheduled", { signal: abort.signal });

    expect(result.outcome).toBe("failed");
    expect(result.errors).toEqual(["[Error] provider failed before shutdown"]);
    const state = await h.pool.query<{
      currently_syncing: boolean;
      sync_started_by: string | null;
    }>(
      "SELECT currently_syncing, sync_started_by FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(state.rows[0]).toEqual({ currently_syncing: false, sync_started_by: null });
    const run = await h.pool.query<{ status: string; error: string | null }>(
      "SELECT status, error FROM public.imap_sync_runs WHERE id = $1",
      [result.runId]
    );
    expect(run.rows[0]).toEqual({
      status: "failed",
      error: "SYNC_ERROR"
    });
  });

  it.each(["body", "history"] as const)(
    "recognizes shutdown after the %s lane without changing account health",
    async (lane) => {
      const h = await setupIntegration(`full-sync-${lane}-abort`);
      activeAccountIds.push(h.account.id);
      const folders = buildInboxAndSentFolders();
      const engine = h.buildEngine({ folders });
      await engine.syncAccount(h.account.id, "manual");
      await dueAllFolders(h.pool, h.account.id);
      const account = await h.repository.getAccount(h.account.id);
      if (!account) throw new Error("missing account");
      const healthBefore = await accountHealthSnapshot(h.pool, h.account.id);
      const abort = new AbortController();
      const internal = engine as unknown as {
        fetchBodyBacklog: () => Promise<{ fetched: number; hitLockBudget: boolean }>;
        runHistoryLane: () => Promise<{
          messagesUpserted: number;
          bodiesFetched: number;
          hitLockBudget: boolean;
          errors: string[];
        }>;
      };

      if (lane === "body") {
        vi.spyOn(internal, "fetchBodyBacklog").mockImplementation(async () => {
          abort.abort();
          return { fetched: 0, hitLockBudget: false };
        });
      } else {
        vi.spyOn(internal, "runHistoryLane").mockImplementation(async () => {
          abort.abort();
          return { messagesUpserted: 0, bodiesFetched: 0, hitLockBudget: false, errors: [] };
        });
      }

      const [result] = await engine.syncDueAccounts(1, { signal: abort.signal });

      expect(result.outcome).toBe("partial_success");
      expect(result.errors).toEqual(["Sync interrupted by scheduler"]);
      expect(await accountHealthSnapshot(h.pool, h.account.id)).toEqual(healthBefore);
      const state = await h.repository.getAccount(h.account.id);
      expect(state?.currently_syncing).toBe(false);
      expect(state?.sync_started_by).toBeNull();
      const locks = await h.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_locks
         WHERE locktype = 'advisory'
           AND granted = true
           AND objid::bigint = $1::bigint`,
        [account.lock_id]
      );
      expect(locks.rows[0].count).toBe("0");
    }
  );

  it("treats a scheduler abort during Sent connection setup as a neutral yield", async () => {
    const h = await setupIntegration("sent-fast-pass-connect-abort");
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");
    await dueAllFolders(h.pool, h.account.id);

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const engine = h.buildEngine({
      folders,
      clientFactory: async (_account, options) => {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("IMAP connection interrupted for higher-priority sync work")),
            { once: true }
          );
        });
        throw new Error("unreachable");
      }
    });
    const abort = new AbortController();
    const sync = engine.syncDueSentFolders(1, { signal: abort.signal });

    await started;
    abort.abort();
    const [result] = await sync;

    expect(result.outcome).toBe("success");
    expect(result.errors).toEqual([]);
  });

  it("Scenario A — initial sync uses snapshot + watermark (spec §10.4)", async () => {
    const h = await setupIntegration("A");
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({ folders });

    // Cycle 1: snapshot taken, top batch [104,105] processed.
    const cycle1 = await engine.syncAccount(h.account.id, "manual");
    expect(cycle1.outcome).toBe("success");

    const after1 = (
      await h.pool.query<{
        initial_sync_complete: boolean;
        initial_sync_target_max_uid: string | null;
        initial_sync_oldest_uid_synced: string | null;
      }>(
        `SELECT initial_sync_complete, initial_sync_target_max_uid, initial_sync_oldest_uid_synced
         FROM public.imap_folders WHERE account_id=$1 AND path='INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(Number(after1.initial_sync_target_max_uid)).toBe(105);
    expect(Number(after1.initial_sync_oldest_uid_synced)).toBe(104);
    expect(after1.initial_sync_complete).toBe(false);

    // Cycle 2: next batch [102,103]. Force the folder due.
    await dueAllFolders(h.pool, h.account.id);
    const cycle2 = await engine.syncAccount(h.account.id, "manual");
    expect(cycle2.outcome).toBe("success");

    const after2 = (
      await h.pool.query<{
        initial_sync_complete: boolean;
        initial_sync_oldest_uid_synced: string | null;
      }>(
        `SELECT initial_sync_complete, initial_sync_oldest_uid_synced
         FROM public.imap_folders WHERE account_id=$1 AND path='INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(Number(after2.initial_sync_oldest_uid_synced)).toBe(102);
    expect(after2.initial_sync_complete).toBe(false);

    // Cycle 3: last UID 101, mark complete.
    await dueAllFolders(h.pool, h.account.id);
    const cycle3 = await engine.syncAccount(h.account.id, "manual");
    expect(cycle3.outcome).toBe("success");

    const after3 = (
      await h.pool.query<{ initial_sync_complete: boolean; last_uid: string | null }>(
        `SELECT initial_sync_complete, last_uid
         FROM public.imap_folders WHERE account_id=$1 AND path='INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(after3.initial_sync_complete).toBe(true);
    expect(Number(after3.last_uid)).toBe(105);

    const count = (
      await h.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.imap_messages
         WHERE account_id=$1 AND folder_path='INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(Number(count.count)).toBe(5);
  });

  it("mirrors new mail while the initial snapshot is still backfilling", async () => {
    const h = await setupIntegration("initial-live-head");
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({
      folders,
      overrides: { INCREMENTAL_SYNC_BATCH_SIZE: 1 }
    });

    await engine.syncAccount(h.account.id, "manual");
    folders[0].messages.push(
      makeTextMessage({
        uid: 106,
        subject: "arrived during initial sync",
        from: "fresh@x.test",
        to: "u@x.test",
        body: "fresh"
      })
    );
    folders[0].messages.push(
      makeTextMessage({
        uid: 107,
        subject: "second arrival during initial sync",
        from: "fresh-2@x.test",
        to: "u@x.test",
        body: "fresh again"
      })
    );

    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");

    const duringBackfill = (
      await h.pool.query<{
        initial_sync_complete: boolean;
        initial_sync_oldest_uid_synced: string | null;
        last_uid: string | null;
        mirrored_live_uid: string | null;
      }>(
        `SELECT
           f.initial_sync_complete,
           f.initial_sync_oldest_uid_synced,
           f.last_uid,
           m.uid::text AS mirrored_live_uid
         FROM public.imap_folders f
         LEFT JOIN public.imap_messages m
           ON m.account_id = f.account_id
          AND m.folder_path = f.path
          AND m.uidvalidity = f.uidvalidity
          AND m.uid = 106
         WHERE f.account_id = $1
           AND f.path = 'INBOX'`,
        [h.account.id]
      )
    ).rows[0];

    expect(duringBackfill.initial_sync_complete).toBe(false);
    expect(Number(duringBackfill.initial_sync_oldest_uid_synced)).toBe(102);
    expect(Number(duringBackfill.last_uid)).toBe(106);
    expect(Number(duringBackfill.mirrored_live_uid)).toBe(106);

    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");

    const afterCompletion = (
      await h.pool.query<{
        initial_sync_complete: boolean;
        last_uid: string | null;
        mirrored_live_uids: string;
      }>(
        `SELECT
           f.initial_sync_complete,
           f.last_uid,
           count(m.id)::text AS mirrored_live_uids
         FROM public.imap_folders f
         LEFT JOIN public.imap_messages m
           ON m.account_id = f.account_id
          AND m.folder_path = f.path
          AND m.uidvalidity = f.uidvalidity
          AND m.uid IN (106, 107)
         WHERE f.account_id = $1
           AND f.path = 'INBOX'
         GROUP BY f.id`,
        [h.account.id]
      )
    ).rows[0];

    expect(afterCompletion.initial_sync_complete).toBe(true);
    expect(Number(afterCompletion.last_uid)).toBe(107);
    expect(Number(afterCompletion.mirrored_live_uids)).toBe(2);
  });

  it("Scenario B — reconcile backfills missing-in-DB UIDs (spec §10.7 step 3)", async () => {
    const h = await setupIntegration("B");
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 11_001,
        messages: [
          makeTextMessage({ uid: 101, subject: "a", from: "a@x.test", to: "u@x.test", body: "a" }),
          makeTextMessage({ uid: 102, subject: "b", from: "b@x.test", to: "u@x.test", body: "b" })
        ]
      }
    ];
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });

    await engine.syncAccount(h.account.id, "manual");

    // Simulate a gap: drop UID 102 from the DB (server still has it).
    await h.pool.query(
      `DELETE FROM public.imap_messages WHERE account_id=$1 AND folder_path='INBOX' AND uid=102`,
      [h.account.id]
    );
    // Add UID 103 to the fixture (server has it, we don't).
    folders[0].messages.push(
      makeTextMessage({ uid: 103, subject: "c", from: "c@x.test", to: "u@x.test", body: "c" })
    );

    await dueAllFolders(h.pool, h.account.id);
    const cycle2 = await engine.syncAccount(h.account.id, "manual");
    expect(cycle2.outcome).toBe("success");

    const uids = (
      await h.pool.query<{ uid: string }>(
        `SELECT uid::text AS uid FROM public.imap_messages
         WHERE account_id=$1 AND folder_path='INBOX' AND deleted_in_provider=false
         ORDER BY uid`,
        [h.account.id]
      )
    ).rows.map((r) => Number(r.uid));
    expect(uids).toEqual([101, 102, 103]);

    const event = (
      await h.pool.query<{ payload: { backfilled: number } }>(
        `SELECT payload FROM public.imap_sync_events
         WHERE account_id=$1 AND event_type='RECONCILE_BACKFILL'
         ORDER BY occurred_at DESC LIMIT 1`,
        [h.account.id]
      )
    ).rows[0];
    expect(event).toBeDefined();
    expect(event.payload.backfilled).toBeGreaterThanOrEqual(1);
  });

  it("Scenario C — AUTH_ERROR short-circuits to BROKEN (spec §13.1)", async () => {
    const h = await setupIntegration("C");
    activeAccountIds.push(h.account.id);
    const engine = h.buildEngine({
      folders: [],
      clientFactory: async () => {
        throw new Error("Authentication failed: invalid credentials");
      }
    });

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("failed");

    const row = (
      await h.pool.query<{
        sync_state: string;
        sync_state_reason: string;
        current_backoff_ms: number;
        backoff_until: Date | null;
      }>(
        `SELECT sync_state, sync_state_reason, current_backoff_ms, backoff_until
         FROM public.imap_accounts WHERE id=$1`,
        [h.account.id]
      )
    ).rows[0];
    expect(row.sync_state).toBe("BROKEN");
    expect(row.sync_state_reason).toBe("AUTH_ERROR");
    expect(row.current_backoff_ms).toBe(0);
    expect(row.backoff_until).toBeNull();
  });

  it("Scenario D — UIDVALIDITY reset cap → BROKEN after >2 in 24h (spec §11)", async () => {
    const h = await setupIntegration("D");
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 100,
        messages: [makeTextMessage({ uid: 1, subject: "x", from: "a@x.test", to: "u@x.test", body: "x" })]
      }
    ];
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");

    // Reset #1.
    folders[0].uidValidity = 200;
    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");

    let row = (
      await h.pool.query<{ sync_state: string; uidvalidity_reset_count: number }>(
        `SELECT a.sync_state, f.uidvalidity_reset_count
         FROM public.imap_accounts a JOIN public.imap_folders f ON f.account_id=a.id
         WHERE a.id=$1 AND f.path='INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(row.uidvalidity_reset_count).toBe(1);
    expect(row.sync_state).not.toBe("BROKEN");

    // Reset #2 (at cap, not over).
    folders[0].uidValidity = 300;
    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");

    row = (
      await h.pool.query<{ sync_state: string; uidvalidity_reset_count: number }>(
        `SELECT a.sync_state, f.uidvalidity_reset_count
         FROM public.imap_accounts a JOIN public.imap_folders f ON f.account_id=a.id
         WHERE a.id=$1 AND f.path='INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(row.uidvalidity_reset_count).toBe(2);
    expect(row.sync_state).not.toBe("BROKEN");

    // Reset #3 — over cap.
    folders[0].uidValidity = 400;
    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");

    const broken = (
      await h.pool.query<{
        sync_state: string;
        sync_state_reason: string | null;
        uidvalidity_reset_count: number;
      }>(
        `SELECT a.sync_state, a.sync_state_reason, f.uidvalidity_reset_count
         FROM public.imap_accounts a JOIN public.imap_folders f ON f.account_id=a.id
         WHERE a.id=$1 AND f.path='INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(broken.uidvalidity_reset_count).toBe(3);
    expect(broken.sync_state).toBe("BROKEN");
    expect(broken.sync_state_reason).toBe("SYNC_ERROR");

    // 24h rolling window: backdate, unbreak, expect a single reset to count=1.
    await h.pool.query(
      `UPDATE public.imap_folders
       SET last_uidvalidity_reset_at = now() - interval '25 hours'
       WHERE account_id=$1 AND path='INBOX'`,
      [h.account.id]
    );
    await h.pool.query(
      `UPDATE public.imap_accounts SET sync_state='HEALTHY', sync_state_reason=NULL WHERE id=$1`,
      [h.account.id]
    );
    folders[0].uidValidity = 500;
    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");

    const after24h = (
      await h.pool.query<{ uidvalidity_reset_count: number }>(
        `SELECT uidvalidity_reset_count FROM public.imap_folders
         WHERE account_id=$1 AND path='INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(after24h.uidvalidity_reset_count).toBe(1);
  });

  it("Scenario E — folder-missing 7-day grace (spec §10.2)", async () => {
    const h = await setupIntegration("E");
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 100,
        messages: [makeTextMessage({ uid: 1, subject: "x", from: "a@x.test", to: "u@x.test", body: "x" })]
      },
      {
        path: "Project-Alpha",
        delimiter: "/",
        uidValidity: 200,
        messages: [makeTextMessage({ uid: 1, subject: "y", from: "b@x.test", to: "u@x.test", body: "y" })]
      }
    ];
    const engineFull = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engineFull.syncAccount(h.account.id, "manual");

    // Provider drops Project-Alpha from LIST.
    const onlyInbox = [folders[0]];
    const engineMissing = h.buildEngine({
      folders: onlyInbox,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50 },
      clientFactory: async () => new FixtureImapClient(onlyInbox) as unknown as MirrorImapClient
    });

    await forceFolderDiscovery(h.pool, h.account.id);
    await dueAllFolders(h.pool, h.account.id);
    await engineMissing.syncAccount(h.account.id, "manual");

    let row = (
      await h.pool.query<{ status: string; tracked: boolean; missing_since: Date | null }>(
        `SELECT status, tracked, missing_since FROM public.imap_folders
         WHERE account_id=$1 AND path='Project-Alpha'`,
        [h.account.id]
      )
    ).rows[0];
    expect(row.missing_since).not.toBeNull();
    expect(row.status).not.toBe("MISSING");
    expect(row.tracked).toBe(true);

    // Past grace: backdate missing_since 8 days.
    await backdateMissingSince(h.pool, h.account.id, "Project-Alpha", "8 days");
    await forceFolderDiscovery(h.pool, h.account.id);
    await dueAllFolders(h.pool, h.account.id);
    await engineMissing.syncAccount(h.account.id, "manual");

    row = (
      await h.pool.query<{ status: string; tracked: boolean; missing_since: Date | null }>(
        `SELECT status, tracked, missing_since FROM public.imap_folders
         WHERE account_id=$1 AND path='Project-Alpha'`,
        [h.account.id]
      )
    ).rows[0];
    expect(row.status).toBe("MISSING");
    expect(row.tracked).toBe(false);
  });

  it("excludes a Rackspace INBOX.INBOX alias only after metadata fingerprint verification", async () => {
    const h = await setupIntegration("rackspace-alias-verified");
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET provider_profile = 'rackspace' WHERE id = $1", [h.account.id]);
    const sharedMessages = [
      makeTextMessage({ uid: 1, subject: "same-a", from: "a@x.test", to: "u@x.test", body: "a" }),
      makeTextMessage({ uid: 2, subject: "same-b", from: "b@x.test", to: "u@x.test", body: "b" })
    ];
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: ".",
        specialUse: "\\Inbox",
        uidValidity: 77_001,
        messages: sharedMessages
      },
      {
        path: "INBOX.INBOX",
        delimiter: ".",
        uidValidity: 77_001,
        messages: sharedMessages
      }
    ];
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");

    const folderRows = await h.pool.query<{ path: string; tracked: boolean; excluded_reason: string | null }>(
      `
      SELECT path, tracked, excluded_reason
      FROM public.imap_folders
      WHERE account_id = $1
      ORDER BY path
      `,
      [h.account.id]
    );
    expect(folderRows.rows).toEqual([
      { path: "INBOX", tracked: true, excluded_reason: null },
      { path: "INBOX.INBOX", tracked: false, excluded_reason: "excluded_duplicate_alias:INBOX" }
    ]);

    const messageFolders = await h.pool.query<{ folder_path: string; count: string }>(
      `
      SELECT folder_path, count(*)::text AS count
      FROM public.imap_messages
      WHERE account_id = $1
      GROUP BY folder_path
      ORDER BY folder_path
      `,
      [h.account.id]
    );
    expect(messageFolders.rows).toEqual([{ folder_path: "INBOX", count: "2" }]);
  });

  it("keeps a Rackspace INBOX.INBOX folder when its metadata fingerprint differs", async () => {
    const h = await setupIntegration("rackspace-alias-different");
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET provider_profile = 'rackspace' WHERE id = $1", [h.account.id]);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: ".",
        specialUse: "\\Inbox",
        uidValidity: 88_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "inbox-a", from: "a@x.test", to: "u@x.test", body: "a" }),
          makeTextMessage({ uid: 2, subject: "inbox-b", from: "b@x.test", to: "u@x.test", body: "b" })
        ]
      },
      {
        path: "INBOX.INBOX",
        delimiter: ".",
        uidValidity: 88_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "nested-a", from: "a@x.test", to: "u@x.test", body: "a" }),
          makeTextMessage({ uid: 2, subject: "nested-b", from: "b@x.test", to: "u@x.test", body: "b" })
        ]
      }
    ];
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");

    const folderRows = await h.pool.query<{ path: string; tracked: boolean; excluded_reason: string | null }>(
      `
      SELECT path, tracked, excluded_reason
      FROM public.imap_folders
      WHERE account_id = $1
      ORDER BY path
      `,
      [h.account.id]
    );
    expect(folderRows.rows).toEqual([
      { path: "INBOX", tracked: true, excluded_reason: null },
      { path: "INBOX.INBOX", tracked: true, excluded_reason: null }
    ]);

    const messageFolders = await h.pool.query<{ folder_path: string; count: string }>(
      `
      SELECT folder_path, count(*)::text AS count
      FROM public.imap_messages
      WHERE account_id = $1
      GROUP BY folder_path
      ORDER BY folder_path
      `,
      [h.account.id]
    );
    expect(messageFolders.rows).toEqual([
      { folder_path: "INBOX", count: "2" },
      { folder_path: "INBOX.INBOX", count: "2" }
    ]);
  });

  it("Scenario F — PARTIAL_SUCCESS counts as success (spec §12.2)", async () => {
    const h = await setupIntegration("F");
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 100,
        messages: [makeTextMessage({ uid: 1, subject: "x", from: "a@x.test", to: "u@x.test", body: "x" })]
      },
      {
        path: "Project-Bravo",
        delimiter: "/",
        uidValidity: 200,
        messages: [makeTextMessage({ uid: 1, subject: "y", from: "b@x.test", to: "u@x.test", body: "y" })]
      }
    ];
    // First, a clean sync to seed the counters.
    const okEngine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await okEngine.syncAccount(h.account.id, "manual");

    const before = (
      await h.pool.query<{
        consecutive_successes: number;
        consecutive_failures: number;
      }>(
        `SELECT consecutive_successes, consecutive_failures FROM public.imap_accounts WHERE id=$1`,
        [h.account.id]
      )
    ).rows[0];

    // Now flake on Project-Bravo only.
    class FlakyClient extends FixtureImapClient {
      async getMailboxLock(path: string) {
        if (path === "Project-Bravo") {
          throw new Error("Mailbox temporarily unavailable (provider error)");
        }
        return super.getMailboxLock(path);
      }
    }
    const flakyEngine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50 },
      clientFactory: async () => new FlakyClient(folders) as unknown as MirrorImapClient
    });
    await dueAllFolders(h.pool, h.account.id);
    const partial = await flakyEngine.syncAccount(h.account.id, "manual");
    expect(partial.outcome).toBe("partial_success");

    const after = (
      await h.pool.query<{
        consecutive_successes: number;
        consecutive_failures: number;
        sync_state: string;
      }>(
        `SELECT consecutive_successes, consecutive_failures, sync_state
         FROM public.imap_accounts WHERE id=$1`,
        [h.account.id]
      )
    ).rows[0];
    expect(after.consecutive_successes).toBe(before.consecutive_successes + 1);
    expect(after.consecutive_failures).toBe(0);
    expect(after.sync_state).toBe("DEGRADED");
  });

  it("Scenario G.1 — lock budget still allows priority folders and skips lower priority work", async () => {
    const h = await setupIntegration("G-priority-budget", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      MAX_LOCK_HOLD_MS: 1
    });
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 100,
        messages: [makeTextMessage({ uid: 1, subject: "priority", from: "a@x.test", to: "u@x.test", body: "priority" })]
      },
      {
        path: "Project-Charlie",
        delimiter: "/",
        uidValidity: 200,
        messages: [makeTextMessage({ uid: 1, subject: "rr", from: "b@x.test", to: "u@x.test", body: "rr" })]
      }
    ];
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    class BudgetExpiredAfterListClient extends FixtureImapClient {
      async list() {
        const listed = await super.list();
        now += 10;
        return listed;
      }
    }

    try {
      const engine = h.buildEngine({
        folders,
        clientFactory: async () => new BudgetExpiredAfterListClient(folders) as unknown as MirrorImapClient
      });
      const result = await engine.syncAccount(h.account.id, "manual");

      expect(result.outcome).toBe("success");
      expect(result.hitLockBudget).toBe(true);
      expect(result.foldersProcessed).toBe(1);
      expect(result.bodiesFetched).toBe(0);

      const rows = await h.pool.query<{ folder_path: string; count: string }>(
        `
        SELECT folder_path, count(*)::text AS count
        FROM public.imap_messages
        WHERE account_id = $1
        GROUP BY folder_path
        ORDER BY folder_path
        `,
        [h.account.id]
      );
      expect(rows.rows).toEqual([{ folder_path: "INBOX", count: "1" }]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("Scenario G.2/G.3 — non-priority sync exits at batch boundaries without resetting backoff", async () => {
    const h = await setupIntegration("G-rr-budget", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      INCREMENTAL_SYNC_BATCH_SIZE: 1,
      MAX_LOCK_HOLD_MS: 5
    });
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "Project-Delta",
        delimiter: "/",
        uidValidity: 300,
        messages: [
          makeTextMessage({ uid: 1, subject: "seed-1", from: "a@x.test", to: "u@x.test", body: "seed-1" }),
          makeTextMessage({ uid: 2, subject: "seed-2", from: "a@x.test", to: "u@x.test", body: "seed-2" }),
          makeTextMessage({ uid: 3, subject: "seed-3", from: "a@x.test", to: "u@x.test", body: "seed-3" })
        ]
      }
    ];
    const seedEngine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50, MAX_LOCK_HOLD_MS: 600_000 } });
    await seedEngine.syncAccount(h.account.id, "manual");
    const seeded = await h.pool.query<{
      initial_sync_complete: boolean;
      last_uid: string | null;
      count: string;
    }>(
      `
      SELECT f.initial_sync_complete, f.last_uid, count(m.id)::text AS count
      FROM public.imap_folders f
      LEFT JOIN public.imap_messages m ON m.account_id = f.account_id AND m.folder_path = f.path
      WHERE f.account_id = $1 AND f.path = 'Project-Delta'
      GROUP BY f.id
      `,
      [h.account.id]
    );
    expect(seeded.rows[0]).toMatchObject({
      initial_sync_complete: true,
      last_uid: "3",
      count: "3"
    });

    folders[0].messages.push(
      makeTextMessage({ uid: 4, subject: "new-4", from: "a@x.test", to: "u@x.test", body: "new-4" }),
      makeTextMessage({ uid: 5, subject: "new-5", from: "a@x.test", to: "u@x.test", body: "new-5" }),
      makeTextMessage({ uid: 6, subject: "new-6", from: "a@x.test", to: "u@x.test", body: "new-6" })
    );
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET consecutive_successes = 7,
          consecutive_failures = 2,
          current_backoff_ms = 1234,
          backoff_until = now() - interval '1 second'
      WHERE id = $1
      `,
      [h.account.id]
    );
    await dueAllFolders(h.pool, h.account.id);

    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    class BudgetExpiredAfterMetadataFetchClient extends FixtureImapClient {
      async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>
      ) {
        for await (const message of super.fetch(range, query)) {
          yield message;
        }
        if (Array.isArray(range)) now += 10;
      }
    }

    try {
      const engine = h.buildEngine({
        folders,
        clientFactory: async () => new BudgetExpiredAfterMetadataFetchClient(folders) as unknown as MirrorImapClient
      });
      const result = await engine.syncAccount(h.account.id, "manual");

      expect(result.outcome).toBe("success");
      expect(result.hitLockBudget).toBe(true);
      expect(result.messagesUpserted).toBe(1);

      const folder = await h.pool.query<{ last_uid: string | null }>(
        "SELECT last_uid FROM public.imap_folders WHERE account_id = $1 AND path = 'Project-Delta'",
        [h.account.id]
      );
      expect(Number(folder.rows[0].last_uid)).toBe(4);

      const uids = await h.pool.query<{ uid: string }>(
        `
        SELECT uid::text AS uid
        FROM public.imap_messages
        WHERE account_id = $1 AND folder_path = 'Project-Delta'
        ORDER BY uid
        `,
        [h.account.id]
      );
      expect(uids.rows.map((row) => Number(row.uid))).toEqual([1, 2, 3, 4]);

      const account = await h.pool.query<{
        consecutive_successes: number;
        consecutive_failures: number;
        current_backoff_ms: number;
        backoff_until: Date | null;
      }>(
        `
        SELECT consecutive_successes, consecutive_failures, current_backoff_ms, backoff_until
        FROM public.imap_accounts
        WHERE id = $1
        `,
        [h.account.id]
      );
      expect(account.rows[0].consecutive_successes).toBe(7);
      expect(account.rows[0].consecutive_failures).toBe(2);
      expect(account.rows[0].current_backoff_ms).toBe(1234);
      expect(account.rows[0].backoff_until).not.toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("caps body backlog batches per tick", async () => {
    const h = await setupIntegration("G-body-cap", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      BODY_BACKFILL_BATCH_SIZE: 2,
      MAX_BODY_BATCHES_PER_TICK: 2
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1", [h.account.id]);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 400,
        messages: Array.from({ length: 7 }, (_, index) => makeTextMessage({
          uid: index + 1,
          subject: `body-${index + 1}`,
          from: "a@x.test",
          to: "u@x.test",
          body: `body-${index + 1}`
        }))
      }
    ];

    const backlogSpy = vi.spyOn(h.repository, "getBodyBacklog");
    const engine = h.buildEngine({ folders });
    const result = await engine.syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(4);
    expect(backlogSpy).toHaveBeenCalledTimes(1);
    expect(backlogSpy.mock.calls[0]?.[1]).toBe(4);

    const bodyCount = await h.pool.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM public.imap_messages
      WHERE account_id = $1 AND body_fetched_at IS NOT NULL
      `,
      [h.account.id]
    );
    expect(Number(bodyCount.rows[0].count)).toBe(4);
  });

  it("completes body storage atomically across concurrent retries", async () => {
    const h = await setupIntegration("G-body-completion-atomic", {
      BODY_STORAGE_MODE: "parsed_only",
      BODY_BACKFILL_BATCH_SIZE: 1,
      MAX_BODY_BATCHES_PER_TICK: 1
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 409,
      messages: [makeTextMessage({
        uid: 1,
        subject: "atomic body completion",
        from: "a@x.test",
        to: "u@x.test",
        body: "atomic body completion"
      })]
    }];
    const synced = await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");
    expect(synced.outcome).toBe("success");
    const message = await h.pool.query<{ id: string }>(
      "SELECT id FROM public.imap_messages WHERE account_id = $1 AND uid = 1",
      [h.account.id]
    );
    const messageId = message.rows[0].id;
    await h.pool.query(
      `UPDATE public.imap_messages SET body_fetched_at = NULL WHERE id = $1`,
      [messageId]
    );
    await h.pool.query(
      `UPDATE public.imap_folders SET bodies_fetched_count = 0
       WHERE account_id = $1 AND path = 'INBOX'`,
      [h.account.id]
    );

    await Promise.all(Array.from(
      { length: 5 },
      () => h.repository.completeBodyStorage(messageId)
    ));

    const completion = await h.pool.query<{
      body_fetched_at: Date | null;
      bodies_fetched_count: number;
    }>(
      `SELECT message.body_fetched_at, folder.bodies_fetched_count
       FROM public.imap_messages message
       JOIN public.imap_folders folder
         ON folder.account_id = message.account_id
        AND folder.path = message.folder_path
       WHERE message.id = $1`,
      [messageId]
    );
    expect(completion.rows[0].body_fetched_at).not.toBeNull();
    expect(completion.rows[0].bodies_fetched_count).toBe(1);

    await h.pool.query(
      `UPDATE public.imap_messages SET body_fetched_at = NULL WHERE id = $1`,
      [messageId]
    );
    const blocker = await h.pool.connect();
    let pendingCompletion: Promise<void> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM public.imap_messages WHERE id = $1 FOR UPDATE",
        [messageId]
      );
      const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      pendingCompletion = h.repository.completeBodyStorage(messageId);
      await vi.waitFor(async () => {
        const waiting = await h.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND $1 = ANY(pg_blocking_pids(pid))
             AND query ILIKE '%WITH target AS MATERIALIZED%'`,
          [blockerPid.rows[0].pid]
        );
        expect(waiting.rows[0].count).toBe("1");
      }, { timeout: 2_000, interval: 10 });
      await blocker.query("DELETE FROM public.imap_messages WHERE id = $1", [messageId]);
      await blocker.query("COMMIT");
      await expect(pendingCompletion).rejects.toThrow(
        `Message not found after body storage: ${messageId}`
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await pendingCompletion?.catch(() => undefined);
    }
  });

  it("batches small parsed-only bodies through one UID FETCH command", async () => {
    const h = await setupIntegration("G-body-batch", {
      BODY_STORAGE_MODE: "parsed_only",
      INITIAL_SYNC_BATCH_SIZE: 50,
      BODY_BACKFILL_BATCH_SIZE: 3,
      MAX_BODY_BATCHES_PER_TICK: 1
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1", [h.account.id]);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 401,
        messages: Array.from({ length: 3 }, (_, index) => makeTextMessage({
          uid: index + 1,
          subject: `batched-body-${index + 1}`,
          from: "a@x.test",
          to: "u@x.test",
          body: `batched-body-${index + 1}`
        }))
      }
    ];

    let sourceFetches = 0;
    let downloads = 0;
    class CountingBodyBatchClient extends FixtureImapClient {
      async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>,
        options?: Record<string, unknown>
      ) {
        if (query.source && Array.isArray(range)) {
          sourceFetches += 1;
          for (const uid of range) {
            const fetched = await super.fetchOne(String(uid), query, options);
            if (fetched) yield fetched;
          }
          return;
        }
        for await (const message of super.fetch(range, query)) {
          yield message;
        }
      }

      async download(
        range: string,
        part?: string,
        options?: Record<string, unknown>
      ) {
        downloads += 1;
        return await super.download(range, part, options);
      }
    }

    const engine = h.buildEngine({
      folders,
      clientFactory: async () => new CountingBodyBatchClient(folders)
    });
    const result = await engine.syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(3);
    expect(sourceFetches).toBe(1);
    expect(downloads).toBe(0);
  });

  it("groups an interleaved logical backlog by folder before parsed-only body fetch", async () => {
    const h = await setupIntegration("G-body-batch-folders", {
      BODY_STORAGE_MODE: "parsed_only",
      INITIAL_SYNC_BATCH_SIZE: 50,
      BODY_BACKFILL_BATCH_SIZE: 4,
      MAX_BODY_BATCHES_PER_TICK: 1,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );
    const folders: FixtureFolder[] = [
      {
        path: "Folder-A",
        delimiter: "/",
        uidValidity: 404,
        messages: [4, 2].map((uid) => makeTextMessage({
          uid,
          subject: `folder-a-${uid}`,
          from: "a@x.test",
          to: "u@x.test",
          body: `folder-a-${uid}`
        }))
      },
      {
        path: "Folder-B",
        delimiter: "/",
        uidValidity: 405,
        messages: [3, 1].map((uid) => makeTextMessage({
          uid,
          subject: `folder-b-${uid}`,
          from: "a@x.test",
          to: "u@x.test",
          body: `folder-b-${uid}`
        }))
      }
    ];

    const sourceRanges: number[][] = [];
    let downloads = 0;
    class CountingFolderBatchClient extends FixtureImapClient {
      override async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>
      ) {
        if (query.source && Array.isArray(range)) sourceRanges.push(range);
        yield* super.fetch(range, query);
      }

      override async download(
        range: string,
        part?: string,
        options?: Record<string, unknown>
      ) {
        downloads += 1;
        return await super.download(range, part, options);
      }
    }

    const result = await h.buildEngine({
      folders,
      clientFactory: async () => new CountingFolderBatchClient(folders)
    }).syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(4);
    expect(sourceRanges).toHaveLength(2);
    expect(sourceRanges.every((range) => range.length === 2)).toBe(true);
    expect(downloads).toBe(0);
  });

  it("commits returned batch bodies and retries exactly the UIDs missing from FETCH", async () => {
    const h = await setupIntegration("G-body-batch-missing", {
      BODY_STORAGE_MODE: "parsed_only",
      INITIAL_SYNC_BATCH_SIZE: 50,
      BODY_BACKFILL_BATCH_SIZE: 3,
      MAX_BODY_BATCHES_PER_TICK: 1
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 402,
      messages: Array.from({ length: 3 }, (_, index) => makeTextMessage({
        uid: index + 1,
        subject: `missing-batch-body-${index + 1}`,
        from: "a@x.test",
        to: "u@x.test",
        body: `missing-batch-body-${index + 1}`
      }))
    }];

    class MissingBatchUidClient extends FixtureImapClient {
      downloads: string[] = [];

      override async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>
      ) {
        if (query.source && Array.isArray(range)) {
          yield* super.fetch(range.filter((uid) => uid !== 2), query);
          return;
        }
        yield* super.fetch(range, query);
      }

      override async download(
        range: string,
        part?: string,
        options?: Record<string, unknown>
      ) {
        this.downloads.push(range);
        return await super.download(range, part, options);
      }
    }

    const client = new MissingBatchUidClient(folders);
    const result = await h.buildEngine({
      folders,
      clientFactory: async () => client
    }).syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(3);
    expect(client.downloads).toEqual(["2"]);
    const rows = await h.pool.query<{
      uid: string;
      body_fetched_at: Date | null;
      deleted_in_provider: boolean;
    }>(
      `SELECT uid::text, body_fetched_at, deleted_in_provider
       FROM public.imap_messages
       WHERE account_id = $1
       ORDER BY uid`,
      [h.account.id]
    );
    expect(rows.rows.map((row) => ({
      uid: row.uid,
      fetched: row.body_fetched_at !== null,
      deleted: row.deleted_in_provider
    }))).toEqual([
      { uid: "1", fetched: true, deleted: false },
      { uid: "2", fetched: true, deleted: false },
      { uid: "3", fetched: true, deleted: false }
    ]);
  });

  it("marks only a truly gone UID moved after a batch omission and individual retry", async () => {
    const h = await setupIntegration("G-body-batch-gone", {
      BODY_STORAGE_MODE: "parsed_only",
      INITIAL_SYNC_BATCH_SIZE: 50,
      BODY_BACKFILL_BATCH_SIZE: 3,
      MAX_BODY_BATCHES_PER_TICK: 1
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 406,
      messages: Array.from({ length: 3 }, (_, index) => makeTextMessage({
        uid: index + 1,
        subject: `gone-batch-body-${index + 1}`,
        from: "a@x.test",
        to: "u@x.test",
        body: `gone-batch-body-${index + 1}`
      }))
    }];

    class GoneBatchUidClient extends FixtureImapClient {
      override async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>
      ) {
        if (query.source && Array.isArray(range)) {
          yield* super.fetch(range.filter((uid) => uid !== 2), query);
          return;
        }
        yield* super.fetch(range, query);
      }

      override async download(
        range: string,
        part?: string,
        options?: Record<string, unknown>
      ) {
        if (range === "2") return {};
        return await super.download(range, part, options);
      }
    }

    const result = await h.buildEngine({
      folders,
      clientFactory: async () => new GoneBatchUidClient(folders)
    }).syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    const rows = await h.pool.query<{
      uid: string;
      body_fetched_at: Date | null;
      deleted_in_provider: boolean;
    }>(
      `SELECT uid::text, body_fetched_at, deleted_in_provider
       FROM public.imap_messages
       WHERE account_id = $1
       ORDER BY uid`,
      [h.account.id]
    );
    expect(rows.rows.map((row) => ({
      uid: row.uid,
      fetched: row.body_fetched_at !== null,
      deleted: row.deleted_in_provider
    }))).toEqual([
      { uid: "1", fetched: true, deleted: false },
      { uid: "2", fetched: false, deleted: true },
      { uid: "3", fetched: true, deleted: false }
    ]);
  });

  it("rolls back every evidence write when a parsed-only batch evidence transaction fails", async () => {
    const h = await setupIntegration("G-body-batch-evidence-atomic", {
      BODY_STORAGE_MODE: "parsed_only",
      INITIAL_SYNC_BATCH_SIZE: 50,
      BODY_BACKFILL_BATCH_SIZE: 3,
      MAX_BODY_BATCHES_PER_TICK: 1
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 406,
      messages: Array.from({ length: 3 }, (_, index) => makeTextMessage({
        uid: index + 1,
        subject: `atomic-body-${index + 1}`,
        from: "a@x.test",
        to: "u@x.test",
        body: `atomic-body-${index + 1}`
      }))
    }];
    let evidenceWrites = 0;
    const failingProtection: MetadataProtectionAdapter = {
      storageMode: "plaintext",
      async protect(context, values) {
        if (context.kind === "message_body") {
          evidenceWrites += 1;
          if (evidenceWrites === 2) throw new Error("injected evidence batch failure");
        }
        return plaintextMetadataProtection.protect(context, values);
      },
      async reveal(context, stored) {
        return plaintextMetadataProtection.reveal(context, stored);
      }
    };

    const failed = await new MirrorEngine({
      pool: h.pool,
      config: h.config,
      metadataProtection: failingProtection,
      clientFactory: async () => new FixtureImapClient(folders)
    }).syncAccount(h.account.id, "manual");

    expect(failed.outcome).toBe("failed");
    const rows = await h.pool.query<{ body_rows: string }>(
      `SELECT count(b.message_id)::text AS body_rows
       FROM public.imap_messages m
       LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
       WHERE m.account_id = $1`,
      [h.account.id]
    );
    expect(Number(rows.rows[0].body_rows)).toBe(0);
  });

  it("retries a parsed-only batch after body storage fails without losing batched evidence", async () => {
    const h = await setupIntegration("G-body-batch-store-retry", {
      BODY_STORAGE_MODE: "parsed_only",
      INITIAL_SYNC_BATCH_SIZE: 50,
      BODY_BACKFILL_BATCH_SIZE: 3,
      MAX_BODY_BATCHES_PER_TICK: 1
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 407,
      messages: Array.from({ length: 3 }, (_, index) => makeTextMessage({
        uid: index + 1,
        subject: `store-retry-body-${index + 1}`,
        from: "a@x.test",
        to: "u@x.test",
        body: `store-retry-body-${index + 1}`
      }))
    }];
    const databaseStore = new DatabaseBodyStore(h.repository);
    let storeCalls = 0;
    const failingStore: BodyStore = {
      async store(body) {
        storeCalls += 1;
        if (storeCalls === 2) throw new Error("injected body store failure");
        await databaseStore.store(body);
      }
    };

    const failed = await h.buildEngine({
      folders,
      bodyStore: failingStore
    }).syncAccount(h.account.id, "manual");

    expect(failed.outcome).toBe("failed");
    const afterFailure = await h.pool.query<{
      uid: string;
      body_fetched_at: Date | null;
      search_extract: string | null;
      body_text: string | null;
    }>(
      `SELECT m.uid::text, m.body_fetched_at, b.search_extract, b.body_text
       FROM public.imap_messages m
       LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
       WHERE m.account_id = $1
       ORDER BY m.uid`,
      [h.account.id]
    );
    expect(afterFailure.rows.map((row) => ({
      uid: row.uid,
      fetched: row.body_fetched_at !== null,
      evidence: row.search_extract,
      payload: row.body_text
    }))).toEqual([
      {
        uid: "1",
        fetched: true,
        evidence: "store-retry-body-1",
        payload: "store-retry-body-1"
      },
      {
        uid: "2",
        fetched: false,
        evidence: "store-retry-body-2",
        payload: null
      },
      {
        uid: "3",
        fetched: false,
        evidence: "store-retry-body-3",
        payload: null
      }
    ]);

    const retriedUids: string[] = [];
    const retried = await h.buildEngine({
      folders,
      hooks: {
        onBodyFetched(message) {
          retriedUids.push(String(message.uid));
        }
      }
    }).syncAccount(h.account.id, "manual");
    expect(retried.outcome).toBe("success");
    expect(retriedUids).toEqual(["2", "3"]);
    const completed = await h.pool.query<{
      uid: string;
      body_fetched_at: Date | null;
      search_extract: string | null;
      body_text: string | null;
    }>(
      `SELECT m.uid::text, m.body_fetched_at, b.search_extract, b.body_text
       FROM public.imap_messages m
       LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
       WHERE m.account_id = $1
       ORDER BY m.uid`,
      [h.account.id]
    );
    expect(completed.rows.map((row) => ({
      uid: row.uid,
      fetched: row.body_fetched_at !== null,
      evidence: row.search_extract,
      payload: row.body_text
    }))).toEqual([1, 2, 3].map((uid) => ({
      uid: String(uid),
      fetched: true,
      evidence: `store-retry-body-${uid}`,
      payload: `store-retry-body-${uid}`
    })));
  });

  it("streams parsed-only bodies that exceed the bounded batch source cap", async () => {
    const h = await setupIntegration("G-body-batch-cap", {
      BODY_STORAGE_MODE: "parsed_only",
      BODY_RAW_MAX_BYTES: 64,
      INITIAL_SYNC_BATCH_SIZE: 50,
      BODY_BACKFILL_BATCH_SIZE: 2,
      MAX_BODY_BATCHES_PER_TICK: 1
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 403,
      messages: Array.from({ length: 2 }, (_, index) => makeTextMessage({
        uid: index + 1,
        subject: `large-body-${index + 1}`,
        from: "a@x.test",
        to: "u@x.test",
        body: "x".repeat(256)
      }))
    }];

    let sourceFetches = 0;
    let downloads = 0;
    class CountingStreamingFallbackClient extends FixtureImapClient {
      override async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>
      ) {
        if (query.source && Array.isArray(range)) sourceFetches += 1;
        yield* super.fetch(range, query);
      }

      override async download(
        range: string,
        part?: string,
        options?: Record<string, unknown>
      ) {
        downloads += 1;
        return await super.download(range, part, options);
      }
    }

    const result = await h.buildEngine({
      folders,
      clientFactory: async () => new CountingStreamingFallbackClient(folders)
    }).syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(2);
    expect(sourceFetches).toBe(0);
    expect(downloads).toBe(2);
  });

  it("collapses a lost IMAP connection into one error instead of failing every remaining folder", async () => {
    const h = await setupIntegration("G-connection-lost");
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 420,
        messages: [
          makeTextMessage({ uid: 1, subject: "in", from: "a@x.test", to: "u@x.test", body: "in" })
        ]
      },
      { path: "Sent", delimiter: "/", specialUse: "\\Sent", uidValidity: 421, messages: [] },
      { path: "Notes", delimiter: "/", uidValidity: 422, messages: [] }
    ];

    // Dies after INBOX: every later getMailboxLock sees imapflow's NoConnection.
    class ConnectionLostFixtureImapClient extends FixtureImapClient {
      async getMailboxLock(path: string) {
        if (path !== "INBOX") {
          throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
        }
        return super.getMailboxLock(path);
      }
    }

    const engine = h.buildEngine({
      folders,
      clientFactory: async () => new ConnectionLostFixtureImapClient(folders)
    });
    const result = await engine.syncAccount(h.account.id, "manual");

    // "Sent" is a priority folder, but the connection died — the run must not
    // count it as a priority failure, and "Notes" must not add a third error.
    expect(result.outcome).toBe("partial_success");
    expect(result.foldersProcessed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Sent: [Error] [code=NoConnection] Connection not available");
    expect(result.errors[0]).toContain("connection lost");

    const account = await h.pool.query<{ consecutive_failures: number; sync_state: string }>(
      "SELECT consecutive_failures, sync_state FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(account.rows[0].consecutive_failures).toBe(0);
  });

  it("hard-closes an unusable host-owned client without waiting for LOGOUT", async () => {
    const h = await setupIntegration("G-unusable-host-client-cleanup");
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 423,
        messages: []
      }
    ];
    await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");

    let releaseLogout: (() => void) | undefined;
    class UnusableFixtureImapClient extends FixtureImapClient {
      usable = false;
      close = vi.fn(() => undefined);
      override logout = vi.fn(async () => await new Promise<void>((resolve) => {
        releaseLogout = resolve;
      }));

      override async getMailboxLock(): Promise<MailboxLock> {
        throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
      }
    }

    const client = new UnusableFixtureImapClient(folders);
    const engine = h.buildEngine({ folders });
    const run = engine.syncAccount(h.account.id, "scheduled", {
      liveInboxOnly: true,
      forceReconcileFolders: ["INBOX"],
      client,
      clientAccountId: h.account.id,
      keepClientOpen: true
    });
    const completion = await Promise.race([
      run.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100))
    ]);
    releaseLogout?.();
    await run;

    expect(completion).toBe("completed");
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.logout).not.toHaveBeenCalled();
  });

  it("stores parsed bodies without raw MIME when BODY_STORAGE_MODE is parsed_only", async () => {
    const h = await setupIntegration("G-parsed-only-bodies", { BODY_STORAGE_MODE: "parsed_only" });
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1", [h.account.id]);
    const fixtureMessage = makeTextMessage({
      uid: 1,
      subject: "parsed",
      from: "a@x.test",
      to: "u@x.test",
      body: "parsed-only body"
    });
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 410,
        messages: [fixtureMessage]
      }
    ];

    const engine = h.buildEngine({ folders });
    const result = await engine.syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(1);

    const body = (
      await h.pool.query<{
        raw_mime: Buffer | null;
        raw_mime_sha256: string | null;
        raw_bytes: string;
        raw_truncated: boolean;
        body_text: string | null;
        body_plain: string | null;
      }>(
        `
        SELECT b.raw_mime, b.raw_mime_sha256, b.raw_bytes::text,
               b.raw_truncated, b.body_text, b.body_plain
        FROM public.imap_message_bodies b
        JOIN public.imap_messages m ON m.id = b.message_id
        WHERE m.account_id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(body.raw_mime).toBeNull();
    expect(body.raw_mime_sha256).toBe(createHash("sha256").update(fixtureMessage.raw).digest("hex"));
    expect(Number(body.raw_bytes)).toBeGreaterThan(0);
    expect(body.raw_truncated).toBe(false);
    expect(`${body.body_text ?? ""}${body.body_plain ?? ""}`).toContain("parsed-only body");
  });

  it("commits bounded search and threading evidence before invoking the body store", async () => {
    const h = await setupIntegration("G-body-store-seam");
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1", [h.account.id]);
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 411,
      messages: [makeTextMessage({
        uid: 1,
        subject: "seam",
        from: "a@x.test",
        to: "u@x.test",
        body: "searchable before payload storage"
      })]
    }];
    const databaseStore = new DatabaseBodyStore(h.repository);
    const observedFetchedCounts: number[] = [];
    const observed: Array<{
      search_extract: string | null;
      raw_mime: Buffer | null;
      body_text: string | null;
      raw_mime_sha256: string | null;
      threading_payload_sha256: string | null;
      body_fetched_at: Date | null;
    }> = [];
    const bodyStore: BodyStore = {
      async store(body) {
        const state = await h.pool.query<{
          search_extract: string | null;
          raw_mime: Buffer | null;
          body_text: string | null;
          raw_mime_sha256: string | null;
          threading_payload_sha256: string | null;
          body_fetched_at: Date | null;
        }>(
          `SELECT b.search_extract, b.raw_mime, b.body_text,
                  b.raw_mime_sha256, b.threading_payload_sha256,
                  m.body_fetched_at
           FROM public.imap_message_bodies b
           JOIN public.imap_messages m ON m.id = b.message_id
           WHERE b.message_id = $1`,
          [body.messageId]
        );
        observed.push(state.rows[0]);
        const progress = await h.pool.query<{ live_bodies_fetched_count: number }>(
          `SELECT live_bodies_fetched_count
           FROM public.imap_account_progress
           WHERE account_id = $1`,
          [h.account.id]
        );
        observedFetchedCounts.push(progress.rows[0]?.live_bodies_fetched_count ?? -1);
        await databaseStore.store(body);
      }
    };

    const result = await h.buildEngine({ folders, bodyStore }).syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(observed).toEqual([{
      search_extract: "searchable before payload storage",
      raw_mime: null,
      body_text: null,
      raw_mime_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      threading_payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      body_fetched_at: null
    }]);
    expect(observedFetchedCounts).toEqual([0]);
    const completed = await h.pool.query<{
      has_raw: boolean;
      body_text: string | null;
      body_fetched_at: Date | null;
    }>(
      `SELECT b.raw_mime IS NOT NULL AS has_raw, b.body_text, m.body_fetched_at
       FROM public.imap_message_bodies b
       JOIN public.imap_messages m ON m.id = b.message_id
       WHERE m.account_id = $1`,
      [h.account.id]
    );
    expect(completed.rows[0]).toMatchObject({
      has_raw: true,
      body_text: "searchable before payload storage",
      body_fetched_at: expect.any(Date)
    });
  });

  it("Scenario H — initial sync timeout aborts IMAP without advancing the watermark", async () => {
    const h = await setupIntegration("H-initial-timeout", {
      INITIAL_SYNC_BATCH_SIZE: 2,
      INITIAL_SYNC_BATCH_TIMEOUT_MS: 100,
      MAX_LOCK_HOLD_MS: 600_000
    });
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 500,
        messages: [
          makeTextMessage({ uid: 1, subject: "old", from: "a@x.test", to: "u@x.test", body: "old" }),
          makeTextMessage({ uid: 2, subject: "middle", from: "a@x.test", to: "u@x.test", body: "middle" }),
          makeTextMessage({ uid: 3, subject: "new", from: "a@x.test", to: "u@x.test", body: "new" })
        ]
      }
    ];
    let closeCalls = 0;

    class StallingInitialFetchClient extends FixtureImapClient {
      close(): void {
        closeCalls += 1;
      }

      async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>
      ) {
        if (Array.isArray(range)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        for await (const message of super.fetch(range, query)) {
          yield message;
        }
      }
    }

    const stallingEngine = h.buildEngine({
      folders,
      clientFactory: async () => new StallingInitialFetchClient(folders) as unknown as MirrorImapClient
    });
    const timedOut = await stallingEngine.syncAccount(h.account.id, "manual");

    expect(timedOut.outcome).toBe("failed");
    expect(timedOut.errors[0]).toContain("INITIAL_SYNC_BATCH_TIMEOUT_MS exceeded during initial sync FETCH");
    expect(closeCalls).toBeGreaterThan(0);

    const afterTimeout = (
      await h.pool.query<{
        sync_state: string;
        sync_state_reason: string | null;
        initial_sync_complete: boolean;
        initial_sync_target_max_uid: string | null;
        initial_sync_oldest_uid_synced: string | null;
        message_count: string;
      }>(
        `
        SELECT
          a.sync_state,
          a.sync_state_reason,
          f.initial_sync_complete,
          f.initial_sync_target_max_uid,
          f.initial_sync_oldest_uid_synced,
          count(m.id)::text AS message_count
        FROM public.imap_accounts a
        JOIN public.imap_folders f ON f.account_id = a.id AND f.path = 'INBOX'
        LEFT JOIN public.imap_messages m ON m.account_id = a.id AND m.folder_path = f.path
        WHERE a.id = $1
        GROUP BY a.id, f.id
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(afterTimeout.sync_state).toBe("DEGRADED");
    expect(afterTimeout.sync_state_reason).toBe("SYNC_TIMEOUT");
    expect(afterTimeout.initial_sync_complete).toBe(false);
    expect(Number(afterTimeout.initial_sync_target_max_uid)).toBe(3);
    expect(Number(afterTimeout.initial_sync_oldest_uid_synced)).toBe(4);
    expect(Number(afterTimeout.message_count)).toBe(0);

    await dueAllFolders(h.pool, h.account.id);
    const retryEngine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_TIMEOUT_MS: 600_000 }
    });
    const retry = await retryEngine.syncAccount(h.account.id, "manual");

    expect(retry.outcome).toBe("success");
    expect(retry.messagesUpserted).toBe(2);

    const afterRetry = (
      await h.pool.query<{
        initial_sync_complete: boolean;
        initial_sync_oldest_uid_synced: string | null;
        uid: string;
      }>(
        `
        SELECT f.initial_sync_complete, f.initial_sync_oldest_uid_synced, m.uid::text AS uid
        FROM public.imap_folders f
        JOIN public.imap_messages m ON m.account_id = f.account_id AND m.folder_path = f.path
        WHERE f.account_id = $1 AND f.path = 'INBOX'
        ORDER BY m.uid
        `,
        [h.account.id]
      )
    ).rows;
    expect(afterRetry.map((row) => Number(row.uid))).toEqual([2, 3]);
    expect(afterRetry[0].initial_sync_complete).toBe(false);
    expect(Number(afterRetry[0].initial_sync_oldest_uid_synced)).toBe(2);
  });

  it("Scenario I — stuck DEGRADED escalates to retryable BROKEN, recovers, then becomes terminal", async () => {
    const h = await setupIntegration("I-stuck-degraded", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);

    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET sync_state = 'DEGRADED',
          sync_state_reason = 'PRIORITY_SYNC_LAG',
          last_priority_sync_succeeded_at = now() - interval '25 hours',
          consecutive_failures = 4,
          consecutive_successes = 0,
          current_backoff_ms = 1234,
          backoff_until = NULL
      WHERE id = $1
      `,
      [h.account.id]
    );

    const failingEngine = h.buildEngine({
      folders: [],
      clientFactory: async () => {
        throw new Error("provider temporarily unavailable");
      }
    });
    const escalated = await failingEngine.syncAccount(h.account.id, "manual");

    expect(escalated.outcome).toBe("failed");
    const retryable = (
      await h.pool.query<{
        sync_state: string;
        sync_state_reason: string | null;
        consecutive_failures: number;
        current_backoff_ms: number;
        retry_ms: number | null;
      }>(
        `
        SELECT
          sync_state,
          sync_state_reason,
          consecutive_failures,
          current_backoff_ms,
          ceil(extract(epoch from (backoff_until - now())) * 1000)::int AS retry_ms
        FROM public.imap_accounts
        WHERE id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(retryable.sync_state).toBe("BROKEN");
    expect(retryable.sync_state_reason).toBe("STUCK_DEGRADED_24H");
    expect(retryable.consecutive_failures).toBe(4);
    expect(retryable.current_backoff_ms).toBe(1234);
    expect(retryable.retry_ms).toBeGreaterThan(50 * 60_000);
    expect(retryable.retry_ms).toBeLessThanOrEqual(60 * 60_000);

    await h.pool.query("UPDATE public.imap_accounts SET backoff_until = now() - interval '1 second' WHERE id = $1", [
      h.account.id
    ]);
    const runnable = await h.repository.getRunnableAccounts(10);
    expect(runnable.map((account) => account.id)).toContain(h.account.id);

    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 600,
        messages: [makeTextMessage({ uid: 1, subject: "recovered", from: "a@x.test", to: "u@x.test", body: "ok" })]
      }
    ];
    const recoveryEngine = h.buildEngine({ folders });
    const recovered = await recoveryEngine.syncAccount(h.account.id, "manual");

    expect(recovered.outcome).toBe("success");
    const recoveredAccount = (
      await h.pool.query<{
        sync_state: string;
        sync_state_reason: string | null;
        last_priority_age_ms: number | null;
        backoff_until: Date | null;
      }>(
        `
        SELECT
          sync_state,
          sync_state_reason,
          ceil(extract(epoch from (now() - last_priority_sync_succeeded_at)) * 1000)::int AS last_priority_age_ms,
          backoff_until
        FROM public.imap_accounts
        WHERE id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(recoveredAccount.sync_state).not.toBe("BROKEN");
    expect(recoveredAccount.sync_state_reason).not.toBe("STUCK_DEGRADED_24H");
    expect(recoveredAccount.sync_state_reason).not.toBe("STUCK_DEGRADED_TERMINAL");
    expect(recoveredAccount.last_priority_age_ms).toBeLessThan(10_000);
    expect(recoveredAccount.backoff_until).toBeNull();

    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET sync_state = 'BROKEN',
          sync_state_reason = 'STUCK_DEGRADED_24H',
          last_priority_sync_succeeded_at = now() - interval '8 days',
          consecutive_failures = 5,
          current_backoff_ms = 2222,
          backoff_until = now() - interval '1 second'
      WHERE id = $1
      `,
      [h.account.id]
    );
    const terminal = await failingEngine.syncAccount(h.account.id, "manual");

    expect(terminal.outcome).toBe("failed");
    const terminalAccount = (
      await h.pool.query<{
        sync_state: string;
        sync_state_reason: string | null;
        consecutive_failures: number;
        current_backoff_ms: number;
        backoff_until: Date | null;
      }>(
        `
        SELECT sync_state, sync_state_reason, consecutive_failures, current_backoff_ms, backoff_until
        FROM public.imap_accounts
        WHERE id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(terminalAccount.sync_state).toBe("BROKEN");
    expect(terminalAccount.sync_state_reason).toBe("STUCK_DEGRADED_TERMINAL");
    expect(terminalAccount.consecutive_failures).toBe(5);
    expect(terminalAccount.current_backoff_ms).toBe(2222);
    expect(terminalAccount.backoff_until).toBeNull();

    const terminalRunnable = await h.repository.getRunnableAccounts(10);
    expect(terminalRunnable.map((account) => account.id)).not.toContain(h.account.id);

    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET sync_state = 'DEGRADED',
          sync_state_reason = NULL
      WHERE id = $1
      `,
      [h.account.id]
    );
    const manuallyClearedRunnable = await h.repository.getRunnableAccounts(10);
    expect(manuallyClearedRunnable.map((account) => account.id)).toContain(h.account.id);
  });

  it("Scenario J — folder-count cap warns, enforces INBOX/Sent-only tracking, then auto-recovers", async () => {
    const h = await setupIntegration("J-folder-count-cap", {
      FOLDER_COUNT_WARN_THRESHOLD: 50,
      FOLDER_COUNT_ENFORCE_THRESHOLD: 200,
      MAX_PRIORITY_FOLDERS_PER_CYCLE: 10,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);

    const warningFolders = buildEmptyFolders(60);
    const warningEngine = h.buildEngine({ folders: warningFolders });
    expect((await warningEngine.syncAccount(h.account.id, "manual")).outcome).toBe("success");
    await markCurrentTrackedFoldersClean(h);

    let warning = (
      await h.pool.query<{
        sync_state: string;
        sync_state_reason: string | null;
        current_count: string;
        tracked_current_count: string;
      }>(
        `
        SELECT
          a.sync_state,
          a.sync_state_reason,
          count(f.*) FILTER (WHERE f.status != 'MISSING' AND f.missing_since IS NULL)::text AS current_count,
          count(f.*) FILTER (WHERE f.status != 'MISSING' AND f.missing_since IS NULL AND f.tracked = true)::text AS tracked_current_count
        FROM public.imap_accounts a
        JOIN public.imap_folders f ON f.account_id = a.id
        WHERE a.id = $1
        GROUP BY a.id
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(Number(warning.current_count)).toBe(60);
    expect(Number(warning.tracked_current_count)).toBe(60);
    expect(warning.sync_state).toBe("HEALTHY");
    expect(warning.sync_state_reason).toBe("MANY_FOLDERS_PERFORMANCE_NOTE");

    const largeFolders = buildEmptyFolders(250);
    const enforcedEngine = h.buildEngine({ folders: largeFolders });
    await forceFolderDiscovery(h.pool, h.account.id);
    expect((await enforcedEngine.syncAccount(h.account.id, "manual")).outcome).toBe("success");
    await markCurrentTrackedFoldersClean(h);

    const enforced = (
      await h.pool.query<{
        sync_state: string;
        sync_state_reason: string | null;
        current_count: string;
        tracked_current_count: string;
        cap_excluded_current_count: string;
      }>(
        `
        SELECT
          a.sync_state,
          a.sync_state_reason,
          count(f.*) FILTER (WHERE f.status != 'MISSING' AND f.missing_since IS NULL)::text AS current_count,
          count(f.*) FILTER (WHERE f.status != 'MISSING' AND f.missing_since IS NULL AND f.tracked = true)::text AS tracked_current_count,
          count(f.*) FILTER (
            WHERE f.status != 'MISSING'
              AND f.missing_since IS NULL
              AND f.excluded_reason = 'folder_count_cap_exceeded'
          )::text AS cap_excluded_current_count
        FROM public.imap_accounts a
        JOIN public.imap_folders f ON f.account_id = a.id
        WHERE a.id = $1
        GROUP BY a.id
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(Number(enforced.current_count)).toBe(250);
    expect(Number(enforced.tracked_current_count)).toBe(2);
    expect(Number(enforced.cap_excluded_current_count)).toBe(248);
    expect(enforced.sync_state).toBe("DEGRADED");
    expect(enforced.sync_state_reason).toBe("TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG");

    const optedIn = await h.repository.trackFolder(h.account.id, "Archive-003");
    expect(optedIn?.tracked).toBe(true);
    expect(optedIn?.excluded_reason).toBeNull();
    await forceFolderDiscovery(h.pool, h.account.id);
    expect((await enforcedEngine.syncAccount(h.account.id, "manual")).outcome).toBe("success");

    const optedInAfterDiscovery = (
      await h.pool.query<{
        tracked: boolean;
        excluded_reason: string | null;
        cap_excluded_current_count: string;
      }>(
        `
        SELECT
          f.tracked,
          f.excluded_reason,
          (
            SELECT count(*)::text
            FROM public.imap_folders capped
            WHERE capped.account_id = f.account_id
              AND capped.status != 'MISSING'
              AND capped.missing_since IS NULL
              AND capped.excluded_reason = 'folder_count_cap_exceeded'
          ) AS cap_excluded_current_count
        FROM public.imap_folders f
        WHERE f.account_id = $1
          AND f.path = 'Archive-003'
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(optedInAfterDiscovery.tracked).toBe(true);
    expect(optedInAfterDiscovery.excluded_reason).toBeNull();
    expect(Number(optedInAfterDiscovery.cap_excluded_current_count)).toBe(247);

    const recoveredFolders = buildEmptyFolders(45);
    const recoveredEngine = h.buildEngine({ folders: recoveredFolders });
    await forceFolderDiscovery(h.pool, h.account.id);
    expect((await recoveredEngine.syncAccount(h.account.id, "manual")).outcome).toBe("success");
    await markCurrentTrackedFoldersClean(h);

    const recovered = (
      await h.pool.query<{
        sync_state: string;
        sync_state_reason: string | null;
        current_count: string;
        tracked_current_count: string;
        cap_excluded_current_count: string;
      }>(
        `
        SELECT
          a.sync_state,
          a.sync_state_reason,
          count(f.*) FILTER (WHERE f.status != 'MISSING' AND f.missing_since IS NULL)::text AS current_count,
          count(f.*) FILTER (WHERE f.status != 'MISSING' AND f.missing_since IS NULL AND f.tracked = true)::text AS tracked_current_count,
          count(f.*) FILTER (
            WHERE f.status != 'MISSING'
              AND f.missing_since IS NULL
              AND f.excluded_reason = 'folder_count_cap_exceeded'
          )::text AS cap_excluded_current_count
        FROM public.imap_accounts a
        JOIN public.imap_folders f ON f.account_id = a.id
        WHERE a.id = $1
        GROUP BY a.id
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(Number(recovered.current_count)).toBe(45);
    expect(Number(recovered.tracked_current_count)).toBe(45);
    expect(Number(recovered.cap_excluded_current_count)).toBe(0);
    expect(recovered.sync_state).toBe("HEALTHY");
    expect(recovered.sync_state_reason).toBeNull();
  });

  it("Scenario K — missing-mailbox errors force rediscovery and pause folder sync", async () => {
    const h = await setupIntegration("K-pending-verification", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);

    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 61_001,
        messages: [makeTextMessage({ uid: 1, subject: "inbox", from: "a@x.test", to: "u@x.test", body: "inbox" })]
      },
      {
        path: "Project-Alpha",
        delimiter: "/",
        uidValidity: 61_002,
        messages: [makeTextMessage({ uid: 1, subject: "project", from: "b@x.test", to: "u@x.test", body: "project" })]
      }
    ];

    const initialEngine = h.buildEngine({ folders });
    expect((await initialEngine.syncAccount(h.account.id, "manual")).outcome).toBe("success");

    class MissingProjectClient extends FixtureImapClient {
      async getMailboxLock(path: string) {
        if (path === "Project-Alpha") {
          throw new Error("Command failed — NO Mailbox doesn't exist: Project-Alpha");
        }
        return super.getMailboxLock(path);
      }
    }

    const missingEngine = h.buildEngine({
      folders,
      clientFactory: async () => new MissingProjectClient(folders) as unknown as MirrorImapClient
    });
    await dueAllFolders(h.pool, h.account.id);
    const missing = await missingEngine.syncAccount(h.account.id, "manual");
    expect(missing.outcome).toBe("partial_success");
    expect(missing.errors.join("|")).toContain("Project-Alpha");

    const pending = (
      await h.pool.query<{
        status: string;
        missing_since: Date | null;
        next_folder_discovery_is_due: boolean;
        event_count: string;
      }>(
        `
        SELECT
          f.status,
          f.missing_since,
          a.next_folder_discovery_at <= now() + interval '5 seconds' AS next_folder_discovery_is_due,
          (
            SELECT count(*)::text
            FROM public.imap_sync_events e
            WHERE e.account_id = a.id
              AND e.folder_path = f.path
              AND e.event_type = 'FOLDER_PENDING_VERIFICATION'
          ) AS event_count
        FROM public.imap_accounts a
        JOIN public.imap_folders f ON f.account_id = a.id
        WHERE a.id = $1
          AND f.path = 'Project-Alpha'
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(pending.status).toBe("PENDING_VERIFICATION");
    expect(pending.missing_since).not.toBeNull();
    expect(pending.next_folder_discovery_is_due).toBe(true);
    expect(Number(pending.event_count)).toBe(1);

    const dueWhilePending = await h.repository.getFoldersDueForSync(h.account.id);
    expect(dueWhilePending.map((folder) => folder.path)).not.toContain("Project-Alpha");

    const account = await h.repository.getAccount(h.account.id);
    expect(account).not.toBeNull();
    await h.repository.upsertDiscoveredFolders(
      account!,
      folders.map((folder) => ({
        path: folder.path,
        delimiter: folder.delimiter,
        specialUse: folder.specialUse
      }))
    );
    const revived = (
      await h.pool.query<{ status: string; missing_since: Date | null }>(
        `SELECT status, missing_since FROM public.imap_folders WHERE account_id = $1 AND path = 'Project-Alpha'`,
        [h.account.id]
      )
    ).rows[0];
    expect(revived.status).toBe("PENDING");
    expect(revived.missing_since).toBeNull();

    await dueAllFolders(h.pool, h.account.id);
    const recovered = await initialEngine.syncAccount(h.account.id, "manual");
    expect(recovered.outcome).toBe("success");
    const active = (
      await h.pool.query<{ status: string; missing_since: Date | null }>(
        `SELECT status, missing_since FROM public.imap_folders WHERE account_id = $1 AND path = 'Project-Alpha'`,
        [h.account.id]
      )
    ).rows[0];
    expect(active.status).toBe("ACTIVE");
    expect(active.missing_since).toBeNull();
  });

  it("Scenario L — three-lane sync runs hot, body, then history under the lock budget", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z");
    const recentDate = new Date();
    const h = await setupIntegration("L-three-lane", {
      BODY_BACKFILL_BATCH_SIZE: 1,
      INITIAL_SYNC_BATCH_SIZE: 10,
      MAX_BODY_BATCHES_PER_TICK: 1,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET body_fetch_policy = 'immediate',
          historical_backfill_mode = 'metadata_and_bodies',
          archive_refresh_interval = 'monthly',
          max_backfill_rate = 'small'
      WHERE id = $1
      `,
      [h.account.id]
    );

    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 81_001,
        messages: [
          makeTextMessage({
            uid: 1,
            subject: "old-inbox",
            from: "a@x.test",
            to: "u@x.test",
            body: "old inbox",
            internalDate: oldDate
          }),
          makeTextMessage({
            uid: 10,
            subject: "fresh",
            from: "a@x.test",
            to: "u@x.test",
            body: "fresh",
            internalDate: recentDate
          })
        ]
      },
      {
        path: "Archive",
        delimiter: "/",
        uidValidity: 81_002,
        messages: [
          makeTextMessage({
            uid: 1,
            subject: "old",
            from: "b@x.test",
            to: "u@x.test",
            body: "old",
            internalDate: oldDate
          })
        ]
      }
    ];

    const events: string[] = [];
    const engine = new MirrorEngine({
      pool: h.pool,
      config: h.config,
      repository: h.repository,
      clientFactory: async () => new FixtureImapClient(folders),
      hooks: {
        onMessageUpsert(message) {
          events.push(`${message.window_status === "HISTORICAL" ? "history" : "hot"}:${message.folder_path}:${message.uid}`);
        },
        onBodyFetched(message) {
          events.push(`body:${message.window_status}:${message.folder_path}:${message.uid}`);
        }
      }
    });

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");
    expect(result.hitLockBudget).toBe(false);
    expect(events.indexOf("hot:INBOX:10")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("body:IN_WINDOW:INBOX:10")).toBeGreaterThan(events.indexOf("hot:INBOX:10"));
    expect(events.indexOf("history:INBOX:1")).toBeGreaterThan(events.indexOf("body:IN_WINDOW:INBOX:10"));
    expect(events.indexOf("body:HISTORICAL:INBOX:1")).toBeGreaterThan(events.indexOf("history:INBOX:1"));

    const archive = (
      await h.pool.query<{
        historical_target_count: number | null;
        headers_synced_count: number;
        bodies_fetched_count: number;
        backfill_in_progress: boolean;
        last_archive_refresh_at: Date | null;
      }>(
        `
        SELECT
          historical_target_count,
          headers_synced_count,
          bodies_fetched_count,
          backfill_in_progress,
          last_archive_refresh_at
        FROM public.imap_folders
        WHERE account_id = $1
          AND path = 'INBOX'
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(archive).toMatchObject({
      historical_target_count: 1,
      headers_synced_count: 2,
      bodies_fetched_count: 2,
      backfill_in_progress: false
    });
    expect(archive.last_archive_refresh_at).not.toBeNull();

    const progress = (
      await h.pool.query<{
        historical_headers_complete_pct: number;
        historical_bodies_complete_pct: number;
      }>(
        `
        SELECT historical_headers_complete_pct, historical_bodies_complete_pct
        FROM public.imap_account_progress
        WHERE account_id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(progress).toEqual({
      historical_headers_complete_pct: 100,
      historical_bodies_complete_pct: 100
    });

    const blocked = await setupIntegration("L-budget-skip", {
      BODY_BACKFILL_BATCH_SIZE: 1,
      INITIAL_SYNC_BATCH_SIZE: 10,
      MAX_BODY_BATCHES_PER_TICK: 1,
      MAX_LOCK_HOLD_MS: 50,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(blocked.account.id);
    await blocked.pool.query(
      `
      UPDATE public.imap_accounts
      SET body_fetch_policy = 'immediate',
          historical_backfill_mode = 'metadata_and_bodies',
          max_backfill_rate = 'aggressive'
      WHERE id = $1
      `,
      [blocked.account.id]
    );

    class SlowBodyClient extends FixtureImapClient {
      override async fetchOne(range: string) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return await super.fetchOne(range);
      }
    }

    const blockedEngine = blocked.buildEngine({
      folders,
      clientFactory: async () => new SlowBodyClient(folders) as unknown as MirrorImapClient
    });
    const blockedResult = await blockedEngine.syncAccount(blocked.account.id, "manual");
    expect(blockedResult.outcome).toBe("success");
    expect(blockedResult.hitLockBudget).toBe(true);

    const skippedHistory = (
      await blocked.pool.query<{
        historical_target_count: number | null;
        historical_message_count: string;
      }>(
        `
        SELECT
          f.historical_target_count,
          (
            SELECT count(*)::text
            FROM public.imap_messages m
            WHERE m.account_id = f.account_id
              AND m.folder_path = f.path
              AND m.window_status = 'HISTORICAL'
              AND m.deleted_in_provider = false
          ) AS historical_message_count
        FROM public.imap_folders f
        WHERE f.account_id = $1
          AND f.path = 'INBOX'
        `,
        [blocked.account.id]
      )
    ).rows[0];
    expect(skippedHistory.historical_target_count).toBeNull();
    expect(Number(skippedHistory.historical_message_count)).toBe(0);
  });

  it("batches small parsed-only bodies during inline historical backfill", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z");
    const h = await setupIntegration("history-body-batch", {
      BODY_STORAGE_MODE: "parsed_only",
      BODY_BACKFILL_BATCH_SIZE: 2,
      INITIAL_SYNC_BATCH_SIZE: 10,
      MAX_BODY_BATCHES_PER_TICK: 1,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET body_fetch_policy = 'immediate',
          historical_backfill_mode = 'metadata_and_bodies',
          archive_refresh_interval = 'monthly',
          max_backfill_rate = 'small'
      WHERE id = $1
      `,
      [h.account.id]
    );

    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 81_003,
      messages: [
        makeTextMessage({
          uid: 1,
          subject: "old-1",
          from: "a@x.test",
          to: "u@x.test",
          body: "old-1",
          internalDate: oldDate
        }),
        makeTextMessage({
          uid: 2,
          subject: "old-2",
          from: "a@x.test",
          to: "u@x.test",
          body: "old-2",
          internalDate: oldDate
        }),
        makeTextMessage({
          uid: 10,
          subject: "fresh",
          from: "a@x.test",
          to: "u@x.test",
          body: "fresh",
          internalDate: new Date()
        })
      ]
    }];

    const sourceRanges: number[][] = [];
    let downloads = 0;
    class CountingHistoryBodyClient extends FixtureImapClient {
      override async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>
      ) {
        if (query.source && Array.isArray(range)) sourceRanges.push(range);
        yield* super.fetch(range, query);
      }

      override async download(
        range: string,
        part?: string,
        options?: Record<string, unknown>
      ) {
        downloads += 1;
        return await super.download(range, part, options);
      }
    }

    const result = await h.buildEngine({
      folders,
      clientFactory: async () => new CountingHistoryBodyClient(folders)
    }).syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(sourceRanges).toEqual([[1, 2]]);
    expect(downloads).toBe(1);
    const historyBodies = await h.pool.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM public.imap_messages
      WHERE account_id = $1
        AND window_status = 'HISTORICAL'
        AND body_fetched_at IS NOT NULL
      `,
      [h.account.id]
    );
    expect(Number(historyBodies.rows[0].count)).toBe(2);
  });

  it("finishes an in-flight history batch at the safe boundary after the lock budget expires", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z");
    const recentDate = new Date();
    const h = await setupIntegration("history-safe-boundary", {
      BODY_BACKFILL_BATCH_SIZE: 1,
      INITIAL_SYNC_BATCH_SIZE: 10,
      MAX_LOCK_HOLD_MS: 50
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET body_fetch_policy = 'lazy',
           historical_backfill_mode = 'metadata_only',
           max_backfill_rate = 'small'
       WHERE id = $1`,
      [h.account.id]
    );
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 81_101,
      messages: [
        makeTextMessage({
          uid: 1,
          subject: "historical",
          from: "a@x.test",
          to: "u@x.test",
          body: "historical",
          internalDate: oldDate
        }),
        makeTextMessage({
          uid: 10,
          subject: "fresh",
          from: "a@x.test",
          to: "u@x.test",
          body: "fresh",
          internalDate: recentDate
        })
      ]
    }];
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    class LockBoundaryHistoryFetchClient extends FixtureImapClient {
      override async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>
      ) {
        if (Array.isArray(range) && range.includes(1) && query.envelope) {
          now += 75;
        }
        yield* super.fetch(range, query);
      }
    }

    try {
      const result = await h.buildEngine({
        folders,
        clientFactory: async () => new LockBoundaryHistoryFetchClient(folders)
      }).syncAccount(h.account.id, "manual");

      expect(result.outcome).toBe("success");
      expect(result.hitLockBudget).toBe(true);
      expect(result.errors).toEqual([]);
      const history = await h.pool.query<{
        uid: string;
        backfill_in_progress: boolean;
        backfill_oldest_uid_synced: string | null;
      }>(
        `SELECT m.uid::text AS uid, f.backfill_in_progress,
                f.backfill_oldest_uid_synced::text AS backfill_oldest_uid_synced
         FROM public.imap_messages m
         JOIN public.imap_folders f ON f.id = m.folder_id
         WHERE m.account_id = $1 AND m.uid = 1`,
        [h.account.id]
      );
      expect(history.rows).toEqual([{
        uid: "1",
        backfill_in_progress: false,
        backfill_oldest_uid_synced: "1"
      }]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not advance the history watermark when a post-commit hook fails", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z");
    const recentDate = new Date();
    const h = await setupIntegration("history-hook-watermark", {
      BODY_BACKFILL_BATCH_SIZE: 1,
      INITIAL_SYNC_BATCH_SIZE: 10,
      MAX_BODY_BATCHES_PER_TICK: 1,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET body_fetch_policy = 'lazy',
           historical_backfill_mode = 'metadata_only',
           max_backfill_rate = 'small'
       WHERE id = $1`,
      [h.account.id]
    );
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 81_102,
      messages: [
        makeTextMessage({
          uid: 1,
          subject: "historical-hook",
          from: "a@x.test",
          to: "u@x.test",
          body: "historical",
          internalDate: oldDate
        }),
        makeTextMessage({
          uid: 10,
          subject: "fresh-hook",
          from: "a@x.test",
          to: "u@x.test",
          body: "fresh",
          internalDate: recentDate
        })
      ]
    }];

    const failed = await h.buildEngine({
      folders,
      hooks: {
        onMessageUpsert(message) {
          if (Number(message.uid) === 1) throw new Error("forced history hook failure");
        }
      }
    }).syncAccount(h.account.id, "manual");
    expect(failed.outcome).not.toBe("success");

    const afterFailure = await h.pool.query<{
      backfill_in_progress: boolean;
      backfill_oldest_uid_synced: string | null;
    }>(
      `SELECT backfill_in_progress, backfill_oldest_uid_synced::text
       FROM public.imap_folders
       WHERE account_id = $1 AND path = 'INBOX'`,
      [h.account.id]
    );
    expect(afterFailure.rows[0]).toEqual({
      backfill_in_progress: true,
      backfill_oldest_uid_synced: "2"
    });

    const retried = await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");
    expect(retried.outcome).toBe("success");
    const afterRetry = await h.pool.query<{
      backfill_in_progress: boolean;
      backfill_oldest_uid_synced: string | null;
    }>(
      `SELECT backfill_in_progress, backfill_oldest_uid_synced::text
       FROM public.imap_folders
       WHERE account_id = $1 AND path = 'INBOX'`,
      [h.account.id]
    );
    expect(afterRetry.rows[0]).toEqual({
      backfill_in_progress: false,
      backfill_oldest_uid_synced: "1"
    });
  });

  it("Scenario N — history backfill batches across cycles and resumes from the watermark", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z");
    const recentDate = new Date();
    const h = await setupIntegration("N-history-resume", {
      BODY_BACKFILL_BATCH_SIZE: 1,
      INITIAL_SYNC_BATCH_SIZE: 10,
      MAX_BODY_BATCHES_PER_TICK: 1,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET body_fetch_policy = 'immediate',
          historical_backfill_mode = 'metadata_and_bodies',
          archive_refresh_interval = 'monthly',
          max_backfill_rate = 'small'
      WHERE id = $1
      `,
      [h.account.id]
    );

    // One in-window message plus three out-of-window ones. With max_backfill_rate
    // 'small' (one history batch per cycle) and BODY_BACKFILL_BATCH_SIZE=1, the
    // three historical UIDs cannot import in a single syncAccount call — they must
    // span multiple cycles, and each cycle must resume from the persisted watermark.
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 83_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "old-1", from: "a@x.test", to: "u@x.test", body: "old 1", internalDate: oldDate }),
          makeTextMessage({ uid: 2, subject: "old-2", from: "a@x.test", to: "u@x.test", body: "old 2", internalDate: oldDate }),
          makeTextMessage({ uid: 3, subject: "old-3", from: "a@x.test", to: "u@x.test", body: "old 3", internalDate: oldDate }),
          makeTextMessage({ uid: 10, subject: "fresh", from: "a@x.test", to: "u@x.test", body: "fresh", internalDate: recentDate })
        ]
      }
    ];
    const engine = h.buildEngine({ folders });

    const historyState = async () =>
      (
        await h.pool.query<{
          historical_target_count: number | null;
          backfill_in_progress: boolean;
          backfill_oldest_uid_synced: string | null;
        }>(
          `SELECT historical_target_count, backfill_in_progress, backfill_oldest_uid_synced
           FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'`,
          [h.account.id]
        )
      ).rows[0];
    const historicalCount = async () =>
      Number(
        (
          await h.pool.query<{ c: string }>(
            `SELECT count(*)::text AS c FROM public.imap_messages
             WHERE account_id = $1 AND folder_path = 'INBOX'
               AND window_status = 'HISTORICAL' AND deleted_in_provider = false`,
            [h.account.id]
          )
        ).rows[0].c
      );

    // Cycle 1: the hot lane mirrors the fresh message; the history lane snapshots
    // (target = 3) and imports only part of the backlog (batching, not all-at-once).
    await engine.syncAccount(h.account.id, "manual");
    const after1 = await historyState();
    expect(after1.historical_target_count).toBe(3);
    expect(after1.backfill_in_progress).toBe(true);
    const count1 = await historicalCount();
    expect(count1).toBeGreaterThanOrEqual(1);
    expect(count1).toBeLessThan(3);
    const watermark1 = Number(after1.backfill_oldest_uid_synced);

    // Cycle 2: resumes from the persisted watermark — it does NOT re-snapshot
    // (target unchanged), the watermark descends, and more history is imported.
    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");
    const after2 = await historyState();
    expect(after2.historical_target_count).toBe(3);
    expect(Number(after2.backfill_oldest_uid_synced)).toBeLessThan(watermark1);
    expect(await historicalCount()).toBeGreaterThan(count1);

    // Remaining cycles drain the backlog; backfill completes with all three.
    for (let i = 0; i < 5 && (await historyState()).backfill_in_progress; i += 1) {
      await dueAllFolders(h.pool, h.account.id);
      await engine.syncAccount(h.account.id, "manual");
    }
    expect((await historyState()).backfill_in_progress).toBe(false);
    expect(await historicalCount()).toBe(3);
  });

  it("bounds each resumed history query to one batch of UID address space", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z");
    const h = await setupIntegration("history-bounded-uid-ranges", {
      BODY_BACKFILL_BATCH_SIZE: 3,
      INITIAL_SYNC_BATCH_SIZE: 50,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET body_fetch_policy = 'lazy',
           historical_backfill_mode = 'metadata_only',
           max_backfill_rate = 'normal'
       WHERE id = $1`,
      [h.account.id]
    );
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 83_101,
      messages: [
        ...Array.from({ length: 30 }, (_, index) => makeTextMessage({
          uid: index + 1,
          subject: `old-${index + 1}`,
          from: "a@x.test",
          to: "u@x.test",
          body: `old-${index + 1}`,
          internalDate: oldDate
        })),
        makeTextMessage({
          uid: 100,
          subject: "fresh",
          from: "a@x.test",
          to: "u@x.test",
          body: "fresh",
          internalDate: new Date()
        })
      ]
    }];
    const historyRanges: string[] = [];
    class HistoryRangeClient extends FixtureImapClient {
      override async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>
      ) {
        if (typeof range === "object"
          && !Array.isArray(range)
          && range.before instanceof Date
          && typeof range.uid === "string") {
          historyRanges.push(range.uid);
        }
        yield* super.fetch(range, query);
      }
    }

    await h.buildEngine({
      folders,
      clientFactory: async () => new HistoryRangeClient(folders)
    }).syncAccount(h.account.id, "manual");

    expect(historyRanges).toEqual(["28:30", "25:27", "22:24"]);
    expect(historyRanges.every((range) => {
      const [start, end] = range.split(":").map(Number);
      return end - start + 1 <= 3;
    })).toBe(true);
  });

  it("Scenario O — re-running history backfill over mirrored UIDs is idempotent", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z");
    const recentDate = new Date();
    const h = await setupIntegration("O-history-idempotent", {
      BODY_BACKFILL_BATCH_SIZE: 5,
      INITIAL_SYNC_BATCH_SIZE: 10,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET body_fetch_policy = 'immediate',
          historical_backfill_mode = 'metadata_and_bodies',
          archive_refresh_interval = 'monthly',
          max_backfill_rate = 'aggressive'
      WHERE id = $1
      `,
      [h.account.id]
    );
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 84_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "old-1", from: "a@x.test", to: "u@x.test", body: "old 1", internalDate: oldDate }),
          makeTextMessage({ uid: 2, subject: "old-2", from: "a@x.test", to: "u@x.test", body: "old 2", internalDate: oldDate }),
          makeTextMessage({ uid: 10, subject: "fresh", from: "a@x.test", to: "u@x.test", body: "fresh", internalDate: recentDate })
        ]
      }
    ];
    const engine = h.buildEngine({ folders });

    const historicalCount = async () =>
      Number(
        (
          await h.pool.query<{ c: string }>(
            `SELECT count(*)::text AS c FROM public.imap_messages
             WHERE account_id = $1 AND folder_path = 'INBOX'
               AND window_status = 'HISTORICAL' AND deleted_in_provider = false`,
            [h.account.id]
          )
        ).rows[0].c
      );

    // First pass: aggressive rate completes the two-message backfill.
    await engine.syncAccount(h.account.id, "manual");
    expect(await historicalCount()).toBe(2);

    // Clear the watermark so the next run re-snapshots and re-walks the SAME
    // historical UIDs from scratch — the idempotency case.
    await h.pool.query(
      `
      UPDATE public.imap_folders
      SET historical_target_count = NULL,
          backfill_in_progress = false,
          backfill_target_max_uid = NULL,
          backfill_oldest_uid_synced = NULL,
          backfill_since_date = NULL
      WHERE account_id = $1 AND path = 'INBOX'
      `,
      [h.account.id]
    );
    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");

    // Re-walking the same UIDs upserts; it must not duplicate rows.
    expect(await historicalCount()).toBe(2);
    const reSnapshot = (
      await h.pool.query<{ historical_target_count: number | null }>(
        `SELECT historical_target_count FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(reSnapshot.historical_target_count).toBe(2);
    const dupes = await h.pool.query<{ uid: number }>(
      `SELECT uid FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'INBOX'
       GROUP BY uid HAVING count(*) > 1`,
      [h.account.id]
    );
    expect(dupes.rows).toHaveLength(0);
  });

  it("Scenario P — UIDVALIDITY reset mid-backfill clears history state and re-mirrors cleanly", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z");
    const recentDate = new Date();
    const h = await setupIntegration("P-history-uidvalidity-reset", {
      BODY_BACKFILL_BATCH_SIZE: 1,
      INITIAL_SYNC_BATCH_SIZE: 10,
      MAX_BODY_BATCHES_PER_TICK: 1,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET body_fetch_policy = 'immediate',
          historical_backfill_mode = 'metadata_and_bodies',
          archive_refresh_interval = 'monthly',
          max_backfill_rate = 'small'
      WHERE id = $1
      `,
      [h.account.id]
    );
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 85_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "old-1", from: "a@x.test", to: "u@x.test", body: "old 1", internalDate: oldDate }),
          makeTextMessage({ uid: 2, subject: "old-2", from: "a@x.test", to: "u@x.test", body: "old 2", internalDate: oldDate }),
          makeTextMessage({ uid: 3, subject: "old-3", from: "a@x.test", to: "u@x.test", body: "old 3", internalDate: oldDate }),
          makeTextMessage({ uid: 10, subject: "fresh", from: "a@x.test", to: "u@x.test", body: "fresh", internalDate: recentDate })
        ]
      }
    ];
    const engine = h.buildEngine({ folders });

    const liveHistoricalUnder = async (uidvalidity: number) =>
      Number(
        (
          await h.pool.query<{ c: string }>(
            `SELECT count(*)::text AS c FROM public.imap_messages
             WHERE account_id = $1 AND folder_path = 'INBOX'
               AND window_status = 'HISTORICAL' AND deleted_in_provider = false
               AND uidvalidity = $2`,
            [h.account.id, uidvalidity]
          )
        ).rows[0].c
      );

    // One cycle leaves the backfill in progress (snapshot taken, partially walked).
    await engine.syncAccount(h.account.id, "manual");
    const mid = (
      await h.pool.query<{ historical_target_count: number | null; backfill_in_progress: boolean }>(
        `SELECT historical_target_count, backfill_in_progress FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(mid.historical_target_count).toBe(3);
    expect(mid.backfill_in_progress).toBe(true);

    // The provider reports a new UIDVALIDITY mid-backfill.
    folders[0].uidValidity = 85_999;
    await dueAllFolders(h.pool, h.account.id);
    await engine.syncAccount(h.account.id, "manual");

    // The reset tombstones the old-validity rows and clears the stale backfill
    // watermark, so backfill cannot resume against a snapshot from the old validity.
    const tombstoned = Number(
      (
        await h.pool.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM public.imap_messages
           WHERE account_id = $1 AND folder_path = 'INBOX' AND deleted_reason = 'UIDVALIDITY_RESET'`,
          [h.account.id]
        )
      ).rows[0].c
    );
    expect(tombstoned).toBeGreaterThanOrEqual(1);
    const folderUidv = (
      await h.pool.query<{ uidvalidity: string }>(
        `SELECT uidvalidity FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'`,
        [h.account.id]
      )
    ).rows[0];
    expect(Number(folderUidv.uidvalidity)).toBe(85_999);

    // Driving the account forward re-does initial sync and re-snapshots history
    // under the NEW validity: the historical messages are re-mirrored, not orphaned.
    for (let i = 0; i < 8; i += 1) {
      await dueAllFolders(h.pool, h.account.id);
      await engine.syncAccount(h.account.id, "manual");
      if ((await liveHistoricalUnder(85_999)) === 3) break;
    }
    expect(await liveHistoricalUnder(85_999)).toBe(3);
  });

  it("Scenario Q — a new account backfills history on default settings (no manual config)", async () => {
    const oldDate = new Date("2023-01-01T00:00:00Z");
    const recentDate = new Date();
    // Deliberately NO UPDATE to imap_accounts — backfill must work on the schema
    // defaults that createAccount applies.
    const h = await setupIntegration("Q-history-default", {
      INITIAL_SYNC_BATCH_SIZE: 10,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);

    // The enabling default comes from the DB, not a test override.
    const settings = (
      await h.pool.query<{ historical_backfill_mode: string }>(
        `SELECT historical_backfill_mode FROM public.imap_accounts WHERE id = $1`,
        [h.account.id]
      )
    ).rows[0];
    expect(settings.historical_backfill_mode).toBe("metadata_and_bodies");

    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 86_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "old-1", from: "a@x.test", to: "u@x.test", body: "old 1", internalDate: oldDate }),
          makeTextMessage({ uid: 2, subject: "old-2", from: "a@x.test", to: "u@x.test", body: "old 2", internalDate: oldDate }),
          makeTextMessage({ uid: 10, subject: "fresh", from: "a@x.test", to: "u@x.test", body: "fresh", internalDate: recentDate })
        ]
      }
    ];
    const engine = h.buildEngine({ folders });

    for (let i = 0; i < 5; i += 1) {
      await dueAllFolders(h.pool, h.account.id);
      await engine.syncAccount(h.account.id, "manual");
      const state = (
        await h.pool.query<{ backfill_in_progress: boolean; historical_target_count: number | null }>(
          `SELECT backfill_in_progress, historical_target_count FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'`,
          [h.account.id]
        )
      ).rows[0];
      if (state.historical_target_count !== null && !state.backfill_in_progress) break;
    }
    const historical = Number(
      (
        await h.pool.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM public.imap_messages
           WHERE account_id = $1 AND folder_path = 'INBOX'
             AND window_status = 'HISTORICAL' AND deleted_in_provider = false`,
          [h.account.id]
        )
      ).rows[0].c
    );
    expect(historical).toBe(2);
  });

  it("Scenario M — progress counters roll up from folders into account progress", async () => {
    const h = await setupIntegration("M-progress", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      MAX_RR_FOLDERS_PER_CYCLE: 5
    });
    activeAccountIds.push(h.account.id);

    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 71_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "inbox-1", from: "a@x.test", to: "u@x.test", body: "one" }),
          makeTextMessage({ uid: 2, subject: "inbox-2", from: "a@x.test", to: "u@x.test", body: "two" }),
          makeTextMessage({ uid: 3, subject: "inbox-3", from: "a@x.test", to: "u@x.test", body: "three" })
        ]
      },
      {
        path: "Archive",
        delimiter: "/",
        uidValidity: 71_002,
        messages: [
          makeTextMessage({ uid: 1, subject: "archive-1", from: "b@x.test", to: "u@x.test", body: "four" }),
          makeTextMessage({ uid: 2, subject: "archive-2", from: "b@x.test", to: "u@x.test", body: "five" })
        ]
      }
    ];

    const engine = h.buildEngine({ folders });
    await h.pool.query(
      "UPDATE public.imap_accounts SET historical_backfill_mode = 'off' WHERE id = $1",
      [h.account.id]
    );
    expect((await engine.syncAccount(h.account.id, "manual")).outcome).toBe("success");

    const messages = (
      await h.pool.query<{ id: string; folder_path: string; uid: string }>(
        `
        SELECT id, folder_path, uid::text AS uid
        FROM public.imap_messages
        WHERE account_id = $1
        ORDER BY folder_path, uid
        `,
        [h.account.id]
      )
    ).rows;

    for (const message of messages.filter((row) => row.folder_path === "INBOX" || row.uid === "1")) {
      const rawMime = Buffer.from(`Subject: progress ${message.uid}\r\n\r\nbody`);
      await h.repository.storeBody({
        messageId: message.id,
        rawMime,
        rawBytes: rawMime.length,
        rawTruncated: false,
        bodyText: "body",
        bodyHtml: null,
        bodyPlain: "body",
        selectedTextPart: "1",
        selectedTextFormat: "plain",
        headersJson: {},
        mimeStructure: null,
        parserWarnings: [],
        evidence: []
      });
    }

    const folderRows = (
      await h.pool.query<{
        path: string;
        headers_synced_count: number;
        bodies_fetched_count: number;
        live_window_target_count: number | null;
      }>(
        `
        SELECT path, headers_synced_count, bodies_fetched_count, live_window_target_count
        FROM public.imap_folders
        WHERE account_id = $1
        ORDER BY path
        `,
        [h.account.id]
      )
    ).rows;
    expect(folderRows).toEqual([
      expect.objectContaining({
        path: "Archive",
        headers_synced_count: 2,
        bodies_fetched_count: 1,
        live_window_target_count: 2
      }),
      expect.objectContaining({
        path: "INBOX",
        headers_synced_count: 3,
        bodies_fetched_count: 3,
        live_window_target_count: 3
      })
    ]);

    const progress = (
      await h.pool.query<{
        live_headers_complete_pct: number;
        priority_bodies_complete_pct: number;
        live_bodies_complete_pct: number;
        historical_headers_complete_pct: number;
        historical_bodies_complete_pct: number;
        estimated_full_sync_at: Date | null;
      }>(
        `
        SELECT
          live_headers_complete_pct,
          priority_bodies_complete_pct,
          live_bodies_complete_pct,
          historical_headers_complete_pct,
          historical_bodies_complete_pct,
          estimated_full_sync_at
        FROM public.imap_account_progress
        WHERE account_id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(progress).toMatchObject({
      live_headers_complete_pct: 100,
      priority_bodies_complete_pct: 100,
      live_bodies_complete_pct: 80,
      historical_headers_complete_pct: 0,
      historical_bodies_complete_pct: 0,
      estimated_full_sync_at: null
    });

    const details = await h.repository.getAccountDetails(h.account.id);
    expect(details).toMatchObject({
      live_headers_complete_pct: 100,
      priority_bodies_complete_pct: 100,
      live_bodies_complete_pct: 80,
      folders: expect.arrayContaining([
        expect.objectContaining({ path: "INBOX", headers_pct: 100, bodies_pct: 100 }),
        expect.objectContaining({ path: "Archive", headers_pct: 100, bodies_pct: 50 })
      ])
    });
  });

  it("Scenario R — account body progress follows current live rows and rejects truncated bodies", async () => {
    const h = await setupIntegration("R-row-accurate-body-progress", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);

    await h.pool.query(
      "UPDATE public.imap_accounts SET historical_backfill_mode = 'off' WHERE id = $1",
      [h.account.id]
    );

    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 72_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "initial", from: "a@x.test", to: "u@x.test", body: "one" })
        ]
      }
    ];
    const engine = h.buildEngine({ folders });

    expect((await engine.syncAccount(h.account.id, "manual")).outcome).toBe("success");

    const initialMessageId = (
      await h.pool.query<{ id: string }>(
        `
        SELECT id
        FROM public.imap_messages
        WHERE account_id = $1
          AND folder_path = 'INBOX'
          AND uid = 1
        `,
        [h.account.id]
      )
    ).rows[0].id;
    const initialRawMime = Buffer.from("Subject: initial\r\n\r\none");
    await h.repository.storeBody({
      messageId: initialMessageId,
      rawMime: initialRawMime,
      rawBytes: initialRawMime.length,
      rawTruncated: false,
      bodyText: "one",
      bodyHtml: null,
      bodyPlain: "one",
      selectedTextPart: "1",
      selectedTextFormat: "plain",
      headersJson: {},
      mimeStructure: null,
      parserWarnings: [],
      evidence: []
    });

    folders[0].messages.push(
      makeTextMessage({ uid: 2, subject: "after snapshot", from: "b@x.test", to: "u@x.test", body: "two" })
    );
    await dueAllFolders(h.pool, h.account.id);
    expect((await engine.syncAccount(h.account.id, "manual")).outcome).toBe("success");

    const addedMessageId = (
      await h.pool.query<{ id: string }>(
        `
        SELECT id
        FROM public.imap_messages
        WHERE account_id = $1
          AND folder_path = 'INBOX'
          AND uid = 2
        `,
        [h.account.id]
      )
    ).rows[0].id;
    const truncatedRawMime = Buffer.from("Subject: after snapshot\r\n\r\ntwo");
    await h.repository.storeBody({
      messageId: addedMessageId,
      rawMime: truncatedRawMime,
      rawBytes: truncatedRawMime.length,
      rawTruncated: true,
      bodyText: "two",
      bodyHtml: null,
      bodyPlain: "two",
      selectedTextPart: "1",
      selectedTextFormat: "plain",
      headersJson: {},
      mimeStructure: null,
      parserWarnings: ["raw_mime_truncated"],
      evidence: []
    });

    await h.pool.query(
      `
      INSERT INTO public.imap_folders (
        account_id, path, tracked, sync_priority, status, missing_since,
        initial_sync_complete, live_window_target_count
      )
      VALUES
        ($1, 'Untracked', false, 100, 'ACTIVE', NULL, true, 1),
        ($1, 'MissingSince', true, 100, 'ACTIVE', now(), true, 1),
        ($1, 'Pending', true, 100, 'PENDING_VERIFICATION', NULL, true, 1)
      `,
      [h.account.id]
    );
    await h.pool.query(
      `
      INSERT INTO public.imap_messages (
        account_id, folder_path, uidvalidity, uid, internal_date,
        subject, body_fetched_at, deleted_in_provider, window_status
      )
      VALUES
        ($1, 'INBOX', 72001, 3, now(), 'parsed-only complete', now(), false, 'IN_WINDOW'),
        ($1, 'INBOX', 72001, 4, now(), 'marker without body', now(), false, 'IN_WINDOW'),
        ($1, 'INBOX', 72001, 5, now(), 'provider deleted', NULL, true, 'IN_WINDOW'),
        ($1, 'INBOX', 72001, 6, now(), 'historical', NULL, false, 'HISTORICAL'),
        ($1, 'Untracked', 72002, 1, now(), 'untracked', NULL, false, 'IN_WINDOW'),
        ($1, 'MissingSince', 72003, 1, now(), 'missing since', NULL, false, 'IN_WINDOW'),
        ($1, 'Pending', 72004, 1, now(), 'pending verification', NULL, false, 'IN_WINDOW')
      `,
      [h.account.id]
    );
    await h.pool.query(
      `
      INSERT INTO public.imap_message_bodies (
        message_id, raw_mime, raw_bytes, raw_truncated, body_text
      )
      SELECT id, NULL, 20, false, 'parsed-only complete'
      FROM public.imap_messages
      WHERE account_id = $1
        AND folder_path = 'INBOX'
        AND uidvalidity = 72001
        AND uid = 3
      `,
      [h.account.id]
    );

    const folderProgress = (
      await h.pool.query<{
        headers_synced_count: number;
        bodies_fetched_count: number;
        live_window_target_count: number | null;
      }>(
        `
        SELECT headers_synced_count, bodies_fetched_count, live_window_target_count
        FROM public.imap_folders
        WHERE account_id = $1
          AND path = 'INBOX'
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(folderProgress).toEqual({
      headers_synced_count: 2,
      bodies_fetched_count: 2,
      live_window_target_count: 1
    });

    const progress = (
      await h.pool.query<{
        live_headers_synced_count: number;
        live_headers_target_count: number;
        live_headers_complete_pct: number;
        priority_bodies_fetched_count: number;
        priority_bodies_target_count: number;
        priority_bodies_complete_pct: number;
        live_bodies_fetched_count: number;
        live_bodies_target_count: number;
        live_bodies_complete_pct: number;
      }>(
        `
        SELECT
          live_headers_synced_count,
          live_headers_target_count,
          live_headers_complete_pct,
          priority_bodies_fetched_count,
          priority_bodies_target_count,
          priority_bodies_complete_pct,
          live_bodies_fetched_count,
          live_bodies_target_count,
          live_bodies_complete_pct
        FROM public.imap_account_progress
        WHERE account_id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(progress).toEqual({
      live_headers_synced_count: 1,
      live_headers_target_count: 3,
      live_headers_complete_pct: 33,
      priority_bodies_fetched_count: 2,
      priority_bodies_target_count: 4,
      priority_bodies_complete_pct: 50,
      live_bodies_fetched_count: 2,
      live_bodies_target_count: 4,
      live_bodies_complete_pct: 50
    });

    const details = await h.repository.getAccountDetails(h.account.id);
    expect(details?.folders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "INBOX",
        bodies_fetched_count: 2,
        live_bodies_fetched_count: 2,
        live_bodies_target_count: 4,
        bodies_pct: 50
      }),
      expect.objectContaining({
        path: "Untracked",
        live_bodies_fetched_count: 0,
        live_bodies_target_count: 1,
        bodies_pct: 0
      }),
      expect.objectContaining({
        path: "MissingSince",
        live_bodies_fetched_count: 0,
        live_bodies_target_count: 1,
        bodies_pct: 0
      }),
      expect.objectContaining({
        path: "Pending",
        live_bodies_fetched_count: 0,
        live_bodies_target_count: 1,
        bodies_pct: 0
      })
    ]));
  });

  it("Scenario S — settings PATCH makes an existing non-priority live body eligible on the next sync", async () => {
    const h = await setupIntegration("S-live-body-policy-transition", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);

    await h.repository.updateAccountSettings(h.account.id, {
      bodyFetchPolicy: "priority_then_backfill",
      historicalBackfillMode: "off"
    });

    const folders: FixtureFolder[] = [
      {
        path: "Archive",
        delimiter: "/",
        uidValidity: 73_001,
        messages: [
          makeTextMessage({
            uid: 1,
            subject: "non-priority backlog",
            from: "a@x.test",
            to: "u@x.test",
            body: "fetch after policy change"
          })
        ]
      }
    ];
    const engine = h.buildEngine({ folders });

    const first = await engine.syncAccount(h.account.id, "manual");
    expect(first.outcome).toBe("success");
    expect(first.bodiesFetched).toBe(0);

    const before = await h.pool.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM public.imap_message_bodies b
      JOIN public.imap_messages m ON m.id = b.message_id
      WHERE m.account_id = $1
      `,
      [h.account.id]
    );
    expect(before.rows[0].count).toBe("0");

    const app = createApiApp({
      apiToken: "api-token",
      adminToken: null,
      repository: h.repository,
      engine,
      applyMigration: async () => undefined,
      send: (async () => {
        throw new Error("not used");
      }) as never,
      search: (async () => {
        throw new Error("not used");
      }) as never,
      drafts: {} as never,
      mutations: {} as never,
      content: {} as never
    });
    const headers = {
      authorization: "Bearer api-token",
      "content-type": "application/json"
    };

    const patch = await app.request(`/accounts/${h.account.id}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ bodyFetchPolicy: "immediate" })
    });
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toMatchObject({
      account: { body_fetch_policy: "immediate" }
    });

    const sync = await app.request(`/accounts/${h.account.id}/sync`, {
      method: "POST",
      headers
    });
    expect(sync.status).toBe(200);
    await expect(sync.json()).resolves.toMatchObject({
      result: {
        outcome: "success",
        bodiesFetched: 1
      }
    });

    const after = await h.pool.query<{ count: string }>(
      `
      SELECT count(*)::text AS count
      FROM public.imap_message_bodies b
      JOIN public.imap_messages m ON m.id = b.message_id
      WHERE m.account_id = $1
      `,
      [h.account.id]
    );
    expect(after.rows[0].count).toBe("1");
  });
});

// Helpful diagnostic when the suite is silently skipped.
if (!DB_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.log("[sync-engine.integration] DATABASE_URL not set — integration suite skipped.");
}
