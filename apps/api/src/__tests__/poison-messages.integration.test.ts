import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool, type PgPool } from "../db.js";
import { resetConfigForTests } from "../config.js";
import { buildSyncStatus } from "../search/sync-status.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import type { FetchMessage, MirrorImapClient } from "../imap-client.js";
import type { SyncMode, SyncResult, UnreadableMessageRecord } from "../types.js";
import {
  buildInboxAndSentFolders,
  folderCountDrift,
  setupIntegration,
  teardownIntegration,
  type IntegrationHarness
} from "./helpers/integration-harness.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;

/** A provider whose FETCH response for some UIDs lacks the envelope. */
class PoisonFixtureImapClient extends FixtureImapClient {
  readonly requested: number[][] = [];

  constructor(folders: FixtureFolder[], private readonly poison: Set<number>) {
    super(folders);
  }

  override async *fetch(
    range: string | number[] | Record<string, unknown>,
    query: Record<string, unknown>
  ): AsyncIterable<FetchMessage> {
    const metadata = Boolean(query.envelope);
    if (metadata && Array.isArray(range)) this.requested.push([...range]);
    for await (const message of super.fetch(range, query)) {
      if (metadata && this.poison.has(message.uid)) {
        const { envelope: _envelope, ...withoutEnvelope } = message;
        yield withoutEnvelope as FetchMessage;
      } else {
        yield message;
      }
    }
  }
}

function message(uid: number, internalDate?: Date) {
  return makeTextMessage({ uid, subject: `m-${uid}`, from: "a@x.test", to: "u@x.test", body: `b-${uid}`, internalDate });
}

async function folderRecords(
  pool: PgPool,
  accountId: string,
  path = "INBOX"
): Promise<Record<string, UnreadableMessageRecord> | null> {
  return (await pool.query<{ unreadable_messages: Record<string, UnreadableMessageRecord> | null }>(
    "SELECT unreadable_messages FROM public.imap_folders WHERE account_id = $1 AND path = $2",
    [accountId, path]
  )).rows[0].unreadable_messages;
}

async function liveUids(pool: PgPool, accountId: string, path = "INBOX"): Promise<number[]> {
  return (await pool.query<{ uid: string }>(
    `SELECT uid::text AS uid FROM public.imap_messages
     WHERE account_id = $1 AND folder_path = $2 AND deleted_in_provider = false`,
    [accountId, path]
  )).rows.map((row) => Number(row.uid)).sort((left, right) => left - right);
}

