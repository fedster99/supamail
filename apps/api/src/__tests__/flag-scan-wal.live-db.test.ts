import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config.js";
import { closePool, getPool, type PgPool } from "../db.js";
import { makeTextMessage, type FixtureFolder } from "../smoke/fixture-imap.js";
import type { ImapFolder } from "../types.js";
import { setupIntegration, teardownIntegration } from "./helpers/integration-harness.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

// One flag-scan batch at the production default (INCREMENTAL_SYNC_BATCH_SIZE).
const SCANNED = 50;
const CHANGED_UIDS = [7, 31];

/** WAL written by `work`, measured after a checkpoint so first page touches pay full-page images, as in production. */
async function walBytes(pool: PgPool, work: () => Promise<unknown>): Promise<number> {
  await pool.query("CHECKPOINT");
  const before = (await pool.query<{ lsn: string }>("SELECT pg_current_wal_insert_lsn()::text AS lsn")).rows[0]!.lsn;
  await work();
  const after = (await pool.query<{ lsn: string }>("SELECT pg_current_wal_insert_lsn()::text AS lsn")).rows[0]!.lsn;
  const diff = await pool.query<{ bytes: string }>(
    "SELECT pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::text AS bytes",
    [after, before]
  );
  return Number(diff.rows[0]!.bytes);
}

liveDb("flag scan write path", () => {
  const accountIds: string[] = [];

  beforeAll(() => {
    resetConfigForTests();
  });

  afterEach(async () => {
    while (accountIds.length > 0) await teardownIntegration(getPool(), accountIds.pop()!);
  });

  afterAll(async () => {
    await closePool();
  });

  it("locks and writes only the scanned rows whose flags differ", async () => {
    const h = await setupIntegration("flag-scan-wal", { INITIAL_SYNC_BATCH_SIZE: SCANNED });
    accountIds.push(h.account.id);
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 42_001,
      messages: Array.from({ length: SCANNED }, (_, index) => makeTextMessage({
        uid: index + 1,
        subject: `flag-scan-${index + 1}`,
        from: "sender@example.test",
        to: "user@example.test",
        body: `flag-scan-${index + 1}`,
        flags: ["\\Seen"]
      }))
    }];
    await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");
    const folder = (await h.pool.query<ImapFolder>(
      "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
      [h.account.id]
    )).rows[0]!;
    const rows = async () => (await h.pool.query<{ uid: string; flags: string[]; xmax: string }>(
      `SELECT uid::text AS uid, flags, xmax::text AS xmax
       FROM public.imap_messages
       WHERE account_id = $1 AND folder_path = 'INBOX'
       ORDER BY uid`,
      [h.account.id]
    )).rows;
    const stored = await rows();
    expect(stored).toHaveLength(SCANNED);
    const snapshots = stored.map((row) => ({ uid: Number(row.uid), flags: row.flags }));
    const scan = (messages: typeof snapshots) =>
      h.repository.applyFlagScan(h.account.id, folder, Number(folder.uidvalidity), messages);

    // A scan that finds no difference takes no row lock: xmax stays as it was.
    // WAL is cluster-wide, so take the quietest of three runs; background work only adds.
    let unchanged: Awaited<ReturnType<typeof scan>> | undefined;
    let unchangedWal = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      unchangedWal = Math.min(unchangedWal, await walBytes(h.pool, async () => {
        unchanged = await scan(snapshots);
      }));
    }
    expect(unchanged).toMatchObject({ flagsChanged: 0 });
    expect(unchanged!.messages).toHaveLength(SCANNED);
    expect((await rows()).map((row) => row.xmax)).toEqual(stored.map((row) => row.xmax));

    // Before this change every scan locked each scanned row first; this is that statement.
    const lockAllWal = await walBytes(h.pool, async () => {
      const client = await h.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT 1 FROM public.imap_messages
           WHERE account_id = $1 AND folder_path = 'INBOX' AND uidvalidity = $2
             AND uid = ANY($3::bigint[]) AND deleted_in_provider = false
           FOR UPDATE`,
          [h.account.id, folder.uidvalidity, snapshots.map((snapshot) => snapshot.uid)]
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
    const lockedByOldStatement = await rows();

    // Two changed rows: only those two are locked and rewritten.
    const changedSnapshots = snapshots.map((snapshot) => CHANGED_UIDS.includes(snapshot.uid)
      ? { uid: snapshot.uid, flags: ["\\Seen", "\\Flagged"] }
      : snapshot);
    let changed: Awaited<ReturnType<typeof scan>> | undefined;
    const changedWal = await walBytes(h.pool, async () => {
      changed = await scan(changedSnapshots);
    });
    expect(changed).toMatchObject({ flagsChanged: CHANGED_UIDS.length });
    const after = await rows();
    for (const [index, row] of after.entries()) {
      if (CHANGED_UIDS.includes(Number(row.uid))) {
        expect(row.flags).toEqual(["\\Seen", "\\Flagged"]);
      } else {
        expect(row.flags).toEqual(stored[index]!.flags);
        expect(row.xmax).toBe(lockedByOldStatement[index]!.xmax);
      }
    }

    // The old statement wrote a lock record per row and a full-page image per page.
    // The unchanged scan writes none of it.
    console.info(
      `[flag-scan-wal] scanned=${SCANNED} lock_all=${lockAllWal}B`
      + ` (${(lockAllWal / SCANNED).toFixed(0)}B/row) unchanged_scan=${unchangedWal}B`
      + ` changed_scan(${CHANGED_UIDS.length})=${changedWal}B (${(changedWal / SCANNED).toFixed(0)}B/row)`
    );
    expect(unchangedWal * 10).toBeLessThan(lockAllWal);
  });
});
