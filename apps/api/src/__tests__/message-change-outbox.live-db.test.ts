import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config.js";
import { closePool, getPool } from "../db.js";
import { makeTextMessage, type FixtureFolder } from "../smoke/fixture-imap.js";
import type { ImapFolder } from "../types.js";
import { setupIntegration, teardownIntegration } from "./helpers/integration-harness.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

function inbox(messages: number): FixtureFolder[] {
  return [{
    path: "INBOX",
    delimiter: "/",
    specialUse: "\\Inbox",
    uidValidity: 42_001,
    messages: Array.from({ length: messages }, (_, index) => makeTextMessage({
      uid: index + 1,
      subject: `change-${index + 1}`,
      from: "sender@example.test",
      to: "user@example.test",
      body: `change-${index + 1}`,
      flags: ["\\Seen"]
    }))
  }];
}

liveDb("message change outbox", () => {
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

  it("records each update of a live message in the writer's transaction, whoever writes", async () => {
    const h = await setupIntegration("message-change-outbox", { INITIAL_SYNC_BATCH_SIZE: 10 });
    accountIds.push(h.account.id);
    await h.buildEngine({ folders: inbox(4) }).syncAccount(h.account.id, "manual");
    const messages = (await h.pool.query<{ id: string; uid: string }>(
      "SELECT id, uid::text AS uid FROM public.imap_messages WHERE account_id = $1 ORDER BY uid",
      [h.account.id]
    )).rows;
    const idOf = (uid: number) => messages.find((message) => Number(message.uid) === uid)!.id;
    const changes = async () => (await h.pool.query<{ message_id: string }>(
      "SELECT message_id FROM public.imap_message_changes WHERE account_id = $1 ORDER BY id",
      [h.account.id]
    )).rows.map((row) => row.message_id);

    // New mail is not a change: consumers find it by (created_at, id).
    expect(await changes()).toEqual([]);

    // Sync's flag scan writes only the differing row, so only it is recorded.
    const folder = (await h.pool.query<ImapFolder>(
      "SELECT * FROM public.imap_folders WHERE account_id = $1 AND path = 'INBOX'",
      [h.account.id]
    )).rows[0]!;
    await h.repository.applyFlagScan(h.account.id, folder, Number(folder.uidvalidity), [
      { uid: 1, flags: ["\\Seen", "\\Flagged"] },
      { uid: 2, flags: ["\\Seen"] }
    ]);
    expect(await changes()).toEqual([idOf(1)]);

    // An agent's flag change written through, and a body arriving.
    await h.repository.applyMessageFlags(idOf(2), h.account.id, { remove: ["\\Seen"] });
    await h.pool.query("UPDATE public.imap_messages SET body_fetched_at = now() WHERE id = $1", [idOf(3)]);
    expect(await changes()).toEqual([idOf(1), idOf(2), idOf(3)]);

    // A rolled-back write leaves nothing behind.
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE public.imap_messages SET flags = '{}' WHERE id = $1", [idOf(4)]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await changes()).toHaveLength(3);

    // A deletion is not a change to a live message; a restore is.
    await h.pool.query(
      "UPDATE public.imap_messages SET deleted_in_provider = true, deleted_reason = 'RECONCILE_MISSING', provider_deleted_at = now() WHERE id = $1",
      [idOf(4)]
    );
    expect(await changes()).toHaveLength(3);
    await h.pool.query(
      "UPDATE public.imap_messages SET deleted_in_provider = false, deleted_reason = NULL, provider_deleted_at = NULL WHERE id = $1",
      [idOf(4)]
    );
    expect(await changes()).toEqual([idOf(1), idOf(2), idOf(3), idOf(4)]);

    // Sync rewriting a row it already has (an upsert that updates) is a change too.
    const resync = await h.repository.upsertMessages(h.account.id, folder, Number(folder.uidvalidity), [{
      uid: 3,
      internalDate: new Date("2026-06-01T00:00:00.000Z"),
      sizeBytes: 100,
      flags: ["\\Seen"],
      rfcMessageId: "<change-3@example.test>",
      messageIdNormalized: "change-3@example.test",
      providerMessageId: null,
      providerMessageIdNamespace: null,
      providerThreadId: null,
      providerThreadIdNamespace: null,
      inReplyTo: null,
      referencesHeader: null,
      subject: "change-3",
      fromEmail: "sender@example.test",
      fromName: null,
      toEmails: ["user@example.test"],
      toNames: [null],
      ccEmails: [],
      ccNames: [],
      bccEmails: [],
      headersJson: {},
      mimeStructure: null,
      attachments: []
    }]);
    expect(resync[0]!.id).toBe(idOf(3));
    expect((await changes()).at(-1)).toBe(idOf(3));
    const beforeBatch = (await changes()).length;

    // One statement over several rows records each of them.
    await h.pool.query(
      "UPDATE public.imap_messages SET flags = ARRAY['\\Seen'] WHERE account_id = $1 AND uid IN (1, 2)",
      [h.account.id]
    );
    expect((await changes()).slice(beforeBatch).sort()).toEqual([idOf(1), idOf(2)].sort());
  });

  it("leaves body and updated_at changes HOT-eligible: no index covers them", async () => {
    // PostgreSQL makes an update heap-only only when it changes no indexed column,
    // counting columns in index keys, expressions, and predicates.
    const indexed = await getPool().query<{ attname: string }>(
      `SELECT DISTINCT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE i.indrelid = 'public.imap_messages'::regclass
         AND (a.attnum = ANY(i.indkey::int2[])
           OR coalesce(pg_get_expr(i.indexprs, i.indrelid), '') ~ ('\\m' || a.attname || '\\M')
           OR coalesce(pg_get_expr(i.indpred, i.indrelid), '') ~ ('\\m' || a.attname || '\\M'))`
    );
    const columns = indexed.rows.map((row) => row.attname);
    expect(columns).toContain("deleted_in_provider");
    expect(columns).not.toContain("updated_at");
    expect(columns).not.toContain("body_fetched_at");
  });

  it("needs no rights on the outbox from a writer", async () => {
    const h = await setupIntegration("message-change-writer-rights", { INITIAL_SYNC_BATCH_SIZE: 10 });
    accountIds.push(h.account.id);
    await h.buildEngine({ folders: inbox(1) }).syncAccount(h.account.id, "manual");
    const role = `change_writer_${randomUUID().replaceAll("-", "")}`;
    await h.pool.query(`CREATE ROLE ${role} NOLOGIN BYPASSRLS`);
    const client = await h.pool.connect();
    try {
      await h.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await h.pool.query(`GRANT SELECT, UPDATE ON public.imap_messages TO ${role}`);
      // Search columns derived on every write call the unaccent extension.
      await h.pool.query(`GRANT USAGE ON SCHEMA extensions TO ${role}`);
      await h.pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO ${role}`);
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      await expect(client.query("SELECT 1 FROM public.imap_message_changes")).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(
        "UPDATE public.imap_messages SET body_fetched_at = now() WHERE account_id = $1",
        [h.account.id]
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await h.pool.query(`DROP OWNED BY ${role}`);
      await h.pool.query(`DROP ROLE ${role}`);
    }
    const recorded = await h.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_message_changes WHERE account_id = $1",
      [h.account.id]
    );
    expect(recorded.rows[0]!.count).toBe("1");
  });

  it("prunes rows no consumer claimed within a week and cascades with the account", async () => {
    const h = await setupIntegration("message-change-retention", { INITIAL_SYNC_BATCH_SIZE: 10 });
    accountIds.push(h.account.id);
    await h.buildEngine({ folders: inbox(2) }).syncAccount(h.account.id, "manual");
    await h.pool.query(
      "UPDATE public.imap_messages SET body_fetched_at = now() WHERE account_id = $1",
      [h.account.id]
    );
    await h.pool.query(
      `UPDATE public.imap_message_changes SET changed_at = now() - interval '8 days'
       WHERE id = (SELECT min(id) FROM public.imap_message_changes WHERE account_id = $1)`,
      [h.account.id]
    );
    const count = async () => Number((await h.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_message_changes WHERE account_id = $1",
      [h.account.id]
    )).rows[0]!.count);
    expect(await count()).toBe(2);

    const { prunedChanges } = await h.repository.runMessageChangePruneJob();
    expect(prunedChanges).toBe(1);
    expect(await count()).toBe(1);

    await teardownIntegration(h.pool, accountIds.pop()!);
    expect(await count()).toBe(0);
  });
});