integration("poison messages (real Postgres + fixture IMAP)", () => {
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

  async function harness(suite: string, folders: FixtureFolder[], poison: Set<number>): Promise<{
    h: IntegrationHarness;
    sync: (mode?: SyncMode) => Promise<SyncResult>;
    clients: PoisonFixtureImapClient[];
  }> {
    const h = await setupIntegration(suite, { INITIAL_SYNC_BATCH_SIZE: 50, BODY_BACKFILL_BATCH_SIZE: 50 });
    activeAccountIds.push(h.account.id);
    const clients: PoisonFixtureImapClient[] = [];
    const engine = h.buildEngine({
      folders,
      clientFactory: async () => {
        const client = new PoisonFixtureImapClient(folders, poison);
        clients.push(client);
        return client as unknown as MirrorImapClient;
      }
    });
    return {
      h,
      clients,
      sync: (mode = "full") => engine.syncAccount(h.account.id, "scheduled", { mode })
    };
  }

  it("skips a message that fails three times, and Inbox keeps syncing", async () => {
    const folders = buildInboxAndSentFolders();
    const poison = new Set<number>();
    const { h, sync, clients } = await harness("poison-live", folders, poison);
    expect((await sync()).outcome).toBe("success");
    folders[0].messages.push(message(106), message(107));
    poison.add(106);

    for (const attempt of [1, 2]) {
      const failed = await sync("live");
      expect({ attempt, outcome: failed.outcome }).toEqual({ attempt, outcome: "failed" });
      expect(await liveUids(h.pool, h.account.id)).toEqual([101, 102, 103, 104, 105]);
      expect(await folderRecords(h.pool, h.account.id)).toEqual({
        106: { code: "fetch_incomplete", attempts: attempt, failed_at: expect.any(String) }
      });
    }

    const third = await sync("live");
    expect(third.outcome).toBe("success");
    expect(third.unreadableMessagesSkipped).toBe(1);
    expect(await liveUids(h.pool, h.account.id)).toEqual([101, 102, 103, 104, 105, 107]);
    // The record names the message by UID and a fixed code only.
    expect(await folderRecords(h.pool, h.account.id)).toEqual({
      106: { code: "fetch_incomplete", attempts: 3, failed_at: expect.any(String) }
    });
    const account = await h.pool.query<{ consecutive_failures: number; backoff_until: Date | null }>(
      "SELECT consecutive_failures, backoff_until FROM public.imap_accounts WHERE id = $1",
      [h.account.id]
    );
    expect(account.rows[0]).toEqual({ consecutive_failures: 0, backoff_until: null });

    // Later passes no longer ask for the skipped message.
    folders[0].messages.push(message(108));
    clients.length = 0;
    expect((await sync("live")).outcome).toBe("success");
    expect(clients.flatMap((client) => client.requested).flat()).not.toContain(106);
    expect(await liveUids(h.pool, h.account.id)).toEqual([101, 102, 103, 104, 105, 107, 108]);

    const status = await buildSyncStatus(h.pool, [h.account.id]);
    expect(status.accounts[0].unreadable_messages).toBe(1);
    expect(status.degraded_reasons).toContain("unreadable_messages");
    expect(status.summary).toContain("1 message could not be read");
  });

  it("forgets a failure once the message reads fine", async () => {
    const folders = buildInboxAndSentFolders();
    const poison = new Set<number>();
    const { h, sync } = await harness("poison-transient", folders, poison);
    await sync();
    folders[0].messages.push(message(106));
    poison.add(106);
    expect((await sync("live")).outcome).toBe("failed");
    poison.delete(106);

    expect((await sync("live")).outcome).toBe("success");
    expect(await liveUids(h.pool, h.account.id)).toContain(106);
    expect(await folderRecords(h.pool, h.account.id)).toBeNull();
  });

  it("skips an unparseable message in first sync and history, and each finishes", async () => {
    const old = new Date("2023-01-01T00:00:00Z");
    const unparseable = (uid: number, internalDate?: Date) => ({
      ...message(uid, internalDate),
      // A BODYSTRUCTURE date that is not a date cannot be stored.
      bodyStructure: { part: "1", type: "text/plain", disposition: { date: new Date(Number.NaN) } }
    });
    const folders: FixtureFolder[] = [{
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 61_001,
      messages: [message(1, old), unparseable(2, old), message(3), unparseable(4), message(5)]
    }];
    const { h, sync } = await harness("poison-first-history", folders, new Set());
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET historical_backfill_mode = 'metadata_only', max_backfill_rate = 'aggressive'
       WHERE id = $1`,
      [h.account.id]
    );

    for (let pass = 0; pass < 2; pass += 1) {
      expect((await sync("first_sync")).outcome).toBe("failed");
    }
    const third = await sync("first_sync");
    expect(third.outcome).toBe("success");
    expect(third.unreadableMessagesSkipped).toBe(1);
    expect(await liveUids(h.pool, h.account.id)).toEqual([3, 5]);

    for (let pass = 0; pass < 2; pass += 1) {
      expect((await sync("history")).outcome).toBe("partial_success");
    }
    expect((await sync("history")).unreadableMessagesSkipped).toBe(1);
    expect(await liveUids(h.pool, h.account.id)).toEqual([1, 3, 5]);
    expect(await folderRecords(h.pool, h.account.id)).toEqual({
      2: { code: "structure_invalid", attempts: 3, failed_at: expect.any(String) },
      4: { code: "structure_invalid", attempts: 3, failed_at: expect.any(String) }
    });
    const backlog = await h.repository.getHistoryBacklog((await h.repository.getAccount(h.account.id))!, 1);
    expect(backlog).toEqual([]);
  });

  it("does not count a skipped message as audit drift, and forgets it once the provider deletes it", async () => {
    const folders = buildInboxAndSentFolders();
    const poison = new Set<number>();
    const { h, sync } = await harness("poison-audit", folders, poison);
    await sync();
    folders[0].messages.push(message(106));
    poison.add(106);
    for (let pass = 0; pass < 3; pass += 1) await sync("live");
    const auditDue = () => h.pool.query(
      `UPDATE public.imap_folders
       SET next_reconcile_at = now() - interval '1 second', last_full_reconcile_at = now() - interval '7 hours'
       WHERE account_id = $1 AND path = 'INBOX'`,
      [h.account.id]
    );

    await auditDue();
    const audit = await sync("audit");
    expect(audit.reconcileFoldersAttempted).toBe(1);
    expect(audit.reconcileGapsFound).toBe(0);
    const clean = await h.pool.query<{ last_reconcile_clean: boolean }>(
      "SELECT last_reconcile_clean FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
      [h.account.id]
    );
    expect(clean.rows[0].last_reconcile_clean).toBe(true);

    folders[0].messages = folders[0].messages.filter((candidate) => candidate.uid !== 106);
    await auditDue();
    await sync("audit");
    expect(await folderRecords(h.pool, h.account.id)).toBeNull();
    expect((await buildSyncStatus(h.pool, [h.account.id])).accounts[0].unreadable_messages).toBe(0);
  });

  it("clears the records when the folder's UIDVALIDITY changes", async () => {
    const folders = buildInboxAndSentFolders();
    const poison = new Set<number>([106]);
    const { h, sync } = await harness("poison-uidvalidity", folders, poison);
    await sync();
    folders[0].messages.push(message(106));
    for (let pass = 0; pass < 3; pass += 1) await sync("live");
    expect(await folderRecords(h.pool, h.account.id)).not.toBeNull();

    folders[0].uidValidity += 1;
    await sync("live");
    expect(await folderRecords(h.pool, h.account.id)).toBeNull();
  });

  it("stops recording past the folder's cap, so the folder fails as before", async () => {
    const folders = buildInboxAndSentFolders();
    const poison = new Set<number>([106]);
    const { h, sync } = await harness("poison-cap", folders, poison);
    await sync();
    const full = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [
      String(10_000 + index),
      { code: "fetch_incomplete", attempts: 3, failed_at: new Date().toISOString() }
    ]));
    await h.pool.query(
      "UPDATE public.imap_folders SET unreadable_messages = $2::jsonb WHERE account_id = $1 AND path = 'INBOX'",
      [h.account.id, JSON.stringify(full)]
    );
    folders[0].messages.push(message(106));

    for (let pass = 0; pass < 4; pass += 1) {
      expect((await sync("live")).outcome).toBe("failed");
    }
    expect(Object.keys((await folderRecords(h.pool, h.account.id))!)).not.toContain("106");
  });
});
