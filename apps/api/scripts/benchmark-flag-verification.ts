// Reproducible algorithm/work-count experiment, NOT provider or DB throughput.
// Uses the actual syncFolder and flag FETCH helpers with in-memory boundaries.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { getConfig } from "../src/config.js";
import { MirrorEngine } from "../src/sync-engine.js";
import type { MirrorImapClient } from "../src/imap-client.js";
import { MirrorRepository } from "../src/repository.js";
import { applyPublicMigrations, type PgPool } from "../src/db.js";
import type { ImapFolder, MessageFlagSnapshot, SyncResult } from "../src/types.js";
import { EphemeralPostgres, installEphemeralPostgresSignalHandlers } from "./ephemeral-postgres.js";
import { verifyFlagPage, type FlagCheckpoint } from "../src/__tests__/helpers/flag-verification-prototype.js";

const config = getConfig({
  DATABASE_URL: "postgresql://fixture@127.0.0.1:1/fixture",
  IMAP_ENCRYPTION_KEY: "unused-fixture-key",
});
const batchSize = config.INCREMENTAL_SYNC_BATCH_SIZE;
if (process.argv.includes("--db") || process.argv.includes("--engine")) {
  await runDatabaseProbe();
  process.exit(0);
}
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(1_000, 10_000, 50_000);
assert.ok(sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 100_000));
console.log(JSON.stringify({
  kind: "configuration", batchSize, windowDays: config.WINDOW_DAYS,
  flagWindowDays: config.FLAG_DIFF_WINDOW_DAYS,
  note: "in-memory provider/repository; counters are helper calls, not measured SQL or wire roundtrips",
}));

