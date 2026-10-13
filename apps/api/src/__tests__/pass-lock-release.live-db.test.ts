import { performance } from "node:perf_hooks";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool, createPool, getPool, type PgPool } from "../db.js";
import { resetConfigForTests } from "../config.js";
import { AccountBusyError } from "../errors.js";
import { withAccountLock } from "../locks.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import type { DownloadResult, FetchMessage, MirrorImapClient } from "../imap-client.js";
import type { SyncAccountOptions } from "../sync-engine.js";
import {
  buildInboxAndSentFolders,
  folderCountDrift,
  setupIntegration,
  teardownIntegration,
  type IntegrationHarness
} from "./helpers/integration-harness.js";

const liveDb = process.env.LIVE_DB_TESTS === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const mocks = vi.hoisted(() => ({
  deliverSmtp: vi.fn(),
  appenderAppend: vi.fn()
}));

vi.mock("../smtp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../smtp-client.js")>();
  return {
    ...actual,
    deliverSmtp: mocks.deliverSmtp,
    resolveSmtpCreds: vi.fn(async () => ({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      username: "sender@example.test",
      password: "secret"
    })),
    SentFolderAppender: {
      connect: vi.fn(async () => ({
        list: async () => [{ path: "Sent", specialUse: "\\Sent" }],
        append: mocks.appenderAppend,
        logout: async () => undefined,
        close: () => undefined
      }))
    }
  };
});

vi.mock("../host-validation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../host-validation.js")>(),
  assertSafeSmtpTarget: vi.fn(async () => ({ isPrivateHost: false }))
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A provider whose every round trip takes `delayMs`, so chunks take real time. */
class SlowFixtureImapClient extends FixtureImapClient {
  constructor(folders: FixtureFolder[], private readonly delayMs: number) {
    super(folders);
  }

  override async *fetch(
    range: string | number[] | Record<string, unknown>,
    query: Record<string, unknown>
  ): AsyncIterable<FetchMessage> {
    await sleep(this.delayMs);
    yield* super.fetch(range, query);
  }

  override async search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false> {
    await sleep(this.delayMs);
    return await super.search(query, options);
  }

  override async download(range: string, part?: string, options?: Record<string, unknown>): Promise<DownloadResult> {
    await sleep(this.delayMs);
    return await super.download(range, part, options);
  }
}

function inbox(uids: number[], internalDate?: Date): FixtureFolder {
  return {
    path: "INBOX",
    delimiter: "/",
    specialUse: "\\Inbox",
    uidValidity: 71_001,
    messages: uids.map((uid) => message(uid, internalDate))
  };
}

function message(uid: number, internalDate?: Date) {
  return makeTextMessage({ uid, subject: `m-${uid}`, from: "a@x.test", to: "u@x.test", body: `b-${uid}`, internalDate });
}

async function lockIdOf(h: IntegrationHarness): Promise<string> {
  const account = await h.repository.getAccount(h.account.id);
  if (!account) throw new Error("missing account");
  return account.lock_id;
}

