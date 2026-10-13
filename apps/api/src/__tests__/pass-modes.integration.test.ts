import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, getPool, type PgPool } from "../db.js";
import { resetConfigForTests } from "../config.js";
import { InvalidInputError } from "../errors.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import type { MirrorEngine, SyncAccountOptions } from "../sync-engine.js";
import { SYNC_MODES, type SyncMode } from "../types.js";
import {
  buildInboxAndSentFolders,
  folderCountDrift,
  setupIntegration,
  teardownIntegration,
  type IntegrationHarness
} from "./helpers/integration-harness.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const SINGLE_LANE_MODES = SYNC_MODES.filter((mode) => mode !== "full");

interface AccountState {
  sync_state: string;
  sync_state_reason: string | null;
  consecutive_failures: number;
  consecutive_successes: number;
  current_backoff_ms: number;
  backoff_until: Date | null;
  last_sync_finished_at: Date | null;
  last_priority_sync_succeeded_at: Date | null;
  priority_sync_lag_seconds: number | null;
  currently_syncing: boolean;
}

async function accountState(pool: PgPool, accountId: string): Promise<AccountState> {
  return (await pool.query<AccountState>(
    `SELECT sync_state, sync_state_reason, consecutive_failures, consecutive_successes,
            current_backoff_ms, backoff_until, last_sync_finished_at,
            last_priority_sync_succeeded_at, priority_sync_lag_seconds, currently_syncing
     FROM public.imap_accounts WHERE id = $1`,
    [accountId]
  )).rows[0];
}

/**
 * The state a failed pass leaves behind, with its backoff already passed. An
 * old priority anchor would make the next failure a stuck-degraded escalation,
 * so tests of plain failure classification keep it recent.
 */
async function seedEarlierFailure(
  pool: PgPool,
  accountId: string,
  failures = 3,
  { oldPriorityAnchor = true } = {}
): Promise<void> {
  await pool.query(
    `UPDATE public.imap_accounts
     SET sync_state = 'DEGRADED', sync_state_reason = 'EARLIER_FAILURE',
         consecutive_failures = $2, consecutive_successes = 0,
         current_backoff_ms = 4000, backoff_until = now() - interval '1 second',
         last_priority_sync_succeeded_at = CASE WHEN $3 THEN '2026-01-01T00:00:00Z'::timestamptz ELSE now() END,
         last_sync_finished_at = '2026-01-01T00:00:00Z'
     WHERE id = $1`,
    [accountId, failures, oldPriorityAnchor]
  );
}

/** Every folder clean, audited, and synced just now, so health is HEALTHY. */
async function markFoldersClean(pool: PgPool, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE public.imap_folders
     SET status = 'ACTIVE', last_synced_at = now(), last_full_reconcile_at = now(),
         last_reconcile_clean = true
     WHERE account_id = $1 AND tracked = true`,
    [accountId]
  );
}

/** Make every lane's due time pass, so each mode has work to select. */
async function makeEverythingDue(pool: PgPool, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE public.imap_folders
     SET next_sync_due_at = now() - interval '1 second',
         next_flag_scan_at = now() - interval '1 second',
         next_reconcile_at = now() - interval '1 second'
     WHERE account_id = $1`,
    [accountId]
  );
}

async function runCount(pool: PgPool, accountId: string): Promise<number> {
  return Number((await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM public.imap_sync_runs WHERE account_id = $1",
    [accountId]
  )).rows[0].count);
}

