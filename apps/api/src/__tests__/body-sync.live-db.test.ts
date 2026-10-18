import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closePool } from "../db.js";
import { resetConfigForTests } from "../config.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import type { MirrorImapClient } from "../imap-client.js";
import { setupIntegration, teardownIntegration, type IntegrationHarness } from "./helpers/integration-harness.js";

// ADR 0044: bodies download beside the account lock and commit under it.
const integration = process.env.DATABASE_URL ? describe : describe.skip;

const OLD = new Date("2023-01-01T00:00:00Z");

function inbox(messages: ReturnType<typeof makeTextMessage>[]): FixtureFolder[] {
  return [{ path: "INBOX", delimiter: "/", specialUse: "\\Inbox", uidValidity: 91_001, messages }];
}

function message(uid: number, internalDate = new Date()) {
  return makeTextMessage({
    uid,
    subject: `body-${uid}`,
    from: "a@x.test",
    to: "u@x.test",
    body: `body-${uid}`,
    internalDate
  });
}

/** A fixture whose body FETCH waits until the test opens the gate. */
class GatedBodyClient extends FixtureImapClient {
  entered!: Promise<void>;
  private enter!: () => void;
  private gate: Promise<void>;
  open!: () => void;
  goneUids = new Set<string>();

  constructor(folders: FixtureFolder[]) {
    super(folders);
    this.entered = new Promise((resolve) => { this.enter = resolve; });
    this.gate = new Promise((resolve) => { this.open = resolve; });
  }

  override async fetchOne(range: string, query: Record<string, unknown>, options?: Record<string, unknown>) {
    if (query.source) {
      this.enter();
      await this.gate;
      if (this.goneUids.has(range)) return false;
    }
    return await super.fetchOne(range, query, options);
  }

  override async download(range: string, part?: string, options?: Record<string, unknown>) {
    if (this.goneUids.has(range)) return {} as never;
    return await super.download(range, part, options);
  }
}