for (const size of sizes) {
  for (const mode of ["recent", "full", "paged"] as const) {
    const now = Date.now();
    const provider = Array.from({ length: size }, (_, i) => ({
      uid: i + 1,
      internalDate: now - (0.5 + i % 89) * 86_400_000,
      flags: ["\\Seen", "\\Flagged"],
    }));
    const mirror = new Map(provider.map(row => [row.uid, ["\\Seen"]]));
    let uidRows = 0, flagRows = 0, fetchCalls = 0, searchFetchCalls = 0;
    let writeBatches = 0, maxWriteBatch = 0, pageReads = 0, maxPageRead = 0;
    let updates = 0, jsonFlagBytes = 0, turns = 0, maxFlagRowsPerTurn = 0;
    const client = {
      capabilities: new Set(["IDLE"]),
      mailbox: { uidValidity: 4n, uidNext: size + 1, exists: size },
      async getMailboxLock() { return { release() {} }; },
      async *fetch(query: number[] | { uid?: string; since?: Date }) {
        fetchCalls++;
        if (Array.isArray(query)) {
          for (const uid of query) {
            const row = provider[uid - 1];
            flagRows++;
            jsonFlagBytes += Buffer.byteLength(JSON.stringify({ uid, flags: row.flags }));
            yield { uid, flags: new Set(row.flags) };
          }
        } else if (!query.uid && query.since) {
          searchFetchCalls++;
          for (const row of provider) {
            if (row.internalDate >= query.since.getTime()) {
              uidRows++;
              yield { uid: row.uid };
            }
          }
        }
      },
    } as unknown as MirrorImapClient;
    const applyFlags = async (snapshots: MessageFlagSnapshot[]) => {
      writeBatches++;
      maxWriteBatch = Math.max(maxWriteBatch, snapshots.length);
      let flagsChanged = 0;
      for (const { uid, flags } of snapshots) {
        if (JSON.stringify(mirror.get(uid)) !== JSON.stringify(flags)) flagsChanged++;
        mirror.set(uid, flags);
      }
      updates += flagsChanged;
      return { flagsChanged, messages: [] };
    };
    const started = performance.now();
    if (mode === "paged") {
      let checkpoint: FlagCheckpoint = {
        accountId: "fixture", folderPath: "Archive", uidValidity: 4,
        afterUid: 0, throughUid: size,
      };
      while (true) {
        const before = flagRows;
        const result = await verifyFlagPage({
          checkpoint, currentScope: { accountId: "fixture", folderPath: "Archive", uidValidity: 4 },
          batchSize, client,
          readPage: async (scope, limit) => {
            pageReads++;
            // Simulates an indexed DB keyset page; only these rows materialize.
            const count = Math.min(limit, scope.throughUid - scope.afterUid);
            maxPageRead = Math.max(maxPageRead, count);
            return Array.from({ length: count }, (_, i) => scope.afterUid + i + 1);
          },
          applyFlags: async rows => { await applyFlags(rows); },
        });
        checkpoint = result.checkpoint;
        turns++;
        maxFlagRowsPerTurn = Math.max(maxFlagRowsPerTurn, flagRows - before);
        if (result.complete) break;
      }
    } else {
      const repository = {
        async markFolderSyncStarted() {},
        async markFolderSynced() {},
        applyFlagScan: async (_account: unknown, _folder: unknown, _validity: unknown, rows: MessageFlagSnapshot[]) => applyFlags(rows),
      } as unknown as MirrorRepository;
      const engine = new MirrorEngine({ pool: {} as PgPool, config, repository });
      const folder = {
        id: "fixture-folder", path: "Archive", uidvalidity: "4", last_uid: String(size),
        highest_modseq: null, qresync_highest_modseq: null, initial_sync_complete: true,
        next_flag_scan_at: new Date(now - 1).toISOString(),
      };
      const probe = engine as unknown as { syncFolder: (...args: unknown[]) => Promise<unknown> };
      await probe.syncFolder({ id: "fixture" }, folder, client, {
        allowFlagScan: true, allowReconcile: false, enforceLockDeadline: false,
        reconcileTelemetry: {}, metadataWriteStats: {}, forceFlagScan: mode === "full",
      });
      turns = 1;
      maxFlagRowsPerTurn = flagRows;
    }
    const exact = [...mirror.values()].filter(flags => flags.includes("\\Flagged")).length;
    assert.equal(exact, updates);
    if (mode === "recent") assert.ok(exact < size);
    else assert.equal(exact, size);
    assert.ok(maxWriteBatch <= batchSize);
    if (mode === "paged") {
      assert.ok(maxFlagRowsPerTurn <= batchSize);
      assert.ok(maxPageRead <= batchSize + 1);
      assert.equal(uidRows, 0);
      assert.equal(searchFetchCalls, 0);
    }
    console.log(JSON.stringify({
      kind: "result", mode, size, exact, missed: size - exact, turns,
      fetchHelperCalls: fetchCalls, searchFetchHelperCalls: searchFetchCalls,
      uidRows, flagRows, jsonFlagBytes, writeBatches, maxWriteBatch,
      pageReads, maxPageRead, maxFlagRowsPerTurn,
      harnessWallMs: Math.round(performance.now() - started),
      // Arithmetic model only: one successful page each hosted five-minute cycle.
      modeledMinutesAtOnePagePerFiveMinutes: mode === "paged" ? turns * 5 : null,
    }));
  }
}

