import { getConfig } from "../config.js";
import { applyInitialMigration, closePool, getPool } from "../db.js";
import { MirrorRepository } from "../repository.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "./fixture-imap.js";
import { MirrorEngine } from "../sync-engine.js";

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function generateFolders(messageCount: number, bodyBytes: number): FixtureFolder[] {
  const baseDate = Date.now();
  const body = "x".repeat(bodyBytes);
  const messages = Array.from({ length: messageCount }, (_, index) =>
    makeTextMessage({
      uid: index + 1,
      subject: `Load smoke ${index + 1}`,
      from: `sender-${index + 1}@example.test`,
      to: "load-smoke@example.test",
      internalDate: new Date(baseDate - index * 1_000),
      body
    })
  );

  return [
    {
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 44_004,
      messages
    }
  ];
}

async function countRows(accountId: string): Promise<{
  messages: number;
  bodies: number;
  deletedMessages: number;
}> {
  const pool = getPool();
  const result = await pool.query<{
    messages: string;
    bodies: string;
    deleted_messages: string;
  }>(
    `
    SELECT
      (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1) AS messages,
      (SELECT count(*)::text FROM public.imap_message_bodies b JOIN public.imap_messages m ON m.id = b.message_id WHERE m.account_id = $1) AS bodies,
      (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1 AND deleted_in_provider = true) AS deleted_messages
    `,
    [accountId]
  );
  const row = result.rows[0];
  return {
    messages: Number(row.messages),
    bodies: Number(row.bodies),
    deletedMessages: Number(row.deleted_messages)
  };
}

async function main(): Promise<void> {
  const messageCount = positiveIntEnv("SUPAMAIL_LOAD_MESSAGES", 1_000);
  const bodyBytes = positiveIntEnv("SUPAMAIL_LOAD_BODY_BYTES", 512);
  const bodyBatchSize = positiveIntEnv("BODY_BACKFILL_BATCH_SIZE", 25);
  const metadataBatchSize = positiveIntEnv("INITIAL_SYNC_BATCH_SIZE", 25);
  const memoryLimitBytes = positiveIntEnv("SUPAMAIL_LOAD_MAX_RSS_BYTES", 220 * 1024 * 1024);

  const pool = getPool();
  await applyInitialMigration(pool);

  const config = {
    ...getConfig(),
    BODY_FETCH_POLICY: "immediate" as const,
    BODY_BACKFILL_BATCH_SIZE: bodyBatchSize,
    INITIAL_SYNC_BATCH_SIZE: metadataBatchSize,
    INCREMENTAL_SYNC_BATCH_SIZE: metadataBatchSize,
    BODY_RAW_MAX_BYTES: Math.max(bodyBytes * 2, 1024 * 1024),
    IMAP_ALLOW_PRIVATE_HOSTS: true
  };

  const folders = generateFolders(messageCount, bodyBytes);
  const repository = new MirrorRepository(pool, config);
  const account = await repository.createAccount({
    emailAddress: `load-smoke-${Date.now()}@example.test`,
    host: "fake.imap.local",
    port: 993,
    secure: true,
    username: "load-smoke@example.test",
    password: "not-used-in-load-smoke",
    providerProfile: "generic-imap",
    bodyFetchPolicy: "immediate"
  });

  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);

  try {
    const engine = new MirrorEngine({
      pool,
      config,
      repository,
      clientFactory: async () => new FixtureImapClient(folders)
    });
    const result = await engine.syncAccount(account.id, "manual");
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    const counts = await countRows(account.id);
    const expectedBodies = Math.min(messageCount, bodyBatchSize);
    const assertions: Array<[string, boolean]> = [
      ["sync succeeded", result.outcome === "success"],
      ["all metadata rows mirrored", counts.messages === messageCount],
      ["body backlog remains bounded", counts.bodies === expectedBodies],
      ["no false provider deletes", counts.deletedMessages === 0],
      ["rss stayed under smoke threshold", peakRss < memoryLimitBytes]
    ];
    const failed = assertions.filter(([, passed]) => !passed);
    if (failed.length > 0) {
      throw new Error(`Load smoke failed: ${failed.map(([name]) => name).join(", ")}`);
    }

    console.log(JSON.stringify({
      ok: true,
      messageCount,
      bodyBytes,
      metadataBatchSize,
      bodyBatchSize,
      peakRss,
      result,
      counts
    }, null, 2));
  } finally {
    clearInterval(sampler);
    if (process.env.SUPAMAIL_LOAD_KEEP_DATA !== "true") {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [account.id]);
    }
  }
}

try {
  await main();
} finally {
  await closePool();
}