integration("body sync beside the account lock (real Postgres + fixture IMAP)", () => {
  const accounts: string[] = [];
  let h: IntegrationHarness;

  async function setup(suite: string, folders: FixtureFolder[], mode = "metadata_only") {
    h = await setupIntegration(suite, { BODY_BACKFILL_BATCH_SIZE: 5, MAX_BODY_BATCHES_PER_TICK: 2 });
    accounts.push(h.account.id);
    await h.pool.query(
      `UPDATE public.imap_accounts
       SET body_fetch_policy = 'immediate', historical_backfill_mode = $2, max_backfill_rate = 'aggressive'
       WHERE id = $1`,
      [h.account.id, mode]
    );
    expect((await h.buildEngine({ folders }).syncAccount(h.account.id, "manual")).outcome).toBe("success");
  }

  async function rows() {
    const result = await h.pool.query<{ uid: string; fetched: boolean; deleted: boolean; evidence: boolean }>(
      `SELECT m.uid::text, m.body_fetched_at IS NOT NULL AS fetched, m.deleted_in_provider AS deleted,
              b.message_id IS NOT NULL AS evidence
       FROM public.imap_messages m
       LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
       WHERE m.account_id = $1
       ORDER BY m.uid`,
      [h.account.id]
    );
    return result.rows;
  }

  afterEach(async () => {
    resetConfigForTests();
  });

  afterAll(async () => {
    for (const id of accounts) await teardownIntegration(h.pool, id);
    await closePool();
  });

  it("lets a sync pass take the lock while a body downloads", async () => {
    const folders = inbox([message(1)]);
    await setup("bodies-beside-lock", folders);
    const client = new GatedBodyClient(folders);
    const bodies = h.buildEngine({ folders, clientFactory: async () => client }).syncBodies(h.account.id);
    await client.entered;

    const pass = await h.buildEngine({ folders }).syncAccount(h.account.id, "manual");
    expect(pass.outcome).toBe("success");
    expect(await rows()).toEqual([{ uid: "1", fetched: false, deleted: false, evidence: false }]);

    client.open();
    expect(await bodies).toEqual({ committed: 1, gone: 0, skipped: 0, remaining: false });
    expect(await rows()).toEqual([{ uid: "1", fetched: true, deleted: false, evidence: true }]);
  });

  it("writes nothing for a row deleted while its body downloaded", async () => {
    const folders = inbox([message(1)]);
    await setup("bodies-deleted-before-commit", folders);
    const client = new GatedBodyClient(folders);
    const bodies = h.buildEngine({ folders, clientFactory: async () => client }).syncBodies(h.account.id);
    await client.entered;

    await h.pool.query(
      `UPDATE public.imap_messages SET deleted_in_provider = true, deleted_reason = 'RECONCILE_MISSING'
       WHERE account_id = $1`,
      [h.account.id]
    );
    client.open();
    expect(await bodies).toEqual({ committed: 0, gone: 0, skipped: 1, remaining: false });
    expect(await rows()).toEqual([{ uid: "1", fetched: false, deleted: true, evidence: false }]);
    const folder = await h.pool.query<{ bodies_fetched_count: number }>(
      "SELECT bodies_fetched_count FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
      [h.account.id]
    );
    expect(folder.rows[0].bodies_fetched_count).toBe(0);
  });

  it("keeps a row live when it moved before its old UID came back gone", async () => {
    const folders = inbox([message(1)]);
    await setup("bodies-moved-before-commit", folders);
    const client = new GatedBodyClient(folders);
    client.goneUids.add("1");
    // One batch: a later one would look for the body at the new UID.
    const bodies = h.buildEngine({ folders, clientFactory: async () => client })
      .syncBodies(h.account.id, { maxUnits: 1 });
    await client.entered;

    // A confirmed move keeps the id at a new UID (ADR 0037).
    await h.pool.query("UPDATE public.imap_messages SET uid = 7 WHERE account_id = $1", [h.account.id]);
    client.open();
    expect(await bodies).toEqual({ committed: 0, gone: 0, skipped: 1, remaining: true });
    expect(await rows()).toEqual([{ uid: "7", fetched: false, deleted: false, evidence: false }]);
  });

  it("tombstones a row still at the UID the provider no longer holds", async () => {
    const folders = inbox([message(1)]);
    await setup("bodies-gone", folders);
    const client = new GatedBodyClient(folders);
    client.goneUids.add("1");
    client.open();
    expect(await h.buildEngine({ folders, clientFactory: async () => client }).syncBodies(h.account.id))
      .toEqual({ committed: 0, gone: 1, skipped: 0, remaining: false });
    expect(await rows()).toEqual([{ uid: "1", fetched: false, deleted: true, evidence: false }]);
  });

  it("downloads live-window bodies before archive bodies, missing before upgrades", async () => {
    const folders = inbox([message(1, OLD), message(2, OLD), message(10)]);
    await setup("bodies-order", folders, "metadata_and_bodies");
    const account = await h.repository.getAccount(h.account.id);
    // A stored archive body whose evidence is out of date comes after missing ones.
    await h.pool.query(
      "UPDATE public.imap_messages SET body_fetched_at = now() WHERE account_id = $1 AND uid = 2",
      [h.account.id]
    );
    const uids = async (options: Parameters<typeof h.repository.getBodyBacklog>[2]) =>
      (await h.repository.getBodyBacklog(account!, 10, options)).map((row) => String(row.uid));

    expect(await uids({})).toEqual(["10"]);
    expect(await uids({ includeArchive: true })).toEqual(["10", "1", "2"]);
    const [live] = await h.repository.getBodyBacklog(account!, 1);
    expect(await uids({ includeArchive: true, excludeIds: [live.id] })).toEqual(["1", "2"]);
  });

  it("never runs a body download inside the sync pass", async () => {
    const folders = inbox([message(1, OLD), message(10)]);
    let bodyFetches = 0;
    class CountingClient extends FixtureImapClient {
      override async fetchOne(range: string, query: Record<string, unknown>, options?: Record<string, unknown>) {
        if (query.source) bodyFetches += 1;
        return await super.fetchOne(range, query, options);
      }
    }
    await setup("bodies-not-in-pass", folders, "metadata_and_bodies");
    const engine = h.buildEngine({ folders, clientFactory: async () => new CountingClient(folders) as MirrorImapClient });
    for (let pass = 0; pass < 3; pass += 1) await engine.syncAccount(h.account.id, "manual");
    expect(bodyFetches).toBe(0);
    expect(await engine.syncBodies(h.account.id)).toMatchObject({ committed: 2 });
    expect(bodyFetches).toBe(2);
  });
});
