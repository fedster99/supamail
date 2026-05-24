/**
 * End-to-end conformance for the Tier-1 spec fixes in
 * `apps/sync/docs/rackspace-email-sync-engine-spec.md` (the Signal sync engine
 * spec the SupaMail extraction inherited). Each scenario manipulates real
 * state in Postgres, runs MirrorEngine.syncAccount, and asserts on the
 * resulting rows. No source-string grep tests here.
 *
 * Usage: DATABASE_URL=… IMAP_ENCRYPTION_KEY=… IMAP_ALLOW_PRIVATE_HOSTS=true \
 *        pnpm tsx scripts/spec-conformance.ts
 */
import { getConfig } from "../src/config.js";
import { applyPublicMigrations, closePool, getPool } from "../src/db.js";
import { MirrorRepository } from "../src/repository.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../src/smoke/fixture-imap.js";
import { MirrorEngine } from "../src/sync-engine.js";
import type { MirrorImapClient } from "../src/imap-client.js";

interface ScenarioResult {
  name: string;
  passed: boolean;
  reason?: string;
  evidence?: Record<string, unknown>;
}

const results: ScenarioResult[] = [];

function record(
  name: string,
  passed: boolean,
  reason?: string,
  evidence?: Record<string, unknown>
): void {
  results.push({ name, passed, reason, evidence });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${reason ? ` — ${reason}` : ""}`);
}

function assert(cond: boolean, name: string, reason: string, evidence?: Record<string, unknown>): void {
  record(name, cond, cond ? undefined : reason, cond ? undefined : evidence);
}

function makeFolders(): FixtureFolder[] {
  return [
    {
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 11_001,
      messages: [
        makeTextMessage({ uid: 101, subject: "msg-101", from: "a@x.test", to: "u@x.test", body: "a" }),
        makeTextMessage({ uid: 102, subject: "msg-102", from: "b@x.test", to: "u@x.test", body: "b" }),
        makeTextMessage({ uid: 103, subject: "msg-103", from: "c@x.test", to: "u@x.test", body: "c" }),
        makeTextMessage({ uid: 104, subject: "msg-104", from: "d@x.test", to: "u@x.test", body: "d" }),
        makeTextMessage({ uid: 105, subject: "msg-105", from: "e@x.test", to: "u@x.test", body: "e" })
      ]
    },
    {
      path: "Sent",
      delimiter: "/",
      specialUse: "\\Sent",
      uidValidity: 22_002,
      messages: [
        makeTextMessage({ uid: 201, subject: "sent-201", from: "u@x.test", to: "a@x.test", body: "x" })
      ]
    }
  ];
}

async function setup(suite: string) {
  const pool = getPool();
  await applyPublicMigrations(pool);
  const config = {
    ...getConfig(),
    BODY_FETCH_POLICY: "lazy" as const,
    BODY_BACKFILL_BATCH_SIZE: 5,
    INITIAL_SYNC_BATCH_SIZE: 2,
    INCREMENTAL_SYNC_BATCH_SIZE: 5,
    IMAP_ALLOW_PRIVATE_HOSTS: true
  };
  const email = `spec-conformance-${suite}-${Date.now()}@example.test`;
  const repository = new MirrorRepository(pool, config);
  const account = await repository.createAccount({
    emailAddress: email,
    host: "fake.imap.local",
    port: 993,
    secure: true,
    username: email,
    password: "not-used",
    providerProfile: "generic-imap",
    bodyFetchPolicy: "lazy"
  });
  return { pool, config, repository, account, email };
}

async function teardown(pool: Awaited<ReturnType<typeof setup>>["pool"], accountId: string) {
  await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
}

async function dueAllFolders(pool: Awaited<ReturnType<typeof setup>>["pool"], accountId: string) {
  await pool.query(
    `UPDATE public.imap_folders
     SET next_sync_due_at = now() - interval '1 second'
     WHERE account_id = $1`,
    [accountId]
  );
}

async function scenarioInitialSyncWatermark() {
  console.log("\nScenario A: snapshot + watermark-resumable initial sync (spec §10.4)");
  const { pool, config, repository, account } = await setup("watermark");
  try {
    const folders = makeFolders(); // INBOX has 5 messages, batch size = 2
    const engine = new MirrorEngine({
      pool,
      config,
      repository,
      clientFactory: async () => new FixtureImapClient(folders)
    });

    // Cycle 1: snapshot taken, batch of 2 processed (UIDs 104, 105 — newest-first).
    const cycle1 = await engine.syncAccount(account.id, "manual");
    const folderAfter1 = (
      await pool.query<{
        initial_sync_complete: boolean;
        initial_sync_target_max_uid: string | null;
        initial_sync_oldest_uid_synced: string | null;
      }>(
        `SELECT initial_sync_complete, initial_sync_target_max_uid, initial_sync_oldest_uid_synced
         FROM public.imap_folders WHERE account_id=$1 AND path='INBOX'`,
        [account.id]
      )
    ).rows[0];
    assert(
      cycle1.outcome === "success",
      "cycle 1 succeeds",
      `outcome=${cycle1.outcome} errors=${cycle1.errors.join("|")}`
    );
    assert(
      Number(folderAfter1.initial_sync_target_max_uid) === 105,
      "cycle 1: snapshot recorded targetMaxUid=105",
      `target=${folderAfter1.initial_sync_target_max_uid}`
    );
    assert(
      Number(folderAfter1.initial_sync_oldest_uid_synced) === 104,
      "cycle 1: watermark advanced to 104 (took newest batch [104,105])",
      `oldest=${folderAfter1.initial_sync_oldest_uid_synced}`
    );
    assert(
      folderAfter1.initial_sync_complete === false,
      "cycle 1: INBOX still in initial sync (3 of 5 remain)",
      `complete=${folderAfter1.initial_sync_complete}`
    );

    // Cycle 2: should pick up UIDs 102, 103 next. Force due.
    await dueAllFolders(pool, account.id);
    const cycle2 = await engine.syncAccount(account.id, "manual");
    const folderAfter2 = (
      await pool.query<{
        initial_sync_complete: boolean;
        initial_sync_oldest_uid_synced: string | null;
      }>(
        `SELECT initial_sync_complete, initial_sync_oldest_uid_synced
         FROM public.imap_folders WHERE account_id=$1 AND path='INBOX'`,
        [account.id]
      )
    ).rows[0];
    assert(cycle2.outcome === "success", "cycle 2 succeeds", cycle2.errors.join("|"));
    assert(
      Number(folderAfter2.initial_sync_oldest_uid_synced) === 102,
      "cycle 2: watermark advanced to 102",
      `oldest=${folderAfter2.initial_sync_oldest_uid_synced}`
    );
    assert(
      folderAfter2.initial_sync_complete === false,
      "cycle 2: INBOX still not complete (1 of 5 remains)",
      `complete=${folderAfter2.initial_sync_complete}`
    );

    // Cycle 3: picks up UID 101 (last one), marks complete.
    await dueAllFolders(pool, account.id);
    const cycle3 = await engine.syncAccount(account.id, "manual");
    const folderAfter3 = (
      await pool.query<{
        initial_sync_complete: boolean;
        last_uid: string | null;
        initial_sync_oldest_uid_synced: string | null;
      }>(
        `SELECT initial_sync_complete, last_uid, initial_sync_oldest_uid_synced
         FROM public.imap_folders WHERE account_id=$1 AND path='INBOX'`,
        [account.id]
      )
    ).rows[0];
    assert(cycle3.outcome === "success", "cycle 3 succeeds", cycle3.errors.join("|"));
    assert(
      folderAfter3.initial_sync_complete === true,
      "cycle 3: INBOX initial sync complete",
      `complete=${folderAfter3.initial_sync_complete}`
    );
    assert(
      Number(folderAfter3.last_uid) === 105,
      "cycle 3: last_uid = targetMaxUid = 105",
      `last_uid=${folderAfter3.last_uid}`
    );

    // All 5 messages mirrored.
    const msgCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.imap_messages WHERE account_id=$1 AND folder_path='INBOX'`,
      [account.id]
    );
    assert(
      Number(msgCount.rows[0].count) === 5,
      "all 5 INBOX messages mirrored across 3 cycles",
      `count=${msgCount.rows[0].count}`
    );
  } finally {
    await teardown(pool, account.id);
  }
}

