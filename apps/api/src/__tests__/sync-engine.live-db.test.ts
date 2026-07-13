import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config.js";
import { closePool, getPool, type PgClient } from "../db.js";
import { clearOrphanedLocks } from "../locks.js";
import type { MirrorImapClient } from "../imap-client.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import {
  backdateMissingSince,
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
    // The run started before the worker died, so it predates the stale window.
    const orphanRunId = await h.repository.startSyncRun(h.account.id, "manual");
    await h.pool.query(
      `UPDATE public.imap_sync_runs SET started_at = now() - interval '10 minutes' WHERE id = $1`,
      [orphanRunId]
    );

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
    await h.pool.query(
      `UPDATE public.imap_sync_runs SET started_at = now() - interval '10 minutes' WHERE id = $1`,
      [orphanRunId]
    );

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

    const sweep = await clearOrphanedLocks(h.pool, 1_000);

    // The sweep reports what it reaped, so a SIGKILL/OOM (no pg_locks PID to
    // terminate) is still observable at startup rather than silent.
    expect(sweep.terminatedBackends).toBe(0);
    expect(sweep.accountsReset).toBe(1);
    expect(sweep.runsClosed).toBe(1);

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

  it("does not reap a freshly-started run when the account heartbeat is still stale", async () => {
    const h = await setupIntegration("live-fresh-run-stale-heartbeat", { STALE_HEARTBEAT_MS: 60_000 });
    activeAccountIds.push(h.account.id);

    // The race window: a new sync calls startSyncRun (run opens at status='running')
    // before markAccountSyncStarted refreshes the heartbeat. For a brand-new account
    // the heartbeat is NULL, so the account looks stale to the reaper — but the run
    // just started, so closing it would fail a legitimately-active sync.
    await h.pool.query(
      `
      UPDATE public.imap_accounts
      SET currently_syncing = true,
          last_heartbeat_at = NULL
      WHERE id = $1
      `,
      [h.account.id]
    );
    const freshRunId = await h.repository.startSyncRun(h.account.id, "manual");

    const sweep = await clearOrphanedLocks(h.pool, 60_000);

    // The run started just now, so the started_at guard must leave it open even
    // though the account heartbeat qualifies as stale.
    expect(sweep.runsClosed).toBe(0);
    const freshRun = await h.pool.query<{ status: string; finished_at: Date | null }>(
      `SELECT status, finished_at FROM public.imap_sync_runs WHERE id = $1`,
      [freshRunId]
    );
    expect(freshRun.rows[0].status).toBe("running");
    expect(freshRun.rows[0].finished_at).toBeNull();
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

  it("reserves the first priority slot for Sent so a busy priority set cannot starve it", async () => {
    const h = await setupIntegration("live-sent-priority-slot", {
      PRIORITY_CUTOFF: 10,
      MAX_PRIORITY_FOLDERS_PER_CYCLE: 1
    });
    activeAccountIds.push(h.account.id);
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing account");

    await h.repository.upsertDiscoveredFolders(account, [
      { path: "INBOX", delimiter: "/", specialUse: "\\Inbox" },
      { path: "Sent", delimiter: "/", specialUse: "\\Sent" }
    ]);
    await h.pool.query(
      `UPDATE public.imap_folders
       SET next_sync_due_at = now() - interval '1 second'
       WHERE account_id = $1`,
      [h.account.id]
    );

    const due = await h.repository.getFoldersDueForSync(h.account.id);

    expect(due.map((folder) => folder.path)).toEqual(["Sent"]);
  });

  it("makes Sent due sooner than the regular mailbox sweep", async () => {
    const h = await setupIntegration("live-sent-cadence", {
      SYNC_INTERVAL_MS: 60_000,
      SENT_SYNC_INTERVAL_MS: 30_000
    });
    activeAccountIds.push(h.account.id);
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing account");

    const folders = await h.repository.upsertDiscoveredFolders(account, [
      { path: "INBOX", delimiter: "/", specialUse: "\\Inbox" },
      { path: "Sent", delimiter: "/", specialUse: "\\Sent" }
    ]);
    const inbox = folders.find((folder) => folder.path === "INBOX");
    const sent = folders.find((folder) => folder.path === "Sent");
    if (!inbox || !sent) throw new Error("missing discovered folders");

    await h.repository.markFolderSynced(inbox.id, { uidValidity: 1 });
    await h.repository.markFolderSynced(sent.id, { uidValidity: 1 });

    const delays = await h.pool.query<{ path: string; delay_ms: number }>(
      `SELECT path,
              round(extract(epoch from (next_sync_due_at - now())) * 1000)::int AS delay_ms
       FROM public.imap_folders
       WHERE account_id = $1
       ORDER BY path`,
      [h.account.id]
    );
    const byPath = Object.fromEntries(delays.rows.map((row) => [row.path, row.delay_ms]));

    expect(byPath.Sent).toBeGreaterThan(25_000);
    expect(byPath.Sent).toBeLessThanOrEqual(30_000);
    expect(byPath.INBOX).toBeGreaterThan(55_000);
    expect(byPath.INBOX).toBeLessThanOrEqual(60_000);
  });

  it("drops folders discovery flagged missing from the sync + history working set", async () => {
    // Regression: a folder the user created then deleted is stamped missing_since
    // by discovery, but the sync lane kept SELECTing it. The provider returns a
    // generic error (e.g. Rackspace "Command failed", not a recognized
    // NONEXISTENT/TRYCREATE signal, so it is never sidelined to
    // PENDING_VERIFICATION), the run is marked failed, and consecutive_failures
    // climbs to BROKEN — one deleted folder bricking the whole account. Missing
    // folders are discovery's lifecycle to own, not the sync lane's.
    const h = await setupIntegration("live-missing-folder", { PRIORITY_CUTOFF: 10 });
    activeAccountIds.push(h.account.id);
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing account");

    // "Projects" stands in for the user-created folder that later gets deleted. Keep
    // the name clear of noisyFolderFragments (spam/junk/trash/deleted) or
    // upsertDiscoveredFolders excludes it (tracked=false) and the baseline breaks.
    await h.repository.upsertDiscoveredFolders(account, [
      { path: "INBOX", delimiter: "/" },
      { path: "Projects", delimiter: "/" }
    ]);
    // Both folders are priority, due, and initial-sync complete (history-eligible).
    await h.pool.query(
      `
      UPDATE public.imap_folders
      SET sync_priority = 1,
          next_sync_due_at = now() - interval '1 second',
          initial_sync_complete = true
      WHERE account_id = $1
      `,
      [h.account.id]
    );
    // The harness creates the account body_fetch_policy='lazy', which short-circuits
    // getBodyBacklog to []. Flip it on so the body lane actually SELECTs folders.
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'priority_then_backfill' WHERE id = $1",
      [h.account.id]
    );
    // Seed one in-window, un-body-fetched message per folder so the body lane
    // (getBodyBacklog) — the one un-try/caught reader that bricks the account
    // directly — has a reason to SELECT each folder.
    for (const folderPath of ["INBOX", "Projects"]) {
      await h.pool.query(
        `
        INSERT INTO public.imap_messages
          (account_id, folder_path, uidvalidity, uid, internal_date,
           window_status, deleted_in_provider, body_fetched_at)
        VALUES ($1, $2, 1, 1, now(), 'IN_WINDOW', false, NULL)
        `,
        [h.account.id, folderPath]
      );
    }

    // Baseline: every reader sees both folders before discovery flags one missing.
    const beforeSync = await h.repository.getFoldersDueForSync(h.account.id);
    expect(beforeSync.map((folder) => folder.path).sort()).toEqual(["INBOX", "Projects"]);
    const beforeAccount = await h.repository.getAccount(h.account.id);
    if (!beforeAccount) throw new Error("missing account");
    const beforeHistory = await h.repository.getHistoryBacklog(beforeAccount, 10);
    expect(beforeHistory.map((folder) => folder.path).sort()).toEqual(["INBOX", "Projects"]);
    const beforeBodies = await h.repository.getBodyBacklog(beforeAccount, 10);
    expect(beforeBodies.map((message) => message.folder_path).sort()).toEqual(["INBOX", "Projects"]);

    // Discovery stamps missing_since once the folder vanishes from the provider.
    await backdateMissingSince(h.pool, h.account.id, "Projects", "1 minute");

    // It must leave ALL sync working sets immediately — without waiting for the
    // multi-day grace tombstone — so neither the metadata, history, nor body lane
    // keeps SELECTing the deleted folder and failing the run.
    const dueSync = await h.repository.getFoldersDueForSync(h.account.id);
    expect(dueSync.map((folder) => folder.path)).toEqual(["INBOX"]);
    const afterAccount = await h.repository.getAccount(h.account.id);
    if (!afterAccount) throw new Error("missing account");
    const dueHistory = await h.repository.getHistoryBacklog(afterAccount, 10);
    expect(dueHistory.map((folder) => folder.path)).toEqual(["INBOX"]);
    const dueBodies = await h.repository.getBodyBacklog(afterAccount, 10);
    expect(dueBodies.map((message) => message.folder_path)).toEqual(["INBOX"]);
  });

  it("self-heals a threshold-BROKEN account after its retry cadence, never an AUTH_ERROR one", async () => {
    // An account bricked by transient failures (e.g. the now-fixed deleted-folder
    // brick) must recover on its own once the cause clears — not stay dead until an
    // operator resets it. getRunnableAccounts retries a BROKEN account whose
    // backoff_until has passed; the next clean run heals it. Terminal breaks
    // (AUTH_ERROR) NULL backoff_until and are never auto-retried.
    const h = await setupIntegration("live-self-heal", {
      STUCK_DEGRADED_RETRY_INTERVAL_MS: 60 * 60_000
    });
    activeAccountIds.push(h.account.id);

    // Drive it to BROKEN via the consecutive-failure threshold (BROKEN at 10).
    for (let i = 0; i < 10; i += 1) {
      await h.repository.markAccountSyncFailed(h.account.id, "INBOX.Projects: Command failed");
    }
    const broken = await h.repository.getAccount(h.account.id);
    if (!broken) throw new Error("missing account");
    expect(broken.sync_state).toBe("BROKEN");
    expect(broken.consecutive_failures).toBeGreaterThanOrEqual(10);
    expect(broken.backoff_until).not.toBeNull();

    // While the heal backoff is still in the future, it is not retried.
    const duringBackoff = await h.repository.getRunnableAccounts(25);
    expect(duringBackoff.map((account) => account.id)).not.toContain(h.account.id);

    // Once the retry time passes, it is picked up again — self-heal, no operator action.
    await h.pool.query(
      "UPDATE public.imap_accounts SET backoff_until = now() - interval '1 second' WHERE id = $1",
      [h.account.id]
    );
    const afterBackoff = await h.repository.getRunnableAccounts(25);
    expect(afterBackoff.map((account) => account.id)).toContain(h.account.id);

    // An AUTH_ERROR break is terminal: BROKEN with backoff_until NULL, never retried
    // (retrying bad credentials risks a provider lockout).
    await h.repository.markAccountSyncAuthFailed(h.account.id, "invalid credentials");
    const authBroken = await h.repository.getAccount(h.account.id);
    if (!authBroken) throw new Error("missing account");
    expect(authBroken.sync_state).toBe("BROKEN");
    expect(authBroken.backoff_until).toBeNull();
    const authRunnable = await h.repository.getRunnableAccounts(25);
    expect(authRunnable.map((account) => account.id)).not.toContain(h.account.id);
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

  it("retention prunes imap_sync_events older than the retention window, keeping recent ones", async () => {
    const h = await setupIntegration("live-event-prune");
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `
      INSERT INTO public.imap_sync_events (account_id, event_type, occurred_at)
      VALUES ($1, 'PRUNE_TEST_OLD', now() - interval '200 days'),
             ($1, 'PRUNE_TEST_RECENT', now())
      `,
      [h.account.id]
    );

    const retention = await h.repository.runRetentionJobs();
    expect(retention.prunedEvents).toBeGreaterThanOrEqual(1);

    const remaining = await h.pool.query<{ event_type: string }>(
      "SELECT event_type FROM public.imap_sync_events WHERE account_id = $1 AND event_type LIKE 'PRUNE_TEST_%'",
      [h.account.id]
    );
    const types = remaining.rows.map((row) => row.event_type);
    expect(types).toContain("PRUNE_TEST_RECENT");
    expect(types).not.toContain("PRUNE_TEST_OLD");
  });

  it("degrades on a recent UIDVALIDITY reset, then returns HEALTHY once the reset ages out", async () => {
    const h = await setupIntegration("live-reset-degraded", { RECENT_UIDVALIDITY_RESET_DEGRADED_MS: 60 * 60_000 });
    activeAccountIds.push(h.account.id);
    const engine = h.buildEngine({ folders: buildInboxAndSentFolders() });
    await engine.syncAccount(h.account.id, "manual");

    // Make every folder complete + fully clean, so the account would be HEALTHY —
    // except for a UIDVALIDITY reset at the given time.
    const makeCleanWithReset = async (resetAtSql: string) => {
      await h.pool.query(
        `
        UPDATE public.imap_folders
        SET status = 'ACTIVE',
            initial_sync_complete = true,
            last_synced_at = now(),
            last_full_reconcile_at = now(),
            last_reconcile_clean = true,
            missing_since = NULL,
            last_uidvalidity_reset_at = ${resetAtSql}
        WHERE account_id = $1
        `,
        [h.account.id]
      );
    };
    const readState = async () =>
      (await h.pool.query<{ sync_state: string; sync_state_reason: string | null }>(
        "SELECT sync_state, sync_state_reason FROM public.imap_accounts WHERE id = $1",
        [h.account.id]
      )).rows[0];

    // A reset within the window → DEGRADED with the reset reason (not straight HEALTHY).
    await makeCleanWithReset("now()");
    await h.repository.markAccountSyncSucceeded(h.account.id);
    const recent = await readState();
    expect(recent.sync_state).toBe("DEGRADED");
    expect(recent.sync_state_reason).toBe("RECENT_UIDVALIDITY_RESET");

    // A reset older than the window → HEALTHY (proves the window bound; a stale reset
    // does not degrade forever).
    await makeCleanWithReset("now() - interval '2 hours'");
    await h.repository.markAccountSyncSucceeded(h.account.id);
    const aged = await readState();
    expect(aged.sync_state).toBe("HEALTHY");
    expect(aged.sync_state_reason).toBeNull();
  });
});

if (!LIVE_DB_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.log("[sync-engine.live-db] LIVE_DB_TESTS=1 and DATABASE_URL are required; suite skipped.");
}
