import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client as PostgresClient, Pool as PostgresPool } from "pg";
import { getConfig, resetConfigForTests } from "../config.js";
import { closePool, getPool, type PgClient } from "../db.js";
import { clearOrphanedLockForAccount, clearOrphanedLocks } from "../locks.js";
import { MirrorRepository } from "../repository.js";
import type { FetchMessage, MirrorImapClient } from "../imap-client.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import type { ImapFolder, MessageMetadata } from "../types.js";
import { MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES } from "../sync-limits.js";
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

async function waitForBlockedQuery(
  pool: ReturnType<typeof getPool> | PgClient | PostgresClient,
  blockerPid: number,
  queryFragment: string,
  ms = 5_000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // The observer deliberately holds the blocking row lock in one long
    // transaction; clear PostgreSQL's statistics snapshot so each poll sees
    // backends that began waiting after the previous iteration.
    await pool.query("SELECT pg_stat_clear_snapshot()");
    const blocked = await pool.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity activity
         WHERE activity.pid != $1::int
           AND activity.wait_event_type = 'Lock'
           AND activity.query ILIKE '%' || $2 || '%'
       ) AS found`,
      [blockerPid, queryFragment]
    );
    if (blocked.rows[0]?.found) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`blocked query containing ${queryFragment} was not observed`);
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

function messageMetadata(uid: number, overrides: Partial<MessageMetadata> = {}): MessageMetadata {
  return {
    uid,
    internalDate: new Date("2026-06-01T00:00:00.000Z"),
    sizeBytes: 100,
    flags: ["\\Seen"],
    rfcMessageId: `<metadata-${uid}@example.test>`,
    messageIdNormalized: `metadata-${uid}@example.test`,
    inReplyTo: null,
    referencesHeader: null,
    subject: `metadata-${uid}`,
    fromEmail: "sender@example.test",
    fromName: "Sender",
    toEmails: ["user@example.test"],
    toNames: ["User"],
    ccEmails: [],
    ccNames: [],
    bccEmails: [],
    headersJson: { "message-id": `<metadata-${uid}@example.test>` },
    mimeStructure: null,
    attachments: [],
    ...overrides,
    providerMessageId: overrides.providerMessageId ?? null,
    providerMessageIdNamespace: overrides.providerMessageIdNamespace ?? null,
    providerThreadId: overrides.providerThreadId ?? null,
    providerThreadIdNamespace: overrides.providerThreadIdNamespace ?? null
  };
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

  it("lets a Sent pass yield neutrally whenever the account lock is busy", async () => {
    const h = await setupIntegration("live-sent-lock-yield", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing account");
    const locker = await h.pool.connect();
    await locker.query("SELECT pg_advisory_lock($1::bigint)", [account.lock_id]);
    const abort = new AbortController();

    try {
      const engine = h.buildEngine({ folders: oneFolder("Sent") });
      const result = await engine.syncAccount(h.account.id, "scheduled", {
        sentOnly: true,
        signal: abort.signal
      });

      expect(result.outcome).toBe("success");
      expect(result.errors).toEqual([]);
      const run = await h.pool.query<{ status: string; error: string | null }>(
        "SELECT status, error FROM public.imap_sync_runs WHERE id = $1",
        [result.runId]
      );
      expect(run.rows[0]).toEqual({ status: "success", error: null });
    } finally {
      await locker.query("SELECT pg_advisory_unlock_all()");
      locker.release();
    }
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
      expect(orphanRun.rows[0].error).toBe("WORKER_REAPED");
    } finally {
      await releaseKilledClient(locker);
    }
  });

  it("does not let stale-lock recovery erase a newly acquired sync owner", async () => {
    const h = await setupIntegration("live-orphan-lock-owner-fence", {
      STALE_HEARTBEAT_MS: 1_000
    });
    activeAccountIds.push(h.account.id);
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing account");

    const locker = await h.pool.connect();
    locker.on("error", () => undefined);
    await locker.query("SELECT pg_advisory_lock($1::bigint)", [account.lock_id]);
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET currently_syncing = true,
           sync_started_by = 'dead-owner',
           last_heartbeat_at = now() - interval '10 minutes'
       WHERE id = $1`,
      [h.account.id]
    );

    const reaperPool = {
      query: vi.fn(async (query: string, params: unknown[] = []) => {
        const result = await h.pool.query(query, params);
        if (query.includes("pg_terminate_backend")) {
          await h.repository.markAccountSyncStarted(h.account.id, "new-owner");
        }
        return result;
      })
    } as unknown as typeof h.pool;

    try {
      await expect(clearOrphanedLockForAccount(
        reaperPool,
        account.lock_id,
        1_000
      )).resolves.toBe(true);

      const state = await h.pool.query<{
        currently_syncing: boolean;
        sync_started_by: string | null;
      }>(
        "SELECT currently_syncing, sync_started_by FROM public.imap_accounts WHERE id = $1",
        [h.account.id]
      );
      expect(state.rows[0]).toEqual({
        currently_syncing: true,
        sync_started_by: "new-owner"
      });
    } finally {
      await releaseKilledClient(locker);
      await h.repository.markAccountSyncYielded(h.account.id);
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
    expect(orphanRun.rows[0].error).toBe("WORKER_REAPED");

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

  it("keeps Inbox first in the bounded full-sweep priority set", async () => {
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

    expect(due.map((folder) => folder.path)).toEqual(["INBOX"]);
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
    const h = await setupIntegration("live-flags", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      INCREMENTAL_SYNC_BATCH_SIZE: 2
    });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder("INBOX", 3);
    folders[0].messages[0].uid = 2;
    folders[0].messages[1].uid = 3;
    folders[0].messages[2].uid = 4;
    const fetchQueries: Record<string, unknown>[] = [];
    const hookUids: number[] = [];
    class TrackingImapClient extends FixtureImapClient {
      override async *fetch(
        range: string | number[] | Record<string, unknown>,
        query: Record<string, unknown>,
        _options?: Record<string, unknown>
      ) {
        fetchQueries.push(query);
        yield* super.fetch(range, query);
      }
    }
    const engine = h.buildEngine({
      folders,
      overrides: { INITIAL_SYNC_BATCH_SIZE: 50 },
      clientFactory: async () => new TrackingImapClient(folders),
      hooks: {
        onMessageUpsert(message) {
          hookUids.push(Number(message.uid));
        }
      }
    });
    await engine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      `
      UPDATE public.imap_messages
      SET flags = ARRAY['\\seen']::text[]
      WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = 3
      `,
      [h.account.id]
    );

    const before = await h.pool.query<{
      uid: string;
      subject: string | null;
      headers_json: Record<string, unknown>;
      mime_structure: unknown;
      updated_at: Date;
    }>(
      `
      SELECT uid::text AS uid, subject, headers_json, mime_structure, updated_at
      FROM public.imap_messages
      WHERE account_id = $1 AND folder_path = 'INBOX'
      ORDER BY uid
      `,
      [h.account.id]
    );
    const folderBefore = await h.pool.query<{ headers_synced_count: number }>(
      "SELECT headers_synced_count FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
      [h.account.id]
    );
    hookUids.length = 0;
    fetchQueries.length = 0;

    folders[0].messages[0].flags = ["\\Seen", "\\Flagged"];
    folders[0].messages.push(makeTextMessage({
      uid: 1,
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

    const flagWrites = vi.spyOn(h.repository, "applyFlagScan");
    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");
    expect(result.flagsUpdated).toBe(1);
    expect(hookUids).toEqual([2, 3, 4]);
    expect(flagWrites).toHaveBeenCalledTimes(2);
    expect(flagWrites.mock.calls.every((call) => call[3].length <= 2)).toBe(true);
    flagWrites.mockRestore();

    const projectedFlagFetch = fetchQueries.find((query) => query.flags === true);
    expect(projectedFlagFetch).toEqual({ uid: true, flags: true });

    const rows = await h.pool.query<{
      uid: string;
      flags: string[];
      subject: string | null;
      headers_json: Record<string, unknown>;
      mime_structure: unknown;
      updated_at: Date;
    }>(
      `
      SELECT uid::text AS uid, flags, subject, headers_json, mime_structure, updated_at
      FROM public.imap_messages
      WHERE account_id = $1 AND folder_path = 'INBOX'
      ORDER BY uid
      `,
      [h.account.id]
    );
    expect(rows.rows.map((row) => Number(row.uid))).toEqual([2, 3, 4]);
    expect(rows.rows[0].flags.map((flag) => flag.toLowerCase())).toContain("\\flagged");
    expect(rows.rows[1].flags).toEqual(["\\Seen"]);
    expect(rows.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());
    expect(rows.rows[1].updated_at.getTime()).toBeGreaterThan(before.rows[1].updated_at.getTime());
    expect(rows.rows[2].updated_at.getTime()).toBe(before.rows[2].updated_at.getTime());
    for (let index = 0; index < rows.rows.length; index += 1) {
      expect(rows.rows[index].subject).toBe(before.rows[index].subject);
      expect(rows.rows[index].headers_json).toEqual(before.rows[index].headers_json);
      expect(rows.rows[index].mime_structure).toEqual(before.rows[index].mime_structure);
    }
    const folderAfter = await h.pool.query<{ headers_synced_count: number }>(
      "SELECT headers_synced_count FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
      [h.account.id]
    );
    expect(folderAfter.rows[0]).toEqual(folderBefore.rows[0]);

    const event = await h.pool.query<{ payload: { nextFlags: string[] }; count: string }>(
      `
      SELECT min(payload::text)::jsonb AS payload, count(*)::text AS count
      FROM public.imap_sync_events
      WHERE account_id = $1 AND event_type = 'FLAGS_CHANGED'
      `,
      [h.account.id]
    );
    expect(event.rows[0]?.count).toBe("1");
    expect(event.rows[0]?.payload.nextFlags).toContain("\\flagged");
  });

  it("rejects compressed stored flags by their uncompressed payload size", async () => {
    const h = await setupIntegration("live-compressed-stored-flags", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder("INBOX", 1);
    await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");
    const folder = (
      await h.pool.query<ImapFolder>(
        "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
        [h.account.id]
      )
    ).rows[0];
    if (!folder?.uidvalidity) throw new Error("missing synced folder");

    await h.pool.query(
      `
      UPDATE public.imap_messages
      SET flags = array_fill(repeat('x', $2::int), ARRAY[$3::int])
      WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = 1
      `,
      [h.account.id, 2_200, 4_000]
    );
    const compressed = await h.pool.query<{ stored_bytes: number; payload_bytes: number }>(
      `
      SELECT pg_column_size(flags) AS stored_bytes,
             octet_length(to_json(flags)::text) AS payload_bytes
      FROM public.imap_messages
      WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = 1
      `,
      [h.account.id]
    );
    expect(compressed.rows[0].stored_bytes).toBeLessThan(MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES);
    expect(compressed.rows[0].payload_bytes).toBeGreaterThan(MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES);

    await expect(h.repository.applyFlagScan(
      h.account.id,
      folder,
      Number(folder.uidvalidity),
      [{ uid: 1, flags: [] }]
    )).rejects.toThrow(/stored flags exceed the aggregate logical event limit/i);
  });

  it("rolls back an entire metadata batch when one attachment write fails", async () => {
    const h = await setupIntegration("live-atomic-metadata-batch", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder("INBOX", 1);
    await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");

    const folder = (
      await h.pool.query<ImapFolder>(
        "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
        [h.account.id]
      )
    ).rows[0];
    if (!folder?.uidvalidity) throw new Error("missing synced folder");
    const countBefore = folder.headers_synced_count;
    const first = messageMetadata(100);
    const second = messageMetadata(101);
    second.attachments = [{
      filename: "invalid.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 10,
      disposition: "invalid" as "attachment",
      contentId: null,
      partNumber: "1"
    }];

    await expect(
      h.repository.upsertMessages(
        h.account.id,
        folder,
        Number(folder.uidvalidity),
        [first, second],
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).rejects.toThrow();

    const persisted = await h.pool.query<{ uid: string }>(
      `
      SELECT uid::text AS uid
      FROM public.imap_messages
      WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = ANY($2::bigint[])
      ORDER BY uid
      `,
      [h.account.id, [100, 101]]
    );
    expect(persisted.rows).toEqual([]);
    const countAfter = await h.pool.query<{ headers_synced_count: number }>(
      "SELECT headers_synced_count FROM public.imap_folders WHERE id = $1",
      [folder.id]
    );
    expect(countAfter.rows[0]?.headers_synced_count).toBe(countBefore);
  });

  it("rolls back earlier metadata statements when a later bounded chunk fails", async () => {
    const h = await setupIntegration("live-atomic-split-metadata-batch", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    await h.buildEngine({ folders: oneFolder("INBOX", 1) }).syncAccount(h.account.id, "manual");
    const folder = (
      await h.pool.query<ImapFolder>(
        "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
        [h.account.id]
      )
    ).rows[0];
    if (!folder?.uidvalidity) throw new Error("missing synced folder");
    const countBefore = folder.headers_synced_count;
    const attachment = (index: number) => ({
      filename: `attachment-${index}.bin`,
      mimeType: "application/octet-stream",
      sizeBytes: 10,
      disposition: "attachment" as const,
      contentId: null,
      partNumber: String(index + 1)
    });
    const first = messageMetadata(100);
    first.attachments = Array.from({ length: 3_000 }, (_, index) => attachment(index));
    const second = messageMetadata(101);
    second.attachments = Array.from({ length: 3_000 }, (_, index) => attachment(index));
    second.attachments[0] = {
      ...second.attachments[0],
      disposition: "invalid" as "attachment"
    };

    await expect(h.repository.upsertMessages(
      h.account.id,
      folder,
      Number(folder.uidvalidity),
      [first, second],
      new Date("2026-01-01T00:00:00.000Z")
    )).rejects.toThrow();

    const persisted = await h.pool.query<{ messages: string; attachments: string }>(
      `SELECT count(DISTINCT m.id)::text AS messages,
              count(a.id)::text AS attachments
       FROM public.imap_messages m
       LEFT JOIN public.imap_attachments a ON a.message_id = m.id
       WHERE m.account_id = $1
         AND m.folder_path = 'INBOX'
         AND m.uid = ANY($2::bigint[])`,
      [h.account.id, [100, 101]]
    );
    expect(persisted.rows[0]).toEqual({ messages: "0", attachments: "0" });
    const countAfter = await h.pool.query<{ headers_synced_count: number }>(
      "SELECT headers_synced_count FROM public.imap_folders WHERE id = $1",
      [folder.id]
    );
    expect(countAfter.rows[0]?.headers_synced_count).toBe(countBefore);
  });

  it("serializes overlapping repository batches and counts each new UID once", async () => {
    const h = await setupIntegration("live-concurrent-metadata-batches", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    await h.buildEngine({ folders: oneFolder("INBOX", 0) }).syncAccount(h.account.id, "manual");
    const folder = (
      await h.pool.query<ImapFolder>(
        "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
        [h.account.id]
      )
    ).rows[0];
    if (!folder?.uidvalidity) throw new Error("missing synced folder");

    const [first, second] = await Promise.all([
      h.repository.upsertMessages(
        h.account.id,
        folder,
        Number(folder.uidvalidity),
        [messageMetadata(100), messageMetadata(101)],
        new Date("2026-01-01T00:00:00.000Z")
      ),
      h.repository.upsertMessages(
        h.account.id,
        folder,
        Number(folder.uidvalidity),
        [messageMetadata(101), messageMetadata(102)],
        new Date("2026-01-01T00:00:00.000Z")
      )
    ]);

    expect(first.map((row) => Number(row.uid))).toEqual([100, 101]);
    expect(second.map((row) => Number(row.uid))).toEqual([101, 102]);
    const state = await h.pool.query<{ count: string; headers_synced_count: number }>(
      `SELECT count(m.id)::text AS count, f.headers_synced_count
       FROM public.imap_folders f
       LEFT JOIN public.imap_messages m ON m.folder_id = f.id
       WHERE f.id = $1
       GROUP BY f.id`,
      [folder.id]
    );
    expect(state.rows[0]).toEqual({ count: "3", headers_synced_count: 3 });
  });

  it("serializes UIDVALIDITY reset with stale metadata writes", async () => {
    const h = await setupIntegration("live-uidvalidity-reset-metadata-race", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    await h.buildEngine({ folders: oneFolder("INBOX", 0) }).syncAccount(h.account.id, "manual");
    const folder = (
      await h.pool.query<ImapFolder>(
        "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
        [h.account.id]
      )
    ).rows[0];
    if (!folder?.uidvalidity) throw new Error("missing synced folder");
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing synced account");
    const oldUidValidity = Number(folder.uidvalidity);
    const newUidValidity = oldUidValidity + 1;

    await h.pool.query(
      "UPDATE public.imap_folders SET uidvalidity = NULL WHERE id = $1",
      [folder.id]
    );
    await h.repository.upsertMessages(
      h.account.id,
      folder,
      oldUidValidity,
      [messageMetadata(99)],
      new Date("2026-01-01T00:00:00.000Z")
    );
    const initialized = await h.pool.query<{ uidvalidity: string; headers_synced_count: number }>(
      "SELECT uidvalidity::text, headers_synced_count FROM public.imap_folders WHERE id = $1",
      [folder.id]
    );
    expect(initialized.rows[0]).toEqual({
      uidvalidity: String(oldUidValidity),
      headers_synced_count: 1
    });

    const blocker = new PostgresClient({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await blocker.query("BEGIN");
    const blockerPid = Number((await blocker.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid"
    )).rows[0].pid);
    await blocker.query("SELECT id FROM public.imap_folders WHERE id = $1 FOR UPDATE", [folder.id]);

    const resetPromise = h.repository.handleUidValidityReset(account, folder, newUidValidity);
    void resetPromise.catch(() => undefined);
    const stalePool = new PostgresPool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const staleRepository = new MirrorRepository(stalePool, getConfig());
    let staleWritePromise!: ReturnType<typeof h.repository.upsertMessages>;
    try {
      await waitForBlockedQuery(blocker, blockerPid, "uidvalidity_reset_count");
      staleWritePromise = staleRepository.upsertMessages(
        h.account.id,
        folder,
        oldUidValidity,
        [messageMetadata(100)],
        new Date("2026-01-01T00:00:00.000Z")
      );
      void staleWritePromise.catch(() => undefined);
      await waitForBlockedQuery(blocker, blockerPid, "SELECT id, uidvalidity::text");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      await stalePool.end();
    }

    const [reset, staleWrite] = await Promise.allSettled([resetPromise, staleWritePromise]);
    expect(reset.status).toBe("fulfilled");
    expect(staleWrite.status).toBe("rejected");

    await expect(h.repository.upsertMessages(
      h.account.id,
      folder,
      oldUidValidity,
      [messageMetadata(101)],
      new Date("2026-01-01T00:00:00.000Z")
    )).rejects.toThrow(/no longer matches folder/);
    await expect(h.repository.markFolderSynced(folder.id, {
      uidValidity: oldUidValidity,
      lastUid: 101,
      initialComplete: true
    })).rejects.toThrow(/lost generation/);
    await expect(h.repository.advanceInitialSyncWatermark(
      folder.id,
      99,
      101,
      oldUidValidity
    )).rejects.toThrow(/lost folder generation/);
    await expect(h.repository.advanceInitialSyncLiveHead(
      folder.id,
      101,
      oldUidValidity
    )).rejects.toThrow(/lost folder generation/);
    await expect(h.repository.advanceHistoryBackfillWatermark(
      folder.id,
      99,
      101,
      oldUidValidity
    )).rejects.toThrow(/lost folder generation/);
    await expect(h.repository.setHistoryBackfillSnapshot(
      folder.id,
      101,
      102,
      1,
      new Date("2026-01-01T00:00:00.000Z"),
      oldUidValidity
    )).rejects.toThrow(/lost folder generation/);
    await expect(h.repository.markHistoryBackfillComplete(
      folder.id,
      oldUidValidity
    )).rejects.toThrow(/lost folder generation/);

    const state = await h.pool.query<{
      uidvalidity: string;
      headers_synced_count: number;
      active_old_generation: string;
    }>(
      `SELECT f.uidvalidity::text,
              f.headers_synced_count,
              count(m.id) FILTER (
                WHERE m.uidvalidity = $2 AND m.deleted_in_provider = false
              )::text AS active_old_generation
       FROM public.imap_folders f
       LEFT JOIN public.imap_messages m ON m.folder_id = f.id
       WHERE f.id = $1
       GROUP BY f.id`,
      [folder.id, oldUidValidity]
    );
    expect(state.rows[0]).toEqual({
      uidvalidity: String(newUidValidity),
      headers_synced_count: 0,
      active_old_generation: "0"
    });
  });

  it("times out behind the folder lock without changing messages or counters", async () => {
    const h = await setupIntegration("live-metadata-lock-timeout", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    await h.buildEngine({ folders: oneFolder("INBOX", 0) }).syncAccount(h.account.id, "manual");
    const folder = (
      await h.pool.query<ImapFolder>(
        "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
        [h.account.id]
      )
    ).rows[0];
    if (!folder?.uidvalidity) throw new Error("missing synced folder");

    const blocker = new PostgresClient({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM public.imap_folders WHERE id = $1 FOR UPDATE", [folder.id]);
      await expect(h.repository.upsertMessages(
        h.account.id,
        folder,
        Number(folder.uidvalidity),
        [messageMetadata(100)],
        new Date("2026-01-01T00:00:00.000Z"),
        { deadlineAt: Date.now() + 75 }
      )).rejects.toThrow();
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }

    const state = await h.pool.query<{ count: string; headers_synced_count: number }>(
      `SELECT count(m.id)::text AS count, f.headers_synced_count
       FROM public.imap_folders f
       LEFT JOIN public.imap_messages m ON m.folder_id = f.id
       WHERE f.id = $1
       GROUP BY f.id`,
      [folder.id]
    );
    expect(state.rows[0]).toEqual({ count: "0", headers_synced_count: 0 });
    await expect(h.pool.query("SELECT 1 AS ok")).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it("cancels a blocked metadata transaction and releases the account lock on shutdown", async () => {
    const h = await setupIntegration("live-metadata-shutdown-abort", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      INCREMENTAL_TOTAL_TIMEOUT_MS: 30_000
    });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder("INBOX", 1);
    let pauseIncrementalFetch = false;
    let notifyFetchStarted!: () => void;
    let resumeFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const fetchCanResume = new Promise<void>((resolve) => {
      resumeFetch = resolve;
    });
    class PausingFixtureImapClient extends FixtureImapClient {
      override async *fetch(
        range: Parameters<MirrorImapClient["fetch"]>[0],
        query: Parameters<MirrorImapClient["fetch"]>[1],
        options?: Parameters<MirrorImapClient["fetch"]>[2]
      ): AsyncIterable<FetchMessage> {
        if (pauseIncrementalFetch && Array.isArray(range) && query.envelope === true) {
          notifyFetchStarted();
          await fetchCanResume;
        }
        void options;
        yield* super.fetch(range, query);
      }
    }
    const engine = h.buildEngine({
      folders,
      clientFactory: async () => new PausingFixtureImapClient(folders)
    });
    await engine.syncAccount(h.account.id, "manual");
    const folder = (
      await h.pool.query<ImapFolder>(
        "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
        [h.account.id]
      )
    ).rows[0];
    if (!folder?.uidvalidity) throw new Error("missing synced folder");
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing synced account");
    const healthBefore = await h.pool.query<{
      sync_state: string;
      sync_state_reason: string | null;
      consecutive_failures: number;
      consecutive_successes: number;
    }>(
      `SELECT sync_state, sync_state_reason, consecutive_failures, consecutive_successes
       FROM public.imap_accounts WHERE id = $1`,
      [h.account.id]
    );

    folders[0].messages.push(makeTextMessage({
      uid: 2,
      subject: "arrived-before-shutdown",
      from: "sender@example.test",
      to: "user@example.test",
      body: "arrived-before-shutdown",
      flags: ["\\Seen"]
    }));
    await h.pool.query(
      `UPDATE public.imap_folders
       SET next_sync_due_at = now() - interval '1 second',
           next_flag_scan_at = now() + interval '1 hour',
           next_reconcile_at = now() + interval '1 hour'
       WHERE id = $1`,
      [folder.id]
    );

    const blocker = new PostgresClient({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    const abort = new AbortController();
    let sync: Promise<[Awaited<ReturnType<typeof engine.syncAccount>>]> | null = null;
    try {
      pauseIncrementalFetch = true;
      sync = engine.syncAccount(h.account.id, "scheduled", { signal: abort.signal })
        .then((result) => [result]);
      await timeout(fetchStarted, "incremental metadata fetch to start");

      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM public.imap_folders WHERE id = $1 FOR UPDATE", [folder.id]);
      const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      resumeFetch();

      await vi.waitFor(async () => {
        const waiting = await h.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND $1 = ANY(pg_blocking_pids(pid))`,
          [blockerPid.rows[0].pid]
        );
        expect(waiting.rows[0].count).toBe("1");
      }, { timeout: 2_000, interval: 10 });

      const abortedAt = Date.now();
      abort.abort();
      const stoppedAfterMs = await Promise.race([
        sync.then(() => Date.now() - abortedAt),
        new Promise<number>((resolve) => setTimeout(() => resolve(5_000), 5_000))
      ]);
      expect(stoppedAfterMs).toBeLessThan(1_000);
      const [result] = await sync;
      expect(result.outcome).toBe("partial_success");
      expect(result.errors).toEqual(["Sync interrupted by scheduler"]);
    } finally {
      abort.abort();
      resumeFetch();
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      if (sync) await sync.catch(() => undefined);
    }

    const state = await h.pool.query<{
      message_count: string;
      headers_synced_count: number;
      currently_syncing: boolean;
      sync_started_by: string | null;
    }>(
      `SELECT count(m.id)::text AS message_count,
              f.headers_synced_count,
              a.currently_syncing,
              a.sync_started_by
       FROM public.imap_accounts a
       JOIN public.imap_folders f ON f.account_id = a.id AND f.id = $2
       LEFT JOIN public.imap_messages m ON m.folder_id = f.id
       WHERE a.id = $1
       GROUP BY f.id, a.id`,
      [h.account.id, folder.id]
    );
    expect(state.rows[0]).toEqual({
      message_count: "1",
      headers_synced_count: 1,
      currently_syncing: false,
      sync_started_by: null
    });
    const healthAfter = await h.pool.query<{
      sync_state: string;
      sync_state_reason: string | null;
      consecutive_failures: number;
      consecutive_successes: number;
    }>(
      `SELECT sync_state, sync_state_reason, consecutive_failures, consecutive_successes
       FROM public.imap_accounts WHERE id = $1`,
      [h.account.id]
    );
    expect(healthAfter.rows[0]).toEqual(healthBefore.rows[0]);
    const locks = await h.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND granted = true
         AND objid::bigint = $1::bigint`,
      [account.lock_id]
    );
    expect(locks.rows[0].count).toBe("0");
  });

  it("releases the account lock before bounded cancellation cleanup", async () => {
    const h = await setupIntegration("live-shutdown-account-cleanup-lock", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder("INBOX", 1);
    let pauseMailbox = false;
    let notifyMailboxStarted!: () => void;
    let resumeMailbox!: () => void;
    const mailboxStarted = new Promise<void>((resolve) => {
      notifyMailboxStarted = resolve;
    });
    const mailboxCanResume = new Promise<void>((resolve) => {
      resumeMailbox = resolve;
    });
    class BlockingFixtureImapClient extends FixtureImapClient {
      close(): void {
        resumeMailbox();
      }

      override async getMailboxLock(path: string) {
        if (pauseMailbox && path === "INBOX") {
          notifyMailboxStarted();
          await mailboxCanResume;
        }
        return await super.getMailboxLock(path);
      }
    }
    const engine = h.buildEngine({
      folders,
      clientFactory: async () => new BlockingFixtureImapClient(folders)
    });
    await engine.syncAccount(h.account.id, "manual");
    await h.pool.query(
      "UPDATE public.imap_folders SET next_sync_due_at = now() - interval '1 second' WHERE account_id = $1",
      [h.account.id]
    );
    const account = await h.repository.getAccount(h.account.id);
    if (!account) throw new Error("missing synced account");

    let notifyCleanupEntered!: () => void;
    const cleanupEntered = new Promise<void>((resolve) => {
      notifyCleanupEntered = resolve;
    });
    const originalYield = h.repository.markAccountSyncYielded.bind(h.repository);
    vi.spyOn(h.repository, "markAccountSyncYielded").mockImplementation(async (...args) => {
      notifyCleanupEntered();
      return await originalYield(...args);
    });

    const blocker = new PostgresClient({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    const abort = new AbortController();
    pauseMailbox = true;
    const sync = engine.syncAccount(h.account.id, "scheduled", { signal: abort.signal });
    let syncSettled = false;
    void sync.finally(() => {
      syncSettled = true;
    });
    try {
      await timeout(mailboxStarted, "mailbox operation to start");
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM public.imap_accounts WHERE id = $1 FOR UPDATE", [h.account.id]);

      const abortedAt = Date.now();
      abort.abort();
      await timeout(cleanupEntered, "cancellation cleanup to start");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(syncSettled).toBe(false);

      const locks = await h.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_locks
         WHERE locktype = 'advisory'
           AND granted = true
           AND objid::bigint = $1::bigint`,
        [account.lock_id]
      );
      expect(locks.rows[0].count).toBe("0");
      await blocker.query("ROLLBACK");

      const result = await timeout(sync, "sync cancellation cleanup", 1_500);
      expect(Date.now() - abortedAt).toBeLessThan(1_500);
      expect(result.outcome).toBe("partial_success");
      expect(result.errors).toEqual(["Sync interrupted by scheduler"]);
    } finally {
      abort.abort();
      resumeMailbox();
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      await sync.catch(() => undefined);
    }

    const active = await h.pool.query<{ currently_syncing: boolean }>(
      "SELECT currently_syncing FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(active.rows[0].currently_syncing).toBe(false);
  });

  it("fences delayed cancellation cleanup from a newer sync owner", async () => {
    const h = await setupIntegration("live-shutdown-cleanup-owner-fence");
    activeAccountIds.push(h.account.id);
    await h.repository.markAccountSyncStarted(h.account.id, "new-owner");

    await h.repository.markAccountSyncYielded(h.account.id, {
      expectedSyncOwner: "old-owner",
      deadlineAt: Date.now() + 1_000
    });

    const state = await h.pool.query<{
      currently_syncing: boolean;
      sync_started_by: string | null;
    }>(
      "SELECT currently_syncing, sync_started_by FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(state.rows[0]).toEqual({
      currently_syncing: true,
      sync_started_by: "new-owner"
    });
  });

  it("immediately reschedules an active projection when no advisory owner exists", async () => {
    const h = await setupIntegration("live-shutdown-cleanup-runnable", {
      STALE_HEARTBEAT_MS: 300_000
    });
    activeAccountIds.push(h.account.id);
    await h.repository.markAccountSyncStarted(h.account.id, "orphaned-projection");

    const runnable = await h.repository.getRunnableAccounts(25);
    expect(runnable.map((account) => account.id)).toContain(h.account.id);
  });

  it("counts committed metadata even when a later hook fails", async () => {
    const h = await setupIntegration("live-metadata-throughput-commit", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const result = await h.buildEngine({
      folders: oneFolder("INBOX", 2),
      hooks: {
        onMessageUpsert() {
          throw new Error("forced post-commit hook failure");
        }
      }
    }).syncAccount(h.account.id, "manual");

    expect(result.messagesUpserted).toBe(0);
    expect(result.metadataRowsCommitted).toBe(2);
    expect(result.metadataWriteBatchesAttempted).toBe(1);
    expect(result.metadataWriteBatchesFailed).toBe(0);
    expect(result.metadataWriteDurationMs).toBeGreaterThan(0);
    expect(result.metadataWriteServiceRowsPerSecond).toBeGreaterThan(0);

    const run = await h.pool.query<{
      messages_upserted: number;
      metadata: Record<string, unknown>;
    }>(
      "SELECT messages_upserted, metadata FROM public.imap_sync_runs WHERE id = $1",
      [result.runId]
    );
    expect(run.rows[0]?.messages_upserted).toBe(0);
    expect(run.rows[0]?.metadata).toMatchObject({
      metadataRowsCommitted: 2,
      metadataWriteBatchesAttempted: 1,
      metadataWriteBatchesFailed: 0
    });
  });

  it("records a real rolled-back metadata batch as time spent with zero committed rows", async () => {
    const h = await setupIntegration("live-metadata-throughput-failure", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const originalWrite = h.repository.upsertMessages.bind(h.repository);
    const write = vi.spyOn(h.repository, "upsertMessages").mockImplementation(async (...args) => {
      args[3][0].attachments = [{
        filename: "invalid.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 10,
        disposition: "invalid" as "attachment",
        contentId: null,
        partNumber: "1"
      }];
      return originalWrite(...args);
    });

    try {
      const result = await h.buildEngine({ folders: oneFolder("INBOX", 2) }).syncAccount(h.account.id, "manual");
      expect(result.metadataRowsCommitted).toBe(0);
      expect(result.metadataWriteBatchesAttempted).toBe(1);
      expect(result.metadataWriteBatchesFailed).toBe(1);
      expect(result.metadataWriteDurationMs).toBeGreaterThan(0);
      expect(result.metadataWriteServiceRowsPerSecond).toBe(0);

      const persisted = await h.pool.query<{ uid: string }>(
        "SELECT uid::text AS uid FROM public.imap_messages WHERE account_id = $1 ORDER BY uid",
        [h.account.id]
      );
      expect(persisted.rows).toEqual([]);
      const folder = await h.pool.query<{ headers_synced_count: number }>(
        "SELECT headers_synced_count FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
        [h.account.id]
      );
      expect(folder.rows[0]?.headers_synced_count).toBe(0);

      const run = await h.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM public.imap_sync_runs WHERE id = $1",
        [result.runId]
      );
      expect(run.rows[0]?.metadata).toMatchObject({
        metadataRowsCommitted: 0,
        metadataWriteBatchesAttempted: 1,
        metadataWriteBatchesFailed: 1,
        metadataWriteServiceRowsPerSecond: 0
      });
    } finally {
      write.mockRestore();
    }
  });

  it("keeps bulk metadata retries, flags, attachments, and counters compatible", async () => {
    const h = await setupIntegration("live-bulk-metadata-semantics", { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    await h.buildEngine({ folders: oneFolder("INBOX", 1) }).syncAccount(h.account.id, "manual");

    const folder = (
      await h.pool.query<ImapFolder>(
        "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
        [h.account.id]
      )
    ).rows[0];
    const existingMessage = (
      await h.pool.query<{ id: string }>(
        "SELECT id FROM public.imap_messages WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = 1",
        [h.account.id]
      )
    ).rows[0];
    if (!folder?.uidvalidity || !existingMessage) throw new Error("missing synced fixture rows");
    await h.pool.query(
      `
      INSERT INTO public.imap_attachments (message_id, filename, part_number, disposition, storage_key)
      VALUES
        ($1, 'old.pdf', '2', 'attachment', 'keep-this-key'),
        ($1, 'keep.pdf', '3', 'attachment', 'also-keep')
      `,
      [existingMessage.id]
    );
    await h.pool.query(
      `
      UPDATE public.imap_messages
      SET deleted_in_provider = true,
          provider_deleted_at = now(),
          deleted_reason = 'PROVIDER_DELETED'
      WHERE id = $1
      `,
      [existingMessage.id]
    );

    const newMessage = messageMetadata(100, {
      flags: ["\\Flagged"],
      attachments: [{
        filename: "new.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        disposition: "attachment",
        contentId: null,
        partNumber: "1"
      }]
    });
    const existingUpdate = messageMetadata(1, {
      flags: ["\\Flagged"],
      headersJson: { "x-bulk-refresh": "yes" },
      mimeStructure: { refreshed: true },
      attachments: [{
        filename: "updated.pdf",
        mimeType: "application/pdf",
        sizeBytes: 200,
        disposition: "attachment",
        contentId: null,
        partNumber: "2"
      }]
    });

    const firstWrite = await h.repository.upsertMessages(
      h.account.id,
      folder,
      Number(folder.uidvalidity),
      [newMessage, existingUpdate],
      new Date("2026-01-01T00:00:00.000Z"),
      { preserveExistingFlags: true }
    );
    expect(firstWrite.map((row) => Number(row.uid))).toEqual([100, 1]);

    const afterFirstWrite = await h.pool.query<{
      uid: string;
      flags: string[];
      headers_json: Record<string, unknown>;
      mime_structure: unknown;
      deleted_in_provider: boolean;
    }>(
      `
      SELECT uid::text AS uid, flags, headers_json, mime_structure, deleted_in_provider
      FROM public.imap_messages
      WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = ANY($2::bigint[])
      ORDER BY uid
      `,
      [h.account.id, [1, 100]]
    );
    expect(afterFirstWrite.rows[0]).toMatchObject({
      uid: "1",
      flags: ["\\Seen"],
      headers_json: { "x-bulk-refresh": "yes" },
      mime_structure: { refreshed: true },
      deleted_in_provider: false
    });
    expect(afterFirstWrite.rows[1]).toMatchObject({ uid: "100", flags: ["\\Flagged"] });

    const attachments = await h.pool.query<{
      uid: string;
      part_number: string;
      filename: string | null;
      storage_key: string | null;
    }>(
      `
      SELECT m.uid::text AS uid, a.part_number, a.filename, a.storage_key
      FROM public.imap_attachments a
      JOIN public.imap_messages m ON m.id = a.message_id
      WHERE m.account_id = $1 AND m.folder_path = 'INBOX'
      ORDER BY m.uid, a.part_number
      `,
      [h.account.id]
    );
    expect(attachments.rows).toEqual([
      { uid: "1", part_number: "2", filename: "updated.pdf", storage_key: "keep-this-key" },
      { uid: "1", part_number: "3", filename: "keep.pdf", storage_key: "also-keep" },
      { uid: "100", part_number: "1", filename: "new.txt", storage_key: null }
    ]);

    await h.repository.upsertMessages(
      h.account.id,
      folder,
      Number(folder.uidvalidity),
      [newMessage, existingUpdate],
      new Date("2026-01-01T00:00:00.000Z")
    );
    const afterRetry = await h.pool.query<{ uid: string; flags: string[] }>(
      `
      SELECT uid::text AS uid, flags
      FROM public.imap_messages
      WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = 1
      `,
      [h.account.id]
    );
    expect(afterRetry.rows[0]).toEqual({ uid: "1", flags: ["\\Flagged"] });
    const folderAfter = await h.pool.query<{ headers_synced_count: number }>(
      "SELECT headers_synced_count FROM public.imap_folders WHERE id = $1",
      [folder.id]
    );
    expect(folderAfter.rows[0]?.headers_synced_count).toBe(2);
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
          next_flag_scan_at = now() - interval '1 second',
          next_reconcile_at = now() - interval '1 second'
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

    const health = await h.pool.query<{
      sync_state: string;
      sync_state_reason: string | null;
      last_reconcile_clean: boolean | null;
    }>(
      `
      SELECT a.sync_state, a.sync_state_reason, f.last_reconcile_clean
      FROM public.imap_accounts a
      JOIN public.imap_folders f ON f.account_id = a.id AND f.path = 'INBOX'
      WHERE a.id = $1
      `,
      [h.account.id]
    );
    expect(health.rows[0]).toEqual({
      sync_state: "HEALTHY",
      sync_state_reason: null,
      last_reconcile_clean: true
    });
  });

  it("finishes healthy when reconcile repairs provider-missing messages", async () => {
    const h = await setupIntegration("live-reconcile-repaired-health", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    const folders = oneFolder("INBOX", 2);
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });
    await engine.syncAccount(h.account.id, "manual");

    // Simulate a normal provider-side move/delete after both messages were
    // mirrored. Reconcile should tombstone the vanished UID and finish clean.
    folders[0].messages = folders[0].messages.filter((message) => message.uid !== 2);
    await h.pool.query(
      `
      UPDATE public.imap_folders
      SET next_sync_due_at = now() - interval '1 second',
          next_reconcile_at = now() - interval '1 second'
      WHERE account_id = $1 AND path = 'INBOX'
      `,
      [h.account.id]
    );

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");
    expect(result.reconcileGapsFound).toBe(1);

    const health = await h.pool.query<{
      sync_state: string;
      sync_state_reason: string | null;
      last_reconcile_clean: boolean | null;
      deleted_in_provider: boolean;
      deleted_reason: string | null;
    }>(
      `
      SELECT
        a.sync_state,
        a.sync_state_reason,
        f.last_reconcile_clean,
        m.deleted_in_provider,
        m.deleted_reason
      FROM public.imap_accounts a
      JOIN public.imap_folders f ON f.account_id = a.id AND f.path = 'INBOX'
      JOIN public.imap_messages m
        ON m.account_id = a.id
       AND m.folder_path = f.path
       AND m.uid = 2
      WHERE a.id = $1
      `,
      [h.account.id]
    );

    expect(health.rows[0]).toEqual({
      sync_state: "HEALTHY",
      sync_state_reason: null,
      last_reconcile_clean: true,
      deleted_in_provider: true,
      deleted_reason: "RECONCILE_MISSING"
    });
  });

  it("reports when missing-in-DB repair exceeds the bounded reconcile batch", async () => {
    const h = await setupIntegration("live-reconcile-missing-db-overflow", {
      INITIAL_SYNC_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    await h.buildEngine({ folders: oneFolder("INBOX", 0) }).syncAccount(h.account.id, "manual");

    const folder = await h.pool.query<ImapFolder>(
      "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
      [h.account.id]
    );
    if (!folder.rows[0]) throw new Error("missing INBOX fixture folder");

    async function* providerUids() {
      for (let uid = 1; uid <= 5_001; uid += 1) yield uid;
    }

    const result = await h.repository.markMissingMessagesFromLiveUidStream(
      h.account.id,
      folder.rows[0],
      Number(folder.rows[0].uidvalidity),
      providerUids()
    );

    expect(result.missingInDbUids).toHaveLength(5_000);
    expect(result.missingInDbTruncated).toBe(true);
  });

  it("schedules an early retry when reconcile repair remains incomplete", async () => {
    const h = await setupIntegration("live-reconcile-early-retry", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      SYNC_INTERVAL_MS: 60_000,
      RECONCILE_INTERVAL_MS: 6 * 60 * 60_000
    });
    activeAccountIds.push(h.account.id);
    await h.buildEngine({ folders: oneFolder("INBOX", 0) }).syncAccount(h.account.id, "manual");

    const folder = await h.pool.query<ImapFolder>(
      "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
      [h.account.id]
    );
    if (!folder.rows[0]) throw new Error("missing INBOX fixture folder");

    await h.repository.markFolderSynced(folder.rows[0].id, {
      uidValidity: Number(folder.rows[0].uidvalidity),
      initialComplete: true,
      reconcileClean: false
    });

    const retry = await h.pool.query<{
      last_reconcile_clean: boolean;
      retries_soon: boolean;
    }>(
      `
      SELECT
        last_reconcile_clean,
        next_reconcile_at <= now() + interval '2 minutes' AS retries_soon
      FROM public.imap_folders
      WHERE id = $1
      `,
      [folder.rows[0].id]
    );
    expect(retry.rows[0]).toEqual({
      last_reconcile_clean: false,
      retries_soon: true
    });
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