async function waitingLockRequests(pool: PgPool, lockId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_locks
     WHERE locktype = 'advisory' AND objid::bigint = $1::bigint AND NOT granted`,
    [lockId]
  );
  return Number(result.rows[0].count);
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

async function runCount(pool: PgPool, accountId: string): Promise<number> {
  return Number((await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM public.imap_sync_runs WHERE account_id = $1",
    [accountId]
  )).rows[0].count);
}

async function mirroredUids(pool: PgPool, accountId: string, folderPath = "INBOX"): Promise<number[]> {
  return (await pool.query<{ uid: string }>(
    `SELECT uid::text AS uid FROM public.imap_messages
     WHERE account_id = $1 AND folder_path = $2 AND deleted_in_provider = false`,
    [accountId, folderPath]
  )).rows.map((row) => Number(row.uid)).sort((left, right) => left - right);
}

liveDb("pass lock release and bounded lock waits (live DB)", () => {
  const activeAccountIds: string[] = [];

  beforeAll(() => {
    resetConfigForTests();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deliverSmtp.mockResolvedValue({ accepted: ["r@x.test"], rejected: [], response: "250 OK" });
    mocks.appenderAppend.mockResolvedValue({ uid: 9 });
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

  async function harness(suite: string, overrides: Parameters<typeof setupIntegration>[1] = {}) {
    const h = await setupIntegration(suite, { INITIAL_SYNC_BATCH_SIZE: 50, ...overrides });
    activeAccountIds.push(h.account.id);
    return h;
  }

  it("queues a waiting lock request ahead of the holder's next try", async () => {
    const h = await harness("lock-wait-queue");
    const lockId = await lockIdOf(h);
    const holder = await h.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [lockId]);
      let ran = false;
      const waiter = withAccountLock(h.pool, lockId, async () => {
        ran = true;
        return "acquired";
      }, { waitMs: 5_000 });
      await until(async () => await waitingLockRequests(h.pool, lockId) === 1, "the waiter to queue");

      await holder.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);
      // Postgres granted the lock to the queued waiter as the holder released
      // it, so the holder's immediate retry, like a pass's next chunk, loses.
      const retried = await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
        [lockId]
      );
      expect(retried.rows[0].locked).toBe(false);
      await expect(waiter).resolves.toBe("acquired");
      expect(ran).toBe(true);
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  });

  it("ends a bounded wait as busy and leaves the session's timeouts unchanged", async () => {
    const h = await harness("lock-wait-timeout");
    const lockId = await lockIdOf(h);
    // One connection, so the waiting session is the one reused afterward.
    const onePool = createPool({ DATABASE_URL: process.env.DATABASE_URL!, DATABASE_POOL_MAX: 1 });
    const holder = await h.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [lockId]);
      const startedAt = performance.now();
      const result = await withAccountLock(onePool, lockId, async () => "ran", { waitMs: 300 });
      expect(result).toBeNull();
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(280);
      await holder.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);

      const settings = await withAccountLock(onePool, lockId, async (lock) => (await lock.client.query<{
        lock_timeout: string;
        statement_timeout: string;
      }>("SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout")).rows[0]);
      expect(settings).toEqual({ lock_timeout: "0", statement_timeout: "0" });
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
      await onePool.end();
    }
  });

  it("gets a send the lock between back-to-back history chunks", async () => {
    const budgetMs = 150;
    const waitMs = 2_000;
    const h = await harness("lock-release-send", { BODY_BACKFILL_BATCH_SIZE: 1, MAX_LOCK_HOLD_MS: budgetMs });
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET historical_backfill_mode = 'metadata_only', max_backfill_rate = 'aggressive'
       WHERE id = $1`,
      [h.account.id]
    );
    const old = new Date("2023-01-01T00:00:00Z");
    const folders = [inbox([...Array.from({ length: 40 }, (_, index) => index + 1)], old)];
    folders[0].messages.push(message(100));
    const engine = h.buildEngine({
      folders,
      clientFactory: async () => new SlowFixtureImapClient(folders, 20) as unknown as MirrorImapClient
    });
    expect((await engine.syncAccount(h.account.id, "scheduled", { mode: "first_sync" })).outcome).toBe("success");

    // The host runs history chunks back to back, as a lower lane does, and
    // retries a deferred chunk at once.
    const chunks: Array<{ startedAt: number; finishedAt: number }> = [];
    let stop = false;
    const historyLane = (async () => {
      while (!stop && chunks.length < 200) {
        const startedAt = performance.now();
        try {
          const result = await engine.syncAccount(h.account.id, "scheduled", { mode: "history" });
          chunks.push({ startedAt, finishedAt: performance.now() });
          if (!result.hitLockBudget) break;
        } catch (error) {
          if (!(error instanceof AccountBusyError)) throw error;
        }
      }
    })();

    await until(async () => chunks.length >= 2, "two history chunks");
    let deliveredAt = 0;
    mocks.deliverSmtp.mockImplementationOnce(async () => {
      deliveredAt = performance.now();
      return { accepted: ["r@x.test"], rejected: [], response: "250 OK" };
    });
    const { sendMessage } = await import("../send.js");
    const sendStartedAt = performance.now();
    const sent = await sendMessage(h.pool, { ...h.config, ACCOUNT_LOCK_WAIT_MS: waitMs }, {
      accountId: h.account.id,
      to: [{ email: "r@x.test" }],
      subject: "During history",
      body: { format: "plain", text: "Body" }
    });
    const sendFinishedAt = performance.now();
    await until(async () => chunks.some((chunk) => chunk.startedAt > sendFinishedAt), "a chunk after the send");
    stop = true;
    await historyLane;

    expect(sent.delivered).toBe(true);
    // The send waited for one chunk boundary, far inside its bound.
    expect(deliveredAt - sendStartedAt).toBeLessThan(waitMs);
    expect(deliveredAt - sendStartedAt).toBeLessThan(budgetMs + 750);
    // The history lane kept running around the send, each chunk near its budget.
    expect(chunks.some((chunk) => chunk.finishedAt < sendStartedAt)).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.finishedAt - chunk.startedAt).toBeLessThan(budgetMs + 750);
    }
  });

  it("closes the recorded run as failed when the pass escapes after taking the lock", async () => {
    const h = await harness("lock-release-run-escape");
    const engine = h.buildEngine({ folders: buildInboxAndSentFolders() });
    // Recording success fails, and so does recording that failure: the pass escapes.
    vi.spyOn(h.repository, "markAccountSyncSucceeded").mockRejectedValueOnce(new Error("finalization lost"));
    vi.spyOn(h.repository, "markAccountSyncFailed").mockRejectedValueOnce(new Error("failure write lost"));

    await expect(engine.syncAccount(h.account.id, "manual")).rejects.toThrow("failure write lost");
    const runs = await h.pool.query<{ status: string; finished: boolean }>(
      "SELECT status, finished_at IS NOT NULL AS finished FROM public.imap_sync_runs WHERE account_id = $1",
      [h.account.id]
    );
    expect(runs.rows).toEqual([{ status: "failed", finished: true }]);
  });

  it("lets a live pass wait for its own host's lower lane, and defers past the bound", async () => {
    const h = await harness("lock-wait-live", { ACCOUNT_LOCK_WAIT_MS: 400 });
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({ folders });
    expect((await engine.syncAccount(h.account.id, "manual")).outcome).toBe("success");
    const lockId = await lockIdOf(h);
    const live: SyncAccountOptions = { mode: "live", waitForLock: true };

    // A lower-lane chunk that releases within the bound.
    const shortChunk = withAccountLock(h.pool, lockId, async () => {
      await sleep(150);
    });
    await sleep(20);
    const waited = await engine.syncAccount(h.account.id, "scheduled", live);
    expect(waited.outcome).toBe("success");
    await shortChunk;

    // Without the wait, a held lock defers at once.
    const runsBefore = await runCount(h.pool, h.account.id);
    const holder = await h.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [lockId]);
      await expect(engine.syncAccount(h.account.id, "scheduled", { mode: "live" }))
        .rejects.toBeInstanceOf(AccountBusyError);
      // Past the bound, the waiting pass defers the same way.
      const startedAt = performance.now();
      await expect(engine.syncAccount(h.account.id, "scheduled", live)).rejects.toBeInstanceOf(AccountBusyError);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(380);
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
    expect(await runCount(h.pool, h.account.id)).toBe(runsBefore);
  });

  it("stops a live pass at the budget even in Inbox, and later passes finish the work", async () => {
    const h = await harness("lock-release-live", { INCREMENTAL_SYNC_BATCH_SIZE: 5, MAX_LOCK_HOLD_MS: 100 });
    const folders = [inbox([1])];
    const engine = h.buildEngine({
      folders,
      clientFactory: async () => new SlowFixtureImapClient(folders, 40) as unknown as MirrorImapClient
    });
    await engine.syncAccount(h.account.id, "scheduled", { mode: "first_sync" });
    for (let uid = 2; uid <= 31; uid += 1) folders[0].messages.push(message(uid));

    const first = await engine.syncAccount(h.account.id, "scheduled", { mode: "live" });
    expect(first.hitLockBudget).toBe(true);
    expect(first.messagesUpserted).toBeGreaterThanOrEqual(5);
    expect(first.messagesUpserted).toBeLessThan(30);
    for (let pass = 0; pass < 20 && (await mirroredUids(h.pool, h.account.id)).length < 31; pass += 1) {
      await engine.syncAccount(h.account.id, "scheduled", { mode: "live" });
    }
    expect(await mirroredUids(h.pool, h.account.id)).toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
  });

  it("stops first sync and the body lane at the budget, after at least one chunk", async () => {
    const h = await harness("lock-release-first-body", {
      MAX_LOCK_HOLD_MS: 1,
      BODY_BACKFILL_BATCH_SIZE: 10
    });
    await h.pool.query(
      "UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1",
      [h.account.id]
    );
    const folders: FixtureFolder[] = ["INBOX", "Alpha", "Beta", "Gamma"].map((path, index) => ({
      path,
      delimiter: "/",
      specialUse: path === "INBOX" ? "\\Inbox" : undefined,
      uidValidity: 72_000 + index,
      messages: [message(1), message(2), message(3)]
    }));
    const engine = h.buildEngine({
      folders,
      clientFactory: async () => new SlowFixtureImapClient(folders, 10) as unknown as MirrorImapClient
    });

    // The budget is already spent after login and discovery, yet each pass
    // finishes one folder.
    const first = await engine.syncAccount(h.account.id, "scheduled", { mode: "first_sync" });
    expect(first.hitLockBudget).toBe(true);
    expect(first.foldersProcessed).toBe(1);
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await engine.syncAccount(h.account.id, "scheduled", { mode: "first_sync" })).foldersProcessed).toBe(1);
    }
    expect((await h.repository.getFoldersForFirstSync(h.account.id))).toEqual([]);

    const body = await engine.syncAccount(h.account.id, "scheduled", { mode: "body" });
    expect(body.hitLockBudget).toBe(true);
    expect(body.bodiesFetched).toBe(1);
  });

  it("lets an audit follow the whole-window flag scan it rides with, past the budget", async () => {
    const h = await harness("lock-release-audit-rider", { MAX_LOCK_HOLD_MS: 1 });
    const folders = buildInboxAndSentFolders();
    const engine = h.buildEngine({ folders });
    expect((await engine.syncAccount(h.account.id, "manual")).outcome).toBe("success");
    folders[0].messages = folders[0].messages.filter((candidate) => candidate.uid !== 105);
    // Without a modseq, the scheduled audit brings a whole-window flag scan.
    await h.pool.query(
      `UPDATE public.imap_folders
       SET next_reconcile_at = CASE WHEN path = 'INBOX' THEN now() - interval '1 second'
                                    ELSE now() + interval '1 hour' END,
           next_flag_scan_at = now() + interval '1 hour',
           last_full_reconcile_at = now() - interval '7 hours'
       WHERE account_id = $1`,
      [h.account.id]
    );

    const audit = await engine.syncAccount(h.account.id, "scheduled", { mode: "audit" });
    expect(audit.reconcileFoldersAttempted).toBe(1);
    const gone = await h.pool.query<{ deleted_reason: string | null }>(
      "SELECT deleted_reason FROM public.imap_messages WHERE account_id = $1 AND folder_path = 'INBOX' AND uid = 105",
      [h.account.id]
    );
    expect(gone.rows[0].deleted_reason).toBe("RECONCILE_MISSING");
  });
});