integration("sync pass modes (real Postgres + fixture IMAP)", () => {
  const activeAccountIds: string[] = [];

  beforeAll(() => {
    resetConfigForTests();
  });

  afterEach(async () => {
    const pool = getPool();
    let drift: Awaited<ReturnType<typeof folderCountDrift>> = [];
    try {
      drift = await folderCountDrift(pool, activeAccountIds);
    } finally {
      while (activeAccountIds.length > 0) {
        await teardownIntegration(pool, activeAccountIds.pop()!).catch(() => undefined);
      }
    }
    expect(drift).toEqual([]);
  });

  afterAll(async () => {
    await closePool();
  });

  /** An account whose Inbox and Sent finished their first sync in one full pass. */
  async function syncedAccount(suite: string): Promise<{
    h: IntegrationHarness;
    folders: FixtureFolder[];
    engine: MirrorEngine;
  }> {
    const h = await setupIntegration(suite, { INITIAL_SYNC_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({ folders });
    expect((await engine.syncAccount(h.account.id, "manual")).outcome).toBe("success");
    return { h, folders, engine };
  }

  it("records the account state at the end of every mode, and success clears backoff", async () => {
    const { h, engine } = await syncedAccount("modes-finalize");

    for (const mode of SINGLE_LANE_MODES) {
      await seedEarlierFailure(h.pool, h.account.id);
      await makeEverythingDue(h.pool, h.account.id);
      const result = await engine.syncAccount(h.account.id, "scheduled", { mode });

      expect({ mode, outcome: result.outcome, recorded: result.mode }).toEqual({
        mode,
        outcome: "success",
        recorded: mode
      });
      const state = await accountState(h.pool, h.account.id);
      expect({ mode, ...state }).toMatchObject({
        mode,
        consecutive_failures: 0,
        consecutive_successes: 1,
        backoff_until: null,
        currently_syncing: false,
        sync_state_reason: expect.not.stringMatching(/^EARLIER_FAILURE$/)
      });
      // A single-lane pass leaves the full-sync schedule to the host's timer.
      expect(state.last_sync_finished_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(state.last_priority_sync_succeeded_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    }

    // The full pass still moves the full-sync schedule.
    await engine.syncAccount(h.account.id, "manual");
    expect((await accountState(h.pool, h.account.id)).last_sync_finished_at!.getTime())
      .toBeGreaterThan(Date.now() - 60_000);
  });

  it("classifies a failed pass in every mode as a full pass does: auth, transient, or BROKEN", async () => {
    const { h, folders } = await syncedAccount("modes-classify");
    const failingEngine = (error: Error) => h.buildEngine({
      folders,
      clientFactory: async () => {
        throw error;
      }
    });
    const credentialRejected = () => Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      serverResponseCode: "AUTHENTICATIONFAILED"
    });
    const providerUnavailable = () => Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      serverResponseCode: "UNAVAILABLE"
    });

    for (const mode of SINGLE_LANE_MODES) {
      await seedEarlierFailure(h.pool, h.account.id, 0, { oldPriorityAnchor: false });
      await makeEverythingDue(h.pool, h.account.id);
      const transient = await failingEngine(providerUnavailable()).syncAccount(
        h.account.id, "scheduled", { mode }
      );
      expect({ mode, outcome: transient.outcome }).toEqual({ mode, outcome: "failed" });
      const afterTransient = await accountState(h.pool, h.account.id);
      expect({ mode, ...afterTransient }).toMatchObject({
        mode,
        sync_state: "DEGRADED",
        consecutive_failures: 1,
        currently_syncing: false
      });
      expect(afterTransient.backoff_until!.getTime()).toBeGreaterThan(Date.now());
      expect(afterTransient.last_sync_finished_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

      // The tenth consecutive failure breaks the account with a scheduled retry.
      await seedEarlierFailure(h.pool, h.account.id, 9, { oldPriorityAnchor: false });
      await makeEverythingDue(h.pool, h.account.id);
      await failingEngine(providerUnavailable()).syncAccount(h.account.id, "scheduled", { mode });
      const broken = await accountState(h.pool, h.account.id);
      expect({ mode, sync_state: broken.sync_state }).toEqual({ mode, sync_state: "BROKEN" });
      expect(broken.backoff_until).not.toBeNull();

      // A rejected credential is terminal: BROKEN with no scheduled retry.
      await seedEarlierFailure(h.pool, h.account.id, 0, { oldPriorityAnchor: false });
      await makeEverythingDue(h.pool, h.account.id);
      await failingEngine(credentialRejected()).syncAccount(h.account.id, "scheduled", { mode });
      const auth = await accountState(h.pool, h.account.id);
      expect({ mode, ...auth }).toMatchObject({
        mode,
        sync_state: "BROKEN",
        sync_state_reason: expect.stringMatching(/^AUTH_ERROR/),
        backoff_until: null
      });
    }
  });

  it("keeps an unfinished Inbox failure until a pass finishes Inbox", async () => {
    const { h, engine } = await syncedAccount("modes-unfinished-priority");
    await seedEarlierFailure(h.pool, h.account.id, 2);
    // Inbox's last sync started and failed: its status never returned to ACTIVE.
    await h.pool.query(
      `UPDATE public.imap_folders SET status = 'SYNCING', next_sync_due_at = now() + interval '1 hour'
       WHERE account_id = $1 AND path = 'INBOX'`,
      [h.account.id]
    );
    await makeEverythingDueExceptInbox(h.pool, h.account.id);

    const sent = await engine.syncAccount(h.account.id, "scheduled", { mode: "sent" });
    expect(sent.outcome).toBe("success");
    expect(sent.foldersProcessed).toBe(1);
    const afterSent = await accountState(h.pool, h.account.id);
    // A Sent success proves nothing about Inbox, so the failure streak and the
    // priority anchor stay as Inbox's failure left them.
    expect(afterSent.consecutive_failures).toBe(2);
    expect(afterSent.current_backoff_ms).toBe(4000);
    expect(afterSent.last_priority_sync_succeeded_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    const live = await engine.syncAccount(h.account.id, "scheduled", { mode: "live" });
    expect(live.outcome).toBe("success");
    const afterLive = await accountState(h.pool, h.account.id);
    expect(afterLive.consecutive_failures).toBe(0);
    expect(afterLive.backoff_until).toBeNull();
    expect(afterLive.last_priority_sync_succeeded_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("keeps a quiet mailbox healthy when the host proves its folders unchanged", async () => {
    const { h, engine } = await syncedAccount("modes-host-freshness");
    await markFoldersClean(h.pool, h.account.id);
    // No pass touched these folders for an hour.
    await h.pool.query(
      "UPDATE public.imap_folders SET last_synced_at = now() - interval '1 hour' WHERE account_id = $1",
      [h.account.id]
    );

    await engine.syncAccount(h.account.id, "scheduled", { mode: "body" });
    expect(await accountState(h.pool, h.account.id)).toMatchObject({
      sync_state: "DEGRADED",
      sync_state_reason: "PRIORITY_SYNC_LAG"
    });

    const provenAt = new Date(Date.now() - 10_000);
    await engine.syncAccount(h.account.id, "scheduled", {
      mode: "body",
      folderFreshness: new Map([["INBOX", provenAt], ["Sent", provenAt]])
    });
    const fresh = await accountState(h.pool, h.account.id);
    expect(fresh).toMatchObject({ sync_state: "HEALTHY", sync_state_reason: null });
    expect(fresh.priority_sync_lag_seconds).toBeGreaterThanOrEqual(10);
    expect(fresh.priority_sync_lag_seconds).toBeLessThan(60);

    // A folder the host did not vouch for still counts from its last sync.
    await engine.syncAccount(h.account.id, "scheduled", {
      mode: "body",
      folderFreshness: new Map([["INBOX", provenAt]])
    });
    expect(await accountState(h.pool, h.account.id)).toMatchObject({
      sync_state: "DEGRADED",
      sync_state_reason: "PRIORITY_SYNC_LAG"
    });

    // A host clock ahead of the database never reports negative lag.
    const ahead = new Date(Date.now() + 3_600_000);
    await engine.syncAccount(h.account.id, "scheduled", {
      mode: "body",
      folderFreshness: new Map([["INBOX", ahead], ["Sent", ahead]])
    });
    const clamped = await accountState(h.pool, h.account.id);
    expect(clamped.sync_state).toBe("HEALTHY");
    expect(clamped.priority_sync_lag_seconds).toBeGreaterThanOrEqual(0);
  });

  it("first sync takes one newest-first batch per incomplete folder and nothing else", async () => {
    const h = await setupIntegration("modes-first-sync", { INITIAL_SYNC_BATCH_SIZE: 2 });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({ folders });

    const first = await engine.syncAccount(h.account.id, "scheduled", { mode: "first_sync" });
    expect(first.outcome).toBe("success");
    expect(first.foldersProcessed).toBe(2);
    expect(first.bodiesFetched).toBe(0);
    const inbox = await h.pool.query<{ uid: string }>(
      `SELECT uid::text FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'INBOX' ORDER BY uid`,
      [h.account.id]
    );
    expect(inbox.rows.map((row) => row.uid)).toEqual(["104", "105"]);
    expect((await accountState(h.pool, h.account.id)).sync_state).toBe("INITIAL_SYNC");

    for (let pass = 0; pass < 5; pass += 1) {
      await engine.syncAccount(h.account.id, "scheduled", { mode: "first_sync" });
    }
    expect((await accountState(h.pool, h.account.id)).sync_state).not.toBe("INITIAL_SYNC");

    // New mail in a folder whose first sync is complete belongs to the live lane.
    folders[0].messages.push(makeTextMessage({
      uid: 106, subject: "after first sync", from: "a@x.test", to: "u@x.test", body: "new"
    }));
    const idle = await engine.syncAccount(h.account.id, "scheduled", { mode: "first_sync" });
    expect({ folders: idle.foldersProcessed, messages: idle.messagesUpserted, bodies: idle.bodiesFetched })
      .toEqual({ folders: 0, messages: 0, bodies: 0 });
  });

  it("history walks older mail without running the folder or live body lanes", async () => {
    const h = await setupIntegration("modes-history", {
      INITIAL_SYNC_BATCH_SIZE: 50,
      BODY_BACKFILL_BATCH_SIZE: 50
    });
    activeAccountIds.push(h.account.id);
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET body_fetch_policy = 'lazy', historical_backfill_mode = 'metadata_only',
           max_backfill_rate = 'aggressive'
       WHERE id = $1`,
      [h.account.id]
    );
    const old = new Date("2023-01-01T00:00:00Z");
    const folders: FixtureFolder[] = [{
      path: "INBOX", delimiter: "/", specialUse: "\\Inbox", uidValidity: 91_001,
      messages: [
        makeTextMessage({ uid: 1, subject: "old", from: "a@x.test", to: "u@x.test", body: "o", internalDate: old }),
        makeTextMessage({ uid: 2, subject: "recent", from: "a@x.test", to: "u@x.test", body: "r" })
      ]
    }];
    const engine = h.buildEngine({ folders });
    await engine.syncAccount(h.account.id, "scheduled", { mode: "first_sync" });
    folders[0].messages.push(makeTextMessage({
      uid: 3, subject: "new", from: "a@x.test", to: "u@x.test", body: "n"
    }));

    const history = await engine.syncAccount(h.account.id, "scheduled", { mode: "history" });
    expect(history.outcome).toBe("success");
    expect(history.foldersProcessed).toBe(0);
    const mirrored = await h.pool.query<{ uid: string }>(
      "SELECT uid::text FROM public.imap_messages WHERE account_id = $1 ORDER BY uid",
      [h.account.id]
    );
    // UID 1 is history; UID 3 is new mail, which waits for the live lane.
    expect(mirrored.rows.map((row) => row.uid)).toEqual(["1", "2"]);
  });

  it("flag scan updates due folders' flags without auditing, and skips login when nothing is due", async () => {
    const { h, folders } = await syncedAccount("modes-flag-scan");
    const inbox = folders[0];
    inbox.messages.find((message) => message.uid === 101)!.flags = ["\\Seen"];
    inbox.messages = inbox.messages.filter((message) => message.uid !== 105);
    await h.pool.query(
      `UPDATE public.imap_folders
       SET next_flag_scan_at = CASE WHEN path = 'INBOX' THEN now() - interval '1 second'
                                    ELSE now() + interval '1 hour' END,
           next_reconcile_at = now() + interval '1 hour', last_full_reconcile_at = now()
       WHERE account_id = $1`,
      [h.account.id]
    );
    const factory = vi.fn(async () => new FixtureImapClient(folders));
    const engine = h.buildEngine({ folders, clientFactory: factory });

    const scan = await engine.syncAccount(h.account.id, "scheduled", { mode: "flag_scan" });
    expect(scan.outcome).toBe("success");
    expect(scan.foldersProcessed).toBe(1);
    expect(scan.flagsUpdated).toBe(1);
    expect(scan.reconcileFoldersAttempted).toBe(0);
    const rows = await h.pool.query<{ uid: string; flags: string[]; deleted_in_provider: boolean }>(
      `SELECT uid::text, flags, deleted_in_provider FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'INBOX' AND uid IN (101, 105) ORDER BY uid`,
      [h.account.id]
    );
    expect(rows.rows).toEqual([
      { uid: "101", flags: ["\\Seen"], deleted_in_provider: false },
      { uid: "105", flags: [], deleted_in_provider: false }
    ]);

    factory.mockClear();
    const runsBefore = await runCount(h.pool, h.account.id);
    const idle = await engine.syncAccount(h.account.id, "scheduled", { mode: "flag_scan" });
    expect(idle.foldersProcessed).toBe(0);
    expect(factory).not.toHaveBeenCalled();
    expect(await runCount(h.pool, h.account.id)).toBe(runsBefore + 1);
  });

  it("audit reconciles due folders only", async () => {
    const { h, folders, engine } = await syncedAccount("modes-audit");
    folders[0].messages = folders[0].messages.filter((message) => message.uid !== 105);
    folders[1].messages = [];
    await h.pool.query(
      `UPDATE public.imap_folders
       SET next_reconcile_at = CASE WHEN path = 'INBOX' THEN now() - interval '1 second'
                                    ELSE now() + interval '1 hour' END,
           last_full_reconcile_at = now() - interval '7 hours'
       WHERE account_id = $1`,
      [h.account.id]
    );

    const audit = await engine.syncAccount(h.account.id, "scheduled", { mode: "audit" });
    expect(audit.outcome).toBe("success");
    expect(audit.reconcileFoldersAttempted).toBe(1);
    const rows = await h.pool.query<{ folder_path: string; uid: string; deleted_reason: string | null }>(
      `SELECT folder_path, uid::text, deleted_reason FROM public.imap_messages
       WHERE account_id = $1 AND uid IN (105, 201) ORDER BY uid`,
      [h.account.id]
    );
    expect(rows.rows).toEqual([
      { folder_path: "INBOX", uid: "105", deleted_reason: "RECONCILE_MISSING" },
      // Sent's audit is not due, so its provider-deleted message waits.
      { folder_path: "Sent", uid: "201", deleted_reason: null }
    ]);
  });

  it("closes orphaned runs under the lock without a run or an account-state change", async () => {
    const { h, engine } = await syncedAccount("modes-cleanup");
    const orphan = await h.pool.query<{ id: string }>(
      `INSERT INTO public.imap_sync_runs (account_id, trigger_type, started_at)
       VALUES ($1, 'scheduled', now() - interval '5 minutes') RETURNING id`,
      [h.account.id]
    );
    const fresh = await h.pool.query<{ id: string }>(
      "INSERT INTO public.imap_sync_runs (account_id, trigger_type) VALUES ($1, 'scheduled') RETURNING id",
      [h.account.id]
    );
    const runsBefore = await runCount(h.pool, h.account.id);
    const stateBefore = await accountState(h.pool, h.account.id);
    const account = await h.repository.getAccount(h.account.id);

    const holder = await h.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [account!.lock_id]);
      await expect(engine.closeOrphanedSyncRuns(h.account.id)).resolves.toBeNull();
      await holder.query("SELECT pg_advisory_unlock($1::bigint)", [account!.lock_id]);
    } finally {
      holder.release();
    }

    await expect(engine.closeOrphanedSyncRuns(h.account.id)).resolves.toBe(1);
    const runs = await h.pool.query<{ id: string; status: string; error: string | null }>(
      "SELECT id, status, error FROM public.imap_sync_runs WHERE id = ANY($1::uuid[]) ORDER BY started_at",
      [[orphan.rows[0].id, fresh.rows[0].id]]
    );
    expect(runs.rows).toEqual([
      { id: orphan.rows[0].id, status: "failed", error: "WORKER_REAPED" },
      // A run opened under a minute ago may still be waiting for the lock.
      { id: fresh.rows[0].id, status: "running", error: null }
    ]);
    expect(await runCount(h.pool, h.account.id)).toBe(runsBefore);
    expect(await accountState(h.pool, h.account.id)).toEqual(stateBefore);
  });

  it("rejects options the chosen mode does not run before recording a run", async () => {
    const { h, engine } = await syncedAccount("modes-validate");
    const runsBefore = await runCount(h.pool, h.account.id);
    const invalid: SyncAccountOptions[] = [
      { mode: "body", forceFolderDiscovery: true },
      { mode: "full", forceInboxReconcile: true },
      { mode: "audit", forceReconcileFolders: ["INBOX"] },
      { mode: "live", forceReconcileFolders: ["INBOX", "Sent", "Archive"] },
      { mode: "live", forceReconcileFolders: [""] },
      { mode: "nonsense" as SyncMode },
      { mode: "body", folderFreshness: new Map([["INBOX", new Date(Number.NaN)]]) },
      { mode: "body", folderFreshness: { INBOX: new Date() } as unknown as Map<string, Date> }
    ];
    for (const options of invalid) {
      await expect(engine.syncAccount(h.account.id, "scheduled", options))
        .rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(await runCount(h.pool, h.account.id)).toBe(runsBefore);
  });
});

async function makeEverythingDueExceptInbox(pool: PgPool, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE public.imap_folders
     SET next_sync_due_at = now() - interval '1 second'
     WHERE account_id = $1 AND path <> 'INBOX'`,
    [accountId]
  );
}
