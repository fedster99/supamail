import { getConfig } from "../src/config.js";
import { applyInitialMigration, closePool, getPool } from "../src/db.js";
import { MirrorRepository } from "../src/repository.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../src/smoke/fixture-imap.js";
import { MirrorEngine } from "../src/sync-engine.js";

const folders: FixtureFolder[] = [
  {
    path: "INBOX",
    delimiter: "/",
    specialUse: "\\Inbox",
    uidValidity: 11_001,
    messages: [
      makeTextMessage({
        uid: 101,
        subject: "Dry run hello",
        from: "alice@example.test",
        to: "dryrun@example.test",
        internalDate: new Date(Date.now() - 60 * 60_000),
        flags: ["\\Seen"],
        body: "This is a fake local sync message.",
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 34 },
            {
              part: "2",
              type: "application/pdf",
              size: 1234,
              disposition: { type: "attachment", params: { filename: "fixture.pdf" } }
            }
          ]
        }
      }),
      makeTextMessage({
        uid: 102,
        subject: "Dry run follow up",
        from: "bob@example.test",
        to: "dryrun@example.test",
        internalDate: new Date(Date.now() - 30 * 60_000),
        body: "Second fake local sync message."
      })
    ]
  },
  {
    path: "Sent",
    delimiter: "/",
    specialUse: "\\Sent",
    uidValidity: 22_002,
    messages: [
      makeTextMessage({
        uid: 201,
        subject: "Dry run sent",
        from: "dryrun@example.test",
        to: "charlie@example.test",
        internalDate: new Date(Date.now() - 15 * 60_000),
        flags: ["\\Seen"],
        body: "A fake sent message."
      })
    ]
  },
  {
    path: "Trash",
    delimiter: "/",
    specialUse: "\\Trash",
    uidValidity: 33_003,
    messages: []
  }
];

async function main(): Promise<void> {
  const pool = getPool();
  await applyInitialMigration(pool);
  const config = {
    ...getConfig(),
    BODY_FETCH_POLICY: "immediate" as const,
    BODY_BACKFILL_BATCH_SIZE: 10,
    INITIAL_SYNC_BATCH_SIZE: 2,
    INCREMENTAL_SYNC_BATCH_SIZE: 2
  };

  const email = `dryrun-${Date.now()}@example.test`;
  const repository = new MirrorRepository(pool, config);

  const hooks = {
    folders: 0,
    messages: 0,
    bodies: 0,
    syncRuns: 0
  };

  const engine = new MirrorEngine({
    pool,
    config,
    repository,
    hooks: {
      onFolderChanged: () => {
        hooks.folders += 1;
      },
      onMessageUpsert: () => {
        hooks.messages += 1;
      },
      onBodyFetched: () => {
        hooks.bodies += 1;
      },
      onSyncRunCompleted: () => {
        hooks.syncRuns += 1;
      }
    },
    clientFactory: async () => new FixtureImapClient(folders)
  });

  const account = await repository.createAccount({
    emailAddress: email,
    host: "fake.imap.local",
    port: 993,
    secure: true,
    username: email,
    password: "not-used-in-dry-run",
    providerProfile: "generic-imap",
    bodyFetchPolicy: "immediate"
  });

  try {
    const firstSync = await engine.syncAccount(account.id, "manual");
    const secondSync = await engine.syncAccount(account.id, "manual");
    const counts = await pool.query<{
      accounts: string;
      folders: string;
      tracked_folders: string;
      messages: string;
      bodies: string;
      attachments: string;
      runs: string;
      deleted_messages: string;
    }>(
      `
      SELECT
        (SELECT count(*)::text FROM public.imap_accounts WHERE id = $1) AS accounts,
        (SELECT count(*)::text FROM public.imap_folders WHERE account_id = $1) AS folders,
        (SELECT count(*)::text FROM public.imap_folders WHERE account_id = $1 AND tracked = true) AS tracked_folders,
        (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1) AS messages,
        (SELECT count(*)::text FROM public.imap_message_bodies b JOIN public.imap_messages m ON m.id = b.message_id WHERE m.account_id = $1) AS bodies,
        (SELECT count(*)::text FROM public.imap_attachments a JOIN public.imap_messages m ON m.id = a.message_id WHERE m.account_id = $1) AS attachments,
        (SELECT count(*)::text FROM public.imap_sync_runs WHERE account_id = $1) AS runs,
        (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1 AND deleted_in_provider = true) AS deleted_messages
      `,
      [account.id]
    );

    const row = counts.rows[0];
    const assertions: Array<[string, boolean]> = [
      ["first sync succeeded", firstSync.outcome === "success"],
      ["second sync is idempotent", secondSync.outcome === "success" && secondSync.messagesUpserted === 0],
      ["created account", Number(row.accounts) === 1],
      ["discovered all fixture folders", Number(row.folders) === 3],
      ["excluded Trash from tracked folders", Number(row.tracked_folders) === 2],
      ["mirrored messages", Number(row.messages) === 3],
      ["stored raw/parsed bodies", Number(row.bodies) === 3],
      ["stored attachment metadata", Number(row.attachments) === 1],
      ["recorded sync runs", Number(row.runs) === 2],
      ["no false provider deletes", Number(row.deleted_messages) === 0],
      ["fired hooks", hooks.folders === 3 && hooks.messages === 3 && hooks.bodies === 3 && hooks.syncRuns === 2]
    ];

    const failed = assertions.filter(([, passed]) => !passed);
    if (failed.length > 0) {
      throw new Error(`Dry run failed: ${failed.map(([name]) => name).join(", ")}`);
    }

    console.log(JSON.stringify({
      ok: true,
      accountId: account.id,
      firstSync,
      secondSync,
      counts: row,
      hooks
    }, null, 2));
  } finally {
    if (process.env.SUPAMAIL_DRY_RUN_KEEP_DATA !== "true") {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [account.id]);
    }
  }
}

try {
  await main();
} finally {
  await closePool();
}
