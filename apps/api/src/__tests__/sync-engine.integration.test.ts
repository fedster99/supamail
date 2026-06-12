import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, getPool } from "../db.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import type { MirrorImapClient } from "../imap-client.js";
import { resetConfigForTests } from "../config.js";
import { MirrorEngine } from "../sync-engine.js";
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
    expect(row.sync_state_reason).toMatch(/^AUTH_ERROR:/);
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
    expect(broken.sync_state_reason).toMatch(/UIDVALIDITY_RESET_LIMIT_EXCEEDED/);

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

    const engine = h.buildEngine({ folders });
    const result = await engine.syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(4);

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
    expect(result.errors[0]).toContain("Sent: Connection not available");
    expect(result.errors[0]).toContain("connection lost");

    const account = await h.pool.query<{ consecutive_failures: number; sync_state: string }>(
      "SELECT consecutive_failures, sync_state FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(account.rows[0].consecutive_failures).toBe(0);
  });

  it("stores parsed bodies without raw MIME when BODY_STORAGE_MODE is parsed_only", async () => {
    const h = await setupIntegration("G-parsed-only-bodies", { BODY_STORAGE_MODE: "parsed_only" });
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1", [h.account.id]);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 410,
        messages: [
          makeTextMessage({ uid: 1, subject: "parsed", from: "a@x.test", to: "u@x.test", body: "parsed-only body" })
        ]
      }
    ];

    const engine = h.buildEngine({ folders });
    const result = await engine.syncAccount(h.account.id, "manual");

    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(1);

    const body = (
      await h.pool.query<{
        raw_mime: Buffer | null;
        raw_bytes: string;
        raw_truncated: boolean;
        body_text: string | null;
        body_plain: string | null;
      }>(
        `
        SELECT b.raw_mime, b.raw_bytes::text, b.raw_truncated, b.body_text, b.body_plain
        FROM public.imap_message_bodies b
        JOIN public.imap_messages m ON m.id = b.message_id
        WHERE m.account_id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(body.raw_mime).toBeNull();
    expect(Number(body.raw_bytes)).toBeGreaterThan(0);
    expect(body.raw_truncated).toBe(false);
    expect(`${body.body_text ?? ""}${body.body_plain ?? ""}`).toContain("parsed-only body");
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
    expect(afterTimeout.sync_state_reason).toContain("INITIAL_SYNC_BATCH_TIMEOUT_MS exceeded during initial sync FETCH");
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
          throw Object.assign(new Error("NO [NONEXISTENT] Mailbox doesn't exist"), {
            serverResponseCode: "NONEXISTENT"
          });
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
        parserWarnings: []
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
});

// Helpful diagnostic when the suite is silently skipped.
if (!DB_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.log("[sync-engine.integration] DATABASE_URL not set — integration suite skipped.");
}
