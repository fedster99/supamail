import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import type { MirrorImapClient } from "../imap-client.js";
import { resetConfigForTests } from "../config.js";
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
});

// Helpful diagnostic when the suite is silently skipped.
if (!DB_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.log("[sync-engine.integration] DATABASE_URL not set — integration suite skipped.");
}
