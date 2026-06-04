import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config.js";
import { closePool, getPool, type PgClient } from "../db.js";
import { clearOrphanedLocks } from "../locks.js";
import type { MirrorImapClient } from "../imap-client.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import {
  buildInboxAndSentFolders,
  setupIntegration,
  teardownIntegration
} from "./helpers/integration-harness.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

function timeout<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function oneFolder(path = "INBOX", messages = 2): FixtureFolder[] {
  return [{
    path,
    delimiter: "/",
    specialUse: path === "INBOX" ? "\\Inbox" : undefined,
    uidValidity: 42_001,
    messages: Array.from({ length: messages }, (_, index) => makeTextMessage({
      uid: index + 1,
      subject: `${path}-${index + 1}`,
      from: "sender@example.test",
      to: "user@example.test",
      body: `${path}-${index + 1}`,
      flags: ["\\Seen"]
    }))
  }];
}

async function releaseKilledClient(client: PgClient): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock_all()");
  } catch {
    // The orphan-lock test intentionally terminates this backend.
  } finally {
    (client.release as (err?: Error | boolean) => void)(true);
  }
}

liveDb("live DB reliability lane", () => {
  const activeAccountIds: string[] = [];

  beforeAll(() => {
    resetConfigForTests();
  });

  afterEach(async () => {
    const pool = getPool();
    while (activeAccountIds.length > 0) {
      const accountId = activeAccountIds.pop()!;
      await teardownIntegration(pool, accountId).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it("serializes concurrent syncs with the account advisory lock", async () => {
    const h = await setupIntegration("live-lock", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder();
    let releaseList: () => void = () => undefined;
    const listCanReturn = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listEntered: () => void = () => undefined;
    const listWasEntered = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    let factoryCalls = 0;

    class BlockingListClient extends FixtureImapClient {
      async list() {
        listEntered();
        await listCanReturn;
        return super.list();
      }
    }

    const engine = h.buildEngine({
      folders,
      clientFactory: async () => {
        factoryCalls += 1;
        return new BlockingListClient(folders) as unknown as MirrorImapClient;
      }
    });

    const first = engine.syncAccount(h.account.id, "manual");
    await timeout(listWasEntered, "first sync entered LIST");
    const second = await engine.syncAccount(h.account.id, "manual");

    expect(second.outcome).toBe("failed");
    expect(second.errors.some((error) => error.includes("Account lock busy"))).toBe(true);
    expect(factoryCalls).toBe(1);

    releaseList();
    const firstResult = await timeout(first, "first sync completion");
    expect(firstResult.outcome).toBe("success");
  });

  it("reclaims stale advisory locks from pg_locks, closes the orphaned run, and then syncs", async () => {
    const h = await setupIntegration("live-orphan-lock", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      STALE_HEARTBEAT_MS: 1_000
    });
    activeAccountIds.push(h.account.id);
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing account");

    const locker = await h.pool.connect();
    locker.on("error", () => undefined);
    await locker.query("SELECT pg_advisory_lock($1::bigint)", [account.lock_id]);
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET currently_syncing = true,
          sync_started_by = 'dead-worker',
          last_heartbeat_at = now() - interval '10 minutes'
      WHERE id = $1
      `,
      [h.account.id]
    );
    // The dead worker also left its sync run open at status='running'. Reaping the
    // stale lock must close it, or it reads as a phantom perpetually-active sync.
    const orphanRunId = await h.repository.startSyncRun(h.account.id, "manual");

    try {
      const engine = h.buildEngine({ folders: oneFolder(), overrides: { STALE_HEARTBEAT_MS: 1_000 } });
      const result = await engine.syncAccount(h.account.id, "manual");
      expect(result.outcome).toBe("success");

      const locks = await h.pool.query<{ count: string }>(
        `
        SELECT count(*)::text AS count
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND granted = true
          AND objid::bigint = $1::bigint
        `,
        [account.lock_id]
      );
      expect(Number(locks.rows[0].count)).toBe(0);

      const orphanRun = await h.pool.query<{
        status: string;
        finished_at: Date | null;
        error: string | null;
      }>(
        `SELECT status, finished_at, error FROM public.imap_sync_runs WHERE id = $1`,
        [orphanRunId]
      );
      expect(orphanRun.rows[0].status).toBe("failed");
      expect(orphanRun.rows[0].finished_at).not.toBeNull();
      expect(orphanRun.rows[0].error).toMatch(/reaped/);
    } finally {
      await releaseKilledClient(locker);
    }
  });

  it("closes orphaned sync runs for stale accounts but leaves live accounts running", async () => {
    const h = await setupIntegration("live-orphan-run-startup", { STALE_HEARTBEAT_MS: 1_000 });
    activeAccountIds.push(h.account.id);

    // Model a SIGKILL/OOM on this account: the worker died, so its advisory-lock
    // session already ended (no pg_locks row to terminate), but it left the
    // account flagged syncing with a stale heartbeat and its run row stuck at
    // status='running'. clearOrphanedLocks runs once at worker startup and must
    // close that run.
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET currently_syncing = true,
          sync_started_by = 'dead-worker',
          last_heartbeat_at = now() - interval '10 minutes'
      WHERE id = $1
      `,
      [h.account.id]
    );
    const orphanRunId = await h.repository.startSyncRun(h.account.id, "manual");

    // A second account is genuinely live: flagged syncing with a fresh heartbeat
    // and its own open run. Stale-lock recovery must be conservative and leave it
    // untouched, or it would fail a legitimately running sync.
    const liveEmail = `integration-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const liveAccount = await h.repository.createAccount({
      emailAddress: liveEmail,
      host: "fake.imap.local",
      port: 993,
      secure: true,
      username: liveEmail,
      password: "not-used",
      providerProfile: "generic-imap",
      bodyFetchPolicy: "lazy"
    });
    activeAccountIds.push(liveAccount.id);
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET currently_syncing = true,
          sync_started_by = 'live-worker',
          last_heartbeat_at = now()
      WHERE id = $1
      `,
      [liveAccount.id]
    );
    const liveRunId = await h.repository.startSyncRun(liveAccount.id, "manual");

    await clearOrphanedLocks(h.pool, 1_000);

    // Stale account is reaped: flag cleared, run closed as failed (reaped).
    const accountRow = await h.pool.query<{ currently_syncing: boolean }>(
      `SELECT currently_syncing FROM public.imap_accounts WHERE id = $1`,
      [h.account.id]
    );
    expect(accountRow.rows[0].currently_syncing).toBe(false);

    const orphanRun = await h.pool.query<{
      status: string;
      finished_at: Date | null;
      error: string | null;
    }>(
      `SELECT status, finished_at, error FROM public.imap_sync_runs WHERE id = $1`,
      [orphanRunId]
    );
    expect(orphanRun.rows[0].status).toBe("failed");
    expect(orphanRun.rows[0].finished_at).not.toBeNull();
    expect(orphanRun.rows[0].error).toMatch(/reaped/);

    // Live account is untouched: still syncing, run still open.
    const liveAccountRow = await h.pool.query<{ currently_syncing: boolean }>(
      `SELECT currently_syncing FROM public.imap_accounts WHERE id = $1`,
      [liveAccount.id]
    );
    expect(liveAccountRow.rows[0].currently_syncing).toBe(true);

    const liveRun = await h.pool.query<{ status: string; finished_at: Date | null }>(
      `SELECT status, finished_at FROM public.imap_sync_runs WHERE id = $1`,
      [liveRunId]
    );
    expect(liveRun.rows[0].status).toBe("running");
    expect(liveRun.rows[0].finished_at).toBeNull();
  });

  it("selects due folders by priority and round-robin cursor", async () => {
    const h = await setupIntegration("live-scheduling", {
      PRIORITY_CUTOFF: 10,
      MAX_PRIORITY_FOLDERS_PER_CYCLE: 1,
      MAX_RR_FOLDERS_PER_CYCLE: 2
    });
    activeAccountIds.push(h.account.id);
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing account");

    await h.repository.upsertDiscoveredFolders(account, [
      { path: "Priority", delimiter: "/" },
      { path: "RR-A", delimiter: "/" },
      { path: "RR-B", delimiter: "/" },
      { path: "RR-C", delimiter: "/" }
    ]);
    await h.pool.query(
      `
      UPDATE public.imap_folders
      SET sync_priority = CASE WHEN path = 'Priority' THEN 1 ELSE 100 END,
          next_sync_due_at = now() - interval '1 second'
      WHERE account_id = $1
      `,
      [h.account.id]
    );

    const first = await h.repository.getFoldersDueForSync(h.account.id);
    const second = await h.repository.getFoldersDueForSync(h.account.id);

    expect(first.map((folder) => folder.path)).toEqual(["Priority", "RR-A", "RR-B"]);
    expect(second.map((folder) => folder.path)).toEqual(["Priority", "RR-C", "RR-A"]);
  });

  it("flag scans update known rows only and emit FLAGS_CHANGED", async () => {
    const h = await setupIntegration("live-flags", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder("INBOX", 2);
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");

    folders[0].messages[0].flags = ["\\Seen", "\\Flagged"];
    folders[0].messages.push(makeTextMessage({
      uid: 0,
      subject: "unknown",
      from: "sender@example.test",
      to: "user@example.test",
      body: "unknown",
      flags: ["\\Seen"]
    }));
    await h.pool.query(
      `
      UPDATE public.imap_folders
      SET next_sync_due_at = now() - interval '1 second',
          next_flag_scan_at = now() - interval '1 second',
          last_full_reconcile_at = now(),
          next_reconcile_at = now() + interval '1 day',
          last_reconcile_clean = true
      WHERE account_id = $1 AND path = 'INBOX'
      `,
      [h.account.id]
    );

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");
    expect(result.flagsUpdated).toBe(1);

    const rows = await h.pool.query<{ uid: string; flags: string[] }>(
      `
      SELECT uid::text AS uid, flags
      FROM public.imap_messages
      WHERE account_id = $1 AND folder_path = 'INBOX'
      ORDER BY uid
      `,
      [h.account.id]
    );
    expect(rows.rows.map((row) => Number(row.uid))).toEqual([1, 2]);
    expect(rows.rows[0].flags.map((flag) => flag.toLowerCase())).toContain("\\flagged");

    const event = await h.pool.query<{ payload: { nextFlags: string[] } }>(
      `
      SELECT payload
      FROM public.imap_sync_events
      WHERE account_id = $1 AND event_type = 'FLAGS_CHANGED'
      ORDER BY occurred_at DESC
      LIMIT 1
      `,
      [h.account.id]
    );
    expect(event.rows[0]?.payload.nextFlags).toContain("\\flagged");
  });

  it("reconcile owns missing-in-DB recovery and emits RECONCILE_BACKFILL", async () => {
    const h = await setupIntegration("live-reconcile", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder("INBOX", 2);
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");

    await h.pool.query(
      "DELETE FROM public.imap_messages WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = 2",
      [h.account.id]
    );
    await h.pool.query(
      `
      UPDATE public.imap_folders
      SET next_sync_due_at = now() - interval '1 second',
          next_flag_scan_at = now() - interval '1 second'
      WHERE account_id = $1 AND path = 'INBOX'
      `,
      [h.account.id]
    );

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");
    expect(result.reconcileGapsFound).toBeGreaterThanOrEqual(1);

    const uids = await h.pool.query<{ uid: string }>(
      `
      SELECT uid::text AS uid
      FROM public.imap_messages
      WHERE account_id = $1 AND folder_path = 'INBOX' AND deleted_in_provider = false
      ORDER BY uid
      `,
      [h.account.id]
    );
    expect(uids.rows.map((row) => Number(row.uid))).toEqual([1, 2]);

    const event = await h.pool.query<{ payload: { backfilled: number } }>(
      `
      SELECT payload
      FROM public.imap_sync_events
      WHERE account_id = $1 AND event_type = 'RECONCILE_BACKFILL'
      ORDER BY occurred_at DESC
      LIMIT 1
      `,
      [h.account.id]
    );
    expect(event.rows[0]?.payload.backfilled).toBeGreaterThanOrEqual(1);
  });

  it("reconcile treats archive-only folders as clean when the live window is empty", async () => {
    const h = await setupIntegration("live-reconcile-archive-only", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const oldInternalDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    const folders: FixtureFolder[] = [{
      path: "INBOX.Archive",
      delimiter: "/",
      specialUse: "\\Archive",
      uidValidity: 52_001,
      messages: [
        makeTextMessage({
          uid: 1,
          subject: "old-archive",
          from: "sender@example.test",
          to: "user@example.test",
          body: "old-archive",
          internalDate: oldInternalDate
        })
      ]
    }];
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });

    const first = await engine.syncAccount(h.account.id, "manual");
    expect(first.outcome).toBe("success");

    await h.pool.query(
      `
      UPDATE public.imap_folders
      SET next_sync_due_at = now() - interval '1 second',
          next_reconcile_at = now() - interval '1 second'
      WHERE account_id = $1 AND path = 'INBOX.Archive'
      `,
      [h.account.id]
    );

    const second = await engine.syncAccount(h.account.id, "manual");
    expect(second.outcome).toBe("success");
    expect(second.reconcileGapsFound).toBe(0);

    const folder = await h.pool.query<{ last_reconcile_clean: boolean | null }>(
      `
      SELECT last_reconcile_clean
      FROM public.imap_folders
      WHERE account_id = $1 AND path = 'INBOX.Archive'
      `,
      [h.account.id]
    );
    expect(folder.rows[0]?.last_reconcile_clean).toBe(true);
  });

  it("retention expires old in-window rows and purges only trapdoor delete reasons", async () => {
    const h = await setupIntegration("live-retention", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder("INBOX", 5);
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");

    await h.pool.query(
      `
      UPDATE public.imap_messages
      SET internal_date = now() - interval '200 days',
          window_status = 'IN_WINDOW'
      WHERE account_id = $1 AND uid = 1
      `,
      [h.account.id]
    );
    await h.pool.query(
      `
      UPDATE public.imap_messages
      SET deleted_in_provider = true,
          provider_deleted_at = now() - interval '31 days',
          deleted_reason = CASE uid
            WHEN 2 THEN 'UIDVALIDITY_RESET'
            WHEN 3 THEN 'MOVED_OUT'
            WHEN 4 THEN 'FOLDER_MISSING'
            WHEN 5 THEN 'RECONCILE_MISSING'
          END
      WHERE account_id = $1 AND uid IN (2, 3, 4, 5)
      `,
      [h.account.id]
    );

    const retention = await h.repository.runRetentionJobs();
    expect(retention.expired).toBeGreaterThanOrEqual(1);
    expect(retention.purged).toBe(3);

    const rows = await h.pool.query<{ uid: string; window_status: string; deleted_reason: string | null }>(
      `
      SELECT uid::text AS uid, window_status, deleted_reason
      FROM public.imap_messages
      WHERE account_id = $1
      ORDER BY uid
      `,
      [h.account.id]
    );
    expect(rows.rows.map((row) => Number(row.uid))).toEqual([1, 5]);
    expect(rows.rows.find((row) => Number(row.uid) === 1)?.window_status).toBe("EXPIRED");
    expect(rows.rows.find((row) => Number(row.uid) === 5)?.deleted_reason).toBe("RECONCILE_MISSING");
  });

  it("health stays INITIAL_SYNC or DEGRADED until folder and reconcile state are clean", async () => {
    const h = await setupIntegration("live-health");
    activeAccountIds.push(h.account.id);
    const engine = h.buildEngine({ folders: buildInboxAndSentFolders() });

    const first = await engine.syncAccount(h.account.id, "manual");
    expect(first.outcome).toBe("success");
    const incomplete = await h.pool.query<{ sync_state: string; sync_state_reason: string | null }>(
      "SELECT sync_state, sync_state_reason FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(incomplete.rows[0].sync_state).toBe("INITIAL_SYNC");
    expect(incomplete.rows[0].sync_state_reason).toBe("INITIAL_SYNC_IN_PROGRESS");

    await h.pool.query(
      `
      UPDATE public.imap_folders
      SET status = 'ACTIVE',
          initial_sync_complete = true,
          last_synced_at = now(),
          last_full_reconcile_at = now(),
          last_reconcile_clean = path <> 'INBOX'
      WHERE account_id = $1
      `,
      [h.account.id]
    );
    await h.repository.markAccountSyncSucceeded(h.account.id);
    const degraded = await h.pool.query<{ sync_state: string; sync_state_reason: string | null }>(
      "SELECT sync_state, sync_state_reason FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(degraded.rows[0].sync_state).toBe("DEGRADED");
    expect(degraded.rows[0].sync_state_reason).toBe("RECONCILE_GAPS_FOUND");
  });
});

if (!LIVE_DB_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.log("[sync-engine.live-db] LIVE_DB_TESTS=1 and DATABASE_URL are required; suite skipped.");
}