async function scenarioReconcileBackfill() {
  console.log("\nScenario B: reconcile backfills missing-in-DB UIDs (spec §10.7 step 3)");
  const { pool, config, repository, account } = await setup("backfill");
  try {
    // Use a small fixture so initial sync finishes in one cycle.
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
    const engine = new MirrorEngine({
      pool,
      config: { ...config, INITIAL_SYNC_BATCH_SIZE: 50 }, // do initial sync in one shot
      repository,
      clientFactory: async () => new FixtureImapClient(folders)
    });

    await engine.syncAccount(account.id, "manual");
    // Initial sync complete; both 101, 102 mirrored.

    // Now simulate a gap: delete UID 102's row from the DB (server still has it).
    // This mimics a transient sync failure that dropped a UID — reconcile must heal.
    await pool.query(
      `DELETE FROM public.imap_messages WHERE account_id=$1 AND folder_path='INBOX' AND uid=102`,
      [account.id]
    );

    // Also add a NEW UID 103 to the fixture: provider got a new message but
    // it falls BELOW the lastUid-cursor edge (simulating a UID resurrection).
    // This is the same code path — reconcile sees 103 on server, not in DB.
    folders[0].messages.push(
      makeTextMessage({ uid: 103, subject: "c", from: "c@x.test", to: "u@x.test", body: "c" })
    );

    // Force the folder due so reconcile runs.
    await dueAllFolders(pool, account.id);
    const cycle2 = await engine.syncAccount(account.id, "manual");

    assert(
      cycle2.outcome === "success",
      "reconcile cycle succeeds",
      cycle2.errors.join("|")
    );

    // Sanity: reconcileGapsFound should reflect missing-in-DB UIDs.
    // 102 (deleted from DB), 103 (new on server beyond lastUid range) — depends
    // on whether incremental picks up 103 first. lastUid was set to 102, so
    // incremental SEARCH(uid 103:*) will pick up 103. Then reconcile finds 102.
    const final = await pool.query<{ uid: string }>(
      `SELECT uid::text AS uid FROM public.imap_messages
       WHERE account_id=$1 AND folder_path='INBOX' AND deleted_in_provider=false
       ORDER BY uid`,
      [account.id]
    );
    const uids = final.rows.map((r) => Number(r.uid));
    assert(
      uids.includes(101) && uids.includes(102) && uids.includes(103),
      "all three UIDs present after backfill",
      `uids=${JSON.stringify(uids)}`
    );

    // Confirm a RECONCILE_BACKFILL event was logged (the gap was healed via reconcile, not incremental).
    const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM public.imap_sync_events
       WHERE account_id=$1 AND event_type='RECONCILE_BACKFILL'
       ORDER BY occurred_at DESC LIMIT 1`,
      [account.id]
    );
    assert(
      events.rows.length === 1,
      "RECONCILE_BACKFILL event emitted",
      `count=${events.rows.length}`
    );
    if (events.rows.length === 1) {
      assert(
        Number(events.rows[0].payload.backfilled) >= 1,
        `RECONCILE_BACKFILL.backfilled >= 1 (got ${events.rows[0].payload.backfilled})`,
        JSON.stringify(events.rows[0].payload)
      );
    }
  } finally {
    await teardown(pool, account.id);
  }
}

async function scenarioAuthError() {
  console.log("\nScenario C: AUTH_ERROR short-circuits to BROKEN (spec §13.1)");
  const { pool, config, repository, account } = await setup("auth");
  try {
    const engine = new MirrorEngine({
      pool,
      config,
      repository,
      clientFactory: async () => {
        throw new Error("Authentication failed: invalid credentials");
      }
    });
    const result = await engine.syncAccount(account.id, "manual");
    assert(result.outcome === "failed", "sync outcome=failed", `outcome=${result.outcome}`);

    const row = (
      await pool.query<{ sync_state: string; sync_state_reason: string; current_backoff_ms: number; backoff_until: Date | null }>(
        `SELECT sync_state, sync_state_reason, current_backoff_ms, backoff_until
         FROM public.imap_accounts WHERE id=$1`,
        [account.id]
      )
    ).rows[0];
    assert(row.sync_state === "BROKEN", "account immediately BROKEN", `sync_state=${row.sync_state}`);
    assert(
      /^AUTH_ERROR:/.test(row.sync_state_reason),
      "sync_state_reason starts with AUTH_ERROR:",
      `reason=${row.sync_state_reason}`
    );
    assert(row.current_backoff_ms === 0, "no backoff applied (auth is non-retryable)", `backoff=${row.current_backoff_ms}`);
    assert(row.backoff_until === null, "backoff_until cleared", `until=${row.backoff_until}`);
  } finally {
    await teardown(pool, account.id);
  }
}

async function scenarioUidValidityCap() {
  console.log("\nScenario D: UIDVALIDITY reset cap → BROKEN after >2 in 24h (spec §11)");
  const { pool, config, repository, account } = await setup("uidvalidity");
  try {
    // Initial sync with uidvalidity=100.
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 100,
        messages: [makeTextMessage({ uid: 1, subject: "x", from: "a@x.test", to: "u@x.test", body: "x" })]
      }
    ];
    const engine = new MirrorEngine({
      pool,
      config: { ...config, INITIAL_SYNC_BATCH_SIZE: 50 },
      repository,
      clientFactory: async () => new FixtureImapClient(folders)
    });
    await engine.syncAccount(account.id, "manual");

    // Reset #1: uidvalidity bumps to 200. Should NOT mark BROKEN (count = 1).
    folders[0].uidValidity = 200;
    await dueAllFolders(pool, account.id);
    await engine.syncAccount(account.id, "manual");
    let row = (
      await pool.query<{ sync_state: string; sync_state_reason: string | null; uidvalidity_reset_count: number }>(
        `SELECT a.sync_state, a.sync_state_reason, f.uidvalidity_reset_count
         FROM public.imap_accounts a JOIN public.imap_folders f ON f.account_id=a.id
         WHERE a.id=$1 AND f.path='INBOX'`,
        [account.id]
      )
    ).rows[0];
    assert(row.uidvalidity_reset_count === 1, "reset #1: count=1", `count=${row.uidvalidity_reset_count}`);
    assert(row.sync_state !== "BROKEN", "reset #1: account NOT BROKEN", `state=${row.sync_state}`);

    // Reset #2: uidvalidity to 300. Still under cap (count = 2 = MAX, not > MAX).
    folders[0].uidValidity = 300;
    await dueAllFolders(pool, account.id);
    await engine.syncAccount(account.id, "manual");
    row = (
      await pool.query<{ sync_state: string; sync_state_reason: string | null; uidvalidity_reset_count: number }>(
        `SELECT a.sync_state, a.sync_state_reason, f.uidvalidity_reset_count
         FROM public.imap_accounts a JOIN public.imap_folders f ON f.account_id=a.id
         WHERE a.id=$1 AND f.path='INBOX'`,
        [account.id]
      )
    ).rows[0];
    assert(row.uidvalidity_reset_count === 2, "reset #2: count=2", `count=${row.uidvalidity_reset_count}`);
    assert(row.sync_state !== "BROKEN", "reset #2: still NOT BROKEN at cap", `state=${row.sync_state}`);

    // Reset #3: uidvalidity to 400. Exceeds cap → BROKEN.
    folders[0].uidValidity = 400;
    await dueAllFolders(pool, account.id);
    await engine.syncAccount(account.id, "manual");
    row = (
      await pool.query<{ sync_state: string; sync_state_reason: string; uidvalidity_reset_count: number }>(
        `SELECT a.sync_state, a.sync_state_reason, f.uidvalidity_reset_count
         FROM public.imap_accounts a JOIN public.imap_folders f ON f.account_id=a.id
         WHERE a.id=$1 AND f.path='INBOX'`,
        [account.id]
      )
    ).rows[0];
    assert(
      row.uidvalidity_reset_count === 3,
      "reset #3: count=3 (over cap of 2)",
      `count=${row.uidvalidity_reset_count}`
    );
    assert(
      row.sync_state === "BROKEN",
      "reset #3: account marked BROKEN",
      `state=${row.sync_state}`
    );
    assert(
      /UIDVALIDITY_RESET_LIMIT_EXCEEDED/.test(row.sync_state_reason ?? ""),
      "reason mentions UIDVALIDITY_RESET_LIMIT_EXCEEDED",
      `reason=${row.sync_state_reason}`
    );

    // Now back-date the last reset to >24h ago and try one more reset.
    // Count should reset to 1 (not blow past cap again).
    await pool.query(
      `UPDATE public.imap_folders SET last_uidvalidity_reset_at = now() - interval '25 hours'
       WHERE account_id=$1 AND path='INBOX'`,
      [account.id]
    );
    // Unbreak the account so syncFolder is reachable again.
    await pool.query(
      `UPDATE public.imap_accounts SET sync_state='HEALTHY', sync_state_reason=NULL WHERE id=$1`,
      [account.id]
    );
    folders[0].uidValidity = 500;
    await dueAllFolders(pool, account.id);
    await engine.syncAccount(account.id, "manual");
    row = (
      await pool.query<{ sync_state: string; sync_state_reason: string | null; uidvalidity_reset_count: number }>(
        `SELECT a.sync_state, a.sync_state_reason, f.uidvalidity_reset_count
         FROM public.imap_accounts a JOIN public.imap_folders f ON f.account_id=a.id
         WHERE a.id=$1 AND f.path='INBOX'`,
        [account.id]
      )
    ).rows[0];
    assert(
      row.uidvalidity_reset_count === 1,
      "reset after 24h gap: count reset to 1",
      `count=${row.uidvalidity_reset_count}`
    );
  } finally {
    await teardown(pool, account.id);
  }
}

async function scenarioFolderMissingGrace() {
  console.log("\nScenario E: folder-missing 7-day grace (spec §10.2)");
  const { pool, config, repository, account } = await setup("missing");
  try {
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
    const engine = new MirrorEngine({
      pool,
      config: { ...config, INITIAL_SYNC_BATCH_SIZE: 50 },
      repository,
      clientFactory: async () => new FixtureImapClient(folders)
    });
    await engine.syncAccount(account.id, "manual");
    // Both folders tracked.

    // Provider stops listing Project-Alpha (simulating a flaky LIST response).
    const onlyInbox = [folders[0]];
    let clientFactoryCallCount = 0;
    const engineMissing = new MirrorEngine({
      pool,
      config: { ...config, INITIAL_SYNC_BATCH_SIZE: 50 },
      repository,
      clientFactory: async () => {
        clientFactoryCallCount++;
        return new FixtureImapClient(onlyInbox);
      }
    });

    // First sync after the disappearance — within grace.
    // We need to force folder discovery to run. The engine runs discovery if
    // next_folder_discovery_at is null or in the past.
    await pool.query(
      `UPDATE public.imap_accounts SET next_folder_discovery_at = now() - interval '1 second' WHERE id=$1`,
      [account.id]
    );
    await dueAllFolders(pool, account.id);
    await engineMissing.syncAccount(account.id, "manual");

    let row = (
      await pool.query<{ status: string; tracked: boolean; missing_since: Date | null }>(
        `SELECT status, tracked, missing_since FROM public.imap_folders
         WHERE account_id=$1 AND path='Project-Alpha'`,
        [account.id]
      )
    ).rows[0];
    assert(
      row.missing_since !== null,
      "within grace: missing_since stamped",
      `missing_since=${row.missing_since}`
    );
    assert(
      row.status !== "MISSING",
      "within grace: status NOT MISSING",
      `status=${row.status}`
    );
    assert(
      row.tracked === true,
      "within grace: folder still tracked",
      `tracked=${row.tracked}`
    );

    // Back-date missing_since to 8 days ago (past 7-day grace).
    await pool.query(
      `UPDATE public.imap_folders SET missing_since = now() - interval '8 days'
       WHERE account_id=$1 AND path='Project-Alpha'`,
      [account.id]
    );
    await pool.query(
      `UPDATE public.imap_accounts SET next_folder_discovery_at = now() - interval '1 second' WHERE id=$1`,
      [account.id]
    );
    await dueAllFolders(pool, account.id);
    await engineMissing.syncAccount(account.id, "manual");

    row = (
      await pool.query<{ status: string; tracked: boolean; missing_since: Date | null }>(
        `SELECT status, tracked, missing_since FROM public.imap_folders
         WHERE account_id=$1 AND path='Project-Alpha'`,
        [account.id]
      )
    ).rows[0];
    assert(
      row.status === "MISSING",
      "past grace: status flipped to MISSING",
      `status=${row.status}`
    );
    assert(
      row.tracked === false,
      "past grace: folder untracked",
      `tracked=${row.tracked}`
    );
  } finally {
    await teardown(pool, account.id);
  }
}

async function scenarioPartialCounterRule() {
  console.log("\nScenario F: PARTIAL_SUCCESS counts as success (spec §12.2)");
  const { pool, config, repository, account } = await setup("partial");
  try {
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

    // First, successful sync to set baseline counters.
    const okEngine = new MirrorEngine({
      pool,
      config: { ...config, INITIAL_SYNC_BATCH_SIZE: 50 },
      repository,
      clientFactory: async () => new FixtureImapClient(folders)
    });
    await okEngine.syncAccount(account.id, "manual");

    const beforeRow = (
      await pool.query<{ consecutive_successes: number; consecutive_failures: number; sync_state: string }>(
        `SELECT consecutive_successes, consecutive_failures, sync_state FROM public.imap_accounts WHERE id=$1`,
        [account.id]
      )
    ).rows[0];

    // Now build a client that succeeds on INBOX but throws on Project-Bravo.
    class FlakyClient extends FixtureImapClient {
      async getMailboxLock(path: string) {
        if (path === "Project-Bravo") {
          throw new Error("Mailbox temporarily unavailable (provider error)");
        }
        return super.getMailboxLock(path);
      }
    }
    const flakyEngine = new MirrorEngine({
      pool,
      config: { ...config, INITIAL_SYNC_BATCH_SIZE: 50 },
      repository,
      clientFactory: async () => new FlakyClient(folders) as unknown as MirrorImapClient
    });
    await dueAllFolders(pool, account.id);
    const partial = await flakyEngine.syncAccount(account.id, "manual");

    assert(
      partial.outcome === "partial_success",
      "outcome=partial_success",
      `outcome=${partial.outcome} errors=${partial.errors.join("|")}`
    );

    const afterRow = (
      await pool.query<{ consecutive_successes: number; consecutive_failures: number; sync_state: string }>(
        `SELECT consecutive_successes, consecutive_failures, sync_state FROM public.imap_accounts WHERE id=$1`,
        [account.id]
      )
    ).rows[0];

    assert(
      afterRow.consecutive_successes === beforeRow.consecutive_successes + 1,
      "PARTIAL bumps consecutive_successes (spec §12.2)",
      `before=${beforeRow.consecutive_successes} after=${afterRow.consecutive_successes}`
    );
    assert(
      afterRow.consecutive_failures === 0,
      "PARTIAL resets consecutive_failures",
      `failures=${afterRow.consecutive_failures}`
    );
    assert(
      afterRow.sync_state === "DEGRADED",
      "PARTIAL leaves account DEGRADED (spec §12.2)",
      `state=${afterRow.sync_state}`
    );
  } finally {
    await teardown(pool, account.id);
  }
}

async function scenarioInitialSyncStallTimeout() {
  console.log("\nScenario H: initial-sync stall timeout preserves the initial-sync watermark");
  const { pool, config, repository, account } = await setup("initial-timeout");
  try {
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

    const stallingEngine = new MirrorEngine({
      pool,
      config: {
        ...config,
        INITIAL_SYNC_BATCH_SIZE: 2,
        INITIAL_SYNC_BATCH_TIMEOUT_MS: 100,
        MAX_LOCK_HOLD_MS: 600_000
      },
      repository,
      clientFactory: async () => new StallingInitialFetchClient(folders) as unknown as MirrorImapClient
    });
    const timedOut = await stallingEngine.syncAccount(account.id, "manual");

    assert(
      timedOut.outcome === "failed",
      "timeout cycle fails transiently",
      `outcome=${timedOut.outcome} errors=${timedOut.errors.join("|")}`
    );
    assert(
      timedOut.errors.some((error) => error.includes("INITIAL_SYNC_BATCH_TIMEOUT_MS exceeded during initial sync FETCH")),
      "timeout reason names INITIAL_SYNC_BATCH_TIMEOUT_MS",
      timedOut.errors.join("|")
    );
    assert(closeCalls > 0, "timeout aborts IMAP client", `closeCalls=${closeCalls}`);

    const afterTimeout = (
      await pool.query<{
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
        [account.id]
      )
    ).rows[0];
    assert(afterTimeout.sync_state === "DEGRADED", "timeout marks account DEGRADED", `state=${afterTimeout.sync_state}`);
    assert(afterTimeout.initial_sync_complete === false, "initial sync remains incomplete", `complete=${afterTimeout.initial_sync_complete}`);
    assert(
      Number(afterTimeout.initial_sync_target_max_uid) === 3,
      "snapshot target is retained",
      `target=${afterTimeout.initial_sync_target_max_uid}`
    );
    assert(
      Number(afterTimeout.initial_sync_oldest_uid_synced) === 4,
      "watermark remains at snapshot sentinel",
      `oldest=${afterTimeout.initial_sync_oldest_uid_synced}`
    );
    assert(Number(afterTimeout.message_count) === 0, "no message rows written for timed-out batch", `count=${afterTimeout.message_count}`);

    await dueAllFolders(pool, account.id);
    const retryEngine = new MirrorEngine({
      pool,
      config: { ...config, INITIAL_SYNC_BATCH_SIZE: 2, INITIAL_SYNC_BATCH_TIMEOUT_MS: 600_000 },
      repository,
      clientFactory: async () => new FixtureImapClient(folders)
    });
    const retry = await retryEngine.syncAccount(account.id, "manual");
    const retryRows = (
      await pool.query<{ initial_sync_complete: boolean; initial_sync_oldest_uid_synced: string | null; uid: string }>(
        `
        SELECT f.initial_sync_complete, f.initial_sync_oldest_uid_synced, m.uid::text AS uid
        FROM public.imap_folders f
        JOIN public.imap_messages m ON m.account_id = f.account_id AND m.folder_path = f.path
        WHERE f.account_id = $1 AND f.path = 'INBOX'
        ORDER BY m.uid
        `,
        [account.id]
      )
    ).rows;
    assert(retry.outcome === "success", "retry cycle succeeds", `outcome=${retry.outcome} errors=${retry.errors.join("|")}`);
    assert(
      retryRows.map((row) => Number(row.uid)).join(",") === "2,3",
      "retry resumes from the unchanged watermark",
      `uids=${retryRows.map((row) => row.uid).join(",")}`
    );
    assert(
      Number(retryRows[0]?.initial_sync_oldest_uid_synced) === 2,
      "retry advances watermark only after successful fetch",
      `oldest=${retryRows[0]?.initial_sync_oldest_uid_synced}`
    );
  } finally {
    await teardown(pool, account.id);
  }
}

async function scenarioStuckDegradedEscalation() {
  console.log("\nScenario I: stuck DEGRADED escalates to retryable BROKEN, then terminal BROKEN");
  const { pool, config, repository, account } = await setup("stuck-degraded");
  try {
    await pool.query(
      `
      UPDATE public.imap_accounts
      SET sync_state = 'DEGRADED',
          sync_state_reason = 'PRIORITY_SYNC_LAG',
          last_priority_sync_succeeded_at = now() - interval '25 hours',
          consecutive_failures = 4,
          current_backoff_ms = 1234,
          backoff_until = NULL
      WHERE id = $1
      `,
      [account.id]
    );

    const failingEngine = new MirrorEngine({
      pool,
      config,
      repository,
      clientFactory: async () => {
        throw new Error("provider temporarily unavailable");
      }
    });
    const escalated = await failingEngine.syncAccount(account.id, "manual");
    const retryable = (
      await pool.query<{
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
        [account.id]
      )
    ).rows[0];
    assert(escalated.outcome === "failed", "stuck-degraded failure is transiently failed", `outcome=${escalated.outcome}`);
    assert(retryable.sync_state === "BROKEN", "25h stuck DEGRADED becomes BROKEN", `state=${retryable.sync_state}`);
    assert(
      retryable.sync_state_reason === "STUCK_DEGRADED_24H",
      "retryable reason is STUCK_DEGRADED_24H",
      `reason=${retryable.sync_state_reason}`
    );
    assert(
      retryable.consecutive_failures === 4,
      "stuck-degraded escalation does not increment exponential failure count",
      `failures=${retryable.consecutive_failures}`
    );
    assert(
      retryable.current_backoff_ms === 1234,
      "stuck-degraded escalation preserves stored exponential backoff",
      `backoff=${retryable.current_backoff_ms}`
    );
    assert(
      retryable.retry_ms !== null && retryable.retry_ms > 50 * 60_000 && retryable.retry_ms <= 60 * 60_000,
      "retryable stuck-degraded schedules approximately one-hour retry",
      `retry_ms=${retryable.retry_ms}`
    );

    await pool.query("UPDATE public.imap_accounts SET backoff_until = now() - interval '1 second' WHERE id = $1", [
      account.id
    ]);
    let runnable = await repository.getRunnableAccounts(10);
    assert(
      runnable.some((candidate) => candidate.id === account.id),
      "retryable STUCK_DEGRADED_24H is runnable after backoff elapses",
      `ids=${runnable.map((candidate) => candidate.id).join(",")}`
    );

    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 600,
        messages: [makeTextMessage({ uid: 1, subject: "recovered", from: "a@x.test", to: "u@x.test", body: "ok" })]
      }
    ];
    const recoveryEngine = new MirrorEngine({
      pool,
      config: { ...config, INITIAL_SYNC_BATCH_SIZE: 50 },
      repository,
      clientFactory: async () => new FixtureImapClient(folders)
    });
    const recovered = await recoveryEngine.syncAccount(account.id, "manual");
    const recoveredRow = (
      await pool.query<{
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
        [account.id]
      )
    ).rows[0];
    assert(recovered.outcome === "success", "successful priority retry completes", `outcome=${recovered.outcome}`);
    assert(recoveredRow.sync_state !== "BROKEN", "successful priority retry exits BROKEN", `state=${recoveredRow.sync_state}`);
    assert(
      recoveredRow.sync_state_reason !== "STUCK_DEGRADED_24H"
        && recoveredRow.sync_state_reason !== "STUCK_DEGRADED_TERMINAL",
      "successful priority retry clears stuck-degraded reason",
      `reason=${recoveredRow.sync_state_reason}`
    );
    assert(
      recoveredRow.last_priority_age_ms !== null && recoveredRow.last_priority_age_ms < 10_000,
      "successful priority retry refreshes last_priority_sync_succeeded_at",
      `age_ms=${recoveredRow.last_priority_age_ms}`
    );
    assert(recoveredRow.backoff_until === null, "successful priority retry clears backoff_until", `until=${recoveredRow.backoff_until}`);

    await pool.query(
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
      [account.id]
    );
    await failingEngine.syncAccount(account.id, "manual");
    const terminal = (
      await pool.query<{
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
        [account.id]
      )
    ).rows[0];
    assert(terminal.sync_state === "BROKEN", "8d stuck account remains BROKEN", `state=${terminal.sync_state}`);
    assert(
      terminal.sync_state_reason === "STUCK_DEGRADED_TERMINAL",
      "8d stuck account becomes terminal",
      `reason=${terminal.sync_state_reason}`
    );
    assert(terminal.consecutive_failures === 5, "terminal cutoff does not increment failure count", `failures=${terminal.consecutive_failures}`);
    assert(terminal.current_backoff_ms === 2222, "terminal cutoff preserves stored backoff", `backoff=${terminal.current_backoff_ms}`);
    assert(terminal.backoff_until === null, "terminal cutoff clears retry scheduling", `until=${terminal.backoff_until}`);

    runnable = await repository.getRunnableAccounts(10);
    assert(
      !runnable.some((candidate) => candidate.id === account.id),
      "terminal stuck-degraded account is not runnable",
      `ids=${runnable.map((candidate) => candidate.id).join(",")}`
    );

    await pool.query(
      `
      UPDATE public.imap_accounts
      SET sync_state = 'DEGRADED',
          sync_state_reason = NULL
      WHERE id = $1
      `,
      [account.id]
    );
    runnable = await repository.getRunnableAccounts(10);
    assert(
      runnable.some((candidate) => candidate.id === account.id),
      "manual operator clear restores scheduling",
      `ids=${runnable.map((candidate) => candidate.id).join(",")}`
    );
  } finally {
    await teardown(pool, account.id);
  }
}

async function main(): Promise<void> {
  console.log("SupaMail Tier-1 spec conformance — exercising real Postgres + fixture IMAP\n");
  console.log(`DATABASE_URL=${process.env.DATABASE_URL?.replace(/:[^@:]*@/, ":***@")}`);

  await scenarioInitialSyncWatermark();
  await scenarioReconcileBackfill();
  await scenarioAuthError();
  await scenarioUidValidityCap();
  await scenarioFolderMissingGrace();
  await scenarioPartialCounterRule();
  await scenarioInitialSyncStallTimeout();
  await scenarioStuckDegradedEscalation();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log("\n" + "=".repeat(64));
  console.log(`SUMMARY: ${passed} passed, ${failed} failed (of ${results.length})`);
  console.log("=".repeat(64));

  if (failed > 0) {
    console.log("\nFAILURES:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.reason}`);
      if (r.evidence) console.log(`    evidence: ${JSON.stringify(r.evidence)}`);
    }
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await closePool();
}