async function runDatabaseProbe() {
  const integrated = process.argv.includes("--engine");
  const database = new EphemeralPostgres({
    image: "postgres:16-alpine", namePrefix: "supamail-flag-page", purpose: "flag-page-experiment",
  });
  installEphemeralPostgresSignalHandlers(database, { logPrefix: "[flag-page]" });
  let pool: Pool | undefined;
  try {
    const url = await database.start();
    pool = new Pool({ connectionString: url, max: config.DATABASE_POOL_MAX });
    pool.on("error", () => { throw new Error("fixture database connection failed"); });
    await applyPublicMigrations(pool);
    const repository = new MirrorRepository(pool, { ...config, IMAP_ALLOW_PRIVATE_HOSTS: true });
    const account = await repository.createAccount({
      emailAddress: "flags@example.test", host: "127.0.0.1", port: 993, secure: true,
      username: "fixture", password: "unused-fixture", providerProfile: "generic-imap",
    });
    const other = await repository.createAccount({
      emailAddress: "other@example.test", host: "127.0.0.1", port: 993, secure: true,
      username: "fixture", password: "unused-fixture", providerProfile: "generic-imap",
    });
    const folder = (await pool.query<ImapFolder>(
      "INSERT INTO public.imap_folders (account_id,path,uidvalidity,tracked,initial_sync_complete) VALUES ($1,'Archive',4,true,true) RETURNING *",
      [account.id],
    )).rows[0];
    // Controls share UIDs but differ in account, folder, or UIDVALIDITY.
    await pool.query(
      `INSERT INTO public.imap_messages (account_id,folder_path,uidvalidity,uid,internal_date,flags)
       VALUES ($1,'Archive',4,1,now(),$3), ($2,'Other',4,1,now(),$3), ($2,'Archive',5,1,now(),$3)`,
      [other.id, account.id, ["\\Seen"]],
    );
    const query = `SELECT uid::text FROM public.imap_messages
      WHERE account_id=$1 AND folder_path=$2 AND uidvalidity=$3
        AND uid>$4 AND uid<=$5 AND deleted_in_provider=false
        AND window_status='IN_WINDOW' AND internal_date >= $6
      ORDER BY imap_messages.uid LIMIT $7`;
    for (const size of [1_000, 10_000]) {
      await pool.query(
        `INSERT INTO public.imap_messages
         (account_id,folder_id,folder_path,uidvalidity,uid,internal_date,flags)
         SELECT $1,$2,'Archive',4,n,now()-((0.5+n%89)*interval '1 day'),$4
         FROM generate_series(1,$3::int) n ON CONFLICT DO NOTHING`,
        [account.id, folder.id, size, ["\\Seen"]],
      );
      await pool.query(
        "UPDATE public.imap_messages SET flags=$2 WHERE account_id=$1 AND folder_path='Archive' AND uidvalidity=4",
        [account.id, ["\\Seen"]],
      );
      await pool.query("ANALYZE public.imap_messages");
      const cutoff = new Date(Date.now() - config.WINDOW_DAYS * 86_400_000);
      const plan = await pool.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + query,
        [account.id, "Archive", 4, 0, size, cutoff, batchSize + 1]);
      for (const expectedChanges of [size, 0]) {
      const readTimes: number[] = [], writeTimes: number[] = [];
      let checked = 0, changed = 0, maxWaiters = 0, peakClients = 0;
      let checkpoint: FlagCheckpoint = {
        accountId: account.id, folderPath: "Archive", uidValidity: 4, afterUid: 0, throughUid: size,
      };
      const client = {
        mailbox: { path: "Archive", uidValidity: 4n, uidNext: size + 1, exists: size },
        async getMailboxLock() { return { release() {} }; },
        async logout() {},
        async *fetch(uids: number[]) {
          for (const uid of uids) yield { uid, flags: new Set(["\\Seen", "\\Flagged"]) };
        },
      } as unknown as MirrorImapClient;
      if (integrated) {
        await pool.query("UPDATE public.imap_accounts SET sync_state='HEALTHY' WHERE id=$1", [account.id]);
        await pool.query(`UPDATE public.imap_folders SET last_uid=$2, status='ACTIVE',
          next_reconcile_at=now()+interval '1 day', next_flag_scan_at=now(),
          flag_scan_after_uid=NULL, flag_scan_through_uid=NULL WHERE id=$1`, [folder.id, size]);
        await repository.beginFlagScan(account.id, folder, 4, size,
          { deadlineAt: Date.now() + config.FLAG_SCAN_TOTAL_TIMEOUT_MS });
      }
      const started = performance.now();
      const cpuStart = process.cpuUsage();
      let peakRss = process.memoryUsage().rss;
      const turns: number[] = [];
      while (true) {
        if (integrated) {
          const t = performance.now();
          // Reconstruct the engine each turn: only the database keeps progress.
          const engine: MirrorEngine = new MirrorEngine({ pool, repository, config,
            clientFactory: async () => client });
          const result: SyncResult = await engine.syncAccount(account.id, "scheduled", { flagVerificationOnly: true });
          assert.equal(result.errors.length, 0, JSON.stringify(result));
          checked += result.flagRowsChecked ?? 0;
          assert.ok((result.flagRowsChecked ?? 0) > 0, "integrated sweep stopped making progress");
          changed += result.flagsUpdated;
          turns.push(performance.now() - t);
          peakClients = Math.max(peakClients, pool.totalCount);
          maxWaiters = Math.max(maxWaiters, pool.waitingCount);
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
          if ((await repository.getFlagScanContinuations(account.id)).length === 0) break;
          continue;
        }
        const result = await verifyFlagPage({
          checkpoint, currentScope: { accountId: account.id, folderPath: "Archive", uidValidity: 4 },
          batchSize, client,
          readPage: async (scope, limit) => {
            const t = performance.now();
            const rows = await pool!.query<{ uid: string }>(query,
              [scope.accountId, scope.folderPath, scope.uidValidity, scope.afterUid, scope.throughUid, cutoff, limit]);
            readTimes.push(performance.now() - t);
            assert.ok(rows.rows.length <= batchSize + 1);
            return rows.rows.map(row => Number(row.uid));
          },
          applyFlags: async rows => {
            const t = performance.now();
            const result = await repository.applyFlagScan(account.id, folder, 4, rows,
              { deadlineAt: Date.now() + config.FLAG_SCAN_TOTAL_TIMEOUT_MS });
            changed += result.flagsChanged;
            writeTimes.push(performance.now() - t);
          },
        });
        checkpoint = result.checkpoint;
        checked += result.checked;
        maxWaiters = Math.max(maxWaiters, pool.waitingCount);
        peakClients = Math.max(peakClients, pool.totalCount);
        if (result.complete) break;
      }
      const wallMs = performance.now() - started;
      const exact: number = Number((await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM public.imap_messages WHERE account_id=$1
         AND folder_path='Archive' AND uidvalidity=4 AND flags @> $2`,
        [account.id, ["\\Flagged"]],
      )).rows[0].count);
      assert.equal(exact, size);
      assert.equal(changed, expectedChanges);
      const wrong: number = Number((await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM public.imap_messages WHERE
         (account_id<>$1 OR folder_path<>'Archive' OR uidvalidity<>4) AND flags @> $2`,
        [account.id, ["\\Flagged"]],
      )).rows[0].count);
      assert.equal(wrong, 0);
      // Replaying the first acknowledged page must not create another change.
      const replay = await repository.applyFlagScan(account.id, folder, 4,
        Array.from({ length: batchSize }, (_, i) => ({ uid: i + 1, flags: ["\\Seen", "\\Flagged"] })));
      assert.equal(replay.flagsChanged, 0);
      const stats = (values: number[]) => {
        if (values.length === 0) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const p = (q: number) => Number(sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)].toFixed(3));
        return { count: values.length, totalMs: Math.round(values.reduce((a,b) => a+b, 0)),
          p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), worstMs: p(1) };
      };
      console.log(JSON.stringify({ kind: integrated ? "engine-result" : "database-result", size, phase: expectedChanges ? "changed" : "unchanged",
        checked, exact, changed, wrongScopeUpdates: wrong,
        replayChanges: replay.flagsChanged, wallMs: Math.round(wallMs), reads: stats(readTimes),
        writes: stats(writeTimes), peakClients, sampledMaxWaiters: maxWaiters,
        turns: stats(turns), cpu: process.cpuUsage(cpuStart), peakRss,
        queryPlan: plan.rows[0]["QUERY PLAN"],
        note: integrated
          ? "real local Postgres, engine, locks and durable cursor; simulated IMAP, no mixed worker/MCP/search/body load or resource limit"
          : "real local Postgres and repository; simulated IMAP, no worker/MCP/search/body workload or durable checkpoint",
      }));
      }
    }
  } finally {
    await pool?.end();
    await database.cleanup("flag page experiment complete");
  }
}
